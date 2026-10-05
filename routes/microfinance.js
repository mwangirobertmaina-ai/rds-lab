'use strict';
// ============================================================================
// routes/microfinance.js — STAGE 193 PART D: MICROFINANCE / SACCO (additive; mounted by server.js at /api/mfi)
//
// A deposit-taking microfinance bank or SACCO rents the platform; its staff sign in through routes/platform.js (sealed to
// their tenant) and run member savings and loans here. Every movement posts BALANCED DOUBLE-ENTRY JOURNALS to the same
// ledger engine, so the trial balance and the F1..F9 freeze gate cover it, and AML/CTR runs through the SAME compliance
// engine as the cash desk and the forex counter. All amounts are KES, integer cents, parsed exactly.
//
// WHAT IT DOES (worked in docs/microfinance and in the tests):
//   MEMBERS   each member has a savings balance and may have loans. Opening a member links to the client registry.
//   SAVINGS   deposit  -> Dr 1020 Cash / Cr 2000 Member Deposits ; the member's own balance rises
//             withdraw -> Dr 2000 / Cr 1020 Cash ; refused if the member's balance is too low
//   LOANS     declining-balance, equal-principal schedule. Disburse -> Dr 1200 Loans / Cr 1020 Cash.
//             A repayment is split interest-first: interest -> Cr 4000 Interest Income, principal -> Cr 1200 Loans.
//             The loan closes when outstanding principal reaches zero.
//
// INVARIANTS (the tests prove each from the LEDGER, not from this module): after every action the trial balance balances
//   and the chain is valid; 1200 == sum of outstanding loan principal; 2000 == sum of member savings; interest posted to
//   4000 == sum of interest paid. Nothing here keeps a second copy of the money; the ledger is the single source of truth.
// ============================================================================
const express = require('express');
const router = express.Router();

let D = {};
function init(deps) { D = deps || {}; state(); }

const PROTO = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];
const isSafeKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+\-]{1,80}$/.test(v) && !PROTO.includes(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const clean = (v, max = 120) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
const now = () => Date.now();
const bad = (res, msg, code = 400, extra) => res.status(code).json({ success: false, error: msg, ...(extra || {}) });
const ok = (res, body) => res.json({ success: true, ...body });

// money is KES minor units (cents), parsed exactly
function parseKes(input) {
    let t = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : typeof input === 'string' ? input.trim().replace(/,/g, '') : '';
    if (!t || /e/i.test(t) || !/^\d{1,13}(\.\d{1,2})?$/.test(t)) return null;
    const [i, f = ''] = t.split('.'); const minor = Number(i) * 100 + (f ? Number(f.padEnd(2, '0')) : 0);
    return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
const kes = (minor) => { const a = Math.abs(minor); return (minor < 0 ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0'); };
// interest rate: percent per month, stored as basis points (1% = 100 bp), parsed from e.g. "3" or "3.5"
function parseRatePct(input) {
    let t = typeof input === 'number' ? String(input) : typeof input === 'string' ? input.trim() : '';
    if (!t || !/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
    const [i, f = ''] = t.split('.'); const bp = Number(i) * 100 + (f ? Number(f.padEnd(2, '0')) : 0);
    return bp >= 0 && bp <= 2000 ? bp : null;     // 0 to 20% per month
}
const pctStr = (bp) => (bp / 100).toFixed(2).replace(/\.?0+$/, m => (m.includes('.') ? '' : m));

// ---------------------------------------------------------------------------
// state (saved with the server snapshot via deps.getState())
// ---------------------------------------------------------------------------
function state() {
    const s = (D.getState && D.getState()) || {};
    if (!s.members || typeof s.members !== 'object') s.members = {};   // tenantId -> { memberId: {...} }
    if (!s.loans || typeof s.loans !== 'object') s.loans = {};        // tenantId -> { loanId: {...} }
    if (!s.ledgerLog || typeof s.ledgerLog !== 'object') s.ledgerLog = {}; // tenantId -> [ {kind, ...} ] activity for statements
    if (!Number.isSafeInteger(s.mseq)) s.mseq = 0;
    if (!Number.isSafeInteger(s.lseq)) s.lseq = 0;
    return s;
}
const dirty = () => { if (D.markDirty) D.markDirty(); };
const audit = (type, rec) => { if (D.appendAudit) D.appendAudit(type, rec); };
const members = (t) => (state().members[t] || (state().members[t] = {}));
const loans = (t) => (state().loans[t] || (state().loans[t] = {}));
const activity = (t) => (state().ledgerLog[t] || (state().ledgerLog[t] = []));
const logAct = (t, rec) => { const a = activity(t); a.push({ at: now(), ...rec }); if (a.length > 100000) a.shift(); };

// ---------------------------------------------------------------------------
// auth: signed-in tenant staff; the seal in server.js pins the tenant. Cashier/admin transact, auditor reads.
// ---------------------------------------------------------------------------
function auth(req, res, next) {
    const p = D.verifyJwt ? D.verifyJwt((req.headers.authorization || '').replace(/^Bearer\s+/, '')) : null;
    if (!p || !p.tenantId) return bad(res, 'Sign in as institution staff.', 401);
    req.mf = { tenantId: p.tenantId, email: p.email || p.sub || 'staff', staffRole: p.staffRole || null, breakGlass: !!p.breakGlass };
    next();
}
const canTransact = (req, res, next) => {
    if (!(['CASHIER', 'TENANT_ADMIN'].includes(req.mf.staffRole)) || req.mf.breakGlass) return bad(res, 'Only a cashier or administrator can transact. Auditors and support access are read-only.', 403);
    if (D.billingOverdue && D.billingOverdue(req.mf.tenantId)) return bad(res, 'Transacting is paused: a subscription invoice is overdue. Please settle it to resume.', 402);
    next();
};
function mfiTenant(req, res) {
    const id = req.mf.tenantId, t = D.tenantConfig ? D.tenantConfig(id) : null;
    if (!t) { bad(res, 'Institution not found or not active.', 404); return null; }
    if (!['MICROFINANCE_BANK', 'MICROFINANCE_CREDIT', 'SACCO', 'COMMERCIAL_BANK'].includes(t.type)) { bad(res, 'The members and loans module is for microfinance, SACCO or bank institutions. This institution is a ' + t.type + '.', 403); return null; }
    return t;
}

// post one balanced KES journal in the tenant's ledger, returning its id
function post(tenantId, description, reference, source, postings, idemKey) {
    const r = D.ledger.post(tenantId, { currency: 'KES', description, reference, source, idempotencyKey: idemKey, postings }, { by: 'MFI_COUNTER', system: true });
    if (!r.entry) throw new Error('journal did not post');
    return r.entry.entryId;
}
function ledgerBal(tid, code) { try { const b = D.ledger.balanceOf(tid, code); return b.debit - b.credit; } catch (e) { return 0; } }

// ---------------------------------------------------------------------------
// MEMBERS
// ---------------------------------------------------------------------------
const memberView = (m) => ({ memberId: m.memberId, name: m.name, phone: m.phone, idNumber: m.idNumber ? mask(m.idNumber) : null, savingsBalance: kes(m.savingsMinor), shareCapital: kes(m.shareMinor || 0), openLoans: m.openLoans || 0, joinedAt: m.joinedAt });
const mask = (s) => { const v = String(s || ''); return v.length <= 3 ? '***' : '*'.repeat(v.length - 3) + v.slice(-3); };
router.post('/members', auth, canTransact, (req, res) => {
    const t = mfiTenant(req, res); if (!t) return; const tid = t.tenantId, b = req.body || {};
    const name = clean(b.name, 100); if (name.length < 3 || !/\s/.test(name)) return bad(res, "Enter the member's full name (first and last name).");
    const phone = clean(b.phone, 20); if (phone && !(D.isPhone ? D.isPhone(phone) : /^\+?[0-9 ()-]{7,20}$/.test(phone))) return bad(res, 'Enter a valid phone number, or leave it blank.');
    const idNumber = clean(b.idNumber, 30).toUpperCase();
    const S = state(); S.mseq++; const memberId = `MEM-${tid}-${String(S.mseq).padStart(6, '0')}`;
    members(tid)[memberId] = { memberId, tenantId: tid, name, phone: phone || null, idNumber: idNumber || null, savingsMinor: 0, shareMinor: 0, openLoans: 0, joinedAt: now(), joinedBy: req.mf.email };
    try { if (D.compliance && D.compliance.clients) D.compliance.clients.upsert({ phones: [phone].filter(Boolean), idNumber: idNumber || undefined, idType: 'NATIONAL_ID', countryCode: 'KE', name, account: { type: 'WALKIN', ref: memberId }, source: 'MFI_MEMBER', by: req.mf.email }); } catch (e) {}
    audit('MFI_MEMBER_ADDED', { tenantId: tid, memberId, by: req.mf.email }); dirty();
    ok(res, { message: `${name} added as member ${memberId}.`, member: memberView(members(tid)[memberId]) });
});
router.get('/members', auth, (req, res) => {
    const t = mfiTenant(req, res); if (!t) return; const tid = t.tenantId, q = String((req.query && req.query.q) || '').toLowerCase();
    let list = Object.values(members(tid));
    if (q) list = list.filter(m => m.memberId.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || String(m.phone).includes(q) || String(m.idNumber).toLowerCase().includes(q));
    list.sort((a, b) => b.joinedAt - a.joinedAt);
    ok(res, { count: list.length, members: list.slice(0, 500).map(memberView) });
});
function memberOf(req, res) { const t = mfiTenant(req, res); if (!t) return null; const id = clean(req.body && req.body.memberId || req.params && req.params.memberId || req.query && req.query.memberId, 40); const m = members(t.tenantId)[id]; if (!m) { bad(res, 'Member not found.', 404); return null; } return { t, m }; }
router.get('/members/:memberId', auth, (req, res) => {
    const x = memberOf(req, res); if (!x) return; const { t, m } = x, tid = t.tenantId;
    const myLoans = Object.values(loans(tid)).filter(l => l.memberId === m.memberId).map(loanView);
    ok(res, { member: memberView(m), loans: myLoans, activity: activity(tid).filter(a => a.memberId === m.memberId).slice(-50).reverse() });
});

// ---------------------------------------------------------------------------
// SAVINGS
// ---------------------------------------------------------------------------
const CTR_KES_MINOR = () => { const n = Number(process.env.CTR_KES_THRESHOLD) > 0 ? Number(process.env.CTR_KES_THRESHOLD) : 1000000; return n * 100; };
function amlGate(tid, amountMinor, type, m) {
    if (amountMinor >= CTR_KES_MINOR()) { if (!m.name || !m.idNumber) throw Object.assign(new Error(`A cash transaction of KES ${kes(amountMinor)} is at or above the reporting threshold. Record the member's ID first.`), { status: 409 }); }
    if (D.compliance) D.compliance.assertCdd(tid, { amountMinor, currency: 'KES', type, customerName: m.name, idNumber: m.idNumber });
}
function amlRecord(tid, amountMinor, type, m, ledgerEntryId, by) {
    let ctrId = null, alerts = [];
    try {
        if (D.compliance) {
            const out = D.compliance.recordTransaction(tid, { amountMinor, currency: 'KES', type, customerName: m.name, idNumber: m.idNumber, ledgerEntryId }, by);
            if (out.ctr) ctrId = out.ctr.ctrId; alerts = (out.alerts || []).map(a => a.rule);
            if (D.compliance.clients && D.compliance.clients.recordCash) D.compliance.clients.recordCash({ idNumber: m.idNumber, name: m.name, phone: m.phone, amountMinor, type: type.replace('CASH_', ''), ref: ledgerEntryId });
        }
    } catch (e) {}
    return { ctrId, alerts };
}
router.post('/savings/deposit', auth, canTransact, (req, res) => {
    const x = memberOf(req, res); if (!x) return; const { t, m } = x, tid = t.tenantId;
    const amt = parseKes(req.body && req.body.amount); if (!amt) return bad(res, 'Enter the deposit amount.');
    try { amlGate(tid, amt, 'CASH_DEPOSIT', m); } catch (e) { return bad(res, e.message, e.status || 409, { code: e.code }); }
    const ref = `SAV-D-${tid}-${now()}`;
    let entry; try { entry = post(tid, `Savings deposit by ${m.name}`, ref, 'MFI_SAVINGS', [{ account: '1020', side: 'D', amountMinor: amt }, { account: '2000', side: 'C', amountMinor: amt }], ref); }
    catch (e) { return bad(res, 'Could not post to the ledger: ' + e.message, 500); }
    m.savingsMinor += amt; logAct(tid, { kind: 'SAVINGS_DEPOSIT', memberId: m.memberId, amountMinor: amt, ref: entry });
    const aml = amlRecord(tid, amt, 'CASH_DEPOSIT', m, entry, req.mf.email);
    audit('MFI_SAVINGS_DEPOSIT', { tenantId: tid, memberId: m.memberId, amount: kes(amt), by: req.mf.email, ctrId: aml.ctrId }); dirty();
    ok(res, { message: `KES ${kes(amt)} deposited. ${m.name}'s savings balance is now KES ${kes(m.savingsMinor)}.${aml.ctrId ? ` A cash report (${aml.ctrId}) is open: file it in goAML.` : ''}`, member: memberView(m), journal: entry, ctrId: aml.ctrId, alerts: aml.alerts });
});
router.post('/savings/withdraw', auth, canTransact, (req, res) => {
    const x = memberOf(req, res); if (!x) return; const { t, m } = x, tid = t.tenantId;
    const amt = parseKes(req.body && req.body.amount); if (!amt) return bad(res, 'Enter the withdrawal amount.');
    if (amt > m.savingsMinor) return bad(res, `${m.name} has only KES ${kes(m.savingsMinor)} in savings. Cannot withdraw KES ${kes(amt)}.`, 409);
    if (amt > ledgerBal(tid, '1020')) return bad(res, `The vault holds only KES ${kes(ledgerBal(tid, '1020'))}. Cannot pay out KES ${kes(amt)}.`, 409);
    try { amlGate(tid, amt, 'CASH_WITHDRAWAL', m); } catch (e) { return bad(res, e.message, e.status || 409, { code: e.code }); }
    const ref = `SAV-W-${tid}-${now()}`;
    let entry; try { entry = post(tid, `Savings withdrawal by ${m.name}`, ref, 'MFI_SAVINGS', [{ account: '2000', side: 'D', amountMinor: amt }, { account: '1020', side: 'C', amountMinor: amt }], ref); }
    catch (e) { return bad(res, 'Could not post to the ledger: ' + e.message, 500); }
    m.savingsMinor -= amt; logAct(tid, { kind: 'SAVINGS_WITHDRAWAL', memberId: m.memberId, amountMinor: amt, ref: entry });
    const aml = amlRecord(tid, amt, 'CASH_WITHDRAWAL', m, entry, req.mf.email);
    audit('MFI_SAVINGS_WITHDRAWAL', { tenantId: tid, memberId: m.memberId, amount: kes(amt), by: req.mf.email, ctrId: aml.ctrId }); dirty();
    ok(res, { message: `KES ${kes(amt)} withdrawn. ${m.name}'s savings balance is now KES ${kes(m.savingsMinor)}.`, member: memberView(m), journal: entry, ctrId: aml.ctrId, alerts: aml.alerts });
});

// ---------------------------------------------------------------------------
// LOANS (declining-balance, equal-principal). Interest accrues on the outstanding principal.
// ---------------------------------------------------------------------------
function buildSchedule(principalMinor, months, rateBp) {
    // equal principal per month; interest on the outstanding balance at the start of each month
    const base = Math.floor(principalMinor / months), rows = [];
    let outstanding = principalMinor;
    for (let i = 1; i <= months; i++) {
        const principalThis = i === months ? outstanding : base;      // last instalment clears any rounding remainder
        const interestThis = Math.round(outstanding * rateBp / 10000); // rateBp is per-month basis points of 100%; 300bp = 3% => *3/100 = *300/10000
        rows.push({ month: i, openingMinor: outstanding, principalMinor: principalThis, interestMinor: interestThis, paymentMinor: principalThis + interestThis });
        outstanding -= principalThis;
    }
    return rows;
}
const loanView = (l) => ({ loanId: l.loanId, memberId: l.memberId, principal: kes(l.principalMinor), months: l.months, ratePctPerMonth: pctStr(l.rateBp), outstanding: kes(l.outstandingMinor), interestPaid: kes(l.interestPaidMinor), status: l.status, disbursedAt: l.disbursedAt, totalScheduledInterest: kes(l.scheduledInterestMinor) });
router.post('/loans', auth, canTransact, (req, res) => {
    const x = memberOf(req, res); if (!x) return; const { t, m } = x, tid = t.tenantId, b = req.body || {};
    const principal = parseKes(b.amount); if (!principal) return bad(res, 'Enter the loan amount.');
    const months = Number(b.months); if (!Number.isInteger(months) || months < 1 || months > 60) return bad(res, 'Enter the loan term in months (1 to 60).');
    const rateBp = parseRatePct(b.ratePctPerMonth); if (rateBp === null) return bad(res, 'Enter the monthly interest rate as a percent (e.g. 3 or 3.5).');
    if (Object.values(loans(tid)).some(l => l.memberId === m.memberId && l.status === 'ACTIVE')) return bad(res, `${m.name} already has an active loan. Close it before issuing another.`, 409);
    if (principal > ledgerBal(tid, '1020')) return bad(res, `The vault holds only KES ${kes(ledgerBal(tid, '1020'))}. Cannot disburse KES ${kes(principal)}.`, 409);
    try { amlGate(tid, principal, 'CASH_WITHDRAWAL', m); } catch (e) { return bad(res, e.message, e.status || 409, { code: e.code }); }
    const schedule = buildSchedule(principal, months, rateBp), scheduledInterest = schedule.reduce((s, r) => s + r.interestMinor, 0);
    const S = state(); S.lseq++; const loanId = `LN-${tid}-${String(S.lseq).padStart(6, '0')}`, ref = loanId;
    let entry; try { entry = post(tid, `Loan disbursed to ${m.name}`, ref, 'MFI_LOAN', [{ account: '1200', side: 'D', amountMinor: principal }, { account: '1020', side: 'C', amountMinor: principal }], `${loanId}:DISBURSE`); }
    catch (e) { return bad(res, 'Could not post to the ledger: ' + e.message, 500); }
    loans(tid)[loanId] = { loanId, tenantId: tid, memberId: m.memberId, principalMinor: principal, months, rateBp, schedule, scheduledInterestMinor: scheduledInterest, outstandingMinor: principal, interestPaidMinor: 0, principalPaidMinor: 0, status: 'ACTIVE', disbursedAt: now(), disbursedBy: req.mf.email, repayments: [] };
    m.openLoans = (m.openLoans || 0) + 1;
    const aml = amlRecord(tid, principal, 'CASH_WITHDRAWAL', m, entry, req.mf.email);
    logAct(tid, { kind: 'LOAN_DISBURSED', memberId: m.memberId, amountMinor: principal, ref: loanId });
    audit('MFI_LOAN_DISBURSED', { tenantId: tid, loanId, memberId: m.memberId, amount: kes(principal), months, rate: pctStr(rateBp), by: req.mf.email, ctrId: aml.ctrId }); dirty();
    ok(res, { message: `Loan ${loanId} of KES ${kes(principal)} disbursed to ${m.name} over ${months} months at ${pctStr(rateBp)}% per month. Total interest if paid on schedule: KES ${kes(scheduledInterest)}.`,
        loan: loanView(loans(tid)[loanId]), schedule: schedule.map(r => ({ month: r.month, opening: kes(r.openingMinor), principal: kes(r.principalMinor), interest: kes(r.interestMinor), payment: kes(r.paymentMinor) })), ctrId: aml.ctrId });
});
router.get('/loans', auth, (req, res) => {
    const t = mfiTenant(req, res); if (!t) return; const tid = t.tenantId, status = String((req.query && req.query.status) || '').toUpperCase();
    let list = Object.values(loans(tid)); if (['ACTIVE', 'CLOSED'].includes(status)) list = list.filter(l => l.status === status);
    list.sort((a, b) => b.disbursedAt - a.disbursedAt);
    ok(res, { count: list.length, loans: list.slice(0, 500).map(loanView) });
});
// repayment: interest-first, then principal. interest due now = outstanding * rate (one period); any excess reduces principal.
router.post('/loans/:loanId/repay', auth, canTransact, (req, res) => {
    const t = mfiTenant(req, res); if (!t) return; const tid = t.tenantId;
    const loanId = clean(req.params.loanId, 40), l = loans(tid)[loanId];
    if (!l) return bad(res, 'Loan not found.', 404);
    if (l.status !== 'ACTIVE') return bad(res, 'This loan is already closed.', 409);
    const amt = parseKes(req.body && req.body.amount); if (!amt) return bad(res, 'Enter the repayment amount.');
    const m = members(tid)[l.memberId] || { name: 'Member', idNumber: null, phone: null };
    // interest due this payment = interest on the current outstanding for one period
    const interestDue = Math.round(l.outstandingMinor * l.rateBp / 10000);
    let interestPart = Math.min(amt, interestDue), principalPart = amt - interestPart;
    if (principalPart > l.outstandingMinor) return bad(res, `That is more than the loan needs. Outstanding principal is KES ${kes(l.outstandingMinor)} plus interest KES ${kes(interestDue)}. Maximum payment is KES ${kes(l.outstandingMinor + interestDue)}.`, 409);
    const ref = `${loanId}:REPAY:${(l.repayments.length + 1)}`;
    const postings = [{ account: '1020', side: 'D', amountMinor: amt }];
    if (principalPart > 0) postings.push({ account: '1200', side: 'C', amountMinor: principalPart });
    if (interestPart > 0) postings.push({ account: '4000', side: 'C', amountMinor: interestPart });
    let entry; try { entry = post(tid, `Loan repayment from ${m.name} (${loanId})`, loanId, 'MFI_LOAN', postings, ref); }
    catch (e) { return bad(res, 'Could not post to the ledger: ' + e.message, 500); }
    l.outstandingMinor -= principalPart; l.interestPaidMinor += interestPart; l.principalPaidMinor += principalPart;
    l.repayments.push({ at: now(), amountMinor: amt, interestMinor: interestPart, principalMinor: principalPart, by: req.mf.email, ref: entry });
    logAct(tid, { kind: 'LOAN_REPAYMENT', memberId: l.memberId, amountMinor: amt, ref: loanId });
    let closed = false;
    if (l.outstandingMinor === 0) { l.status = 'CLOSED'; l.closedAt = now(); if (members(tid)[l.memberId]) members(tid)[l.memberId].openLoans = Math.max(0, (members(tid)[l.memberId].openLoans || 1) - 1); closed = true; }
    audit('MFI_LOAN_REPAYMENT', { tenantId: tid, loanId, amount: kes(amt), interest: kes(interestPart), principal: kes(principalPart), outstanding: kes(l.outstandingMinor), by: req.mf.email }); dirty();
    ok(res, { message: `KES ${kes(amt)} received: KES ${kes(interestPart)} interest, KES ${kes(principalPart)} principal. Outstanding is now KES ${kes(l.outstandingMinor)}.${closed ? ' The loan is fully repaid and CLOSED.' : ''}`,
        loan: loanView(l), split: { interest: kes(interestPart), principal: kes(principalPart) }, journal: entry, closed });
});

// ---------------------------------------------------------------------------
// RECONCILIATION: the figures the institution and a regulator check (each read from the LEDGER)
// ---------------------------------------------------------------------------
router.get('/reconcile', auth, (req, res) => {
    const t = mfiTenant(req, res); if (!t) return; const tid = t.tenantId;
    const ledgerLoans = ledgerBal(tid, '1200'), ledgerDeposits = -ledgerBal(tid, '2000'); // 2000 is a liability (credit normal), so outstanding = credit-debit
    const memberSavings = Object.values(members(tid)).reduce((s, m) => s + m.savingsMinor, 0);
    const loanOutstanding = Object.values(loans(tid)).reduce((s, l) => s + l.outstandingMinor, 0);
    const tb = D.ledger.trialBalance(tid), chain = D.ledger.verifyChain(tid);
    const checks = [
        { id: 'TRIAL_BALANCE', label: 'The books balance (debits = credits)', ok: tb.balanced && tb.equationHolds },
        { id: 'LEDGER_CHAIN', label: 'The ledger is tamper-evident (hash chain intact)', ok: chain.valid },
        { id: 'LOANS_MATCH', label: 'Loans in the ledger equal the sum of members\' outstanding loans', ok: ledgerLoans === loanOutstanding, ledger: kes(ledgerLoans), members: kes(loanOutstanding) },
        { id: 'SAVINGS_MATCH', label: 'Member deposits in the ledger equal the sum of members\' savings', ok: ledgerDeposits === memberSavings, ledger: kes(ledgerDeposits), members: kes(memberSavings) }
    ];
    ok(res, { ok: checks.every(c => c.ok), vaultCash: kes(ledgerBal(tid, '1020')), interestEarned: kes(-ledgerBal(tid, '4000')), checks });
});

function mfiStats(tid) {
    const mem = Object.values(members(tid)), ln = Object.values(loans(tid));
    return { members: mem.length, activeLoans: ln.filter(l => l.status === 'ACTIVE').length,
        savingsHeld: kes(mem.reduce((s, m) => s + m.savingsMinor, 0)), loansOutstanding: kes(ln.reduce((s, l) => s + l.outstandingMinor, 0)),
        vaultCash: kes(ledgerBal(tid, '1020')), interestEarned: kes(-ledgerBal(tid, '4000')) };
}

module.exports = router;
module.exports.init = init;
module.exports.stats = mfiStats;
module.exports._test = { parseKes, buildSchedule, kes, pctStr };