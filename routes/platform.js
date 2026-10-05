'use strict';
// ============================================================================
// routes/platform.js — STAGE 193 MULTI-TENANT PLATFORM (additive; loaded by server.js, mounted at /api/platform)
//
// This turns the RDS compliance + ledger engine into a product that MANY financial institutions rent, each one sealed
// as its own tenant. A forex bureau and a microfinance bank on the same server never see each other's data, staff or books.
//
// THE THREE LAYERS (they never blur):
//   PLATFORM OWNER (you)   approves/suspends tenants, verifies licences, sees billing. Can open a tenant's books ONLY through
//                          a transparent "break-glass" action that is written to the audit chain. Never a silent backdoor.
//   TENANT ADMIN           runs ONE institution, invites that institution's own staff, nothing outside their tenant.
//   TENANT STAFF           cashier / MLRO (compliance) / auditor — sealed inside their tenant.
//
// HOW ISOLATION IS ENFORCED (the part that matters most):
//   Every staff token carries BOTH the role AND the tenant: { role, tenantId, platform:false }. A token for tenant A can
//   never act on tenant B, because tenantGuard() below compares the token's tenantId with the x-business-id on the request
//   and refuses any mismatch. The platform owner's token (platform:true) is the only one allowed to cross tenants, and only
//   through the audited break-glass path.
//
// HONESTY RULE: a tenant is stamped "LICENCE_DECLARED" (not verified) until the owner verifies the number against the public
//   CBK / SASRA register and marks it LICENCE_VERIFIED. The software never asserts an institution is licensed; it records what
//   the institution declared and what the owner verified. This is what keeps the product safe and credible to a regulator.
//
// Server state (tenants, staff, break-glass log, billing) is injected by server.js through init(deps) and saved with the
// rest of the snapshot, so it survives restarts. No database or third-party service is required.
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
const bad = (res, msg, code = 400, extra) => res.status(code).json({ success: false, error: msg, ...(extra || {}) });
const ok = (res, body) => res.json({ success: true, ...body });
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const emailOk = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 120;
const audit = (a, r) => { try { if (D.appendAudit) D.appendAudit(a, r); } catch (e) {} };
const dirty = () => { try { if (D.markDirty) D.markDirty(); } catch (e) {} };

// ---------------------------------------------------------------------------
// tenant types: each decides the chart of accounts, the cashier screen and the default currencies
// ---------------------------------------------------------------------------
const TENANT_TYPES = {
    FOREX_BUREAU: { label: 'Forex bureau', regulator: 'CBK', coa: 'FOREX', multiCurrency: true, defaultCurrencies: ['KES', 'USD', 'EUR', 'GBP'], licenceLabel: 'CBK forex bureau licence number' },
    MICROFINANCE_BANK: { label: 'Deposit-taking microfinance bank', regulator: 'CBK', coa: 'MICROFINANCE', multiCurrency: false, defaultCurrencies: ['KES'], licenceLabel: 'CBK microfinance bank licence number' },
    MICROFINANCE_CREDIT: { label: 'Credit-only microfinance (non-deposit)', regulator: 'CBK', coa: 'MICROFINANCE', multiCurrency: false, defaultCurrencies: ['KES'], licenceLabel: 'CBK non-deposit credit provider licence number' },
    SACCO: { label: 'Deposit-taking SACCO', regulator: 'SASRA', coa: 'MICROFINANCE', multiCurrency: false, defaultCurrencies: ['KES'], licenceLabel: 'SASRA SACCO licence number' },
    COMMERCIAL_BANK: { label: 'Commercial bank', regulator: 'CBK', coa: 'MICROFINANCE', multiCurrency: true, defaultCurrencies: ['KES', 'USD'], licenceLabel: 'CBK bank licence number' }
};
const REGULATORS = { CBK: 'Central Bank of Kenya', SASRA: 'Sacco Societies Regulatory Authority' };
// tenant staff roles -> the engine roles they map to (so the existing ledger/compliance auth still works unchanged)
const STAFF_ROLES = {
    TENANT_ADMIN: { label: 'Institution administrator', engineRole: 'SOVEREIGN_ADMIN' },        // runs this one institution
    CASHIER: { label: 'Cashier / teller', engineRole: 'COMMERCIAL_CASHIER' },
    COMPLIANCE: { label: 'Compliance officer (MLRO)', engineRole: 'SOVEREIGN_ADMIN' },           // approves KYC, files reports
    AUDITOR: { label: 'Internal auditor (read only)', engineRole: 'CENTRAL_BANK_AUDITOR' }
};
const CUR = (v) => { const c = String(v || '').toUpperCase(); return /^[A-Z]{3}$/.test(c) ? c : null; };

// ---------------------------------------------------------------------------
// state (saved with the server snapshot via server.js)
// ---------------------------------------------------------------------------
function state() {
    const s = (D.getState && D.getState()) || {};
    if (!s.tenants || typeof s.tenants !== 'object') s.tenants = {};
    if (!s.staff || typeof s.staff !== 'object') s.staff = {};          // staffId -> record (passwordHash lives here, never leaves)
    if (!s.breakGlass || !Array.isArray(s.breakGlass)) s.breakGlass = [];
    if (!Number.isSafeInteger(s.seq)) s.seq = 0;
    if (!Number.isSafeInteger(s.staffSeq)) s.staffSeq = 0;
    return s;
}
const tenants = () => state().tenants;
const staffAll = () => state().staff;
const tenant = (id) => (isSafeKey(id) ? tenants()[id] : null) || null;
const TENANT_STATUS = ['PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'CLOSED'];
const LICENCE_STATUS = ['LICENCE_DECLARED', 'LICENCE_VERIFIED', 'LICENCE_REJECTED'];

// password hashing (scrypt; same approach the server uses for the owner password)
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function makePw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: hashPw(pw, salt) }; }
function checkPw(pw, rec) { try { const h = hashPw(pw, rec.salt); const a = Buffer.from(h, 'hex'), b = Buffer.from(rec.hash, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); } catch (e) { return false; } }
const pwStrong = (pw) => typeof pw === 'string' && pw.length >= 8 && pw.length <= 128;

// ---------------------------------------------------------------------------
// auth middleware
// ---------------------------------------------------------------------------
function readToken(req) { const h = req.headers['authorization']; if (!h || !h.startsWith('Bearer ')) return null; return (D.verifyJwt ? D.verifyJwt(h.slice(7).trim()) : null); }
// the PLATFORM OWNER: the existing owner login (role SOVEREIGN_ADMIN, no tenantId) OR a token explicitly marked platform:true
function platformOwner(req, res, next) {
    const p = readToken(req);
    if (!p) return bad(res, 'Sign in as the platform owner.', 401);
    const isOwner = ((p.role === 'SOVEREIGN_ADMIN' && !p.tenantId) || p.platform === true) && !p.breakGlass && !p.tenantId;
    if (!isOwner) return bad(res, 'Platform owner only.', 403);
    req.pf = p; next();
}
// a signed-in TENANT STAFF member, sealed to their tenant
function tenantAuth(...roles) {
    return (req, res, next) => {
        const p = readToken(req);
        if (!p || !p.staffId || !p.tenantId) return bad(res, 'Sign in to your institution.', 401);
        const rec = staffAll()[p.staffId];
        if (!rec || rec.disabled || rec.tenantId !== p.tenantId) return bad(res, 'This sign-in is no longer valid.', 401);
        const t = tenant(p.tenantId);
        if (!t) return bad(res, 'Institution not found.', 404);
        if (t.status !== 'ACTIVE') return bad(res, `Your institution is ${String(t.status).toLowerCase().replace('_', ' ')}. Contact the platform administrator.`, 403);
        if (roles.length && !roles.includes(p.staffRole)) return bad(res, 'You do not have permission for this action.', 403);
        req.staff = { ...p, rec }; req.tenant = t; next();
    };
}
// SEAL: a staff request that carries x-business-id must match the token's tenant. No token touches another tenant's data.
function tenantGuard(req, res, next) {
    const hdr = req.headers['x-business-id'];
    if (hdr !== undefined && hdr !== null && hdr !== '' && hdr !== req.staff.tenantId) return bad(res, 'You cannot access another institution.', 403);
    next();
}

// ---------------------------------------------------------------------------
// views (never leak password hashes or other tenants' data)
// ---------------------------------------------------------------------------
function tenantPublic(t) {
    const ty = TENANT_TYPES[t.type] || {};
    return { tenantId: t.tenantId, name: t.name, type: t.type, typeLabel: ty.label || t.type, regulator: t.regulator, regulatorName: REGULATORS[t.regulator] || t.regulator,
        status: t.status, licenceStatus: t.licenceStatus, currencies: t.currencies, county: t.county, createdAt: t.createdAt };
}
function tenantOwnerView(t) {
    const staff = Object.values(staffAll()).filter(s => s.tenantId === t.tenantId);
    return { ...tenantPublic(t), licenceNumber: t.licenceNumber, licenceLabel: (TENANT_TYPES[t.type] || {}).licenceLabel, address: t.address, ownerName: t.ownerName, ownerEmail: t.ownerEmail, ownerPhone: t.ownerPhone,
        staffCount: staff.length, reviewedBy: t.reviewedBy || null, reviewedAt: t.reviewedAt || null, reviewNote: t.reviewNote || null, licenceVerifiedBy: t.licenceVerifiedBy || null, licenceVerifiedAt: t.licenceVerifiedAt || null,
        suspendedReason: t.suspendedReason || null, billing: t.billing || { plan: 'TRIAL', status: 'TRIAL' } };
}
const staffView = (s) => ({ staffId: s.staffId, tenantId: s.tenantId, name: s.name, email: s.email, role: s.staffRole, roleLabel: (STAFF_ROLES[s.staffRole] || {}).label, disabled: !!s.disabled, createdAt: s.createdAt, lastLoginAt: s.lastLoginAt || null, mustChangePassword: !!s.mustChangePassword });

// ============================================================================
// PUBLIC: self-registration (no sign-in). An institution applies; it cannot transact until the owner approves it.
// ============================================================================
router.post('/register', (req, res) => {
    const b = req.body || {};
    const name = clean(b.name, 120); if (name.length < 3) return bad(res, 'Enter the institution\'s full legal name.');
    const type = String(b.type || '').toUpperCase(); if (!has(TENANT_TYPES, type)) return bad(res, `type must be one of: ${Object.keys(TENANT_TYPES).join(', ')}.`);
    const ty = TENANT_TYPES[type], regulator = ty.regulator;
    const licenceNumber = clean(b.licenceNumber, 60); if (licenceNumber.length < 2) return bad(res, `Enter your ${ty.licenceLabel}.`);
    const county = clean(b.county, 60); if (county.length < 2) return bad(res, 'Enter the county where the institution operates.');
    const address = clean(b.address, 200); if (address.length < 4) return bad(res, 'Enter the physical address (a real premises is required by the regulator).');
    const ownerName = clean(b.ownerName, 100); if (ownerName.length < 3) return bad(res, 'Enter the administrator\'s full name.');
    const ownerEmail = clean(b.ownerEmail, 120).toLowerCase(); if (!emailOk(ownerEmail)) return bad(res, 'Enter a valid administrator email.');
    const ownerPhone = clean(b.ownerPhone, 20); if (!(D.isPhone ? D.isPhone(ownerPhone) : /^\+?[0-9 ()-]{7,20}$/.test(ownerPhone))) return bad(res, 'Enter a valid administrator phone number.');
    const chosenPw = String(b.password == null ? '' : b.password); if (!pwStrong(chosenPw)) return bad(res, 'Choose an administrator password of 8 to 128 characters.');
    // currencies: declared now, defaulted by type; KES is always present
    let currencies = Array.isArray(b.currencies) ? b.currencies.map(CUR).filter(Boolean) : [];
    if (!currencies.length) currencies = ty.defaultCurrencies.slice();
    if (!ty.multiCurrency) currencies = ['KES'];
    currencies = [...new Set(['KES', ...currencies])].slice(0, 25);

    const S = state();
    // (email is unique per institution, checked after the tenant id exists is not needed here: a brand-new tenant has no staff yet)
    if (Object.values(S.tenants).length >= 5000) return bad(res, 'Registration is temporarily closed. Please try again later.', 503);

    S.seq++; const tenantId = `TEN-${String(S.seq).padStart(5, '0')}`, t0 = now();
    const t = { tenantId, name, type, regulator, licenceNumber, licenceStatus: 'LICENCE_DECLARED', county, address, currencies,
        ownerName, ownerEmail, ownerPhone, status: 'PENDING_REVIEW', createdAt: t0, billing: { plan: 'TRIAL', status: 'TRIAL', since: t0 } };
    S.tenants[tenantId] = t;
    // create the institution's first administrator with the password THEY chose (sealed to this tenant, usable once approved)
    S.staffSeq++; const staffId = `STF-${String(S.staffSeq).padStart(6, '0')}`;
    const pw = makePw(chosenPw);
    S.staff[staffId] = { staffId, tenantId, name: ownerName, email: ownerEmail, staffRole: 'TENANT_ADMIN', salt: pw.salt, hash: pw.hash, mustChangePassword: false, disabled: false, createdAt: t0, createdBy: 'SELF_REGISTRATION' };
    audit('PLATFORM_TENANT_REGISTERED', { tenantId, type, regulator, licenceNumber, by: ownerEmail });
    dirty();
    ok(res, { message: `Application received for "${name}". It is PENDING REVIEW. You cannot sign in until the platform administrator approves your institution and verifies your licence.`,
        tenant: tenantPublic(t), adminEmail: ownerEmail,
        note: 'You can sign in with the email and password you set, as soon as the platform administrator approves your institution. Your licence is recorded as DECLARED, not verified: it will be checked against the ' + (REGULATORS[regulator]) + ' public register before your institution goes live.' });
});
router.get('/types', (req, res) => ok(res, { types: Object.entries(TENANT_TYPES).map(([k, v]) => ({ id: k, label: v.label, regulator: v.regulator, regulatorName: REGULATORS[v.regulator], multiCurrency: v.multiCurrency, defaultCurrencies: v.defaultCurrencies, licenceLabel: v.licenceLabel })), regulators: REGULATORS }));

// ============================================================================
// TENANT STAFF: sign-in (sealed to one institution)
// ============================================================================
router.post('/staff/login', (req, res) => {
    const b = req.body || {}, email = clean(b.email, 120).toLowerCase(), pw = String(b.password == null ? '' : b.password), tid = clean(b.tenantId, 20);
    if (!emailOk(email) || !pw) return bad(res, 'Enter your email and password.');
    if (!isSafeKey(tid)) return bad(res, 'Choose your institution.');
    // staff are identified by institution + email (so two institutions may each have, say, john@gmail.com)
    const rec = Object.values(staffAll()).find(s => s.email === email && s.tenantId === tid);
    if (!rec || rec.disabled || !checkPw(pw, rec)) { audit('PLATFORM_STAFF_LOGIN_FAILED', { email, tenantId: tid }); return bad(res, 'Invalid institution, email or password.', 401); }
    const t = tenant(rec.tenantId);
    if (!t) return bad(res, 'Your institution was not found. Contact support.', 404);
    if (t.status === 'PENDING_REVIEW') return bad(res, 'Your institution is still waiting for the platform administrator to approve it.', 403);
    if (t.status !== 'ACTIVE') return bad(res, `Your institution is ${String(t.status).toLowerCase().replace('_', ' ')}. Contact the platform administrator.`, 403);
    rec.lastLoginAt = now();
    const engineRole = (STAFF_ROLES[rec.staffRole] || {}).engineRole || 'CENTRAL_BANK_AUDITOR';
    // the token carries BOTH the engine role (so ledger/compliance auth works) AND the tenant + staff role (so we can seal it)
    const token = D.signJwt({ sub: rec.email, email: rec.email, role: engineRole, tenantId: rec.tenantId, staffId: rec.staffId, staffRole: rec.staffRole, platform: false }, 8 * 3600);
    audit('PLATFORM_STAFF_LOGIN', { staffId: rec.staffId, tenantId: rec.tenantId, role: rec.staffRole });
    dirty();
    ok(res, { token, businessId: rec.tenantId, tenant: tenantPublic(t), staff: staffView(rec), mustChangePassword: !!rec.mustChangePassword, message: `Signed in to ${t.name}.` });
});
router.post('/staff/change-password', tenantAuth(), (req, res) => {
    const b = req.body || {}, rec = staffAll()[req.staff.staffId];
    if (!rec) return bad(res, 'Account not found.', 404);
    if (!rec.mustChangePassword && !checkPw(String(b.currentPassword == null ? '' : b.currentPassword), rec)) return bad(res, 'Your current password is wrong.', 403);
    const next = String(b.newPassword == null ? '' : b.newPassword);
    if (!pwStrong(next)) return bad(res, 'Choose a new password of 8 to 128 characters.');
    const pw = makePw(next); rec.salt = pw.salt; rec.hash = pw.hash; rec.mustChangePassword = false;
    audit('PLATFORM_STAFF_PASSWORD_CHANGED', { staffId: rec.staffId, tenantId: rec.tenantId }); dirty();
    ok(res, { message: 'Password changed.' });
});
router.get('/staff/me', tenantAuth(), (req, res) => ok(res, { staff: staffView(req.staff.rec), tenant: tenantPublic(req.tenant), businessId: req.tenant.tenantId }));

// ============================================================================
// TENANT ADMIN: manage this institution's own staff (sealed to their tenant)
// ============================================================================
router.get('/my/staff', tenantAuth('TENANT_ADMIN', 'COMPLIANCE', 'AUDITOR'), tenantGuard, (req, res) =>
    ok(res, { staff: Object.values(staffAll()).filter(s => s.tenantId === req.tenant.tenantId).sort((a, b) => a.createdAt - b.createdAt).map(staffView), roles: Object.entries(STAFF_ROLES).map(([k, v]) => ({ id: k, label: v.label })) }));
router.post('/my/staff', tenantAuth('TENANT_ADMIN'), tenantGuard, (req, res) => {
    const b = req.body || {}, S = state(), name = clean(b.name, 100), email = clean(b.email, 120).toLowerCase(), role = String(b.role || '').toUpperCase();
    if (name.length < 3) return bad(res, 'Enter the staff member\'s full name.');
    if (!emailOk(email)) return bad(res, 'Enter a valid email.');
    if (!has(STAFF_ROLES, role) || role === 'TENANT_ADMIN' && Object.values(S.staff).filter(s => s.tenantId === req.tenant.tenantId && s.staffRole === 'TENANT_ADMIN' && !s.disabled).length >= 3) {
        if (!has(STAFF_ROLES, role)) return bad(res, `role must be one of: ${Object.keys(STAFF_ROLES).join(', ')}.`);
        return bad(res, 'An institution can have at most 3 administrators.', 409);
    }
    if (Object.values(S.staff).some(s => s.email === email && s.tenantId === req.tenant.tenantId)) return bad(res, 'That email is already in use at this institution.', 409);
    if (Object.values(S.staff).filter(s => s.tenantId === req.tenant.tenantId && !s.disabled).length >= 200) return bad(res, 'Staff limit reached for this institution.', 409);
    S.staffSeq++; const staffId = `STF-${String(S.staffSeq).padStart(6, '0')}`;
    const tempPw = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) + '7b', pw = makePw(tempPw);
    S.staff[staffId] = { staffId, tenantId: req.tenant.tenantId, name, email, staffRole: role, salt: pw.salt, hash: pw.hash, mustChangePassword: true, disabled: false, createdAt: now(), createdBy: req.staff.email };
    audit('PLATFORM_STAFF_CREATED', { staffId, tenantId: req.tenant.tenantId, role, by: req.staff.email }); dirty();
    ok(res, { message: `${name} added as ${(STAFF_ROLES[role] || {}).label}. Give them this one-time password; they must change it on first sign-in.`, staff: staffView(S.staff[staffId]), temporaryPassword: tempPw });
});
router.post('/my/staff/:staffId', tenantAuth('TENANT_ADMIN'), tenantGuard, (req, res) => {
    const rec = staffAll()[req.params.staffId], b = req.body || {};
    if (!rec || rec.tenantId !== req.tenant.tenantId) return bad(res, 'Staff member not found.', 404);
    const act = String(b.action || '');
    if (act === 'disable') { if (rec.staffId === req.staff.staffId) return bad(res, 'You cannot disable your own account.', 409); if (rec.staffRole === 'TENANT_ADMIN' && Object.values(staffAll()).filter(s => s.tenantId === req.tenant.tenantId && s.staffRole === 'TENANT_ADMIN' && !s.disabled).length <= 1) return bad(res, 'An institution must keep at least one administrator.', 409); rec.disabled = true; }
    else if (act === 'enable') rec.disabled = false;
    else if (act === 'reset-password') { const tempPw = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) + '5c', pw = makePw(tempPw); rec.salt = pw.salt; rec.hash = pw.hash; rec.mustChangePassword = true; audit('PLATFORM_STAFF_PW_RESET', { staffId: rec.staffId, tenantId: rec.tenantId, by: req.staff.email }); dirty(); return ok(res, { message: `Password reset for ${rec.name}. Give them this one-time password.`, staff: staffView(rec), temporaryPassword: tempPw }); }
    else return bad(res, 'action must be disable, enable or reset-password.');
    audit('PLATFORM_STAFF_' + act.toUpperCase(), { staffId: rec.staffId, tenantId: rec.tenantId, by: req.staff.email }); dirty();
    ok(res, { message: `${rec.name} ${act}d.`, staff: staffView(rec) });
});
// a tenant admin can add a currency (never remove one with transactions); forex only
router.post('/my/currencies', tenantAuth('TENANT_ADMIN'), tenantGuard, (req, res) => {
    const t = req.tenant, ty = TENANT_TYPES[t.type] || {};
    if (!ty.multiCurrency) return bad(res, 'This institution type uses KES only.', 409);
    const add = CUR(req.body && req.body.currency); if (!add) return bad(res, 'Enter a 3-letter currency code, e.g. USD.');
    if (t.currencies.includes(add)) return bad(res, 'That currency is already enabled.', 409);
    if (t.currencies.length >= 25) return bad(res, 'Currency limit reached.', 409);
    t.currencies.push(add); audit('PLATFORM_TENANT_CURRENCY_ADDED', { tenantId: t.tenantId, currency: add, by: req.staff.email }); dirty();
    ok(res, { message: `${add} enabled.`, currencies: t.currencies });
});

// ============================================================================
// PLATFORM OWNER (you): approve / verify / suspend tenants, and break-glass
// ============================================================================
router.get('/tenants', platformOwner, (req, res) => {
    const q = String((req.query && req.query.q) || '').toLowerCase(), status = String((req.query && req.query.status) || '').toUpperCase();
    let list = Object.values(tenants());
    if (status && TENANT_STATUS.includes(status)) list = list.filter(t => t.status === status);
    if (q) list = list.filter(t => t.tenantId.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || String(t.licenceNumber).toLowerCase().includes(q) || String(t.ownerEmail).includes(q));
    list.sort((a, b) => (a.status === 'PENDING_REVIEW' ? -1 : 0) - (b.status === 'PENDING_REVIEW' ? -1 : 0) || b.createdAt - a.createdAt);
    const all = Object.values(tenants());
    ok(res, { tenants: list.slice(0, 500).map(tenantOwnerView), counts: { total: all.length, pending: all.filter(t => t.status === 'PENDING_REVIEW').length, active: all.filter(t => t.status === 'ACTIVE').length, suspended: all.filter(t => t.status === 'SUSPENDED').length, licenceUnverified: all.filter(t => t.licenceStatus === 'LICENCE_DECLARED').length } });
});
router.get('/tenants/:id', platformOwner, (req, res) => { const t = tenant(req.params.id); if (!t) return bad(res, 'Tenant not found.', 404); ok(res, { tenant: tenantOwnerView(t), staff: Object.values(staffAll()).filter(s => s.tenantId === t.tenantId).map(staffView), register: t.regulator === 'SASRA' ? 'https://www.sasra.go.ke' : 'https://www.centralbank.go.ke' }); });
router.post('/tenants/:id/approve', platformOwner, (req, res) => {
    const t = tenant(req.params.id); if (!t) return bad(res, 'Tenant not found.', 404);
    if (t.status !== 'PENDING_REVIEW' && t.status !== 'SUSPENDED') return bad(res, `This tenant is ${t.status}.`, 409);
    t.status = 'ACTIVE'; t.reviewedBy = clean(req.pf.email || req.pf.sub, 80); t.reviewedAt = now(); t.suspendedReason = null;
    audit('PLATFORM_TENANT_APPROVED', { tenantId: t.tenantId, by: t.reviewedBy, licenceStatus: t.licenceStatus }); dirty();
    ok(res, { message: `${t.name} is now ACTIVE. Its administrator can sign in.${t.licenceStatus !== 'LICENCE_VERIFIED' ? ' Note: the licence is still DECLARED, not verified. Verify it against the public register.' : ''}`, tenant: tenantOwnerView(t) });
});
router.post('/tenants/:id/reject', platformOwner, (req, res) => {
    const t = tenant(req.params.id); if (!t) return bad(res, 'Tenant not found.', 404);
    if (t.status === 'ACTIVE') return bad(res, 'Suspend an active tenant instead of rejecting it.', 409);
    t.status = 'REJECTED'; t.reviewedBy = clean(req.pf.email || req.pf.sub, 80); t.reviewedAt = now(); t.reviewNote = clean(req.body && req.body.reason, 200);
    audit('PLATFORM_TENANT_REJECTED', { tenantId: t.tenantId, by: t.reviewedBy, reason: t.reviewNote }); dirty();
    ok(res, { message: `${t.name} rejected.`, tenant: tenantOwnerView(t) });
});
router.post('/tenants/:id/suspend', platformOwner, (req, res) => {
    const t = tenant(req.params.id); if (!t) return bad(res, 'Tenant not found.', 404);
    if (t.status !== 'ACTIVE') return bad(res, 'Only an active tenant can be suspended.', 409);
    t.status = 'SUSPENDED'; t.suspendedReason = clean(req.body && req.body.reason, 200) || 'Suspended by the platform administrator';
    audit('PLATFORM_TENANT_SUSPENDED', { tenantId: t.tenantId, by: clean(req.pf.email || req.pf.sub, 80), reason: t.suspendedReason }); dirty();
    ok(res, { message: `${t.name} suspended. Its staff can no longer sign in or transact.`, tenant: tenantOwnerView(t) });
});
router.post('/tenants/:id/licence', platformOwner, (req, res) => {
    const t = tenant(req.params.id); if (!t) return bad(res, 'Tenant not found.', 404);
    const decision = String((req.body && req.body.decision) || '').toUpperCase();
    if (!['VERIFIED', 'REJECTED', 'DECLARED'].includes(decision)) return bad(res, 'decision must be VERIFIED, REJECTED or DECLARED.');
    const note = clean(req.body && req.body.note, 200);
    if (decision === 'VERIFIED') {
        if (note.length < 4) return bad(res, 'Record how you verified the licence (e.g. "checked CBK register, licence FX/123, dated ...").');
        t.licenceStatus = 'LICENCE_VERIFIED'; t.licenceVerifiedBy = clean(req.pf.email || req.pf.sub, 80); t.licenceVerifiedAt = now(); t.licenceVerifyNote = note;
    } else if (decision === 'REJECTED') { t.licenceStatus = 'LICENCE_REJECTED'; t.licenceVerifyNote = note; }
    else { t.licenceStatus = 'LICENCE_DECLARED'; t.licenceVerifiedBy = null; t.licenceVerifiedAt = null; }
    audit('PLATFORM_TENANT_LICENCE_' + decision, { tenantId: t.tenantId, by: clean(req.pf.email || req.pf.sub, 80), regulator: t.regulator, licenceNumber: t.licenceNumber, note }); dirty();
    ok(res, { message: `Licence for ${t.name} marked ${t.licenceStatus.replace('LICENCE_', '').toLowerCase()}.`, tenant: tenantOwnerView(t) });
});
// transparent break-glass: the owner opens one tenant's books. It is audited and the reason is kept. Never silent.
router.post('/tenants/:id/break-glass', platformOwner, (req, res) => {
    const t = tenant(req.params.id); if (!t) return bad(res, 'Tenant not found.', 404);
    const reason = clean(req.body && req.body.reason, 200); if (reason.length < 10) return bad(res, 'Give the reason for opening this institution\'s books (at least 10 characters). It is recorded.');
    const ttlMin = Math.min(Math.max(Number(req.body && req.body.minutes) || 30, 5), 120);
    const rec = { at: now(), tenantId: t.tenantId, by: clean(req.pf.email || req.pf.sub, 80), reason, minutes: ttlMin };
    const S = state(); S.breakGlass.push(rec); if (S.breakGlass.length > 5000) S.breakGlass.shift();
    audit('PLATFORM_BREAK_GLASS', rec); dirty();
    // a short-lived read-only token scoped to that tenant (auditor role => read only in the ledger/compliance engine)
    const token = D.signJwt({ sub: req.pf.email || req.pf.sub, email: req.pf.email || req.pf.sub, role: 'CENTRAL_BANK_AUDITOR', tenantId: t.tenantId, platform: true, breakGlass: true }, ttlMin * 60);
    ok(res, { message: `Break-glass access to ${t.name} granted for ${ttlMin} minutes (read only). This is recorded in the audit chain and visible to the institution.`, token, businessId: t.tenantId, expiresInMinutes: ttlMin });
});
router.get('/break-glass-log', platformOwner, (req, res) => ok(res, { log: state().breakGlass.slice(-200).reverse() }));
// a tenant can see when the platform owner opened its books (transparency)
router.get('/my/break-glass-log', tenantAuth('TENANT_ADMIN', 'COMPLIANCE', 'AUDITOR'), tenantGuard, (req, res) => ok(res, { log: state().breakGlass.filter(x => x.tenantId === req.tenant.tenantId).slice(-100).reverse().map(x => ({ at: x.at, by: x.by, reason: x.reason, minutes: x.minutes })) }));

// snapshot of the platform for the owner's master control / monitoring
function platformStats() {
    const all = Object.values(tenants()), s = Object.values(staffAll());
    return { tenants: all.length, pending: all.filter(t => t.status === 'PENDING_REVIEW').length, active: all.filter(t => t.status === 'ACTIVE').length, suspended: all.filter(t => t.status === 'SUSPENDED').length,
        licenceVerified: all.filter(t => t.licenceStatus === 'LICENCE_VERIFIED').length, licenceDeclared: all.filter(t => t.licenceStatus === 'LICENCE_DECLARED').length,
        byType: Object.keys(TENANT_TYPES).reduce((o, k) => { const n = all.filter(t => t.type === k).length; if (n) o[k] = n; return o; }, {}), staff: s.length, breakGlass30d: state().breakGlass.filter(x => now() - x.at < 30 * 86400000).length };
}

// which tenants are active (server.js uses this to decide whether a tenant may transact) and how to set up a new tenant's books
function activeTenantIds() { return Object.values(tenants()).filter(t => t.status === 'ACTIVE').map(t => t.tenantId); }
function tenantConfig(id) { const t = tenant(id); if (!t) return null; const ty = TENANT_TYPES[t.type] || {}; return { tenantId: id, name: t.name, type: t.type, coa: ty.coa || 'GENERIC', currencies: t.currencies, regulator: t.regulator, status: t.status, licenceStatus: t.licenceStatus }; }

module.exports = router;
module.exports.init = init;
module.exports.stats = platformStats;
module.exports.activeTenantIds = activeTenantIds;
module.exports.tenantConfig = tenantConfig;
// the admin/ledger engine asks for this: every ACTIVE institution, as a corridor with its chart-of-accounts kind and currencies
module.exports.activeCorridors = () => Object.values(tenants()).filter(t => t.status === 'ACTIVE').map(t => { const ty = TENANT_TYPES[t.type] || {}; return { tenantId: t.tenantId, name: t.name, type: t.type, coa: ty.coa || 'GENERIC', currencies: t.currencies || ['KES'] }; });
module.exports.TENANT_TYPES = TENANT_TYPES;
module.exports.STAFF_ROLES = STAFF_ROLES;
module.exports._hashPw = makePw;              // for tests only