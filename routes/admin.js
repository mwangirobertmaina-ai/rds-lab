'use strict';
// ============================================================================
// routes/admin.js — STAGE 192 ADMIN, LEDGER AND COMPLIANCE (ONE FILE)
//
// Everything the admin page (admin.html) needs lives in this one file, in three parts:
//   PART 1  LEDGER ENGINE       double-entry, exact integer money, immutable hash-chained journals, maker-checker,
//                               period close, reversals, trial balance, statements
//   PART 2  COMPLIANCE ENGINE   customer due diligence, cash-transaction reports, monitoring rules, suspicious-
//                               transaction cases, sanctions screening, filing deadlines
//   PART 3  API + MARKETPLACE   the secured HTTP routes the admin page calls (mounted by server.js at /api/admin,
//                               /api/cashier and /api/kyc) and the hooks that post marketplace money to the ledger
//
// Changes that matter compared with the earlier admin module:
//  - NO AUTH BYPASS. The old file treated any request carrying an x-business-id header and no token as the owner.
//    Every route here needs a valid signed-in session; reading needs admin or auditor; changing needs the administrator role.
//  - A REAL LEDGER. The old version wrote journals to a temporary object and lost them.
//  - REAL COMPLIANCE. No hard-coded "LOW_RISK 99.8%", nothing is auto-approved.
//  - HONEST OUTPUT. Reports state facts and hashes. Nothing certifies compliance, and nothing says a registry or a
//    regulator was contacted when it was not.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const cashier = express.Router();
const kyc = express.Router();


// ############################################################################
// PART 1 — LEDGER ENGINE (no HTTP in this part)
// ############################################################################
const LEDGER = (function () {
// ============================================================================
// routes/ledger.js — STAGE 192 DOUBLE-ENTRY LEDGER ENGINE (no HTTP here; routes/admin.js exposes it)
//
// Design rules (these are what an auditor checks first):
//  1. MONEY IS AN INTEGER. Every amount is stored in minor units (cents). Decimal text such as "1500.50" is parsed
//     exactly (never through floating point) and anything with too many decimals is rejected, not rounded.
//  2. EVERY JOURNAL BALANCES. Sum of debits equals sum of credits exactly, within one currency, or it is refused.
//  3. JOURNALS ARE IMMUTABLE. Entries are append-only and frozen. A mistake is fixed by a REVERSAL entry, never by an edit.
//  4. HASH CHAIN. Each entry carries the SHA-256 of its content plus the previous entry's hash, per tenant. Any change,
//     deletion or re-ordering is detected by verifyChain().
//  5. BALANCES ARE DERIVED from the journal on demand. There is no mutable "balance" field that could drift.
//  6. IDEMPOTENCY. A key can post once. Retrying a request returns the same entry; reusing a key for a different
//     journal is refused.
//  7. PERIODS CLOSE. Nothing can be posted on or before a closed date.
//  8. MAKER-CHECKER. Large or manual journals are held for a second person (unless single-operator mode is
//     explicitly enabled, in which case self-approval is recorded as such).
//  9. TENANTS ARE ISOLATED. Each tenant (institution / corridor) has its own chart of accounts, journal and chain.
// 10. RETENTION. Nothing here deletes records. Each entry carries a retain-until date (7 years by default).
// ============================================================================
const crypto = require('crypto');

class LedgerError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const GENESIS = '0'.repeat(64);
const TYPES = { ASSET: 'D', EXPENSE: 'D', LIABILITY: 'C', EQUITY: 'C', INCOME: 'C' };
const EXP = { KES: 2, USD: 2, GBP: 2, EUR: 2, TZS: 2, UGX: 0, RWF: 0, JPY: 0, ZAR: 2, CNY: 2, AED: 2, INR: 2 };
const expOf = (c) => (has(EXP, c) ? EXP[c] : 2);
const MAX_MINOR = 1e13;                       // 100 billion in major units: far below 2^53, so all sums stay exact

// ---------------------------------------------------------------------------
// exact money handling
// ---------------------------------------------------------------------------
function parseMoney(input, currency) {
    const exp = expOf(currency);
    let t = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : typeof input === 'string' ? input.trim() : '';
    if (!t || /e/i.test(t) || !/^\d{1,13}(\.\d+)?$/.test(t)) throw new LedgerError('BAD_AMOUNT', 'Amounts must be plain positive numbers such as 1500.50.');
    const [i, f = ''] = t.split('.');
    if (f.length > exp) throw new LedgerError('BAD_AMOUNT', `${currency} amounts allow at most ${exp} decimal place${exp === 1 ? '' : 's'}.`);
    const minor = Number(i) * Math.pow(10, exp) + (f ? Number(f.padEnd(exp, '0')) : 0);
    if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_MINOR) throw new LedgerError('BAD_AMOUNT', 'Amount is zero, negative or above the allowed limit.');
    return minor;
}
function formatMoney(minor, currency) {
    const exp = expOf(currency), neg = minor < 0, a = Math.abs(minor), p = Math.pow(10, exp);
    const whole = Math.floor(a / p), frac = exp ? String(a % p).padStart(exp, '0') : '';
    return (neg ? '-' : '') + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (exp ? '.' + frac : '');
}
const dec = (minor, currency) => { const exp = expOf(currency), p = Math.pow(10, exp), a = Math.abs(minor); return (minor < 0 ? '-' : '') + Math.floor(a / p) + (exp ? '.' + String(a % p).padStart(exp, '0') : ''); };

// Kenya time (EAT, UTC+3, no daylight saving) is the accounting calendar
const EAT_MS = 3 * 3600 * 1000;
const dateOf = (ms) => new Date(ms + EAT_MS).toISOString().slice(0, 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const clean = (v, max) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
const safeKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+\-]{1,80}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);

// ---------------------------------------------------------------------------
// default charts of accounts
// ---------------------------------------------------------------------------
const MARKETPLACE_COA = [
    ['1000', 'Bank - Settlement Account', 'ASSET'], ['1010', 'M-Pesa Clearing (collections and payouts)', 'ASSET'], ['1020', 'Cash on Hand', 'ASSET'], ['1100', 'Receivables', 'ASSET'],
    ['2000', 'Customer Funds Held (escrow)', 'LIABILITY'], ['2010', 'Merchant Payables', 'LIABILITY'], ['2020', 'Rider Payables', 'LIABILITY'], ['2030', 'VAT Payable (KRA)', 'LIABILITY'],
    ['2040', 'Customer Deposits', 'LIABILITY'], ['2050', 'Refunds Payable', 'LIABILITY'], ['2090', 'Suspense (to be cleared)', 'LIABILITY'],
    ['3000', "Owner's Equity", 'EQUITY'], ['3100', 'Retained Earnings', 'EQUITY'],
    ['4000', 'Platform Fee Income (net of VAT)', 'INCOME'], ['4100', 'Other Income', 'INCOME'],
    ['5000', 'Payment Processing Fees', 'EXPENSE'], ['5010', 'Bank Charges', 'EXPENSE'], ['5100', 'Operating Expenses', 'EXPENSE']
];
const FOREX_COA = [
    ['1000', 'Bank - Settlement Account', 'ASSET'], ['1010', 'M-Pesa / Mobile Money Clearing', 'ASSET'], ['1020', 'Cash on Hand - Local (KES)', 'ASSET'], ['1030', 'Foreign Currency on Hand', 'ASSET'], ['1100', 'Receivables', 'ASSET'],
    ['2000', 'Customer Payables', 'LIABILITY'], ['2030', 'VAT Payable (KRA)', 'LIABILITY'], ['2090', 'Suspense (to be cleared)', 'LIABILITY'],
    ['3000', "Owner's Equity", 'EQUITY'], ['3100', 'Retained Earnings', 'EQUITY'],
    ['4000', 'FX Trading Income (spread)', 'INCOME'], ['4100', 'Commission Income', 'INCOME'], ['4200', 'Other Income', 'INCOME'],
    ['5000', 'Bank Charges', 'EXPENSE'], ['5100', 'Operating Expenses', 'EXPENSE']
];
const MICROFINANCE_COA = [
    ['1000', 'Bank - Settlement Account', 'ASSET'], ['1010', 'M-Pesa / Mobile Money Clearing', 'ASSET'], ['1020', 'Cash on Hand (vault)', 'ASSET'], ['1200', 'Loans to Members (principal)', 'ASSET'], ['1210', 'Interest Receivable', 'ASSET'], ['1290', 'Loan Loss Provision (contra-asset)', 'ASSET'],
    ['2000', 'Member Deposits / Savings', 'LIABILITY'], ['2010', 'Member Share Capital', 'LIABILITY'], ['2030', 'VAT / Withholding Payable', 'LIABILITY'], ['2090', 'Suspense (to be cleared)', 'LIABILITY'],
    ['3000', "Owner's / Institutional Equity", 'EQUITY'], ['3100', 'Retained Earnings', 'EQUITY'],
    ['4000', 'Interest Income on Loans', 'INCOME'], ['4100', 'Fees & Commission Income', 'INCOME'], ['4200', 'Other Income', 'INCOME'],
    ['5000', 'Interest Expense on Deposits', 'EXPENSE'], ['5100', 'Loan Loss Expense', 'EXPENSE'], ['5200', 'Operating Expenses', 'EXPENSE']
];
const GENERIC_COA = [
    ['1000', 'Cash at Bank', 'ASSET'], ['1020', 'Cash on Hand (vault)', 'ASSET'], ['1100', 'Customer Receivables', 'ASSET'],
    ['2000', 'Customer Deposits', 'LIABILITY'], ['2090', 'Suspense (to be cleared)', 'LIABILITY'],
    ['3000', "Owner's Equity", 'EQUITY'], ['3100', 'Retained Earnings', 'EQUITY'],
    ['4000', 'Fee Income', 'INCOME'], ['5000', 'Operating Expenses', 'EXPENSE']
];

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------
function createLedger(opts = {}) {
    const state = opts.state || {};
    for (const k of ['accounts', 'journals', 'idem', 'periods', 'pending', 'reversals', 'failures']) if (!state[k] || typeof state[k] !== 'object') state[k] = k === 'failures' ? [] : {};
    if (!Array.isArray(state.failures)) state.failures = [];
    const now = opts.now || (() => Date.now());
    const audit = opts.appendAudit || (() => {});
    const cfg = {
        singleOperator: !!opts.singleOperator, manualAlwaysApproved: !!opts.manualAlwaysApproved, retentionYears: opts.retentionYears || 7,
        thresholds: { KES: 1000000, USD: 10000, GBP: 8000, EUR: 9000, ...(opts.thresholds || {}) }, maxPostings: 50
    };
    const thresholdMinor = (cur) => (has(cfg.thresholds, cur) ? cfg.thresholds[cur] : 1000000) * Math.pow(10, expOf(cur));
    const T = (tenant) => { if (!safeKey(tenant)) throw new LedgerError('BAD_TENANT', 'Invalid tenant id.'); return tenant; };
    const accts = (t) => (state.accounts[t] || (state.accounts[t] = {}));
    const jr = (t) => (state.journals[t] || (state.journals[t] = []));
    const pend = (t) => (state.pending[t] || (state.pending[t] = []));
    const idem = (t) => (state.idem[t] || (state.idem[t] = {}));
    const per = (t) => (state.periods[t] || (state.periods[t] = { closedThrough: null, history: [] }));
    const rev = (t) => (state.reversals[t] || (state.reversals[t] = {}));

    function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
    const core = (e) => JSON.stringify([e.prevHash, e.seq, e.tenantId, e.currency, e.postingDate, e.valueDate, e.description, e.reference, e.source, e.postings.map(p => [p.line, p.account, p.side, p.amountMinor, p.memo]), e.idempotencyKey, e.createdAt, e.maker, e.checker, e.selfApproved, e.reversalOf]);

    // ----- accounts -----
    function addAccount(tenant, a, by) {
        T(tenant);
        const code = clean(a.code, 8), name = clean(a.name, 80), type = String(a.type || '').toUpperCase(), currency = String(a.currency || '').toUpperCase();
        if (!/^[0-9]{4,8}$/.test(code)) throw new LedgerError('BAD_ACCOUNT', 'Account code must be 4 to 8 digits.');
        if (!name) throw new LedgerError('BAD_ACCOUNT', 'Account name is required.');
        if (!has(TYPES, type)) throw new LedgerError('BAD_ACCOUNT', `Type must be one of ${Object.keys(TYPES).join(', ')}.`);
        if (!/^[A-Z]{3}$/.test(currency)) throw new LedgerError('BAD_ACCOUNT', 'Currency must be a 3-letter code such as KES.');
        if (has(accts(tenant), code)) throw new LedgerError('DUPLICATE_ACCOUNT', `Account ${code} already exists.`, 409);
        const rec = { code, name, type, normal: TYPES[type], currency, active: true, control: !!a.control || type === 'EQUITY', createdAt: now(), createdBy: clean(by, 80) || 'system' };
        accts(tenant)[code] = rec;
        audit('LEDGER_ACCOUNT_CREATED', { tenant, code, type, currency, by: rec.createdBy });
        return rec;
    }
    function ensureTenant(tenant, currency, profile) {
        T(tenant); const cur = String(currency || 'KES').toUpperCase();
        if (Object.keys(accts(tenant)).length) return false;
        const chart = profile === 'MARKETPLACE' ? MARKETPLACE_COA : profile === 'FOREX' ? FOREX_COA : profile === 'MICROFINANCE' ? MICROFINANCE_COA : GENERIC_COA;
        for (const [code, name, type] of chart) addAccount(tenant, { code, name, type, currency: cur }, 'system');
        return true;
    }
    function deactivateAccount(tenant, code, by) {
        T(tenant); const a = accts(tenant)[code];
        if (!a) throw new LedgerError('NO_ACCOUNT', 'Account not found.', 404);
        const b = balanceOf(tenant, code);
        if (b.debit !== b.credit) throw new LedgerError('NONZERO_BALANCE', 'An account with a balance cannot be closed.', 409);
        a.active = false; a.closedAt = now(); a.closedBy = clean(by, 80);
        audit('LEDGER_ACCOUNT_CLOSED', { tenant, code, by: a.closedBy });
        return a;
    }
    const listAccounts = (tenant) => Object.values(accts(T(tenant))).sort((x, y) => x.code.localeCompare(y.code));

    // ----- balances (always derived from the journal) -----
    function balanceOf(tenant, code, asOf) {
        let debit = 0, credit = 0;
        for (const e of jr(tenant)) { if (asOf && e.postingDate > asOf) continue; for (const p of e.postings) if (p.account === code) { if (p.side === 'D') debit += p.amountMinor; else credit += p.amountMinor; } }
        return { debit, credit };
    }
    function trialBalance(tenant, asOf) {
        T(tenant); if (asOf && !isDate(asOf)) throw new LedgerError('BAD_DATE', 'asOf must be YYYY-MM-DD.');
        const sums = {}; for (const e of jr(tenant)) { if (asOf && e.postingDate > asOf) continue; for (const p of e.postings) { const s = sums[p.account] || (sums[p.account] = { d: 0, c: 0 }); if (p.side === 'D') s.d += p.amountMinor; else s.c += p.amountMinor; } }
        const rows = [], totals = {};
        for (const a of listAccounts(tenant)) {
            const s = sums[a.code] || { d: 0, c: 0 }; if (!s.d && !s.c && !a.active) continue;
            const net = a.normal === 'D' ? s.d - s.c : s.c - s.d;
            rows.push({ code: a.code, name: a.name, type: a.type, currency: a.currency, normal: a.normal, active: a.active, debitMinor: s.d, creditMinor: s.c, balanceMinor: net, balance: dec(net, a.currency), debit: dec(s.d, a.currency), credit: dec(s.c, a.currency) });
            const t = totals[a.currency] || (totals[a.currency] = { debitMinor: 0, creditMinor: 0, assets: 0, liabilities: 0, equity: 0, income: 0, expenses: 0 });
            t.debitMinor += s.d; t.creditMinor += s.c;
            if (a.type === 'ASSET') t.assets += net; else if (a.type === 'LIABILITY') t.liabilities += net; else if (a.type === 'EQUITY') t.equity += net; else if (a.type === 'INCOME') t.income += net; else t.expenses += net;
        }
        for (const cur of Object.keys(totals)) { const t = totals[cur]; t.balanced = t.debitMinor === t.creditMinor; t.equationHolds = t.assets === t.liabilities + t.equity + t.income - t.expenses + 0; t.debit = dec(t.debitMinor, cur); t.credit = dec(t.creditMinor, cur); }
        return { tenant, asOf: asOf || null, generatedAt: now(), rows, totals, balanced: Object.values(totals).every(t => t.balanced), equationHolds: Object.values(totals).every(t => t.equationHolds) };
    }

    // ----- posting -----
    function normalise(tenant, d) {
        const cur = String(d.currency || '').toUpperCase();
        if (!/^[A-Z]{3}$/.test(cur)) throw new LedgerError('BAD_CURRENCY', 'Currency is required (for example KES).');
        if (!Array.isArray(d.postings) || d.postings.length < 2) throw new LedgerError('TOO_FEW_POSTINGS', 'A journal needs at least two postings (a debit and a credit).');
        if (d.postings.length > cfg.maxPostings) throw new LedgerError('TOO_MANY_POSTINGS', `A journal can have at most ${cfg.maxPostings} postings.`);
        const A = accts(tenant); let dr = 0, cr = 0;
        const postings = d.postings.map((p, i) => {
            const side = p && (p.side === 'D' || p.side === 'DEBIT' || p.type === 'DEBIT') ? 'D' : p && (p.side === 'C' || p.side === 'CREDIT' || p.type === 'CREDIT') ? 'C' : null;
            if (!side) throw new LedgerError('BAD_SIDE', `Posting ${i + 1}: side must be DEBIT or CREDIT.`);
            const code = clean(p.account, 8), acc = A[code];
            if (!acc) throw new LedgerError('NO_ACCOUNT', `Posting ${i + 1}: account ${code || '(none)'} does not exist for this tenant.`, 404);
            if (!acc.active) throw new LedgerError('ACCOUNT_CLOSED', `Posting ${i + 1}: account ${code} is closed.`, 409);
            if (acc.currency !== cur) throw new LedgerError('CURRENCY_MISMATCH', `Posting ${i + 1}: account ${code} is in ${acc.currency}, the journal is in ${cur}.`);
            const amountMinor = p.amountMinor !== undefined ? (Number.isSafeInteger(p.amountMinor) && p.amountMinor > 0 && p.amountMinor <= MAX_MINOR ? p.amountMinor : (() => { throw new LedgerError('BAD_AMOUNT', `Posting ${i + 1}: bad amount.`); })()) : parseMoney(p.amount, cur);
            if (side === 'D') dr += amountMinor; else cr += amountMinor;
            return { line: i + 1, account: code, side, amountMinor, memo: clean(p.memo, 80) };
        });
        if (dr !== cr) throw new LedgerError('UNBALANCED', `Journal does not balance: debits ${dec(dr, cur)} vs credits ${dec(cr, cur)}.`);
        if (!Number.isSafeInteger(dr) || dr > MAX_MINOR) throw new LedgerError('BAD_AMOUNT', 'Journal total is above the allowed limit.');
        return { currency: cur, postings, totalMinor: dr };
    }
    const fingerprint = (n, d) => sha(JSON.stringify([n.currency, n.postings.map(p => [p.account, p.side, p.amountMinor]), clean(d.description, 200), d.reference || '', d.postingDate || '']));

    function commit(tenant, n, d, ctx) {
        const t = now(), today = dateOf(t), postingDate = d.postingDate || today;
        if (!isDate(postingDate)) throw new LedgerError('BAD_DATE', 'postingDate must be YYYY-MM-DD.');
        if (postingDate > today) throw new LedgerError('FUTURE_DATE', 'Journals cannot be dated in the future.');
        const cl = per(tenant).closedThrough;
        if (cl && postingDate <= cl) throw new LedgerError('PERIOD_CLOSED', `The period through ${cl} is closed. Post the correction in the current period.`, 409);
        const list = jr(tenant), last = list[list.length - 1];
        const e = {
            entryId: `JE-${tenant}-${String(list.length + 1).padStart(8, '0')}`, seq: list.length + 1, tenantId: tenant, currency: n.currency, postingDate, valueDate: isDate(d.valueDate) ? d.valueDate : postingDate,
            createdAt: t, description: clean(d.description, 200) || 'Journal entry', reference: clean(d.reference, 80), source: clean(d.source || 'MANUAL', 40),
            postings: n.postings, totalMinor: n.totalMinor, idempotencyKey: d.idempotencyKey || null, maker: clean(ctx.by, 80) || 'system', checker: ctx.checker ? clean(ctx.checker, 80) : null,
            selfApproved: !!ctx.selfApproved, reversalOf: d.reversalOf || null, retainUntil: dateOf(t + cfg.retentionYears * 366 * 86400000), prevHash: last ? last.hash : GENESIS
        };
        e.hash = sha(core(e));
        list.push(deepFreeze(e));
        if (e.idempotencyKey) idem(tenant)[e.idempotencyKey] = { entryId: e.entryId, fp: ctx.fp };
        if (e.reversalOf) rev(tenant)[e.reversalOf] = e.entryId;
        audit('LEDGER_JOURNAL_POSTED', { tenant, entryId: e.entryId, seq: e.seq, currency: e.currency, total: dec(e.totalMinor, e.currency), source: e.source, hash: e.hash, maker: e.maker, checker: e.checker });
        return e;
    }

    // ctx: { by, role, system (automated, exempt from approval), exempt }
    function post(tenant, d, ctx = {}) {
        T(tenant); if (!d || typeof d !== 'object') throw new LedgerError('BAD_REQUEST', 'Journal is required.');
        if (d.idempotencyKey !== undefined && d.idempotencyKey !== null && !safeKey(d.idempotencyKey)) throw new LedgerError('BAD_KEY', 'idempotencyKey may use letters, digits and . _ : + - (max 80).');
        const n = normalise(tenant, d), fp = fingerprint(n, d);
        if (d.idempotencyKey) { const prev = idem(tenant)[d.idempotencyKey]; if (prev) { if (prev.fp !== fp) throw new LedgerError('IDEMPOTENCY_CONFLICT', 'That idempotency key was already used for a different journal.', 409); return { status: 'POSTED', duplicate: true, entry: jr(tenant).find(e => e.entryId === prev.entryId) }; } }
        const hasControl = n.postings.some(p => accts(tenant)[p.account].control);
        const needs = !ctx.system && !ctx.exempt && (cfg.manualAlwaysApproved || n.totalMinor >= thresholdMinor(n.currency) || hasControl);
        if (needs) {
            const dup = pend(tenant).find(p => p.status === 'PENDING' && p.fp === fp);
            if (dup) return { status: 'PENDING_APPROVAL', duplicate: true, pending: dup };
            const rec = { pendingId: `PJ-${tenant}-${String(pend(tenant).length + 1).padStart(6, '0')}`, fp, draft: { ...d, currency: n.currency, postings: n.postings.map(p => ({ account: p.account, side: p.side, amountMinor: p.amountMinor, memo: p.memo })) }, totalMinor: n.totalMinor, currency: n.currency, createdBy: clean(ctx.by, 80) || 'unknown', createdAt: now(), status: 'PENDING', reason: hasControl ? 'Touches a control account (equity)' : cfg.manualAlwaysApproved ? 'Manual journals need approval' : `At or above the ${cfg.thresholds[n.currency] || 1000000} ${n.currency} approval limit` };
            pend(tenant).push(rec);
            audit('LEDGER_JOURNAL_HELD', { tenant, pendingId: rec.pendingId, total: dec(n.totalMinor, n.currency), by: rec.createdBy });
            return { status: 'PENDING_APPROVAL', pending: rec };
        }
        return { status: 'POSTED', entry: commit(tenant, n, d, { ...ctx, fp }) };
    }
    function approve(tenant, pendingId, by) {
        T(tenant); const p = pend(tenant).find(x => x.pendingId === pendingId);
        if (!p) throw new LedgerError('NOT_FOUND', 'Pending journal not found.', 404);
        if (p.status !== 'PENDING') throw new LedgerError('ALREADY_DECIDED', `This journal was already ${p.status.toLowerCase()}.`, 409);
        const approver = clean(by, 80), self = approver === p.createdBy;
        if (self && !cfg.singleOperator) throw new LedgerError('SELF_APPROVAL', 'The person who prepared a journal cannot approve it. Ask a second administrator.', 403);
        const n = normalise(tenant, p.draft);
        const e = commit(tenant, n, p.draft, { by: p.createdBy, checker: approver, selfApproved: self, fp: p.fp });
        p.status = 'APPROVED'; p.decidedBy = approver; p.decidedAt = now(); p.entryId = e.entryId;
        audit('LEDGER_JOURNAL_APPROVED', { tenant, pendingId, entryId: e.entryId, by: approver, selfApproved: self });
        return e;
    }
    function reject(tenant, pendingId, by, reason) {
        T(tenant); const p = pend(tenant).find(x => x.pendingId === pendingId);
        if (!p) throw new LedgerError('NOT_FOUND', 'Pending journal not found.', 404);
        if (p.status !== 'PENDING') throw new LedgerError('ALREADY_DECIDED', `This journal was already ${p.status.toLowerCase()}.`, 409);
        p.status = 'REJECTED'; p.decidedBy = clean(by, 80); p.decidedAt = now(); p.rejectReason = clean(reason, 200);
        audit('LEDGER_JOURNAL_REJECTED', { tenant, pendingId, by: p.decidedBy, reason: p.rejectReason });
        return p;
    }
    function reverse(tenant, entryId, by, reason) {
        T(tenant); const o = jr(tenant).find(e => e.entryId === entryId);
        if (!o) throw new LedgerError('NOT_FOUND', 'Journal not found.', 404);
        if (rev(tenant)[entryId]) throw new LedgerError('ALREADY_REVERSED', `Already reversed by ${rev(tenant)[entryId]}.`, 409);
        if (o.reversalOf) throw new LedgerError('IS_REVERSAL', 'A reversal entry cannot itself be reversed. Post a new journal instead.', 409);
        const d = { currency: o.currency, description: `REVERSAL of ${o.entryId}: ${clean(reason, 120) || o.description}`, reference: o.entryId, source: 'REVERSAL', reversalOf: o.entryId, idempotencyKey: `REV:${o.entryId}`, postings: o.postings.map(p => ({ account: p.account, side: p.side === 'D' ? 'C' : 'D', amountMinor: p.amountMinor, memo: `reversal line ${p.line}` })) };
        return post(tenant, d, { by, system: true }).entry;
    }

    // ----- periods -----
    function closePeriod(tenant, date, by) {
        T(tenant); if (!isDate(date)) throw new LedgerError('BAD_DATE', 'date must be YYYY-MM-DD.');
        if (date >= dateOf(now())) throw new LedgerError('BAD_DATE', 'Only past days can be closed.');
        const p = per(tenant); if (p.closedThrough && date <= p.closedThrough) throw new LedgerError('ALREADY_CLOSED', `The period is already closed through ${p.closedThrough}.`, 409);
        if (pend(tenant).some(x => x.status === 'PENDING' && (x.draft.postingDate || dateOf(x.createdAt)) <= date)) throw new LedgerError('PENDING_EXIST', 'Approve or reject pending journals dated in this period first.', 409);
        const tb = trialBalance(tenant, date); if (!tb.balanced) throw new LedgerError('UNBALANCED_TB', 'The trial balance does not balance, so the period cannot be closed.', 409);
        const ch = verifyChain(tenant); if (!ch.valid) throw new LedgerError('CHAIN_BROKEN', 'The ledger hash chain is broken, so the period cannot be closed.', 409);
        const seal = sha(JSON.stringify([tenant, date, tb.rows.map(r => [r.code, r.debitMinor, r.creditMinor]), ch.lastHash]));
        const rec = { closedThrough: date, closedAt: now(), closedBy: clean(by, 80), trialBalanceSeal: seal, entries: ch.entries };
        p.history.push(rec); p.closedThrough = date;
        audit('LEDGER_PERIOD_CLOSED', { tenant, date, seal, by: rec.closedBy });
        return rec;
    }

    // ----- integrity -----
    function verifyChain(tenant) {
        T(tenant); const list = jr(tenant); let prev = GENESIS;
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (e.seq !== i + 1) return { valid: false, entries: list.length, brokenAt: e.entryId, reason: 'Sequence gap or re-ordering', lastHash: prev };
            if (e.prevHash !== prev) return { valid: false, entries: list.length, brokenAt: e.entryId, reason: 'Link to previous entry does not match', lastHash: prev };
            if (sha(core(e)) !== e.hash) return { valid: false, entries: list.length, brokenAt: e.entryId, reason: 'Entry content was changed', lastHash: prev };
            let dr = 0, cr = 0; for (const p of e.postings) { if (p.side === 'D') dr += p.amountMinor; else cr += p.amountMinor; }
            if (dr !== cr) return { valid: false, entries: list.length, brokenAt: e.entryId, reason: 'Debits do not equal credits', lastHash: prev };
            prev = e.hash;
        }
        return { valid: true, entries: list.length, lastHash: prev };
    }
    const tenants = () => Object.keys(state.journals).concat(Object.keys(state.accounts)).filter((v, i, a) => a.indexOf(v) === i);
    function verifyAll() { const out = {}; let valid = true; for (const t of tenants()) { out[t] = verifyChain(t); if (!out[t].valid) valid = false; } return { valid, tenants: out }; }

    // ----- reads -----
    function generalLedger(tenant, { account, from, to } = {}) {
        T(tenant); const a = accts(tenant)[account]; if (!a) throw new LedgerError('NO_ACCOUNT', 'Account not found.', 404);
        for (const d of [from, to]) if (d && !isDate(d)) throw new LedgerError('BAD_DATE', 'Dates must be YYYY-MM-DD.');
        let run = 0; const lines = [];
        for (const e of jr(tenant)) for (const p of e.postings) if (p.account === account) {
            const signed = (p.side === a.normal ? 1 : -1) * p.amountMinor; run += signed;
            if ((from && e.postingDate < from) || (to && e.postingDate > to)) continue;
            lines.push({ entryId: e.entryId, seq: e.seq, date: e.postingDate, description: e.description, reference: e.reference, side: p.side, amountMinor: p.amountMinor, amount: dec(p.amountMinor, a.currency), runningMinor: run, running: dec(run, a.currency) });
        }
        return { account: a, lines, closingMinor: run, closing: dec(run, a.currency) };
    }
    function register(tenant, { from, to, limit = 100, offset = 0, source } = {}) {
        T(tenant); let list = jr(tenant); if (from) list = list.filter(e => e.postingDate >= from); if (to) list = list.filter(e => e.postingDate <= to); if (source) list = list.filter(e => e.source === source);
        const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000), off = Math.max(parseInt(offset, 10) || 0, 0);
        return { total: list.length, entries: list.slice().reverse().slice(off, off + lim).map(e => ({ ...e, total: dec(e.totalMinor, e.currency), reversedBy: rev(tenant)[e.entryId] || null })) };
    }
    const getEntry = (tenant, id) => { const e = jr(T(tenant)).find(x => x.entryId === id); return e ? { ...e, reversedBy: rev(tenant)[id] || null } : null; };
    const pendingList = (tenant, status) => pend(T(tenant)).filter(p => !status || p.status === status).slice().reverse();
    function statements(tenant, asOf) {
        const tb = trialBalance(tenant, asOf), out = {};
        for (const cur of Object.keys(tb.totals)) {
            const t = tb.totals[cur]; out[cur] = { assets: dec(t.assets, cur), liabilities: dec(t.liabilities, cur), equity: dec(t.equity, cur), netIncome: dec(t.income - t.expenses, cur), income: dec(t.income, cur), expenses: dec(t.expenses, cur), equityPlusLiabilities: dec(t.liabilities + t.equity + t.income - t.expenses, cur), balanced: t.assets === t.liabilities + t.equity + t.income - t.expenses };
        }
        return { tenant, asOf: asOf || null, byCurrency: out };
    }
    function summary(tenant) {
        T(tenant); const list = jr(tenant), c = per(tenant);
        return { tenant, accounts: Object.keys(accts(tenant)).length, journals: list.length, pending: pend(tenant).filter(p => p.status === 'PENDING').length, closedThrough: c.closedThrough, lastHash: list.length ? list[list.length - 1].hash : GENESIS, chain: verifyChain(tenant).valid };
    }
    function recordFailure(kind, ref, message) { state.failures.push({ at: now(), kind, ref, message: clean(message, 200) }); if (state.failures.length > 500) state.failures.shift(); }

    // ----- CSV exports (RFC 4180; text beginning with = + - @ is neutralised so spreadsheets cannot run it) -----
    const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const toCsv = (rows) => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const trialBalanceCsv = (tenant, asOf) => { const tb = trialBalance(tenant, asOf); return toCsv([['Code', 'Account', 'Type', 'Currency', 'Debit', 'Credit', 'Balance'], ...tb.rows.map(r => [r.code, r.name, r.type, r.currency, r.debit, r.credit, r.balance]), ...Object.entries(tb.totals).map(([c, t]) => ['', 'TOTAL', '', c, t.debit, t.credit, t.balanced ? 'BALANCED' : 'OUT OF BALANCE'])]); };
    const journalCsv = (tenant, q) => toCsv([['Entry', 'Seq', 'Posting date', 'Currency', 'Line', 'Account', 'Side', 'Amount', 'Description', 'Reference', 'Source', 'Maker', 'Checker', 'Hash'], ...register(tenant, { ...q, limit: 1000 }).entries.flatMap(e => e.postings.map(p => [e.entryId, e.seq, e.postingDate, e.currency, p.line, p.account, p.side === 'D' ? 'DEBIT' : 'CREDIT', dec(p.amountMinor, e.currency), e.description, e.reference, e.source, e.maker, e.checker || '', e.hash]))]);

    return {
        state, cfg, LedgerError, parseMoney, formatMoney, dec, dateOf, ensureTenant, addAccount, deactivateAccount, listAccounts, balanceOf, trialBalance, post, approve, reject, reverse, closePeriod,
        verifyChain, verifyAll, generalLedger, register, getEntry, pendingList, statements, summary, recordFailure, tenants, trialBalanceCsv, journalCsv, toCsv, thresholdMinor,
        freezeLoaded: () => { for (const t of Object.keys(state.journals)) for (const e of state.journals[t]) deepFreeze(e); }
    };
}

return { createLedger, LedgerError, parseMoney, formatMoney, expOf, GENESIS, MARKETPLACE_COA, GENERIC_COA };
})();

// ############################################################################
// PART 2 — COMPLIANCE ENGINE (no HTTP in this part)
// ############################################################################
const COMPLIANCE = (function () {
// ============================================================================
// routes/compliance.js — STAGE 192 COMPLIANCE ENGINE (AML/CFT controls; no HTTP here)
//
// What is REAL here: customer due diligence cases with a second-person review, rule-based risk scoring, cash-transaction
// reports (CTR) with the FRC filing deadline, transaction-monitoring rules (structuring, velocity, missing due diligence,
// high-risk customer), suspicious-transaction cases with the two-day deadline, sanctions screening against a list you load,
// and an exportable record of every decision. Nothing here is ever deleted (7-year retention under POCAMLA Reg. 37).
//
// What is NOT here, on purpose, and is never pretended:
//  - Verification against the national population register (IPRS) needs a government access agreement. Until an adapter
//    is connected, every case is marked "NOT VERIFIED WITH IPRS" and the officer records the document check by hand.
//  - Filing with the Financial Reporting Centre happens in the goAML portal by your compliance officer. This engine
//    prepares the data, tracks the deadline and stores the goAML reference the officer enters.
//  - Sanctions lists (UN, OFAC, Kenya TFS) must be loaded and kept current by you. With no list loaded, screening says so.
// Rules and thresholds below are configurable because laws and rates change. Confirm them with your MLRO / counsel.
// ============================================================================
const crypto = require('crypto');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const clean = (v, max) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
class ComplianceError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
const EAT_MS = 3 * 3600 * 1000, DAY = 86400000;
const EXP = { KES: 2, USD: 2, GBP: 2, EUR: 2, UGX: 0, TZS: 2, JPY: 0 };
const expOf = (c) => (has(EXP, c) ? EXP[c] : 2);
const dec = (minor, cur) => { const e = expOf(cur), p = Math.pow(10, e), a = Math.abs(minor); return (minor < 0 ? '-' : '') + Math.floor(a / p) + (e ? '.' + String(a % p).padStart(e, '0') : ''); };
// FATF "call for action" jurisdictions. Verify against the current FATF publication before relying on it.
const DEFAULT_HIGH_RISK = ['IR', 'KP', 'MM'];

// end of the week in which a transaction happened: Sunday 23:59:59.999 Kenya time (FRC: CTR due at the end of that week)
function endOfWeekEat(ms) {
    const d = new Date(ms + EAT_MS), dow = (d.getUTCDay() + 6) % 7;                 // Monday = 0
    const startOfDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return startOfDay + (6 - dow) * DAY + DAY - 1 - EAT_MS;
}
const normName = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function createCompliance(opts = {}) {
    const state = opts.state || {};
    for (const k of ['kyc', 'alerts', 'ctr', 'str', 'txns', 'log']) if (!Array.isArray(state[k])) state[k] = [];
    if (!state.sanctions || typeof state.sanctions !== 'object') state.sanctions = { entries: [], source: null, listDate: null, loadedAt: null, loadedBy: null };
    const now = opts.now || (() => Date.now());
    const audit = opts.appendAudit || (() => {});
    const cfg = {
        singleOperator: !!opts.singleOperator, retentionYears: 7, strDeadlineDays: 2, highRiskCountries: opts.highRiskCountries || DEFAULT_HIGH_RISK,
        ctrUsd: opts.ctrUsd || 15000, fxPerUsd: { KES: 129, GBP: 0.78, EUR: 0.92, USD: 1, ...(opts.fxPerUsd || {}) }, ctrOverrides: opts.ctrOverrides || {},
        structuringWindowMs: DAY, structuringMin: 3, velocityWindowMs: 3600000, velocityMax: 10, noCddFraction: 0.1
    };
    // threshold in minor units. Rates are configuration (they move); the threshold is a regulatory reference, not a ledger value.
    const ctrThresholdMinor = (cur) => { const o = cfg.ctrOverrides[cur]; if (o) return Math.round(o * Math.pow(10, expOf(cur))); const fx = cfg.fxPerUsd[cur]; if (!fx) return null; return Math.round(cfg.ctrUsd * fx * Math.pow(10, expOf(cur))); };
    const id = (p, list) => `${p}-${String(list.length + 1).padStart(6, '0')}`;
    const retain = () => new Date(now() + cfg.retentionYears * 366 * DAY).toISOString().slice(0, 10);
    const note = (kind, ref, by, detail) => { const r = { at: now(), kind, ref, by: clean(by, 80), detail: clean(detail, 300) }; state.log.push(r); audit('COMPLIANCE_' + kind, { ref, by: r.by }); return r; };

    // ----- sanctions screening -----
    function loadSanctions(entries, meta, by) {
        if (!Array.isArray(entries) || entries.length > 200000) throw new ComplianceError('BAD_LIST', 'Provide a list of entries (max 200,000).');
        const out = entries.map(e => ({ name: clean(e && e.name, 120), aliases: (Array.isArray(e && e.aliases) ? e.aliases : []).slice(0, 20).map(a => clean(a, 120)), ref: clean(e && e.ref, 40) })).filter(e => e.name);
        state.sanctions = { entries: out.map(e => ({ ...e, keys: [e.name, ...e.aliases].map(normName).filter(Boolean) })), source: clean(meta && meta.source, 80) || 'unspecified', listDate: clean(meta && meta.listDate, 20) || null, loadedAt: now(), loadedBy: clean(by, 80) };
        note('SANCTIONS_LIST_LOADED', state.sanctions.source, by, `${out.length} entries, list date ${state.sanctions.listDate || 'unknown'}`);
        return { entries: out.length, source: state.sanctions.source, listDate: state.sanctions.listDate };
    }
    function screenName(name) {
        const n = normName(name), tokens = new Set(n.split(' ').filter(Boolean)), L = state.sanctions;
        if (!L.entries.length) return { listLoaded: false, matched: false, matches: [], note: 'No sanctions list is loaded, so this screening is NOT effective. Load the UN / OFAC / Kenya TFS lists.' };
        const matches = [];
        for (const e of L.entries) for (const k of (e.keys || [])) {
            const kt = k.split(' ').filter(Boolean);
            const exact = k === n, sameTokens = kt.length > 1 && kt.length === tokens.size && kt.every(t => tokens.has(t)), contained = kt.length > 1 && kt.every(t => tokens.has(t));
            if (exact || sameTokens || contained) { matches.push({ listed: e.name, ref: e.ref, reason: exact ? 'exact' : sameTokens ? 'same words, different order' : 'all listed words present' }); break; }
        }
        return { listLoaded: true, matched: matches.length > 0, matches, listDate: L.listDate, source: L.source };
    }

    // ----- customer due diligence (KYC) -----
    function scoreRisk(k) {
        let score = 0; const f = [];
        if (cfg.highRiskCountries.includes(k.countryCode)) { score += 100; f.push('Customer or funds linked to a FATF high-risk jurisdiction'); }
        if (k.isPep) { score += 70; f.push('Politically exposed person'); }
        if (k.sanctions.matched) { score += 100; f.push('Possible sanctions-list match'); }
        const thr = ctrThresholdMinor(k.currency);
        if (thr && k.initialDepositMinor >= thr) { score += 40; f.push('Opening deposit at or above the cash-reporting threshold'); }
        else if (thr && k.initialDepositMinor >= thr / 4) { score += 15; f.push('Large opening deposit'); }
        if (k.initialDepositMinor > 0 && !k.sourceOfFunds) { score += 20; f.push('No source of funds recorded'); }
        if (!k.sanctions.listLoaded) f.push('Sanctions screening could not run (no list loaded)');
        return { score, level: score >= 70 ? 'HIGH' : score >= 35 ? 'MEDIUM' : 'LOW', factors: f };
    }
    function submitKyc(tenant, d, by) {
        const idType = String(d.idType || 'NATIONAL_ID').toUpperCase(), idNumber = clean(d.idNumber, 30).toUpperCase(), fullName = clean(d.fullName, 100), cc = String(d.countryCode == null ? '' : d.countryCode).trim().toUpperCase(), cur = String(d.currency || 'KES').toUpperCase();
        if (fullName.length < 3 || !/\s/.test(fullName)) throw new ComplianceError('BAD_KYC', 'Enter the full legal name (first and last name).');
        if (!['NATIONAL_ID', 'PASSPORT', 'ALIEN_ID'].includes(idType)) throw new ComplianceError('BAD_KYC', 'idType must be NATIONAL_ID, PASSPORT or ALIEN_ID.');
        if (idType === 'NATIONAL_ID' && cc === 'KE' && !/^\d{7,8}$/.test(idNumber)) throw new ComplianceError('BAD_KYC', 'A Kenyan national ID number has 7 or 8 digits.');
        if (idType !== 'NATIONAL_ID' && !/^[A-Z0-9]{6,15}$/.test(idNumber)) throw new ComplianceError('BAD_KYC', 'The document number must be 6 to 15 letters or digits.');
        if (!/^[A-Z]{2}$/.test(cc)) throw new ComplianceError('BAD_KYC', 'countryCode must be a 2-letter code such as KE.');
        const ph = d.phone ? normPhone(d.phone) : null; if (d.phone && !ph) throw new ComplianceError('BAD_KYC', 'Enter a valid phone number.');
        const dep = d.initialDepositMinor === undefined ? 0 : d.initialDepositMinor;
        if (!Number.isSafeInteger(dep) || dep < 0) throw new ComplianceError('BAD_KYC', 'Opening deposit must be a whole number of minor units.');
        const dup = state.kyc.find(k => k.tenantId === tenant && k.idType === idType && k.idNumber === idNumber && k.status !== 'REJECTED');
        if (dup) throw new ComplianceError('DUPLICATE_KYC', `This ${idType.replace('_', ' ').toLowerCase()} already has a case (${dup.kycId}, ${dup.status}).`, 409);
        const rec = { kycId: id('KYC', state.kyc), tenantId: tenant, idType, idNumber, fullName, phone: ph, countryCode: cc, isPep: !!d.isPep, sourceOfFunds: clean(d.sourceOfFunds, 160), currency: cur, initialDepositMinor: dep,
            registryCheck: { status: 'NOT_VERIFIED', method: 'MANUAL_DOCUMENT_CHECK', note: 'Not verified against IPRS (no registry adapter connected). The reviewing officer records the document check.' },
            sanctions: screenName(fullName), status: 'PENDING_REVIEW', submittedBy: clean(by, 80), submittedAt: now(), retainUntil: retain() };
        rec.risk = scoreRisk(rec);
        state.kyc.push(rec); note('KYC_SUBMITTED', rec.kycId, by, `risk ${rec.risk.level}`);
        return rec;
    }
    function reviewKyc(kycId, decision, by, text, role) {
        const k = state.kyc.find(x => x.kycId === kycId); if (!k) throw new ComplianceError('NOT_FOUND', 'KYC case not found.', 404);
        if (k.status !== 'PENDING_REVIEW') throw new ComplianceError('ALREADY_DECIDED', `This case is already ${k.status}.`, 409);
        const reviewer = clean(by, 80), n = clean(text, 400), self = reviewer === k.submittedBy;
        if (self && !cfg.singleOperator) throw new ComplianceError('SELF_REVIEW', 'The person who submitted a case cannot approve it. Ask a second officer.', 403);
        if (!['APPROVE', 'REJECT'].includes(decision)) throw new ComplianceError('BAD_DECISION', 'decision must be APPROVE or REJECT.');
        if (decision === 'REJECT') { if (n.length < 5) throw new ComplianceError('NOTE_REQUIRED', 'Give a reason for the rejection.'); k.status = 'REJECTED'; }
        else {
            if (k.risk.level === 'HIGH' && n.length < 15) throw new ComplianceError('EDD_REQUIRED', 'High-risk customers need an enhanced due diligence note (what was checked, source of wealth, approval rationale).');
            if (k.sanctions.matched && n.length < 15) throw new ComplianceError('SANCTIONS_NOTE_REQUIRED', 'Explain why the possible sanctions match is a false positive before approving.');
            if (k.risk.level === 'HIGH' && role !== 'SOVEREIGN_ADMIN') throw new ComplianceError('SENIOR_REQUIRED', 'High-risk customers need senior (administrator) approval.', 403);
            k.status = 'APPROVED'; k.accountId = `ACC-${sha(k.kycId + k.idNumber).slice(0, 8).toUpperCase()}`;
        }
        k.review = { by: reviewer, at: now(), decision, note: n, selfReviewed: self };
        note('KYC_' + (decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'), kycId, reviewer, n);
        return k;
    }
    const approvedKyc = (tenant, name, idNumber) => state.kyc.find(k => k.tenantId === tenant && k.status === 'APPROVED' && ((idNumber && k.idNumber === String(idNumber).toUpperCase()) || (name && normName(k.fullName) === normName(name))));

    // ----- transaction monitoring -----
    function openAlert(tenant, rule, severity, txn, detail) {
        if (state.alerts.some(a => a.tenantId === tenant && a.rule === rule && a.txnId === txn.txnId)) return null;
        const a = { alertId: id('ALERT', state.alerts), tenantId: tenant, rule, severity, txnId: txn.txnId, customerKey: txn.customerKey, customerName: txn.customerName, detail: clean(detail, 300), status: 'OPEN', createdAt: now(), retainUntil: retain() };
        state.alerts.push(a); note('ALERT_OPENED', a.alertId, 'system', `${rule}: ${a.detail}`); return a;
    }
    // Run BEFORE any money moves: large cash needs approved due diligence on file.
    function assertCdd(tenant, d) {
        const cur = String(d.currency || 'KES').toUpperCase(), amt = d.amountMinor, type = String(d.type || 'CASH_DEPOSIT').toUpperCase();
        const name = clean(d.customerName, 100) || 'Unknown', idNum = clean(d.idNumber, 30).toUpperCase(), thr = ctrThresholdMinor(cur), kyc = approvedKyc(tenant, name, idNum);
        if (type.startsWith('CASH') && thr && Number.isSafeInteger(amt) && amt >= thr && !kyc) throw new ComplianceError('CDD_REQUIRED', `A cash transaction of ${dec(amt, cur)} ${cur} is at or above the reporting threshold. Complete and approve customer due diligence first.`, 409);
        return kyc || null;
    }
    function recordTransaction(tenant, d, by) {
        const cur = String(d.currency || 'KES').toUpperCase(), amt = d.amountMinor;
        if (!Number.isSafeInteger(amt) || amt <= 0) throw new ComplianceError('BAD_AMOUNT', 'Amount must be a positive whole number of minor units.');
        const type = String(d.type || 'CASH_DEPOSIT').toUpperCase();
        if (!['CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'WIRE', 'FX'].includes(type)) throw new ComplianceError('BAD_TYPE', 'Unsupported transaction type.');
        const isCash = type.startsWith('CASH'), name = clean(d.customerName, 100) || 'Unknown', idNum = clean(d.idNumber, 30).toUpperCase();
        const key = idNum ? `ID:${idNum}` : `NAME:${normName(name)}`, t = now(), thr = ctrThresholdMinor(cur);
        const kyc = assertCdd(tenant, d);
        const txn = { txnId: id('TXN', state.txns), tenantId: tenant, type, currency: cur, amountMinor: amt, customerKey: key, customerName: name, kycId: kyc ? kyc.kycId : null, cashierId: clean(by, 80), at: t, ledgerEntryId: d.ledgerEntryId || null, retainUntil: retain() };
        state.txns.push(txn); note('TXN_RECORDED', txn.txnId, by, `${type} ${dec(amt, cur)} ${cur}`);
        const alerts = [], out = { txn, ctr: null, alerts };
        if (isCash && thr && amt >= thr) {
            const ctr = { ctrId: id('CTR', state.ctr), tenantId: tenant, txnId: txn.txnId, customerName: name, customerKey: key, idNumber: idNum || (kyc && kyc.idNumber) || '', amountMinor: amt, currency: cur, transactionType: type, occurredAt: t, dueBy: endOfWeekEat(t), status: 'OPEN', filedAt: null, filedRef: null, retainUntil: retain() };
            state.ctr.push(ctr); out.ctr = ctr; note('CTR_CREATED', ctr.ctrId, 'system', `${dec(amt, cur)} ${cur}, due ${new Date(ctr.dueBy + EAT_MS).toISOString().slice(0, 10)}`);
        }
        const mine = state.txns.filter(x => x.tenantId === tenant && x.customerKey === key && x.currency === cur);
        if (isCash && thr) {
            const win = mine.filter(x => x.type.startsWith('CASH') && t - x.at <= cfg.structuringWindowMs), sum = win.reduce((s, x) => s + x.amountMinor, 0);
            if (win.length >= cfg.structuringMin && sum >= thr && win.every(x => x.amountMinor < thr)) { const a = openAlert(tenant, 'STRUCTURING', 'HIGH', txn, `${win.length} cash transactions in 24h, each under the threshold, totalling ${dec(sum, cur)} ${cur}`); if (a) alerts.push(a); }
            if (!kyc && amt >= thr * cfg.noCddFraction && amt < thr) { const a = openAlert(tenant, 'NO_CDD_ON_FILE', 'MEDIUM', txn, `Cash ${dec(amt, cur)} ${cur} with no approved due diligence on file`); if (a) alerts.push(a); }
        }
        if (mine.filter(x => t - x.at <= cfg.velocityWindowMs).length > cfg.velocityMax) { const a = openAlert(tenant, 'VELOCITY', 'MEDIUM', txn, `More than ${cfg.velocityMax} transactions in one hour`); if (a) alerts.push(a); }
        if (kyc && kyc.risk.level === 'HIGH' && thr && amt >= thr / 4) { const a = openAlert(tenant, 'HIGH_RISK_CUSTOMER', 'HIGH', txn, `Activity by a high-risk customer (${kyc.kycId})`); if (a) alerts.push(a); }
        const sc = screenName(name); if (sc.matched) { const a = openAlert(tenant, 'SANCTIONS_MATCH', 'CRITICAL', txn, `Possible sanctions match: ${sc.matches.map(m => m.listed).join(', ')}`); if (a) alerts.push(a); }
        return out;
    }

    // ----- alerts, STR and filing -----
    function updateAlert(alertId, status, by, text) {
        const a = state.alerts.find(x => x.alertId === alertId); if (!a) throw new ComplianceError('NOT_FOUND', 'Alert not found.', 404);
        if (!['REVIEWING', 'CLOSED_NO_ACTION'].includes(status)) throw new ComplianceError('BAD_STATUS', 'status must be REVIEWING or CLOSED_NO_ACTION.');
        if (['CLOSED_NO_ACTION', 'ESCALATED_STR'].includes(a.status)) throw new ComplianceError('ALREADY_DECIDED', `Alert already ${a.status}.`, 409);
        if (status === 'CLOSED_NO_ACTION' && clean(text, 300).length < 10) throw new ComplianceError('NOTE_REQUIRED', 'Explain why no action is needed (at least 10 characters).');
        a.status = status; a.decidedBy = clean(by, 80); a.decidedAt = now(); a.decisionNote = clean(text, 300); note('ALERT_' + status, alertId, by, text); return a;
    }
    function escalateToStr(alertId, by, narrative) {
        const a = state.alerts.find(x => x.alertId === alertId); if (!a) throw new ComplianceError('NOT_FOUND', 'Alert not found.', 404);
        if (['CLOSED_NO_ACTION', 'ESCALATED_STR'].includes(a.status)) throw new ComplianceError('ALREADY_DECIDED', `Alert already ${a.status}.`, 409);
        if (clean(narrative, 2000).length < 30) throw new ComplianceError('NOTE_REQUIRED', 'Write the grounds for suspicion (at least 30 characters).');
        const t = now(), s = { strId: id('STR', state.str), alertId, tenantId: a.tenantId, customerName: a.customerName, customerKey: a.customerKey, txnId: a.txnId, narrative: clean(narrative, 2000), suspicionAt: t, dueBy: t + cfg.strDeadlineDays * DAY, status: 'DRAFT', preparedBy: clean(by, 80), filedAt: null, filedRef: null, tippingOffWarning: 'Do not tell the customer. Disclosing an STR is an offence.', retainUntil: retain() };
        state.str.push(s); a.status = 'ESCALATED_STR'; a.strId = s.strId; a.decidedBy = s.preparedBy; a.decidedAt = t; note('STR_CREATED', s.strId, by, `from ${alertId}, due within ${cfg.strDeadlineDays} days`); return s;
    }
    function markFiled(kind, refId, goamlRef, by) {
        const list = kind === 'CTR' ? state.ctr : state.str, rec = list.find(x => (kind === 'CTR' ? x.ctrId : x.strId) === refId); if (!rec) throw new ComplianceError('NOT_FOUND', `${kind} not found.`, 404);
        if (rec.status === 'FILED') throw new ComplianceError('ALREADY_FILED', `${kind} already filed (${rec.filedRef}).`, 409);
        const ref = clean(goamlRef, 60); if (ref.length < 4) throw new ComplianceError('REF_REQUIRED', 'Enter the goAML reference number the FRC portal gave you.');
        rec.status = 'FILED'; rec.filedAt = now(); rec.filedRef = ref; rec.filedBy = clean(by, 80); rec.filedLate = rec.filedAt > rec.dueBy; note(kind + '_FILED', refId, by, `${ref}${rec.filedLate ? ' (LATE)' : ''}`); return rec;
    }
    const overdue = () => { const t = now(); return { ctr: state.ctr.filter(c => c.status !== 'FILED' && c.dueBy < t), str: state.str.filter(s => s.status !== 'FILED' && s.dueBy < t) }; };
    function summary(tenant) {
        const f = (l) => l.filter(x => !tenant || x.tenantId === tenant), od = overdue(), t = now();
        return { kycTotal: f(state.kyc).length, kycPending: f(state.kyc).filter(k => k.status === 'PENDING_REVIEW').length, kycApproved: f(state.kyc).filter(k => k.status === 'APPROVED').length, kycHighRisk: f(state.kyc).filter(k => k.risk.level === 'HIGH').length,
            transactions: f(state.txns).length, alertsOpen: f(state.alerts).filter(a => ['OPEN', 'REVIEWING'].includes(a.status)).length, alertsTotal: f(state.alerts).length, ctrOpen: f(state.ctr).filter(c => c.status !== 'FILED').length, ctrTotal: f(state.ctr).length,
            strOpen: f(state.str).filter(s => s.status !== 'FILED').length, strTotal: f(state.str).length, overdueCtr: f(od.ctr).length, overdueStr: f(od.str).length,
            sanctionsListLoaded: state.sanctions.entries.length > 0, sanctionsEntries: state.sanctions.entries.length, sanctionsListDate: state.sanctions.listDate, rulesActive: rules().filter(r => r.active).length, asOf: t };
    }
    function rules() {
        const thr = (c) => { const m = ctrThresholdMinor(c); return m == null ? 'not configured' : `${dec(m, c)} ${c}`; };
        return [
            { id: 'CTR', name: 'Cash transaction report', active: true, detail: `Cash at or above USD ${cfg.ctrUsd.toLocaleString('en-US')} equivalent (KES ${thr('KES')}). Due end of the week.` },
            { id: 'CDD_REQUIRED', name: 'Due diligence before large cash', active: true, detail: 'Cash at or above the CTR threshold is refused unless approved due diligence is on file.' },
            { id: 'NO_CDD_ON_FILE', name: 'No due diligence on file', active: true, detail: `Cash from ${cfg.noCddFraction * 100}% of the threshold up to the threshold, with no approved due diligence, raises an alert.` },
            { id: 'STRUCTURING', name: 'Structuring', active: true, detail: `${cfg.structuringMin}+ cash transactions in 24 hours, each below the threshold, adding up to the threshold or more.` },
            { id: 'VELOCITY', name: 'Velocity', active: true, detail: `More than ${cfg.velocityMax} transactions by one customer in one hour.` },
            { id: 'HIGH_RISK_CUSTOMER', name: 'High-risk customer activity', active: true, detail: 'Transactions of a quarter of the threshold or more by a high-risk customer.' },
            { id: 'SANCTIONS_MATCH', name: 'Sanctions screening', active: state.sanctions.entries.length > 0, detail: state.sanctions.entries.length ? `${state.sanctions.entries.length} listed names (${state.sanctions.source}, ${state.sanctions.listDate || 'date unknown'}).` : 'INACTIVE: no sanctions list loaded.' },
            { id: 'STR_DEADLINE', name: 'STR deadline tracking', active: true, detail: `STR due ${cfg.strDeadlineDays} days after suspicion arises.` }
        ];
    }
    const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const toCsv = (rows) => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const iso = (ms) => (ms ? new Date(ms + EAT_MS).toISOString().replace('Z', '+03:00') : '');
    const ctrCsv = (tenant) => toCsv([['CTR', 'Tenant', 'Customer', 'ID number', 'Type', 'Amount', 'Currency', 'Occurred (EAT)', 'Due by (EAT)', 'Status', 'goAML ref', 'Filed late'], ...state.ctr.filter(c => !tenant || c.tenantId === tenant).map(c => [c.ctrId, c.tenantId, c.customerName, c.idNumber, c.transactionType, dec(c.amountMinor, c.currency), c.currency, iso(c.occurredAt), iso(c.dueBy), c.status, c.filedRef || '', c.filedLate ? 'YES' : ''])]);
    const strCsv = (tenant) => toCsv([['STR', 'Tenant', 'Customer', 'Transaction', 'Suspicion arose (EAT)', 'Due by (EAT)', 'Status', 'goAML ref', 'Narrative'], ...state.str.filter(s => !tenant || s.tenantId === tenant).map(s => [s.strId, s.tenantId, s.customerName, s.txnId, iso(s.suspicionAt), iso(s.dueBy), s.status, s.filedRef || '', s.narrative])]);
    const kycCsv = (tenant) => toCsv([['KYC', 'Tenant', 'Name', 'ID type', 'ID number', 'Country', 'PEP', 'Risk', 'Status', 'Registry check', 'Submitted by', 'Reviewed by', 'Decision note', 'Retain until'], ...state.kyc.filter(k => !tenant || k.tenantId === tenant).map(k => [k.kycId, k.tenantId, k.fullName, k.idType, k.idNumber, k.countryCode, k.isPep ? 'YES' : 'no', k.risk.level, k.status, k.registryCheck.status, k.submittedBy, k.review ? k.review.by : '', k.review ? k.review.note : '', k.retainUntil])]);
    const alertsCsv = (tenant) => toCsv([['Alert', 'Tenant', 'Rule', 'Severity', 'Customer', 'Detail', 'Status', 'Opened (EAT)', 'Decision note'], ...state.alerts.filter(a => !tenant || a.tenantId === tenant).map(a => [a.alertId, a.tenantId, a.rule, a.severity, a.customerName, a.detail, a.status, iso(a.createdAt), a.decisionNote || ''])]);


    // =========================================================================================================
    // ALWAYS-ON CLIENT REGISTRY. Every customer, rider, merchant and cashier walk-in gets a profile automatically from
    // platform activity ("opened by the system"). Profiles are linked across accounts by phone number and ID number,
    // risk-rated continuously, corrected by staff with a full history, and tiered (KYC tier decides the limits).
    // Nothing is ever deleted: corrections add history, merges keep the old ids.
    // =========================================================================================================
    const TIER_NAMES = ['Tier 0: phone only', 'Tier 1: ID number captured', 'Tier 2: ID verified by officer', 'Tier 3: enhanced due diligence'];
    const ccfg = {
        // limits in KES major units: per order, and over the last 30 days (orders placed)
        tierLimits: { 0: { order: 50000, d30: 150000 }, 1: { order: 200000, d30: 1000000 }, 2: { order: 1000000, d30: 10000000 }, 3: { order: Infinity, d30: Infinity }, ...(opts.tierLimits || {}) },
        enforceLimits: opts.enforceLimits !== false, highOrderKes: 100000, volume30MediumKes: 1000000, volume30HighKes: 5000000, ordersVelocity30: 30, ordersVelocity24h: 15,
        cancelRatio: 0.5, cancelMinOrders: 6, refunds30: 5, payout30HighKes: 500000, maxPhones: 3, mediumScore: 35, highScore: 70, logCap: 500
    };
    const REG = () => {
        if (!state.registry || typeof state.registry !== 'object') state.registry = {};
        const r = state.registry; for (const k of ['clients', 'phoneIdx', 'idIdx', 'accIdx', 'refs']) if (!r[k] || typeof r[k] !== 'object') r[k] = {};
        if (!Number.isSafeInteger(r.seq)) r.seq = 0; if (!Array.isArray(r.events)) r.events = []; return r;
    };
    function normPhone(p) { const s = String(p == null ? '' : p).replace(/[\s()\-]/g, ''); if (/^0[17]\d{8}$/.test(s)) return '+254' + s.slice(1); if (/^254[17]\d{8}$/.test(s)) return '+' + s; if (/^\+\d{9,15}$/.test(s)) return s; return null; }
    function idCheck(type, number, cc) {
        const t = String(type || 'NATIONAL_ID').toUpperCase(), n = String(number == null ? '' : number).trim().toUpperCase().replace(/[\s-]+/g, '');
        if (!['NATIONAL_ID', 'PASSPORT', 'ALIEN_ID'].includes(t)) return { ok: false, error: 'Document type must be NATIONAL_ID, PASSPORT or ALIEN_ID.' };
        if (t === 'NATIONAL_ID' && (cc || 'KE') === 'KE' && !/^\d{7,8}$/.test(n)) return { ok: false, error: 'A Kenyan national ID number has 7 or 8 digits.' };
        if (t !== 'NATIONAL_ID' && !/^[A-Z0-9]{6,15}$/.test(n)) return { ok: false, error: 'The document number must be 6 to 15 letters or digits.' };
        return { ok: true, type: t, number: n };
    }
    const idKey = (type, n) => `${type}:${n}`;
    const evt = (kind, ref, by, detail) => { const R = REG(); R.events.push({ at: now(), kind, ref, by: clean(by, 80) || 'system', detail: clean(detail, 200) }); if (R.events.length > 2000) R.events.shift(); audit('CLIENT_' + kind, { ref, by: clean(by, 80) || 'system' }); };
    const windowSum = (c, kinds, ms) => c.activity.filter(a => kinds.includes(a.kind) && now() - a.t <= ms).reduce((s, a) => s + a.amountMinor, 0);
    const windowCount = (c, kinds, ms) => c.activity.filter(a => kinds.includes(a.kind) && now() - a.t <= ms).length;
    const kesMinor = (n) => n * 100;

    function newClient(by) {
        const R = REG(); R.seq++; const t = now();
        return { clientId: 'CLI-' + String(R.seq).padStart(6, '0'), seq: R.seq, createdAt: t, createdBy: by || 'AUTO', displayName: '', names: [], phones: [], ids: [], accounts: [], tier: 0, kycStatus: 'UNVERIFIED',
            idCapturedBy: null, verifiedBy: null, verifiedAt: null, isPep: false, blocked: false, blockedReason: null, risk: { score: 0, level: 'LOW', factors: [], ratedAt: t }, riskHistory: [], activity: [], flags: [], notes: [], corrections: [], mergedFrom: [], lastSeen: t, retainUntil: retain() };
    }
    const cli = (id) => { const c = REG().clients[id]; return c || null; };
    function index(c) {
        const R = REG();
        for (const p of c.phones) R.phoneIdx[p.value] = c.clientId;
        for (const i of c.ids) R.idIdx[idKey(i.type, i.number)] = c.clientId;
        for (const a of c.accounts) R.accIdx[`${a.type}:${a.ref}`] = c.clientId;
    }
    function addName(c, v, source) { const n = clean(v, 100); if (!n || n.length < 2) return; if (!c.names.some(x => normName(x.value) === normName(n))) c.names.push({ value: n, source, at: now() }); if (!c.displayName || (source === 'CASHIER_CORRECTION' || source === 'KYC_CASE')) c.displayName = n; else if (!c.displayName) c.displayName = n; }
    function addPhone(c, p, source) { const v = normPhone(p); if (!v) return false; const e = c.phones.find(x => x.value === v); if (e) { e.lastSeen = now(); return false; } c.phones.push({ value: v, source, firstSeen: now(), lastSeen: now() }); return true; }
    function addId(c, type, number, source, by) { const k = idKey(type, number); if (c.ids.some(x => idKey(x.type, x.number) === k && !x.superseded)) return false; c.ids.push({ type, number, source, at: now(), verified: false, capturedBy: clean(by, 80) || 'system' }); if (!c.idCapturedBy) c.idCapturedBy = clean(by, 80) || 'system'; return true; }
    function addAccount(c, type, ref, source) { if (c.accounts.some(a => a.type === type && a.ref === ref)) return false; c.accounts.push({ type, ref, source, since: now() }); return true; }
    function merge(primary, other, by) {
        const R = REG();
        for (const n of other.names) if (!primary.names.some(x => normName(x.value) === normName(n.value))) primary.names.push(n);
        for (const p of other.phones) if (!primary.phones.some(x => x.value === p.value)) primary.phones.push(p);
        for (const i of other.ids) if (!primary.ids.some(x => idKey(x.type, x.number) === idKey(i.type, i.number))) primary.ids.push(i);
        for (const a of other.accounts) if (!primary.accounts.some(x => x.type === a.type && x.ref === a.ref)) primary.accounts.push(a);
        primary.activity = primary.activity.concat(other.activity).sort((x, y) => x.t - y.t).slice(-ccfg.logCap);
        primary.corrections = primary.corrections.concat(other.corrections); primary.notes = primary.notes.concat(other.notes);
        primary.mergedFrom.push(other.clientId, ...other.mergedFrom); primary.tier = Math.max(primary.tier, other.tier);
        if (other.tier >= primary.tier && other.verifiedBy) { primary.verifiedBy = other.verifiedBy; primary.verifiedAt = other.verifiedAt; }
        if (other.kycStatus === 'VERIFIED' || other.kycStatus === 'ENHANCED') primary.kycStatus = other.kycStatus;
        primary.isPep = primary.isPep || other.isPep; primary.blocked = primary.blocked || other.blocked; primary.createdAt = Math.min(primary.createdAt, other.createdAt);
        if (!primary.displayName) primary.displayName = other.displayName;
        delete R.clients[other.clientId]; index(primary); evt('MERGED', primary.clientId, by, `${other.clientId} merged into ${primary.clientId} (shared phone or ID)`);
    }
    // find or create the one profile for these identifiers, merging any profiles that turn out to be the same person
    function resolve({ phones = [], ids = [], account, by = 'AUTO' }) {
        const R = REG(), found = new Set();
        if (account && R.accIdx[`${account.type}:${account.ref}`] && R.clients[R.accIdx[`${account.type}:${account.ref}`]]) found.add(R.accIdx[`${account.type}:${account.ref}`]);
        for (const p of phones) { const v = normPhone(p); if (v && R.phoneIdx[v] && R.clients[R.phoneIdx[v]]) found.add(R.phoneIdx[v]); }
        for (const i of ids) { const k = idKey(i.type, i.number); if (R.idIdx[k] && R.clients[R.idIdx[k]]) found.add(R.idIdx[k]); }
        if (!found.size) { const c = newClient(by); R.clients[c.clientId] = c; evt('OPENED', c.clientId, by, 'profile opened automatically'); return c; }
        const list = [...found].map(id => R.clients[id]).sort((x, y) => x.seq - y.seq), primary = list[0];
        for (const o of list.slice(1)) merge(primary, o, by);
        return primary;
    }
    function upsert({ phones = [], idNumber, idType, countryCode, name, account, source, by = 'AUTO' }) {
        const ids = []; if (idNumber) { const v = idCheck(idType, idNumber, countryCode); if (v.ok) ids.push(v); }
        const normed = phones.map(normPhone).filter(Boolean);
        if (!normed.length && !ids.length && !account) return null;
        const c = resolve({ phones: normed, ids, account, by });
        for (const p of normed) addPhone(c, p, source);
        for (const i of ids) if (addId(c, i.type, i.number, source, by) && c.tier < 1) { c.tier = 1; c.kycStatus = 'ID_CAPTURED'; }
        if (name) addName(c, name, source);
        if (account) addAccount(c, account.type, account.ref, source);
        c.lastSeen = now(); index(c); assess(c); return c;
    }
    function attachPhone(c, v, source) {
        const R = REG(), owner = R.phoneIdx[v] && R.clients[R.phoneIdx[v]];
        if (owner && owner !== c) { const first = c.seq <= owner.seq; merge(first ? c : owner, first ? owner : c, 'AUTO'); c = first ? c : owner; }
        addPhone(c, v, source); index(c); return c;
    }
    function byAccount(type, ref) { const R = REG(), id = R.accIdx[`${type}:${ref}`]; return id && R.clients[id] ? R.clients[id] : null; }

    // ----- continuous risk rating (transparent: every point has a reason) -----
    function segmentOf(c) {
        const kinds = [...new Set(c.accounts.map(a => a.type))], o30 = windowCount(c, ['ORDER_PLACED'], 30 * 86400000);
        const label = kinds.length > 1 ? 'Dual role: ' + kinds.map(k => k.toLowerCase()).join(' + ') : kinds[0] === 'RIDER' ? 'Rider (gig worker)' : kinds[0] === 'MERCHANT' ? 'Merchant (business)' : kinds[0] === 'WALKIN' ? 'Walk-in (cashier)' : 'Retail customer';
        const tags = []; if (!c.activity.length || now() - c.lastSeen > 30 * 86400000) tags.push('dormant'); if (o30 > 20) tags.push('power user'); if (c.accounts.length > 1) tags.push('multi-account');
        return { kinds, label, tags };
    }
    function assess(c) {
        let score = 0; const f = [], D30 = 30 * 86400000, H24 = 86400000, t = now();
        const vol30 = windowSum(c, ['ORDER_PLACED'], D30), o30 = windowCount(c, ['ORDER_PLACED'], D30), o24 = windowCount(c, ['ORDER_PLACED'], H24);
        const big = c.activity.some(a => a.kind === 'ORDER_PLACED' && a.amountMinor >= kesMinor(ccfg.highOrderKes) && t - a.t <= D30);
        const can30 = windowCount(c, ['ORDER_CANCELLED'], D30), ref30 = windowCount(c, ['ORDER_REFUND'], D30), pay30 = windowSum(c, ['RIDER_PAYOUT'], D30);
        const activeIds = c.ids.filter(i => !i.superseded), distinctIds = new Set(activeIds.map(i => i.number));
        if (!activeIds.length) { score += 10; f.push('No identity document on file'); if (vol30 >= kesMinor(100000)) { score += 10; f.push('Meaningful volume with no ID on file'); } }
        else if (c.tier < 2) { score += 5; f.push('ID number captured but not verified by an officer'); }
        if (distinctIds.size > 1) { score += 35; f.push('More than one ID number on the same person'); if (!c.flags.includes('MULTIPLE_ID_NUMBERS')) c.flags.push('MULTIPLE_ID_NUMBERS'); } else c.flags = c.flags.filter(x => x !== 'MULTIPLE_ID_NUMBERS');
        const toks = c.names.map(n => new Set(normName(n.value).split(' ').filter(x => x.length > 1)));
        if (toks.length > 1 && toks.some((a, i) => toks.slice(i + 1).some(b => ![...a].some(x => b.has(x))))) { score += 20; f.push('Names from different sources do not match'); if (!c.flags.includes('NAME_MISMATCH')) c.flags.push('NAME_MISMATCH'); } else c.flags = c.flags.filter(x => x !== 'NAME_MISMATCH');
        if (c.phones.length > ccfg.maxPhones) { score += 15; f.push(`${c.phones.length} different phone numbers`); }
        if (o30 > ccfg.ordersVelocity30) { score += 15; f.push(`${o30} orders in 30 days`); }
        if (o24 > ccfg.ordersVelocity24h) { score += 15; f.push(`${o24} orders in 24 hours`); }
        if (big) { score += 15; f.push(`An order of KES ${ccfg.highOrderKes.toLocaleString('en-US')} or more`); }
        if (vol30 >= kesMinor(ccfg.volume30MediumKes) && c.tier < 2) { score += 15; f.push('High volume but the ID is not verified'); }
        if (vol30 >= kesMinor(ccfg.volume30HighKes)) { score += 40; f.push(`30-day volume above KES ${ccfg.volume30HighKes.toLocaleString('en-US')}`); } else if (vol30 >= kesMinor(ccfg.volume30MediumKes)) { score += 20; f.push(`30-day volume above KES ${ccfg.volume30MediumKes.toLocaleString('en-US')}`); }
        if (o30 >= ccfg.cancelMinOrders && can30 / o30 >= ccfg.cancelRatio) { score += 20; f.push('Most orders are cancelled'); }
        if (ref30 >= ccfg.refunds30) { score += 10; f.push(`${ref30} refunds in 30 days`); }
        if (pay30 >= kesMinor(ccfg.payout30HighKes)) { score += 20; f.push(`Rider payouts above KES ${ccfg.payout30HighKes.toLocaleString('en-US')} in 30 days`); }
        if (c.isPep) { score += 70; f.push('Politically exposed person'); }
        const names = c.names.map(n => n.value), hit = names.map(n => screenName(n)).find(x => x.matched);
        if (hit) { score += 100; f.push('Possible sanctions-list match: ' + hit.matches.map(m => m.listed).join(', ')); if (!c.flags.includes('SANCTIONS_HIT')) c.flags.push('SANCTIONS_HIT'); } else c.flags = c.flags.filter(x => x !== 'SANCTIONS_HIT');
        const level = score >= ccfg.highScore ? 'HIGH' : score >= ccfg.mediumScore ? 'MEDIUM' : 'LOW', prev = c.risk.level;
        c.risk = { score, level, factors: f, ratedAt: t };
        if (level !== prev || !c.riskHistory.length) { c.riskHistory.push({ at: t, level, score }); if (c.riskHistory.length > 30) c.riskHistory.shift(); }
        const T = state.registry && state.registry.tenant ? state.registry.tenant : 'BIZ-KE', nm = c.displayName || c.clientId;
        if (level === 'HIGH' && prev !== 'HIGH') openAlert(T, 'CLIENT_HIGH_RISK', 'HIGH', { txnId: `${c.clientId}:HIGH:${c.riskHistory.length}`, customerKey: c.clientId, customerName: nm }, `Client rated HIGH (${score}): ${f.slice(0, 3).join('; ')}`);
        if (c.flags.includes('MULTIPLE_ID_NUMBERS')) openAlert(T, 'IDENTITY_CONFLICT', 'HIGH', { txnId: `${c.clientId}:IDCONF`, customerKey: c.clientId, customerName: nm }, 'The same person (same phone or ID) is linked to more than one ID number. An officer must correct the record.');
        if (c.flags.includes('SANCTIONS_HIT')) openAlert(T, 'SANCTIONS_MATCH', 'CRITICAL', { txnId: `${c.clientId}:SANC`, customerKey: c.clientId, customerName: nm }, 'Client name matches the loaded sanctions list');
        return c.risk;
    }

    // ----- platform feeds (called by the marketplace hooks; every one is idempotent by ref) -----
    const once = (ref) => { const R = REG(); if (R.refs[ref]) return false; R.refs[ref] = 1; return true; };
    function logActivity(c, kind, amountMinor, ref) { c.activity.push({ t: now(), kind, amountMinor: Math.max(0, amountMinor | 0), ref }); if (c.activity.length > ccfg.logCap) c.activity.shift(); c.lastSeen = now(); }
    const seenCustomer = (d) => upsert({ phones: [d.phone], name: d.name, account: { type: 'CUSTOMER', ref: String(d.userId) }, source: 'PLATFORM_CUSTOMER' });
    const seenRider = (d) => upsert({ phones: [d.phone], idNumber: d.nationalId && d.nationalId !== 'N/A' && !/^TEST/i.test(d.nationalId) ? d.nationalId : undefined, idType: 'NATIONAL_ID', countryCode: 'KE', name: d.name, account: { type: 'RIDER', ref: String(d.driverId) }, source: 'RIDER_REGISTRATION' });
    const seenMerchant = (d) => upsert({ phones: [d.phone], name: d.ownerName, account: { type: 'MERCHANT', ref: String(d.merchantId) }, source: 'PLATFORM_MERCHANT' });
    function recordOrder(d) {
        let c = (d.userId && byAccount('CUSTOMER', d.userId)) || upsert({ phones: d.phones || [], account: d.userId ? { type: 'CUSTOMER', ref: String(d.userId) } : undefined, source: 'PLATFORM_ORDER' });
        if (!c) return null;
        for (const p of (d.phones || [])) { const v = normPhone(p); if (v && !c.phones.some(x => x.value === v)) c = attachPhone(c, v, 'PLATFORM_ORDER'); }
        const kind = { PLACED: 'ORDER_PLACED', DELIVERED: 'ORDER_DELIVERED', CANCELLED: 'ORDER_CANCELLED', REFUND: 'ORDER_REFUND' }[d.kind];
        if (!kind || !once(`${kind}:${d.orderId}`)) return c; logActivity(c, kind, d.totalMinor || 0, d.orderId); assess(c); return c;
    }
    function recordPayout(d) {
        const c = (d.driverId && byAccount('RIDER', d.driverId)) || upsert({ phones: d.phones || [], account: d.driverId ? { type: 'RIDER', ref: String(d.driverId) } : undefined, source: 'PLATFORM_PAYOUT' });
        if (!c || !once(`RIDER_PAYOUT:${d.ref}`)) return c; logActivity(c, 'RIDER_PAYOUT', d.amountMinor || 0, d.ref); assess(c); return c;
    }
    function recordCash(d) {
        const c = upsert({ phones: [d.phone].filter(Boolean), idNumber: d.idNumber, idType: d.idType || 'NATIONAL_ID', countryCode: 'KE', name: d.name, account: { type: 'WALKIN', ref: d.idNumber ? 'ID:' + String(d.idNumber).toUpperCase() : 'NAME:' + normName(d.name) }, source: 'CASH_DESK' });
        if (!c || !once(`CASH:${d.ref}`)) return c; logActivity(c, 'CASH_' + (d.type || 'TXN'), d.amountMinor || 0, d.ref); assess(c); return c;
    }

    // ----- tiered KYC limits, enforced at checkout -----
    function limitsOf(c) { const L = ccfg.tierLimits[c ? c.tier : 0]; return { order: L.order, d30: L.d30 }; }
    function checkOrder({ userId, phones = [], totalMinor }) {
        let c = userId ? byAccount('CUSTOMER', userId) : null;
        if (!c) { const R = REG(); for (const p of phones) { const v = normPhone(p); if (v && R.phoneIdx[v] && R.clients[R.phoneIdx[v]]) { c = R.clients[R.phoneIdx[v]]; break; } } }
        if (c && c.blocked) return { ok: false, tier: c.tier, code: 'CLIENT_BLOCKED', message: 'Your account is under review. Please contact support.' };
        if (!ccfg.enforceLimits) return { ok: true, tier: c ? c.tier : 0 };
        const tier = c ? c.tier : 0, L = limitsOf(c), amt = Number(totalMinor) || 0, spent = c ? windowSum(c, ['ORDER_PLACED'], 30 * 86400000) : 0;
        const verifyMsg = 'Please visit a cashier with your ID so your account can be verified, then try again.';
        if (L.order !== Infinity && amt > kesMinor(L.order)) return { ok: false, tier, code: 'TIER_ORDER_LIMIT', limit: L.order, message: `Orders above KES ${L.order.toLocaleString('en-US')} need a higher verification level. ${verifyMsg}` };
        if (L.d30 !== Infinity && spent + amt > kesMinor(L.d30)) return { ok: false, tier, code: 'TIER_30D_LIMIT', limit: L.d30, message: `You have reached your KES ${L.d30.toLocaleString('en-US')} limit for 30 days. ${verifyMsg}` };
        return { ok: true, tier };
    }

    // ----- staff actions (all keep history; none delete) -----
    const needReason = (v, n, msg) => { const t = clean(v, 400); if (t.length < n) throw new ComplianceError('NOTE_REQUIRED', msg || `Write at least ${n} characters.`); return t; };
    const mustGet = (id) => { const c = cli(id); if (!c) throw new ComplianceError('NOT_FOUND', 'Client not found.', 404); return c; };
    function correct(clientId, ch, by, reason) {
        const c = mustGet(clientId), why = needReason(reason, 5, 'Say why the details are being corrected (at least 5 characters).'), who = clean(by, 80), done = [];
        const rec = (field, from, to) => { c.corrections.push({ at: now(), by: who, field, from: from == null ? '' : String(from), to: String(to), reason: why }); done.push(field); };
        if (ch.fullName !== undefined) { const n = clean(ch.fullName, 100); if (n.length < 3 || !/\s/.test(n)) throw new ComplianceError('BAD_KYC', 'Enter the full legal name (first and last name).'); if (n !== c.displayName) { rec('fullName', c.displayName, n); addName(c, n, 'CASHIER_CORRECTION'); c.displayName = n; } }
        if (ch.idNumber !== undefined && ch.idNumber !== '') {
            const v = idCheck(ch.idType || (c.ids.find(i => !i.superseded) || {}).type, ch.idNumber, ch.countryCode); if (!v.ok) throw new ComplianceError('BAD_KYC', v.error);
            const R = REG(), owner = R.idIdx[idKey(v.type, v.number)]; if (owner && owner !== c.clientId && R.clients[owner]) throw new ComplianceError('ID_IN_USE', `That ID number already belongs to ${owner}. If both records are the same person, add that person's phone number to merge them.`, 409);
            const cur = c.ids.find(i => !i.superseded && i.type === v.type);
            if (!cur || cur.number !== v.number) { for (const i of c.ids) if (!i.superseded && i.type === v.type) i.superseded = true; rec('idNumber', cur && cur.number, v.number); addId(c, v.type, v.number, 'CASHIER_CORRECTION', who); c.idCapturedBy = who; if (c.tier >= 2) { c.tier = 1; c.kycStatus = 'ID_CAPTURED'; c.verifiedBy = null; c.verifiedAt = null; rec('kycStatus', 'VERIFIED', 'ID_CAPTURED (re-verification needed)'); } else if (c.tier < 1) { c.tier = 1; c.kycStatus = 'ID_CAPTURED'; } }
        }
        if (ch.addPhone) { const v = normPhone(ch.addPhone); if (!v) throw new ComplianceError('BAD_KYC', 'Enter a valid phone number.'); if (!c.phones.some(p => p.value === v)) { rec('addPhone', '', v); const R = REG(), other = R.phoneIdx[v]; if (other && other !== c.clientId && R.clients[other]) { merge(c, R.clients[other], who); openAlert(R.tenant || 'BIZ-KE', 'MERGE_BY_CORRECTION', 'MEDIUM', { txnId: `${c.clientId}:MERGE:${other}`, customerKey: c.clientId, customerName: c.displayName }, `Staff merged two profiles by adding a phone number (${who})`); } addPhone(c, v, 'CASHIER_CORRECTION'); } }
        if (!done.length) throw new ComplianceError('NO_CHANGE', 'Nothing was changed.');
        index(c); c.lastSeen = now(); assess(c); evt('CORRECTED', clientId, who, `${done.join(', ')}: ${why}`); return c;
    }
    function verifyId(clientId, by, role, note) {
        const c = mustGet(clientId), n = needReason(note, 10, 'Describe the document check (at least 10 characters).'), who = clean(by, 80);
        if (!c.ids.some(i => !i.superseded)) throw new ComplianceError('NO_ID', 'Capture the ID number first (correct the details), then verify.', 409);
        if (c.tier >= 2) throw new ComplianceError('ALREADY_VERIFIED', 'This client is already verified.', 409);
        if (role !== 'SOVEREIGN_ADMIN') throw new ComplianceError('SENIOR_REQUIRED', 'Only an administrator can verify an ID.', 403);
        if (who === c.idCapturedBy && !cfg.singleOperator) throw new ComplianceError('SELF_REVIEW', 'The person who captured the ID cannot verify it. Ask a second officer.', 403);
        for (const i of c.ids) if (!i.superseded) i.verified = true;
        c.tier = 2; c.kycStatus = 'VERIFIED'; c.verifiedBy = who; c.verifiedAt = now(); c.notes.push({ at: now(), by: who, text: 'ID verified: ' + n }); assess(c); evt('VERIFIED', clientId, who, n); return c;
    }
    function approveEdd(clientId, by, role, note) {
        const c = mustGet(clientId), n = needReason(note, 15, 'Enhanced due diligence needs a full note (at least 15 characters): source of wealth, checks made.');
        if (role !== 'SOVEREIGN_ADMIN') throw new ComplianceError('SENIOR_REQUIRED', 'Only an administrator can approve enhanced due diligence.', 403);
        if (c.tier < 2) throw new ComplianceError('VERIFY_FIRST', 'Verify the ID (tier 2) first.', 409); if (c.tier >= 3) throw new ComplianceError('ALREADY_VERIFIED', 'Already at tier 3.', 409);
        c.tier = 3; c.kycStatus = 'ENHANCED'; c.notes.push({ at: now(), by: clean(by, 80), text: 'EDD approved: ' + n }); assess(c); evt('EDD_APPROVED', clientId, by, n); return c;
    }
    function setPep(clientId, isPep, by, note) { const c = mustGet(clientId), n = needReason(note, 5); c.isPep = !!isPep; c.notes.push({ at: now(), by: clean(by, 80), text: (isPep ? 'Marked PEP: ' : 'PEP flag removed: ') + n }); assess(c); evt(isPep ? 'PEP_SET' : 'PEP_CLEARED', clientId, by, n); return c; }
    function setBlocked(clientId, blocked, by, reason) { const c = mustGet(clientId), n = needReason(reason, 5, 'Give the reason (at least 5 characters).'); c.blocked = !!blocked; c.blockedReason = blocked ? n : null; c.notes.push({ at: now(), by: clean(by, 80), text: (blocked ? 'BLOCKED: ' : 'Unblocked: ') + n }); evt(blocked ? 'BLOCKED' : 'UNBLOCKED', clientId, by, n); return c; }
    function onKycApproved(k, reviewer) {
        const c = upsert({ phones: [k.phone].filter(Boolean), idNumber: k.idNumber, idType: k.idType, countryCode: k.countryCode, name: k.fullName, account: { type: 'WALKIN', ref: 'KYC:' + k.kycId }, source: 'KYC_CASE', by: k.submittedBy });
        if (!c) return null; c.isPep = c.isPep || !!k.isPep; for (const i of c.ids) if (!i.superseded) i.verified = true;
        c.tier = Math.max(c.tier, 2); c.kycStatus = c.tier >= 3 ? 'ENHANCED' : 'VERIFIED'; c.verifiedBy = clean(reviewer, 80); c.verifiedAt = now(); c.kycCaseId = k.kycId; assess(c); evt('VERIFIED', c.clientId, reviewer, 'via KYC case ' + k.kycId); return c;
    }

    // ----- reads -----
    const summaryOf = (c) => ({ clientId: c.clientId, displayName: c.displayName || '(name not known yet)', segment: segmentOf(c), phones: c.phones.map(p => p.value), ids: c.ids.filter(i => !i.superseded).map(i => ({ type: i.type, number: i.number, verified: i.verified })), accounts: c.accounts.map(a => ({ type: a.type, ref: a.ref })), tier: c.tier, tierName: TIER_NAMES[c.tier], kycStatus: c.kycStatus, risk: c.risk, isPep: c.isPep, blocked: c.blocked, flags: c.flags, orders30: windowCount(c, ['ORDER_PLACED'], 30 * 86400000), volume30Minor: windowSum(c, ['ORDER_PLACED'], 30 * 86400000), createdAt: c.createdAt, lastSeen: c.lastSeen, createdBy: c.createdBy });
    function listClients({ q, risk, tier, kind, status, limit = 200, offset = 0 } = {}) {
        let l = Object.values(REG().clients); const nq = String(q || '').toLowerCase().trim();
        if (nq) l = l.filter(c => c.clientId.toLowerCase().includes(nq) || (c.displayName || '').toLowerCase().includes(nq) || c.phones.some(p => p.value.includes(nq.replace(/^0/, '+254'))) || c.phones.some(p => p.value.includes(nq)) || c.ids.some(i => i.number.toLowerCase().includes(nq)) || c.accounts.some(a => a.ref.toLowerCase().includes(nq)));
        if (risk) l = l.filter(c => c.risk.level === String(risk).toUpperCase()); if (tier !== undefined && tier !== '') l = l.filter(c => c.tier === Number(tier)); if (status) l = l.filter(c => c.kycStatus === String(status).toUpperCase());
        if (kind) l = l.filter(c => c.accounts.some(a => a.type === String(kind).toUpperCase()));
        l.sort((a, b) => b.risk.score - a.risk.score || b.lastSeen - a.lastSeen);
        return { total: l.length, clients: l.slice(offset, offset + Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500)).map(summaryOf) };
    }
    function getClient(clientId) { const c = mustGet(clientId); return { ...summaryOf(c), names: c.names, phoneDetail: c.phones, idDetail: c.ids, accountDetail: c.accounts, riskHistory: c.riskHistory, corrections: c.corrections, notes: c.notes, mergedFrom: c.mergedFrom, activity: c.activity.slice(-40).reverse(), limits: limitsOf(c), idCapturedBy: c.idCapturedBy, verifiedBy: c.verifiedBy, verifiedAt: c.verifiedAt, blockedReason: c.blockedReason, kycCaseId: c.kycCaseId || null, retainUntil: c.retainUntil }; }
    function clientSummary() {
        const l = Object.values(REG().clients), day = now() - 86400000, tiers = [0, 0, 0, 0]; l.forEach(c => tiers[c.tier]++);
        return { total: l.length, tiers, high: l.filter(c => c.risk.level === 'HIGH').length, medium: l.filter(c => c.risk.level === 'MEDIUM').length, unverifiedActive: l.filter(c => c.tier < 2 && c.activity.length).length, conflicts: l.filter(c => c.flags.includes('MULTIPLE_ID_NUMBERS') || c.flags.includes('NAME_MISMATCH')).length, openedToday: l.filter(c => c.createdAt >= day).length, blocked: l.filter(c => c.blocked).length, multiAccount: l.filter(c => c.accounts.length > 1).length, pep: l.filter(c => c.isPep).length, enforceLimits: ccfg.enforceLimits, lastScan: REG().lastScan || null, failures: (REG().failures || []).length, tierLimits: Object.fromEntries(Object.entries(ccfg.tierLimits).map(([k, v]) => [k, { order: v.order === Infinity ? 'no limit' : v.order, d30: v.d30 === Infinity ? 'no limit' : v.d30 }])), tierNames: TIER_NAMES };
    }
    const clientsCsv = () => toCsv([['Client', 'Name', 'Segment', 'Phones', 'ID numbers', 'Accounts', 'KYC tier', 'KYC status', 'Risk', 'Score', 'Why', 'PEP', 'Blocked', 'Orders 30d', 'First seen', 'Last seen'], ...Object.values(REG().clients).map(c => { const s = summaryOf(c); return [c.clientId, s.displayName, s.segment.label, s.phones.join(' '), s.ids.map(i => i.number).join(' '), s.accounts.map(a => a.type + ':' + a.ref).join(' '), c.tier, c.kycStatus, c.risk.level, c.risk.score, c.risk.factors.join('; '), c.isPep ? 'YES' : '', c.blocked ? 'YES' : '', s.orders30, iso(c.createdAt), iso(c.lastSeen)]; })]);
    const failure = (kind, ref, message) => { const R = REG(); if (!Array.isArray(R.failures)) R.failures = []; R.failures.push({ at: now(), kind, ref: clean(ref, 60), message: clean(message, 200) }); if (R.failures.length > 200) R.failures.shift(); };
    const setLastScan = (x) => { REG().lastScan = { at: now(), ...x }; };
    function resetActivity() { const R = REG(); R.refs = {}; for (const c of Object.values(R.clients)) { c.activity = []; c.riskHistory = []; assess(c); } evt('ACTIVITY_RESET', 'ALL', 'system', 'test data cleared'); }
    const clients = { failure, failures: () => (REG().failures || []).slice(-50).reverse(), failureCount: () => (REG().failures || []).length, setLastScan, lastScan: () => REG().lastScan || null, resetActivity, TIER_NAMES, cfg: ccfg, normPhone, idCheck, upsert, seenCustomer, seenRider, seenMerchant, recordOrder, recordPayout, recordCash, checkOrder, correct, verifyId, approveEdd, setPep, setBlocked, onKycApproved, assess, list: listClients, get: getClient, summary: clientSummary, csv: clientsCsv, events: () => REG().events.slice(-200).reverse(), setTenant: (t) => { REG().tenant = t; }, count: () => Object.keys(REG().clients).length, raw: (id) => cli(id) };

    return { state, cfg, clients, raiseAlert: (tenant, rule, severity, ref, key, name, detail) => openAlert(tenant, rule, severity, { txnId: ref, customerKey: key, customerName: name }, detail), ComplianceError, ctrThresholdMinor, assertCdd, endOfWeekEat, loadSanctions, screenName, submitKyc, reviewKyc, recordTransaction, updateAlert, escalateToStr, markFiled, overdue, summary, rules, ctrCsv, strCsv, kycCsv, alertsCsv, toCsv,
        list: (kind, tenant) => ({ kyc: state.kyc, alerts: state.alerts, ctr: state.ctr, str: state.str, txns: state.txns }[kind] || []).filter(x => !tenant || x.tenantId === tenant).slice().reverse(), log: () => state.log.slice(-200).reverse() };
}

return { createCompliance, ComplianceError, endOfWeekEat, normName };
})();

// ############################################################################
// PART 3 — API, CASH DESK, CUSTOMER CHECKS AND MARKETPLACE POSTING
// ############################################################################
let ctx = null;
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const isSafeKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,80}$/.test(v) && !['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'].includes(v);
const clean = (v, max = 120) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().substring(0, max);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const send = (res, code, body) => res.status(code).json(body);
const fail = (res, code, msg, extra) => res.status(code).json({ success: false, error: msg, ...(extra || {}) });

const TENANT_STATUSES = ['APPROVED_ACTIVE', 'SUSPENDED', 'REVOKED', 'SUSPENDED_DEFAULTED', 'PENDING_SOVEREIGN_APPROVAL'];
const BASE_CORRIDORS = [
    { id: 'INST-CBK-RTGS', name: 'Central Bank of Kenya', type: 'CENTRAL_BANK', currency: 'KES', status: 'APPROVED_ACTIVE' },
    { id: 'INST-MPESA', name: 'M-Pesa Mobile Money Hub', type: 'MOBILE_MONEY', currency: 'KES', status: 'APPROVED_ACTIVE' },
    { id: 'INST-EQUITY', name: 'Equity Bank Commercial Node', type: 'COMMERCIAL_BANK', currency: 'KES', status: 'APPROVED_ACTIVE' },
    { id: 'BIZ-KE', name: 'RDS Nairobi Forex Bureau', type: 'FOREX_BUREAU', currency: 'KES', status: 'APPROVED_ACTIVE' },
    { id: 'BIZ-UK', name: 'RDS London Central Reserve', type: 'CENTRAL_RESERVE', currency: 'GBP', status: 'APPROVED_ACTIVE' },
    { id: 'INST-WORLDBANK', name: 'World Bank Sovereign Corridor', type: 'CENTRAL_RESERVE', currency: 'USD', status: 'APPROVED_ACTIVE' }
];

function init(deps) {
    const required = ['verifyToken', 'requireAdmin', 'requireSuperAdmin', 'requireRoles', 'appendAudit', 'verifyAuditChain', 'state', 'ledger', 'compliance'];
    const missing = required.filter(k => !deps || !deps[k]);
    if (missing.length) throw new Error(`admin router init missing: ${missing.join(', ')}`);
    ctx = deps;
    try { ctx.compliance.clients.setTenant(MP()); } catch (e) {}
}
const MP = () => (ctx && ctx.marketplaceTenant) || 'BIZ-KE';
const corridorsAll = () => {
    const st = ctx.corridorStatus || {};
    const dyn = (ctx.corridorRequests || []).map(r => ({ id: r.requestId, name: r.businessName, type: r.type || 'COMMERCIAL_NODE', currency: r.currency || 'KES', status: r.status || 'PENDING_SOVEREIGN_APPROVAL' }));
    // STAGE 193: institutions onboarded through the multi-tenant platform appear as their own corridors, each with its own
    // chart of accounts and currency. server.js injects them through ctx.extraCorridors(); isolation is enforced upstream.
    let plat = [];
    try { plat = (ctx.extraCorridors ? ctx.extraCorridors() : []).map(t => ({ id: t.tenantId, name: t.name, type: t.type, currency: (t.currencies && t.currencies[0]) || 'KES', status: 'APPROVED_ACTIVE', coa: t.coa || 'GENERIC', platform: true })); } catch (e) { plat = []; }
    return [...BASE_CORRIDORS, ...dyn, ...plat].map(c => ({ ...c, status: st[c.id] || c.status }));
};
const corridorOf = (id) => corridorsAll().find(c => c.id === id) || null;
const frozen = (c) => !c || ['SUSPENDED', 'REVOKED', 'SUSPENDED_DEFAULTED', 'PENDING_SOVEREIGN_APPROVAL', 'PENDING_OWNER_APPROVAL'].includes(c.status);
function tenantOf(req) { const t = req.headers['x-business-id']; return isSafeKey(t) ? t : 'INST-CBK-RTGS'; }
function tenantFor(req, res, { write = false } = {}) {
    const id = tenantOf(req), c = corridorOf(id);
    if (!c) { fail(res, 404, 'Unknown tenant corridor.'); return null; }
    if (write && frozen(c)) { fail(res, 403, `Corridor ${id} is ${c.status}: operations are frozen.`); return null; }
    const profile = id === MP() ? 'MARKETPLACE' : (c.coa === 'FOREX' ? 'FOREX' : c.coa === 'MICROFINANCE' ? 'MICROFINANCE' : 'GENERIC');
    ctx.ledger.ensureTenant(id, c.currency, profile);
    // a multi-currency institution (forex bureau, bank) also gets a chart of accounts in each of its declared currencies
    if (c.platform && Array.isArray(c.currencies)) for (const cur of c.currencies) try { ctx.ledger.ensureTenant(id, cur, profile); } catch (e) {}
    return { id, corridor: c };
}
const actor = (req) => clean((req.user && (req.user.email || req.user.sub)) || 'unknown', 80);
const isAuditor = (req) => !(req.user && req.user.role === 'SOVEREIGN_ADMIN');
const maskId = (s) => { const v = String(s || ''); return v.length <= 3 ? '***' : '*'.repeat(v.length - 3) + v.slice(-3); };
// run a handler and turn engine errors into clean API errors
const h = (fn) => (req, res) => {
    try { return fn(req, res); }
    catch (e) {
        if (e && e.code && e.status) return fail(res, e.status, e.message, { code: e.code });
        if (ctx && ctx.logError) ctx.logError(e);
        return fail(res, 500, 'The request could not be completed.');
    }
};
const needCtx = (req, res, next) => (ctx ? next() : fail(res, 503, 'Admin module not initialised.'));
const csv = (res, name, body) => { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${String(name).replace(/[^A-Za-z0-9_.-]/g, '_')}"`, 'Cache-Control': 'no-store' }); res.send(body); };

// every route needs a real session. There is deliberately no header-only shortcut.
router.use(needCtx, (req, res, next) => ctx.verifyToken(req, res, next));
const readOk = (req, res, next) => ctx.requireAdmin(req, res, next);
const writeOk = (req, res, next) => ctx.requireSuperAdmin(req, res, next);

// ---------------------------------------------------------------------------
// dashboard (every number comes from the engines)
// ---------------------------------------------------------------------------
const entryView = (e) => ({ entryId: e.entryId, seq: e.seq, timestamp: e.createdAt, postingDate: e.postingDate, description: e.description, reference: e.reference, source: e.source, currency: e.currency, totalAmount: ctx.ledger.dec(e.totalMinor, e.currency), maker: e.maker, checker: e.checker, selfApproved: e.selfApproved, reversalOf: e.reversalOf || null, reversedBy: e.reversedBy || null, hash: e.hash, postings: e.postings.map(p => ({ line: p.line, type: p.side === 'D' ? 'DEBIT' : 'CREDIT', account: p.account, amount: ctx.ledger.dec(p.amountMinor, e.currency), memo: p.memo })) });
router.get('/compliance-dashboard', readOk, h((req, res) => {
    const t = tenantFor(req, res); if (!t) return;
    const s = ctx.state(), L = ctx.ledger, C = ctx.compliance, audit = ctx.verifyAuditChain();
    const ls = L.summary(t.id), cs = C.summary(t.id), reg = L.register(t.id, { limit: 25 }), kycs = C.list('kyc', t.id).slice(0, 50);
    const tb = L.trialBalance(t.id);
    res.json({
        success: true, tenant: t.id, currency: t.corridor.currency, auditChainValid: audit.valid, ledgerChainValid: ls.chain,
        ledger: { ...ls, trialBalanced: tb.balanced, equationHolds: tb.equationHolds }, compliance: cs, clients: C.clients.summary(), vaultBlocksCount: s.auditStream.length, lanTrafficLogsCount: s.lanTrafficLogs.length,
        doubleEntryEntriesCount: ls.journals, transactionsCount: cs.transactions, localIdVerificationsCount: cs.kycTotal,
        doubleEntryLedger: reg.entries.map(entryView),
        verifications: kycs.map(k => ({ kycId: k.kycId, accountId: k.accountId || '(not opened)', fullName: k.fullName, nationalIdNumber: isAuditor(req) ? maskId(k.idNumber) : k.idNumber, registrySource: 'NOT VERIFIED WITH IPRS (manual document check)', initialDeposit: ctx.ledger.dec(k.initialDepositMinor, k.currency), riskRating: k.risk.level, status: k.status })),
        corridors: corridorsAll(), legacySimulatedRecords: { verifications: s.verifications.length, transactions: s.transactions.length }
    });
}));
router.get('/lan-traffic-logs', readOk, (req, res) => res.json({ success: true, lanTrafficLogs: ctx.state().lanTrafficLogs.slice(-500) }));
router.get('/sovereign-vault', readOk, (req, res) => {
    const stream = ctx.state().auditStream, offset = Math.max(parseInt(req.query.offset, 10) || 0, 0), limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 5000);
    res.json({ success: true, total: stream.length, vaultBlocks: stream.slice(Math.max(stream.length - offset - limit, 0), stream.length - offset) });
});

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------
router.get('/ledger/accounts', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; res.json({ success: true, tenant: t.id, accounts: ctx.ledger.listAccounts(t.id) }); }));
router.post('/ledger/accounts', writeOk, h((req, res) => { const t = tenantFor(req, res, { write: true }); if (!t) return; const a = ctx.ledger.addAccount(t.id, { ...(req.body || {}), currency: (req.body && req.body.currency) || t.corridor.currency }, actor(req)); res.json({ success: true, message: `Account ${a.code} created.`, account: a }); }));
router.post('/ledger/accounts/close', writeOk, h((req, res) => { const t = tenantFor(req, res, { write: true }); if (!t) return; const a = ctx.ledger.deactivateAccount(t.id, clean(req.body && req.body.code, 8), actor(req)); res.json({ success: true, message: `Account ${a.code} closed.`, account: a }); }));

// keeps the original path the page already calls
router.post('/double-entry-post', writeOk, h((req, res) => {
    const t = tenantFor(req, res, { write: true }); if (!t) return;
    const b = req.body || {}, key = b.idempotencyKey || req.headers['idempotency-key'] || null;
    const r = ctx.ledger.post(t.id, { currency: b.currency || t.corridor.currency, description: b.description, reference: b.reference, postingDate: b.postingDate, postings: b.postings, idempotencyKey: key, source: 'MANUAL' }, { by: actor(req), role: req.user.role });
    if (r.status === 'PENDING_APPROVAL') return res.json({ success: true, status: 'PENDING_APPROVAL', duplicate: !!r.duplicate, message: `Journal ${r.pending.pendingId} is held for a second administrator to approve (${r.pending.reason}).`, pending: r.pending });
    res.json({ success: true, status: 'POSTED', duplicate: !!r.duplicate, message: r.duplicate ? `Journal ${r.entry.entryId} was already posted (same request).` : `Journal ${r.entry.entryId} posted and balanced.`, journal: entryView(r.entry) });
}));
router.get('/ledger/pending', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; res.json({ success: true, pending: ctx.ledger.pendingList(t.id, req.query.status ? String(req.query.status).toUpperCase() : 'PENDING').map(p => ({ ...p, total: ctx.ledger.dec(p.totalMinor, p.currency) })) }); }));
router.post('/ledger/approve', writeOk, h((req, res) => { const t = tenantFor(req, res, { write: true }); if (!t) return; const e = ctx.ledger.approve(t.id, clean(req.body && req.body.pendingId, 40), actor(req)); res.json({ success: true, message: `Journal ${e.entryId} approved and posted.`, journal: entryView(e) }); }));
router.post('/ledger/reject', writeOk, h((req, res) => { const t = tenantFor(req, res, { write: true }); if (!t) return; const p = ctx.ledger.reject(t.id, clean(req.body && req.body.pendingId, 40), actor(req), req.body && req.body.reason); res.json({ success: true, message: `Journal ${p.pendingId} rejected.`, pending: p }); }));
router.post('/ledger/reverse', writeOk, h((req, res) => { const t = tenantFor(req, res, { write: true }); if (!t) return; const e = ctx.ledger.reverse(t.id, clean(req.body && req.body.entryId, 60), actor(req), req.body && req.body.reason); res.json({ success: true, message: `Reversal ${e.entryId} posted. The original entry is unchanged.`, journal: entryView(e) }); }));
router.post('/ledger/close-period', writeOk, h((req, res) => { const t = tenantFor(req, res, { write: true }); if (!t) return; const r = ctx.ledger.closePeriod(t.id, clean(req.body && req.body.date, 10), actor(req)); res.json({ success: true, message: `Period closed through ${r.closedThrough}.`, period: r }); }));
router.get('/ledger/trial-balance', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; if (req.query.format === 'csv') return csv(res, `trial-balance-${t.id}-${req.query.asOf || 'now'}.csv`, ctx.ledger.trialBalanceCsv(t.id, req.query.asOf)); res.json({ success: true, ...ctx.ledger.trialBalance(t.id, req.query.asOf) }); }));
router.get('/ledger/general-ledger', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; res.json({ success: true, ...ctx.ledger.generalLedger(t.id, { account: clean(req.query.account, 8), from: req.query.from, to: req.query.to }) }); }));
router.get('/ledger/journals', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; if (req.query.format === 'csv') return csv(res, `journals-${t.id}.csv`, ctx.ledger.journalCsv(t.id, { from: req.query.from, to: req.query.to })); const r = ctx.ledger.register(t.id, { from: req.query.from, to: req.query.to, limit: req.query.limit, offset: req.query.offset, source: req.query.source }); res.json({ success: true, total: r.total, entries: r.entries.map(entryView) }); }));
router.get('/ledger/statements', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; res.json({ success: true, ...ctx.ledger.statements(t.id, req.query.asOf) }); }));
router.get('/ledger/verify', readOk, h((req, res) => { const all = ctx.ledger.verifyAll(), audit = ctx.verifyAuditChain(); res.json({ success: true, valid: all.valid && audit.valid, ledger: all, auditChain: audit, checkedAt: Date.now() }); }));

// ---------------------------------------------------------------------------
// compliance
// ---------------------------------------------------------------------------
const kycView = (k, req) => ({ ...k, idNumber: isAuditor(req) ? maskId(k.idNumber) : k.idNumber, initialDeposit: ctx.ledger.dec(k.initialDepositMinor, k.currency) });
router.get('/compliance/summary', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; res.json({ success: true, summary: ctx.compliance.summary(t.id), rules: ctx.compliance.rules() }); }));
router.get('/compliance/rules', readOk, (req, res) => res.json({ success: true, rules: ctx.compliance.rules(), config: { ctrUsd: ctx.compliance.cfg.ctrUsd, fxPerUsd: ctx.compliance.cfg.fxPerUsd, ctrOverrides: ctx.compliance.cfg.ctrOverrides, strDeadlineDays: ctx.compliance.cfg.strDeadlineDays, retentionYears: ctx.compliance.cfg.retentionYears, highRiskCountries: ctx.compliance.cfg.highRiskCountries }, note: 'Thresholds and rates are configuration. Confirm them with your MLRO and counsel; laws and exchange rates change.' }));
router.get('/compliance/kyc', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; res.json({ success: true, cases: ctx.compliance.list('kyc', t.id).map(k => kycView(k, req)) }); }));
router.post('/compliance/kyc/review', writeOk, h((req, res) => { const b = req.body || {}; const k = ctx.compliance.reviewKyc(clean(b.kycId, 40), String(b.decision || '').toUpperCase(), actor(req), b.note, req.user.role); if (k.status === 'APPROVED') { try { ctx.compliance.clients.onKycApproved(k, actor(req)); } catch (e) {} } res.json({ success: true, message: `Case ${k.kycId} ${k.status.toLowerCase()}.`, case: kycView(k, req) }); }));
router.get('/compliance/alerts', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; res.json({ success: true, alerts: ctx.compliance.list('alerts', t.id) }); }));
router.post('/compliance/alerts/update', writeOk, h((req, res) => { const b = req.body || {}; const a = ctx.compliance.updateAlert(clean(b.alertId, 40), String(b.status || '').toUpperCase(), actor(req), b.note); res.json({ success: true, message: `Alert ${a.alertId} is now ${a.status}.`, alert: a }); }));
router.post('/compliance/alerts/escalate', writeOk, h((req, res) => { const b = req.body || {}; const s = ctx.compliance.escalateToStr(clean(b.alertId, 40), actor(req), b.narrative); res.json({ success: true, message: `STR ${s.strId} drafted. It must be filed in goAML by ${new Date(s.dueBy).toISOString()}. Do not tell the customer.`, str: s }); }));
router.get('/compliance/ctr', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; res.json({ success: true, ctr: ctx.compliance.list('ctr', t.id).map(c => ({ ...c, amount: ctx.ledger.dec(c.amountMinor, c.currency) })), overdue: ctx.compliance.overdue().ctr.length }); }));
router.get('/compliance/str', readOk, h((req, res) => { const t = tenantFor(req, res); if (!t) return; res.json({ success: true, str: ctx.compliance.list('str', t.id), overdue: ctx.compliance.overdue().str.length }); }));
router.post('/compliance/file', writeOk, h((req, res) => { const b = req.body || {}, kind = String(b.kind || '').toUpperCase(); if (!['CTR', 'STR'].includes(kind)) return fail(res, 400, 'kind must be CTR or STR.'); const r = ctx.compliance.markFiled(kind, clean(b.id, 40), b.ref, actor(req)); res.json({ success: true, message: `${kind} ${clean(b.id, 40)} recorded as filed (${r.filedRef})${r.filedLate ? ' - LATE' : ''}.`, record: r }); }));
router.post('/compliance/sanctions', writeOk, h((req, res) => { const b = req.body || {}; const r = ctx.compliance.loadSanctions(b.entries, { source: b.source, listDate: b.listDate }, actor(req)); res.json({ success: true, message: `Sanctions list loaded: ${r.entries} entries.`, ...r }); }));
router.get('/compliance/log', readOk, (req, res) => res.json({ success: true, log: ctx.compliance.log() }));
router.get('/compliance/export/:kind', readOk, h((req, res) => {
    const t = tenantFor(req, res); if (!t) return; const k = String(req.params.kind).replace(/\.csv$/, ''), C = ctx.compliance;
    const map = { ctr: () => C.ctrCsv(t.id), str: () => C.strCsv(t.id), kyc: () => C.kycCsv(t.id), alerts: () => C.alertsCsv(t.id) };
    if (!hasKey(map, k)) return fail(res, 404, 'Unknown export.'); csv(res, `${k}-${t.id}.csv`, map[k]());
}));

// A data pack for regulators or auditors: facts and hashes only. It does NOT certify anything.
router.get('/reports/pack', readOk, h((req, res) => {
    const t = tenantFor(req, res); if (!t) return; const L = ctx.ledger, C = ctx.compliance;
    const parts = { trialBalance: L.trialBalance(t.id), statements: L.statements(t.id), journals: L.register(t.id, { limit: 1000 }).entries.map(entryView), pendingApprovals: L.pendingList(t.id, 'PENDING'), chain: L.verifyChain(t.id), auditChain: ctx.verifyAuditChain(), complianceSummary: C.summary(t.id), rules: C.rules(), ctr: C.list('ctr', t.id), str: C.list('str', t.id), alerts: C.list('alerts', t.id) };
    const digests = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, sha(JSON.stringify(v))]));
    ctx.appendAudit('REGULATORY_DATA_PACK_GENERATED', { tenant: t.id, by: actor(req), manifestHash: sha(JSON.stringify(digests)) });
    res.set({ 'Cache-Control': 'no-store' });
    res.json({ success: true, pack: { tenant: t.id, institution: t.corridor.name, currency: t.corridor.currency, generatedAt: new Date().toISOString(), generatedBy: actor(req), manifest: digests, manifestHash: sha(JSON.stringify(digests)),
        statement: 'Data extract from the RDS ledger and compliance records. It reports what the system holds. It is not an audit opinion and it does not certify compliance with any law or regulator rule. Submission to CBK or the FRC is made by the institution through the regulator\'s own channels.', ...parts } });
}));

// ---------------------------------------------------------------------------
// ALWAYS-ON CLIENT REGISTRY (profiles are opened by the system from platform activity)
// Reading: administrator, auditor (IDs masked) and cashier. Correcting details: administrator or cashier.
// Verifying an ID, enhanced due diligence, PEP flags and blocking: administrator only.
// ---------------------------------------------------------------------------
const clientRead = (req, res, next) => ctx.requireRoles('SOVEREIGN_ADMIN', 'CENTRAL_BANK_AUDITOR', 'COMMERCIAL_CASHIER')(req, res, next);
const clientEdit = (req, res, next) => ctx.requireRoles('SOVEREIGN_ADMIN', 'COMMERCIAL_CASHIER')(req, res, next);
const maskClient = (c, req) => (isAuditor(req) ? { ...c, ids: (c.ids || []).map(i => ({ ...i, number: maskId(i.number) })), idDetail: (c.idDetail || []).map(i => ({ ...i, number: maskId(i.number) })), corrections: (c.corrections || []).map(x => (x.field === 'idNumber' ? { ...x, from: maskId(x.from), to: maskId(x.to) } : x)) } : c);
router.get('/clients', clientRead, h((req, res) => { const q = req.query || {}, r = ctx.compliance.clients.list({ q: q.q, risk: q.risk, tier: q.tier, kind: q.kind, status: q.status, limit: q.limit, offset: q.offset }); res.json({ success: true, total: r.total, clients: r.clients.map(c => maskClient(c, req)), tierNames: ctx.compliance.clients.TIER_NAMES }); }));
router.get('/clients/summary', clientRead, (req, res) => res.json({ success: true, summary: ctx.compliance.clients.summary() }));
router.get('/clients/detail', clientRead, h((req, res) => {
    const id = clean(req.query && req.query.id, 20), c = ctx.compliance.clients.get(id), alerts = ctx.compliance.list('alerts').filter(a => a.customerKey === id).slice(0, 30);
    res.json({ success: true, client: maskClient(c, req), alerts });
}));
router.post('/clients/correct', clientEdit, h((req, res) => { const b = req.body || {}; const c = ctx.compliance.clients.correct(clean(b.clientId, 20), { fullName: b.fullName, idType: b.idType, idNumber: b.idNumber, countryCode: b.countryCode, addPhone: b.addPhone }, actor(req), b.reason); res.json({ success: true, message: `Details corrected for ${c.clientId}. The change is recorded with your name and reason.`, client: maskClient(ctx.compliance.clients.get(c.clientId), req) }); }));
router.post('/clients/verify', writeOk, h((req, res) => { const b = req.body || {}; const c = ctx.compliance.clients.verifyId(clean(b.clientId, 20), actor(req), req.user.role, b.note); res.json({ success: true, message: `${c.clientId} verified (tier 2). Higher limits now apply.`, client: ctx.compliance.clients.get(c.clientId) }); }));
router.post('/clients/edd', writeOk, h((req, res) => { const b = req.body || {}; const c = ctx.compliance.clients.approveEdd(clean(b.clientId, 20), actor(req), req.user.role, b.note); res.json({ success: true, message: `${c.clientId} approved for enhanced due diligence (tier 3).`, client: ctx.compliance.clients.get(c.clientId) }); }));
router.post('/clients/pep', writeOk, h((req, res) => { const b = req.body || {}; const c = ctx.compliance.clients.setPep(clean(b.clientId, 20), b.isPep === true, actor(req), b.note); res.json({ success: true, message: `PEP flag ${c.isPep ? 'set' : 'removed'} for ${c.clientId}.`, client: ctx.compliance.clients.get(c.clientId) }); }));
router.post('/clients/block', writeOk, h((req, res) => { const b = req.body || {}; const c = ctx.compliance.clients.setBlocked(clean(b.clientId, 20), b.blocked === true, actor(req), b.reason); res.json({ success: true, message: `${c.clientId} is now ${c.blocked ? 'BLOCKED: they cannot place orders' : 'unblocked'}.`, client: ctx.compliance.clients.get(c.clientId) }); }));
router.post('/clients/rescan', writeOk, h((req, res) => { const r = hooks.rescan(); res.json({ success: true, message: `Scanned the platform: ${r.scanned} accounts checked, ${r.clients} client profiles.`, ...r }); }));
router.get('/clients/export', readOk, h((req, res) => { ctx.appendAudit('CLIENT_REGISTRY_EXPORTED', { by: actor(req) }); csv(res, 'client-registry.csv', ctx.compliance.clients.csv()); }));
router.get('/clients/events', readOk, (req, res) => res.json({ success: true, events: ctx.compliance.clients.events() }));

// ---------------------------------------------------------------------------
// tenants (kept from the earlier module, with auth and audit)
// ---------------------------------------------------------------------------
router.post('/toggle-tenant-status', writeOk, h((req, res) => {
    const { tenantId } = req.body || {}, status = (req.body && req.body.status) || 'SUSPENDED';
    if (!isSafeKey(tenantId)) return fail(res, 400, 'Valid tenantId required.');
    if (!TENANT_STATUSES.includes(status)) return fail(res, 400, `status must be one of ${TENANT_STATUSES.join(', ')}.`);
    const isMerchant = !!(global.merchantProfiles && hasKey(global.merchantProfiles, tenantId)), isCorridor = !!corridorOf(tenantId);
    if (!isMerchant && !isCorridor) return fail(res, 404, 'Tenant not found.');
    const reqRec = (ctx.corridorRequests || []).find(r => r.requestId === tenantId); if (reqRec) reqRec.status = status;
    const previous = isMerchant ? (global.merchantProfiles[tenantId].status || 'APPROVED_ACTIVE') : ((ctx.corridorStatus || {})[tenantId] || 'APPROVED_ACTIVE');
    if (isMerchant) global.merchantProfiles[tenantId].status = status;
    if (isCorridor && ctx.corridorStatus) ctx.corridorStatus[tenantId] = status;
    ctx.appendAudit('TENANT_STATUS_TOGGLE', { tenantId, previousStatus: previous, newStatus: status, by: actor(req) });
    res.json({ success: true, message: `Tenant ${tenantId} status successfully updated to ${status}.` });
}));
router.post('/request-tenant-corridor', writeOk, h((req, res) => {
    const { businessName, type, currency } = req.body || {};
    if (!businessName || typeof businessName !== 'string' || clean(businessName).length < 3) return fail(res, 400, 'businessName is required.');
    const cur = String(currency || 'KES').toUpperCase(); if (!/^[A-Z]{3}$/.test(cur)) return fail(res, 400, 'currency must be a 3-letter code.');
    const record = { requestId: `CORR_${Date.now()}`, businessName: clean(businessName), type: clean(type, 30) || 'COMMERCIAL_NODE', currency: cur, requestedBy: actor(req), status: 'PENDING_SOVEREIGN_APPROVAL', createdAt: Date.now() };
    if (!Array.isArray(ctx.corridorRequests)) ctx.corridorRequests = [];
    ctx.corridorRequests.push(record); ctx.appendAudit('TENANT_CORRIDOR_REQUEST', record);
    res.json({ success: true, message: `Tenant corridor request for "${record.businessName}" submitted successfully for owner approval.` });
}));

// ---------------------------------------------------------------------------
// customer due diligence + cash desk
// ---------------------------------------------------------------------------
const kycAuth = (req, res, next) => ctx.verifyToken(req, res, (e) => (e ? next(e) : ctx.requireRoles('SOVEREIGN_ADMIN', 'COMMERCIAL_CASHIER')(req, res, next)));
kyc.use(needCtx);
kyc.post('/verify-biometric-face', kycAuth, h((req, res) => {
    const t = tenantFor(req, res, { write: true }); if (!t) return; const b = req.body || {};
    let dep = 0; if (b.initialDeposit !== undefined && b.initialDeposit !== null && String(b.initialDeposit).trim() !== '' && Number(b.initialDeposit) !== 0) dep = ctx.ledger.parseMoney(typeof b.initialDeposit === 'number' ? b.initialDeposit : String(b.initialDeposit), t.corridor.currency);
    const k = ctx.compliance.submitKyc(t.id, { fullName: b.fullName, idType: b.idType, idNumber: b.nationalIdNumber || b.idNumber, countryCode: b.countryCode, phone: b.phone, currency: t.corridor.currency, initialDepositMinor: dep, isPep: b.isPep === true, sourceOfFunds: b.sourceOfFunds }, actor(req));
    try { ctx.compliance.clients.upsert({ phones: [k.phone].filter(Boolean), idNumber: k.idNumber, idType: k.idType, countryCode: k.countryCode, name: k.fullName, account: { type: 'WALKIN', ref: 'KYC:' + k.kycId }, source: 'KYC_CASE', by: actor(req) }); } catch (e) {}
    res.json({ success: true, caseId: k.kycId, risk: k.risk.level, status: k.status, simulated: false,
        message: `Case ${k.kycId} submitted for review (risk: ${k.risk.level}). It is NOT verified against IPRS: a second officer must check the documents and approve it before an account can be opened.` });
}));
cashier.use(needCtx);
cashier.post('/process-transaction', kycAuth, h((req, res) => {
    const t = tenantFor(req, res, { write: true }); if (!t) return; const b = req.body || {}, L = ctx.ledger, C = ctx.compliance, cur = t.corridor.currency;
    const type = String(b.transactionType || 'Cash Deposit').toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_|_$/g, '');
    const kind = type.includes('DEPOSIT') && type.includes('CASH') ? 'CASH_DEPOSIT' : type.includes('WITHDRAW') ? 'CASH_WITHDRAWAL' : type.includes('WIRE') ? 'WIRE' : null;
    if (!kind) return fail(res, 400, 'Supported types: Cash Deposit, Cash Withdrawal, Wire Transfer.');
    const amountMinor = L.parseMoney(typeof b.amount === 'number' ? b.amount : String(b.amount == null ? '' : b.amount), cur);
    const d = { amountMinor, currency: cur, type: kind, customerName: b.customerName, idNumber: b.idNumber };
    C.assertCdd(t.id, d);                                         // refuse BEFORE any money moves
    const accs = L.listAccounts(t.id), has = (c) => accs.some(a => a.code === c && a.active), dep = has('2040') ? '2040' : '2000', cash = has('1020') ? '1020' : '1000', bank = '1000';
    if (!has(dep) || !has(cash)) return fail(res, 409, 'This tenant has no cash or customer-deposit account in its chart of accounts.');
    if (kind === 'CASH_WITHDRAWAL') { const bal = L.balanceOf(t.id, dep); if (bal.credit - bal.debit < amountMinor) return fail(res, 409, 'Insufficient customer deposits on the ledger for this withdrawal.'); }
    const key = clean(req.headers['idempotency-key'] || '', 80) || null;
    const postings = kind === 'CASH_WITHDRAWAL' ? [{ account: dep, side: 'D', amountMinor }, { account: cash, side: 'C', amountMinor }] : [{ account: kind === 'WIRE' ? bank : cash, side: 'D', amountMinor }, { account: dep, side: 'C', amountMinor }];
    const r = L.post(t.id, { currency: cur, description: `${kind.replace('_', ' ')} - ${clean(b.customerName, 60) || 'customer'}`, reference: clean(b.reference, 60), source: 'CASHIER', idempotencyKey: key, postings }, { by: actor(req), exempt: true });
    if (r.duplicate) return res.json({ success: true, duplicate: true, message: `Already processed (${r.entry.entryId}).`, journalId: r.entry.entryId });
    const out = C.recordTransaction(t.id, { ...d, ledgerEntryId: r.entry.entryId }, actor(req));
    try { C.clients.recordCash({ idNumber: b.idNumber, name: b.customerName, phone: b.phone, amountMinor, type: kind.replace('CASH_', ''), ref: out.txn.txnId }); } catch (e) {}
    res.json({ success: true, simulated: false, journalId: r.entry.entryId, txnId: out.txn.txnId, ctrRaised: out.ctr ? out.ctr.ctrId : null, alerts: out.alerts.map(a => a.rule),
        message: `Transaction ${out.txn.txnId} recorded and posted to the ledger (${r.entry.entryId}).${out.ctr ? ` A cash transaction report ${out.ctr.ctrId} is now open: it must be filed in goAML by the end of the week.` : ''}${out.alerts.length ? ` Monitoring alert(s) raised: ${out.alerts.map(a => a.rule).join(', ')}.` : ''}` });
}));

// ---------------------------------------------------------------------------
// marketplace -> ledger (end to end). Failures never block an order: they are recorded and shown as alerts.
// ---------------------------------------------------------------------------
const mc = (n) => Math.round(Number(n || 0) * 100);
const vatOf = (c) => { const r = ctx.vatRate == null ? 0.16 : ctx.vatRate; return Math.round(c * r / (1 + r)); };
function safePost(kind, ref, fn) {
    try { const t = MP(); ctx.ledger.ensureTenant(t, (corridorOf(t) || { currency: 'KES' }).currency, 'MARKETPLACE'); const r = fn(t); return r && r.entry ? r.entry.entryId : null; }
    catch (e) { try { ctx.ledger.recordFailure(kind, ref, e.message); } catch (x) {} return null; }
}
const cl = () => ctx.compliance.clients;
function clientEvent(fn) { try { fn(cl()); } catch (e) { try { cl().failure('EVENT', 'hook', e.message); } catch (x) {} } }
const hooks = {
    onPayment(order) {
        clientEvent(c => c.recordOrder({ userId: order.userId, phones: [order.phone, order.customerPhone], totalMinor: mc(order.total), orderId: order.id, kind: 'PLACED' }));
        return safePost('ORDER_PAYMENT', order.id, (t) => { const tot = mc(order.total); if (!(tot > 0)) return null;
            return ctx.ledger.post(t, { currency: 'KES', description: `Customer payment (SIMULATED M-Pesa) ${order.id}`, reference: order.id, source: 'ORDER_PAYMENT', idempotencyKey: `ORDER:${order.id}:PAY`, postings: [{ account: '1010', side: 'D', amountMinor: tot }, { account: '2000', side: 'C', amountMinor: tot }] }, { by: 'system', system: true }); });
    },
    onSettlement(order) {
        clientEvent(c => c.recordOrder({ userId: order.userId, phones: [order.phone, order.customerPhone], totalMinor: mc(order.total), orderId: order.id, kind: 'DELIVERED' }));
        return safePost('ORDER_SETTLEMENT', order.id, (t) => {
            const b = order.breakdown || {}, tot = mc(order.total), items = mc(b.commodityCost !== undefined ? b.commodityCost : b.shopOwnerPayout), rider = mc(b.riderShare);
            if (!(tot > 0) || items < 0 || rider < 0 || items + rider > tot) throw new Error('Order amounts are inconsistent');
            const income = tot - items - rider, vat = vatOf(income), rev = income - vat, paidAtHandover = !!(ctx.ledger.state.idem[t] && ctx.ledger.state.idem[t][`ORDER:${order.id}:HANDOVER`]);
            const p = [{ account: '2000', side: 'D', amountMinor: paidAtHandover ? tot - items : tot }];
            if (items > 0 && !paidAtHandover) p.push({ account: '2010', side: 'C', amountMinor: items }); if (rider > 0) p.push({ account: '2020', side: 'C', amountMinor: rider }); if (rev > 0) p.push({ account: '4000', side: 'C', amountMinor: rev }); if (vat > 0) p.push({ account: '2030', side: 'C', amountMinor: vat });
            return ctx.ledger.post(t, { currency: 'KES', description: `Order settlement ${order.id} (shop, rider, platform, VAT)`, reference: order.id, source: 'ORDER_SETTLEMENT', idempotencyKey: `ORDER:${order.id}:SETTLE`, postings: p }, { by: 'system', system: true });
        });
    },
    // the shop is paid in full when it hands the order to the rider: release the items amount from escrow to the shop
    onHandover(order) {
        return safePost('ORDER_HANDOVER', order.id, (t) => {
            const b = order.breakdown || {}, items = mc(b.commodityCost !== undefined ? b.commodityCost : b.shopOwnerPayout), tot = mc(order.total);
            if (!(items > 0) || items > tot) throw new Error('Order amounts are inconsistent');
            return ctx.ledger.post(t, { currency: 'KES', description: `Shop paid in full at hand-over ${order.id}`, reference: order.id, source: 'ORDER_HANDOVER', idempotencyKey: `ORDER:${order.id}:HANDOVER`, postings: [{ account: '2000', side: 'D', amountMinor: items }, { account: '2010', side: 'C', amountMinor: items }] }, { by: 'system', system: true });
        });
    },
    onMerchantPayout(rec) {
        return safePost('SHOP_PAYOUT', rec.payoutId, (t) => { const a = mc(rec.amount); if (!(a > 0)) return null;
            return ctx.ledger.post(t, { currency: 'KES', description: `Shop payout (SIMULATED M-Pesa B2C) ${rec.payoutId}${rec.auto ? ' (automatic at hand-over)' : ''}`, reference: rec.payoutId, source: 'SHOP_PAYOUT', idempotencyKey: `MPAYOUT:${rec.payoutId}`, postings: [{ account: '2010', side: 'D', amountMinor: a }, { account: '1010', side: 'C', amountMinor: a }] }, { by: 'system', system: true }); });
    },
    onRefund(order) {
        clientEvent(c => { c.recordOrder({ userId: order.userId, phones: [order.phone, order.customerPhone], totalMinor: mc(order.total), orderId: order.id, kind: 'CANCELLED' }); c.recordOrder({ userId: order.userId, phones: [], totalMinor: mc(order.total), orderId: order.id, kind: 'REFUND' }); });
        return safePost('ORDER_REFUND', order.id, (t) => { if (!ctx.ledger.state.idem[t] || !ctx.ledger.state.idem[t][`ORDER:${order.id}:PAY`]) return null; if (ctx.ledger.state.idem[t][`ORDER:${order.id}:SETTLE`] || ctx.ledger.state.idem[t][`ORDER:${order.id}:HANDOVER`]) return null; const tot = mc(order.total);
            return ctx.ledger.post(t, { currency: 'KES', description: `Refund due to customer (cancelled order) ${order.id}`, reference: order.id, source: 'ORDER_REFUND', idempotencyKey: `ORDER:${order.id}:REFUND`, postings: [{ account: '2000', side: 'D', amountMinor: tot }, { account: '2050', side: 'C', amountMinor: tot }] }, { by: 'system', system: true }); });
    },
    onPayout(rec) {
        clientEvent(c => c.recordPayout({ driverId: rec.driverId, phones: [rec.phone], amountMinor: mc(rec.amount), ref: rec.payoutId }));
        return safePost('RIDER_PAYOUT', rec.payoutId, (t) => { const a = mc(rec.amount); if (!(a > 0)) return null;
            return ctx.ledger.post(t, { currency: 'KES', description: `Rider payout (SIMULATED M-Pesa B2C) ${rec.payoutId}`, reference: rec.payoutId, source: 'RIDER_PAYOUT', idempotencyKey: `PAYOUT:${rec.payoutId}`, postings: [{ account: '2020', side: 'D', amountMinor: a }, { account: '1010', side: 'C', amountMinor: a }] }, { by: 'system', system: true }); });
    }
};
hooks.onRiderRegistered = (d) => clientEvent(c => c.seenRider({ driverId: d.id, phone: d.phone, nationalId: d.nationalId, name: d.name, plate: d.plate }));
hooks.onMerchantSeen = (id, p) => clientEvent(c => c.seenMerchant({ merchantId: id, phone: p.phone, ownerName: p.ownerName }));
// compliance gate at checkout: tier limits and blocked clients. If the registry itself fails, orders are not stopped (the failure is recorded).
hooks.checkOrder = (x) => { try { return cl().checkOrder(x); } catch (e) { try { cl().failure('CHECK_ORDER', 'checkout', e.message); } catch (y) {} return { ok: true }; } };
// the platform is scanned on a timer and on demand, so every account is covered even before it places an order
hooks.rescan = () => {
    if (!ctx || !ctx.platform) return { scanned: 0, skipped: 0, clients: cl().count() };
    const P = ctx.platform() || {}; let n = 0, skipped = 0; const errors = [];
    const done = (o) => o.status === 'COMPLETED_SETTLED' || o.deliveryStatus === 'DELIVERED' || /COMPLETED/.test(String(o.status || '')), canc = (o) => /CANCELLED|REJECTED_BY_VENDOR|ORDERLY_DISMISSED/.test(String(o.status || ''));
    const person = (id) => typeof id === 'string' && /^USR_[0-9A-Za-z]+$/.test(id);       // 'ANONYMOUS' and other placeholders are not clients
    const step = (what, ref, fn) => { try { fn(cl()); n++; } catch (e) { skipped++; if (errors.length < 5) errors.push(`${what} ${ref}: ${e.message}`); try { cl().failure('SCAN', what + ' ' + ref, e.message); } catch (x) {} } };
    for (const [id, u] of Object.entries(P.users || {})) { if (u && typeof u === 'object' && person(id)) step('customer', id, c => c.seenCustomer({ userId: id, phone: u.phone })); else skipped++; }
    for (const d of Object.values(P.drivers || {})) { if (d && typeof d === 'object' && d.id) step('rider', d.id, c => c.seenRider({ driverId: d.id, phone: d.phone, nationalId: d.nationalId, name: d.name })); else skipped++; }
    for (const [id, m] of Object.entries(P.merchantProfiles || global.merchantProfiles || {})) { if (m && typeof m === 'object') step('merchant', id, c => c.seenMerchant({ merchantId: id, phone: m.phone, ownerName: m.ownerName })); else skipped++; }
    for (const list of Object.values(P.orders || {})) for (const o of (Array.isArray(list) ? list : [])) {
        if (!o || typeof o !== 'object' || !o.id || !person(o.userId)) { skipped++; continue; }
        step('order', o.id, c => { const base = { userId: o.userId, phones: [o.phone, o.customerPhone], totalMinor: mc(o.total), orderId: o.id }; c.recordOrder({ ...base, kind: 'PLACED' }); if (done(o)) c.recordOrder({ ...base, phones: [], kind: 'DELIVERED' }); if (canc(o)) { c.recordOrder({ ...base, phones: [], kind: 'CANCELLED' }); c.recordOrder({ ...base, phones: [], kind: 'REFUND' }); } });
    }
    for (const p of (P.payouts || [])) { if (p && typeof p === 'object' && p.payoutId && p.driverId) step('payout', p.payoutId, c => c.recordPayout({ driverId: p.driverId, phones: [p.phone], amountMinor: mc(p.amount), ref: p.payoutId })); else skipped++; }
    const out = { scanned: n, skipped, errors, clients: cl().count() };
    try { cl().setLastScan({ scanned: n, skipped, errors: errors.length }); } catch (e) {}
    return out;
};
hooks.setEnforcement = (on) => { cl().cfg.enforceLimits = !!on; return cl().cfg.enforceLimits; };
// ONE compact, read-only snapshot of the whole admin side, for the master control (store).
hooks.monitor = () => {
    const T = MP(), L = ctx.ledger, C = ctx.compliance, K = C.clients, S = C.summary(T), ks = K.summary();
    const last = L.register(T, { limit: 1 }).entries, sev = {}, open = C.list('alerts', T).filter(a => ['OPEN', 'REVIEWING'].includes(a.status));
    open.forEach(a => { sev[a.severity] = (sev[a.severity] || 0) + 1; });
    const ls = L.summary(T), tb = L.trialBalance(T), fl = L.state.failures || [];
    return {
        tenant: T, generatedAt: Date.now(),
        ledger: { journals: ls.journals, accounts: ls.accounts, pending: ls.pending, closedThrough: ls.closedThrough, chainValid: ls.chain, trialBalanced: tb.balanced, equationHolds: tb.equationHolds, failures: fl.length, lastFailure: fl.length ? fl[fl.length - 1] : null, lastPostingAt: last[0] ? last[0].createdAt : null },
        compliance: { alertsOpen: S.alertsOpen, alertsBySeverity: sev, ctrOpen: S.ctrOpen, strOpen: S.strOpen, overdueCtr: S.overdueCtr, overdueStr: S.overdueStr, kycPending: S.kycPending, sanctionsListLoaded: S.sanctionsListLoaded, sanctionsEntries: S.sanctionsEntries, sanctionsListDate: S.sanctionsListDate, rulesActive: S.rulesActive, transactions: S.transactions },
        clients: { ...ks, failuresRecent: K.failures().slice(0, 5) },
        topRisk: K.list({ risk: 'HIGH', limit: 5 }).clients.map(c => ({ clientId: c.clientId, name: c.displayName, segment: c.segment.label, tier: c.tier, score: c.risk.score, why: c.risk.factors.slice(0, 2), blocked: c.blocked })),
        openAlerts: open.slice(0, 8).map(a => ({ alertId: a.alertId, rule: a.rule, severity: a.severity, customer: a.customerName, detail: a.detail, at: a.createdAt })),
        enforcement: !!K.cfg.enforceLimits
    };
};
// test mode only (the master control refuses this when real payments are on): empty the marketplace ledger
function resetMarketplaceLedger() {
    const t = MP(), S = ctx.ledger.state;
    for (const k of ['journals', 'idem', 'pending', 'reversals']) if (S[k] && S[k][t]) delete S[k][t];
    if (S.periods && S.periods[t]) S.periods[t] = { closedThrough: null, history: [] };
    S.failures.length = 0;
    try { ctx.compliance.clients.resetActivity(); } catch (e) {}
    return true;
}

module.exports = router;
module.exports.init = init;
module.exports.cashier = cashier;
module.exports.kyc = kyc;
module.exports.hooks = hooks;
module.exports.resetMarketplaceLedger = resetMarketplaceLedger;
module.exports.BASE_CORRIDORS = BASE_CORRIDORS;
// the two engines, built into this file (server.js creates one of each and passes them back to init)
module.exports.createLedger = LEDGER.createLedger;
module.exports.createCompliance = COMPLIANCE.createCompliance;
module.exports.LedgerError = LEDGER.LedgerError;
module.exports.ComplianceError = COMPLIANCE.ComplianceError;
module.exports.parseMoney = LEDGER.parseMoney;
module.exports.formatMoney = LEDGER.formatMoney;
module.exports.endOfWeekEat = COMPLIANCE.endOfWeekEat;
module.exports.normName = COMPLIANCE.normName;