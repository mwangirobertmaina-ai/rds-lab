'use strict';
// ============================================================================
// routes/forex.js — STAGE 193 PART C: FOREX BUREAU CASHIER (additive; mounted by server.js at /api/forex)
//
// A licensed forex bureau rents the platform, its staff sign in through routes/platform.js (sealed to their tenant), and
// trade currency at the counter here. Every deal is recorded as BALANCED DOUBLE-ENTRY JOURNALS in the same ledger engine
// as everything else, so the F1..F9 freeze gate and the trial balance cover forex trades automatically, and AML/CTR runs
// through the SAME compliance engine as the cash desk. Nothing here invents its own money store.
//
// THE MODEL (worked in docs/forex and in the tests):
//   The bureau quotes, per foreign currency, a BUY rate and a SELL rate in KES.
//     deal = 'BUY'  -> the bureau BUYS foreign from the customer: foreign comes IN, KES goes OUT (customer is paid KES)
//     deal = 'SELL' -> the bureau SELLS foreign to the customer : foreign goes OUT, KES comes IN  (customer pays KES)
//   A deal touches two currencies, and the ledger balances WITHIN one currency, so each deal posts TWO journals
//   (one KES, one foreign), tied by the same dealId, bridged by the FX Deal Clearing account (1040) in each currency.
//   Realised profit/loss is computed with WEIGHTED-AVERAGE COST per currency (the method auditors expect):
//     on BUY  the foreign position rises at its KES cost;
//     on SELL the foreign position falls at its average cost, and (KES received - average cost) is the realised margin,
//     posted to 4000 FX Trading Income (profit) or 5100 FX Trading Loss (loss).
//
// ISOLATION: every request is already pinned to the caller's tenant by the seal in server.js, so a bureau can only ever
// see and move its own money. This module never trusts an x-business-id it was not given by that seal.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

let D = {};
function init(deps) { D = deps || {}; state(); }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const PROTO = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];
const isSafeKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+\-]{1,80}$/.test(v) && !PROTO.includes(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const clean = (v, max = 120) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
const CUR = (v) => { const c = String(v || '').toUpperCase(); return /^[A-Z]{3}$/.test(c) ? c : null; };
const now = () => Date.now();
const bad = (res, msg, code = 400, extra) => res.status(code).json({ success: false, error: msg, ...(extra || {}) });
const ok = (res, body) => res.json({ success: true, ...body });

// money: integer minor units, parsed exactly (never via floating point). exp = decimal places for the currency.
const EXP = { KES: 2, USD: 2, GBP: 2, EUR: 2, JPY: 0, UGX: 0, TZS: 2, RWF: 0, ZAR: 2, AED: 2, CNY: 2, INR: 2, CHF: 2, CAD: 2, AUD: 2 };
const expOf = (c) => (has(EXP, c) ? EXP[c] : 2);
function parseAmount(input, currency) {
    const exp = expOf(currency);
    let t = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : typeof input === 'string' ? input.trim().replace(/,/g, '') : '';
    if (!t || /e/i.test(t) || !/^\d{1,13}(\.\d+)?$/.test(t)) return null;
    const [i, f = ''] = t.split('.'); if (f.length > exp) return null;
    const minor = Number(i) * Math.pow(10, exp) + (f ? Number(f.padEnd(exp, '0')) : 0);
    return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
const dec = (minor, currency) => { const e = expOf(currency), p = Math.pow(10, e), a = Math.abs(minor); return (minor < 0 ? '-' : '') + Math.floor(a / p) + (e ? '.' + String(a % p).padStart(e, '0') : ''); };
// a rate is KES per 1 unit of foreign, stored as an integer in 1e6ths (6 dp) so 128.5 -> 128500000
const RATE_SCALE = 1000000;
function parseRate(input) {
    let t = typeof input === 'number' ? String(input) : typeof input === 'string' ? input.trim() : '';
    if (!t || /e/i.test(t) || !/^\d{1,7}(\.\d{1,6})?$/.test(t)) return null;
    const [i, f = ''] = t.split('.'); const micros = Number(i) * RATE_SCALE + (f ? Number(f.padEnd(6, '0')) : 0);
    return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}
const rateStr = (micros) => (micros / RATE_SCALE).toFixed(6).replace(/\.?0+$/, m => (m.includes('.') ? '' : m));
// KES minor from a foreign minor amount and a rate (micros). Rounded to whole KES cents, banker-safe (round half up on a positive value).
function kesFromForeign(foreignMinor, foreignCur, rateMicros) {
    const fe = expOf(foreignCur);
    // KES = foreignMajor * rate = (foreignMinor / 10^fe) * (rateMicros / 1e6) ; KES minor = that * 100
    // = foreignMinor * rateMicros * 100 / (10^fe * 1e6). Do it in integer math then round.
    const num = BigInt(foreignMinor) * BigInt(rateMicros) * 100n;
    const den = BigInt(Math.pow(10, fe)) * BigInt(RATE_SCALE);
    const q = num / den, r = num % den;
    return Number(q + (r * 2n >= den ? 1n : 0n));   // round half up
}

// ---------------------------------------------------------------------------
// state (saved with the server snapshot via server.js: deps.getState())
// ---------------------------------------------------------------------------
function state() {
    const s = (D.getState && D.getState()) || {};
    if (!s.rates || typeof s.rates !== 'object') s.rates = {};        // tenantId -> { CUR: { buy, sell, updatedAt, updatedBy } }
    if (!s.positions || typeof s.positions !== 'object') s.positions = {}; // tenantId -> { CUR: { units(minor), costKes(minor) } } weighted-average cost
    if (!s.deals || typeof s.deals !== 'object') s.deals = {};        // tenantId -> [ deal, ... ]
    if (!s.till || typeof s.till !== 'object') s.till = {};           // tenantId -> { openedAt, openingKes, counts, closedAt, ... } current session
    if (!Number.isSafeInteger(s.seq)) s.seq = 0;
    return s;
}
const dirty = () => { if (D.markDirty) D.markDirty(); };
const audit = (type, rec) => { if (D.appendAudit) D.appendAudit(type, rec); };

// ---------------------------------------------------------------------------
// auth: these routes need a signed-in tenant staff member. The isolation seal in server.js already pins the tenant.
// A CASHIER or TENANT_ADMIN may trade; an AUDITOR is read-only; the platform owner never trades (only break-glass read).
// ---------------------------------------------------------------------------
function auth(req, res, next) {
    const p = D.verifyJwt ? D.verifyJwt((req.headers.authorization || '').replace(/^Bearer\s+/, '')) : null;
    if (!p || !p.tenantId) return bad(res, 'Sign in as forex bureau staff.', 401);
    req.fx = { tenantId: p.tenantId, email: p.email || p.sub || 'staff', staffRole: p.staffRole || null, role: p.role || null, breakGlass: !!p.breakGlass };
    next();
}
const canTrade = (req, res, next) => {
    if (!(['CASHIER', 'TENANT_ADMIN'].includes(req.fx.staffRole)) || req.fx.breakGlass) return bad(res, 'Only a cashier or administrator can trade. Auditors and support access are read-only.', 403);
    if (D.billingOverdue && D.billingOverdue(req.fx.tenantId)) return bad(res, 'Trading is paused: a subscription invoice is overdue. Please settle it to resume.', 402);
    next();
};
function forexTenant(req, res) {
    // the tenant is whatever the platform sealed onto this request. Confirm it is an ACTIVE forex bureau.
    const id = req.fx.tenantId, t = D.tenantConfig ? D.tenantConfig(id) : null;
    if (!t) { bad(res, 'Institution not found or not active.', 404); return null; }
    if (t.type !== 'FOREX_BUREAU') { bad(res, 'The forex counter is only for forex bureaus. This institution is a ' + t.type + '.', 403); return null; }
    return t;
}
const rates = (t) => (state().rates[t] || (state().rates[t] = {}));
const positions = (t) => (state().positions[t] || (state().positions[t] = {}));
const deals = (t) => (state().deals[t] || (state().deals[t] = []));
const pos = (t, cur) => { const P = positions(t); return P[cur] || (P[cur] = { units: 0, costKes: 0 }); };

// post one balanced journal in the tenant's ledger, returning its id (throws on imbalance; the engine guarantees balance)
function postJournal(tenantId, currency, description, reference, source, postings, idemKey) {
    const r = D.ledger.post(tenantId, { currency, description, reference, source, idempotencyKey: idemKey, postings }, { by: 'FX_COUNTER', system: true });
    return r.entry ? r.entry.entryId : (r.pending ? null : null);
}

// ---------------------------------------------------------------------------
// RATE BOARD
// ---------------------------------------------------------------------------
router.get('/rates', auth, (req, res) => {
    const t = forexTenant(req, res); if (!t) return;
    const R = rates(t.tenantId), base = 'KES';
    const board = Object.keys(R).sort().map(cur => ({ currency: cur, buy: rateStr(R[cur].buy), sell: rateStr(R[cur].sell), spreadPct: Math.round((R[cur].sell - R[cur].buy) / R[cur].buy * 10000) / 100, updatedAt: R[cur].updatedAt, updatedBy: R[cur].updatedBy }));
    ok(res, { base, currencies: (t.currencies || ['KES']).filter(c => c !== 'KES'), board });
});
router.post('/rates', auth, canTrade, (req, res) => {
    const t = forexTenant(req, res); if (!t) return; const b = req.body || {};
    const cur = CUR(b.currency); if (!cur || cur === 'KES') return bad(res, 'Choose the foreign currency (not KES).');
    if (!(t.currencies || []).includes(cur)) return bad(res, `${cur} is not one of this bureau's declared currencies. Add it in the institution's settings first.`, 409);
    const buy = parseRate(b.buy), sell = parseRate(b.sell);
    if (!buy || !sell) return bad(res, 'Enter the buy and sell rates as KES per 1 ' + cur + ' (up to 6 decimals).');
    if (sell <= buy) return bad(res, 'The sell rate (bureau sells to the customer) must be higher than the buy rate.');
    if (sell > buy * 2) return bad(res, 'That spread looks wrong (sell is more than double buy). Please check the rates.');
    rates(t.tenantId)[cur] = { buy, sell, updatedAt: now(), updatedBy: req.fx.email };
    audit('FOREX_RATE_SET', { tenantId: t.tenantId, currency: cur, buy: rateStr(buy), sell: rateStr(sell), by: req.fx.email }); dirty();
    ok(res, { message: `${cur} rate set: buy ${rateStr(buy)}, sell ${rateStr(sell)}.`, currency: cur, buy: rateStr(buy), sell: rateStr(sell) });
});

// ---------------------------------------------------------------------------
// QUOTE (what the customer gets, before committing)
// ---------------------------------------------------------------------------
function quote(t, dealType, cur, foreignMinor) {
    const R = rates(t)[cur]; if (!R) return { err: `No rate is set for ${cur}. Set it on the rate board first.` };
    const rate = dealType === 'BUY' ? R.buy : R.sell;
    const kesMinor = kesFromForeign(foreignMinor, cur, rate);
    if (!(kesMinor > 0)) return { err: 'Amount is too small for the current rate.' };
    return { rate, rateStr: rateStr(rate), foreignMinor, kesMinor, foreign: dec(foreignMinor, cur), kes: dec(kesMinor, 'KES') };
}
router.post('/quote', auth, (req, res) => {
    const t = forexTenant(req, res); if (!t) return; const b = req.body || {};
    const dealType = String(b.deal || '').toUpperCase(); if (!['BUY', 'SELL'].includes(dealType)) return bad(res, "deal must be BUY (bureau buys foreign) or SELL (bureau sells foreign).");
    const cur = CUR(b.currency); if (!cur || cur === 'KES') return bad(res, 'Choose the foreign currency.');
    const foreignMinor = parseAmount(b.foreignAmount, cur); if (!foreignMinor) return bad(res, `Enter the ${cur} amount.`);
    const q = quote(t.tenantId, dealType, cur, foreignMinor); if (q.err) return bad(res, q.err, 409);
    ok(res, { deal: dealType, currency: cur, ...q,
        customerGets: dealType === 'BUY' ? `KES ${q.kes}` : `${cur} ${q.foreign}`,
        customerGives: dealType === 'BUY' ? `${cur} ${q.foreign}` : `KES ${q.kes}` });
}
);

// ---------------------------------------------------------------------------
// EXECUTE A DEAL  (the heart of C: posts balanced journals + updates the position + AML)
// ---------------------------------------------------------------------------
const CTR_KES_MINOR = () => { const n = Number(process.env.CTR_KES_THRESHOLD) > 0 ? Number(process.env.CTR_KES_THRESHOLD) : 1000000; return n * 100; };
router.post('/deals', auth, canTrade, (req, res) => {
    const t = forexTenant(req, res); if (!t) return; const tid = t.tenantId, b = req.body || {};
    const dealType = String(b.deal || '').toUpperCase(); if (!['BUY', 'SELL'].includes(dealType)) return bad(res, "deal must be BUY or SELL.");
    const cur = CUR(b.currency); if (!cur || cur === 'KES') return bad(res, 'Choose the foreign currency.');
    const foreignMinor = parseAmount(b.foreignAmount, cur); if (!foreignMinor) return bad(res, `Enter the ${cur} amount.`);
    const q = quote(tid, dealType, cur, foreignMinor); if (q.err) return bad(res, q.err, 409);
    try { D.ledger.ensureTenant(tid, cur, 'FOREX'); } catch (e) {}   // the foreign currency's chart of accounts must exist (1030, 1040, ... in that currency)

    // the counter cannot sell foreign it does not hold, or pay out KES it does not have (ledger balances prove this after)
    const P = pos(tid, cur);
    if (dealType === 'SELL' && foreignMinor > P.units) return bad(res, `The till holds only ${dec(P.units, cur)} ${cur}. You cannot sell ${q.foreign} ${cur}.`, 409);
    if (dealType === 'BUY') { const kesBal = ledgerBal(tid, '1020', 'KES'); if (q.kesMinor > kesBal) return bad(res, `The KES till holds only ${dec(kesBal, 'KES')}. You cannot pay out KES ${q.kes}.`, 409); }

    // customer identity (required at/above the CTR threshold; the compliance engine enforces CDD and raises the CTR)
    const name = clean(b.customerName, 100), idNumber = clean(b.idNumber, 30).toUpperCase(), phone = clean(b.phone, 20);
    if (q.kesMinor >= CTR_KES_MINOR() && (!name || !idNumber)) return bad(res, `A deal of KES ${q.kes} is at or above the reporting threshold. Record the customer's full name and ID number before trading.`, 409);

    const S = state(); S.seq++; const dealId = `FX-${tid}-${String(S.seq).padStart(7, '0')}`, t0 = now(), ref = dealId;
    // ---- AML: the SAME compliance engine as the cash desk. Refuse large cash without approved CDD; record the transaction; raise CTR. ----
    let ctrId = null, alerts = [];
    try {
        const C = D.compliance;
        if (C) {
            C.assertCdd(tid, { amountMinor: q.kesMinor, currency: 'KES', type: 'CASH_' + (dealType === 'BUY' ? 'WITHDRAWAL' : 'DEPOSIT'), customerName: name, idNumber });
        }
    } catch (e) { return bad(res, e.message, e.status || 409, { code: e.code }); }

    // ---- post the money: two balanced journals (one per currency), bridged by 1040 FX Deal Clearing ----
    // KES leg and foreign leg are each self-balancing; 1040 nets the deal to zero in each currency once both legs post.
    let kesJournal = null, fxJournal = null;
    try {
        if (dealType === 'BUY') {
            // foreign IN (Dr 1030), KES OUT (Cr 1020). Bridge with 1040 in each currency.
            fxJournal = postJournal(tid, cur, `FX BUY ${q.foreign} ${cur} from customer`, ref, 'FOREX_DEAL', [{ account: '1030-' + cur, side: 'D', amountMinor: foreignMinor }, { account: '1040-' + cur, side: 'C', amountMinor: foreignMinor }], `${dealId}:FX`);
            kesJournal = postJournal(tid, 'KES', `FX BUY: paid KES ${q.kes} for ${q.foreign} ${cur}`, ref, 'FOREX_DEAL', [{ account: '1040', side: 'D', amountMinor: q.kesMinor }, { account: '1020', side: 'C', amountMinor: q.kesMinor }], `${dealId}:KES`);
            // position up at cost
            P.units += foreignMinor; P.costKes += q.kesMinor;
        } else {
            // SELL: foreign OUT (Cr 1030), KES IN (Dr 1020). Realise profit/loss vs weighted-average cost.
            const avgCost = P.units > 0 ? Math.round(P.costKes * (foreignMinor / P.units)) : q.kesMinor;  // KES cost of the foreign released
            fxJournal = postJournal(tid, cur, `FX SELL ${q.foreign} ${cur} to customer`, ref, 'FOREX_DEAL', [{ account: '1040-' + cur, side: 'D', amountMinor: foreignMinor }, { account: '1030-' + cur, side: 'C', amountMinor: foreignMinor }], `${dealId}:FX`);
            const pnl = q.kesMinor - avgCost;  // KES received minus KES cost of the currency given up
            const kesPost = [{ account: '1020', side: 'D', amountMinor: q.kesMinor }, { account: '1040', side: 'C', amountMinor: avgCost }];
            if (pnl > 0) kesPost.push({ account: '4000', side: 'C', amountMinor: pnl });
            else if (pnl < 0) kesPost.push({ account: '5100', side: 'D', amountMinor: -pnl });
            kesJournal = postJournal(tid, 'KES', `FX SELL: received KES ${q.kes} for ${q.foreign} ${cur} (cost ${dec(avgCost, 'KES')}, ${pnl >= 0 ? 'profit' : 'loss'} ${dec(Math.abs(pnl), 'KES')})`, ref, 'FOREX_DEAL', kesPost, `${dealId}:KES`);
            // position down at average cost
            P.units -= foreignMinor; P.costKes = Math.max(0, P.costKes - avgCost); if (P.units === 0) P.costKes = 0;
        }
    } catch (e) {
        try { if (D.ledger.recordFailure) D.ledger.recordFailure('FOREX_DEAL', dealId, e.message); } catch (x) {}
        return bad(res, 'The deal could not be posted to the ledger: ' + e.message, 500);
    }

    const deal = { dealId, tenantId: tid, deal: dealType, currency: cur, foreignMinor, foreign: q.foreign, rate: q.rate, rateStr: q.rateStr, kesMinor: q.kesMinor, kes: q.kes,
        customerName: name || null, idNumber: idNumber || null, phone: phone || null, cashier: req.fx.email, at: t0, kesJournal, fxJournal, ctrId: null };
    deals(tid).push(deal); if (deals(tid).length > 100000) deals(tid).shift();

    // record the transaction + CTR in the compliance engine (KES value is what the threshold is measured in)
    try {
        const C = D.compliance;
        if (C) {
            const out = C.recordTransaction(tid, { amountMinor: q.kesMinor, currency: 'KES', type: 'CASH_' + (dealType === 'BUY' ? 'WITHDRAWAL' : 'DEPOSIT'), customerName: name || 'Walk-in FX customer', idNumber, ledgerEntryId: kesJournal }, req.fx.email);
            if (out.ctr) { ctrId = out.ctr.ctrId; deal.ctrId = ctrId; }
            alerts = (out.alerts || []).map(a => a.rule);
            if (C.clients && C.clients.recordCash) C.clients.recordCash({ idNumber, name, phone, amountMinor: q.kesMinor, type: dealType === 'BUY' ? 'WITHDRAWAL' : 'DEPOSIT', ref: dealId });
        }
    } catch (e) { /* the money already posted correctly; a monitoring hiccup must not undo a balanced deal */ }

    audit('FOREX_DEAL', { tenantId: tid, dealId, deal: dealType, currency: cur, foreign: q.foreign, kes: q.kes, rate: q.rateStr, ctrId, cashier: req.fx.email }); dirty();
    ok(res, { message: `${dealType === 'BUY' ? 'Bought' : 'Sold'} ${q.foreign} ${cur} ${dealType === 'BUY' ? 'for' : 'at'} KES ${q.kes}.${ctrId ? ` A cash report (${ctrId}) is now open: file it in goAML by the end of the week.` : ''}${alerts.length ? ` Alerts: ${alerts.join(', ')}.` : ''}`,
        deal: dealView(deal), ctrId, alerts, receipt: receipt(t, deal) });
});

const dealView = (d) => ({ dealId: d.dealId, deal: d.deal, currency: d.currency, foreign: d.foreign, kes: d.kes, rate: d.rateStr, customerName: d.customerName, idNumber: d.idNumber ? maskId(d.idNumber) : null, cashier: d.cashier, at: d.at, ctrId: d.ctrId, kesJournal: d.kesJournal, fxJournal: d.fxJournal });
const maskId = (s) => { const v = String(s || ''); return v.length <= 3 ? '***' : '*'.repeat(v.length - 3) + v.slice(-3); };
function receipt(t, d) {
    return { bureau: t.name, dealId: d.dealId, when: new Date(d.at).toISOString(),
        line1: d.deal === 'BUY' ? `We bought ${d.foreign} ${d.currency} from you` : `We sold ${d.foreign} ${d.currency} to you`,
        line2: `Rate: 1 ${d.currency} = KES ${d.rateStr}`,
        line3: d.deal === 'BUY' ? `You received KES ${d.kes}` : `You paid KES ${d.kes}`,
        cashier: d.cashier, note: 'Keep this receipt. Exchange of currency only. This is not investment advice.' };
}

// ---------------------------------------------------------------------------
// POSITIONS (how much foreign the bureau holds, its KES cost, and the mark-to-market at the current buy rate)
// ---------------------------------------------------------------------------
function ledgerBal(tid, code, currency) {
    try { const b = D.ledger.balanceOf(tid, code); return b.debit - b.credit; } catch (e) { return 0; }
}
router.get('/positions', auth, (req, res) => {
    const t = forexTenant(req, res); if (!t) return; const tid = t.tenantId, P = positions(tid), R = rates(tid);
    const rows = Object.keys(P).filter(c => P[c].units !== 0 || P[c].costKes !== 0).sort().map(cur => {
        const avg = P[cur].units > 0 ? Math.round(P[cur].costKes / (P[cur].units / Math.pow(10, expOf(cur)))) : 0;
        const markRate = R[cur] ? R[cur].buy : 0, markKes = markRate ? kesFromForeign(P[cur].units, cur, markRate) : 0;
        return { currency: cur, units: dec(P[cur].units, cur), costKes: dec(P[cur].costKes, 'KES'),
            avgCostRate: avg ? (avg / 100).toFixed(4) : null, markRate: markRate ? rateStr(markRate) : null, markKes: markKes ? dec(markKes, 'KES') : null,
            unrealisedKes: markKes ? dec(markKes - P[cur].costKes, 'KES') : null };
    });
    const kesTill = ledgerBal(tid, '1020', 'KES');
    ok(res, { kesOnHand: dec(kesTill, 'KES'), foreign: rows });
});

// ---------------------------------------------------------------------------
// DEAL BLOTTER (today's deals, and a CSV export for the day)
// ---------------------------------------------------------------------------
const dayStart = () => { const eat = now() + 3 * 3600000; return eat - (eat % 86400000) - 3 * 3600000; };
router.get('/deals', auth, (req, res) => {
    const t = forexTenant(req, res); if (!t) return; const tid = t.tenantId;
    const from = req.query.from ? Date.parse(req.query.from + 'T00:00:00+03:00') : dayStart();
    const list = deals(tid).filter(d => d.at >= from).slice(-500).reverse();
    const sum = { buys: 0, sells: 0, buyKes: 0, sellKes: 0, byCurrency: {} };
    for (const d of list) { if (d.deal === 'BUY') { sum.buys++; sum.buyKes += d.kesMinor; } else { sum.sells++; sum.sellKes += d.kesMinor; } const c = sum.byCurrency[d.currency] || (sum.byCurrency[d.currency] = { bought: 0, sold: 0 }); if (d.deal === 'BUY') c.bought += d.foreignMinor; else c.sold += d.foreignMinor; }
    ok(res, { count: list.length, deals: list.map(dealView), summary: { buys: sum.buys, sells: sum.sells, buyKes: dec(sum.buyKes, 'KES'), sellKes: dec(sum.sellKes, 'KES'),
        byCurrency: Object.fromEntries(Object.entries(sum.byCurrency).map(([c, v]) => [c, { bought: dec(v.bought, c), sold: dec(v.sold, c) }])) } });
});
const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
router.get('/deals/export.csv', auth, (req, res) => {
    const t = forexTenant(req, res); if (!t) return; const tid = t.tenantId;
    const from = req.query.from ? Date.parse(req.query.from + 'T00:00:00+03:00') : dayStart();
    const rows = [['Deal ID', 'When', 'Type', 'Currency', 'Foreign amount', 'Rate (KES)', 'KES value', 'Customer', 'ID (masked)', 'Cashier', 'CTR', 'KES journal', 'FX journal'].map(csvCell).join(',')];
    for (const d of deals(tid).filter(x => x.at >= from)) rows.push([d.dealId, new Date(d.at).toISOString(), d.deal, d.currency, d.foreign, d.rateStr, d.kes, d.customerName || '', d.idNumber ? maskId(d.idNumber) : '', d.cashier, d.ctrId || '', d.kesJournal || '', d.fxJournal || ''].map(csvCell).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="forex-deals-${tid}.csv"`, 'Cache-Control': 'no-store' });
    res.send(rows.join('\r\n') + '\r\n');
});

// ---------------------------------------------------------------------------
// TILL RECONCILIATION (the anti-theft check at the counter: what the ledger says the till SHOULD hold, vs what the cashier counts)
// ---------------------------------------------------------------------------
router.get('/till', auth, (req, res) => {
    const t = forexTenant(req, res); if (!t) return; const tid = t.tenantId, P = positions(tid);
    const expectedKes = ledgerBal(tid, '1020', 'KES');
    const foreign = Object.keys(P).filter(c => P[c].units !== 0).map(c => ({ currency: c, expected: dec(P[c].units, c) }));
    ok(res, { expectedKes: dec(expectedKes, 'KES'), foreign, note: 'This is what the ledger says the till should hold right now. Count the cash and confirm it matches at close.' });
});
router.post('/till/reconcile', auth, canTrade, (req, res) => {
    const t = forexTenant(req, res); if (!t) return; const tid = t.tenantId, b = req.body || {}, P = positions(tid);
    const expectedKes = ledgerBal(tid, '1020', 'KES'), countedKes = parseAmount(b.countedKes, 'KES');
    if (countedKes === null && b.countedKes !== '0' && b.countedKes !== 0) return bad(res, 'Enter the counted KES cash.');
    const kesCounted = countedKes || 0, kesDiff = kesCounted - expectedKes;
    const foreign = [];
    for (const cur of Object.keys(P).filter(c => P[c].units !== 0)) {
        const counted = parseAmount((b.countedForeign || {})[cur], cur); const c = counted || 0;
        foreign.push({ currency: cur, expected: dec(P[cur].units, cur), counted: dec(c, cur), diff: dec(c - P[cur].units, cur), matches: c === P[cur].units });
    }
    const matches = kesDiff === 0 && foreign.every(f => f.matches);
    const rec = { at: now(), by: req.fx.email, expectedKes: dec(expectedKes, 'KES'), countedKes: dec(kesCounted, 'KES'), kesDiff: dec(kesDiff, 'KES'), foreign, matches, note: clean(b.note, 200) };
    audit('FOREX_TILL_RECONCILED', { tenantId: tid, by: req.fx.email, matches, kesDiff: dec(kesDiff, 'KES') }); dirty();
    ok(res, { message: matches ? 'Till balances: the counted cash matches the ledger to the cent.' : `Till does NOT balance. KES difference ${dec(kesDiff, 'KES')}. Investigate before close.`, reconciliation: rec });
});

// ---------------------------------------------------------------------------
// snapshot for the institution's own dashboard and the platform master control
// ---------------------------------------------------------------------------
function forexStats(tid) {
    const list = deals(tid), from = dayStart(), today = list.filter(d => d.at >= from);
    const P = positions(tid);
    return { dealsToday: today.length, dealsTotal: list.length,
        buyKesToday: dec(today.filter(d => d.deal === 'BUY').reduce((s, d) => s + d.kesMinor, 0), 'KES'),
        sellKesToday: dec(today.filter(d => d.deal === 'SELL').reduce((s, d) => s + d.kesMinor, 0), 'KES'),
        currenciesHeld: Object.keys(P).filter(c => P[c].units !== 0).length, kesOnHand: dec(ledgerBal(tid, '1020', 'KES'), 'KES') };
}

module.exports = router;
module.exports.init = init;
module.exports.stats = forexStats;
module.exports._test = { parseAmount, parseRate, kesFromForeign, rateStr, dec };