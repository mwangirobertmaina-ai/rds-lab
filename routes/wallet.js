'use strict';
// ============================================================================
// routes/wallet.js — RDS WALLET (Phase 1: accountable ledger, simulated money). Mounted at /api/wallet.
//
// WHAT IT IS
//   A wallet where every user holds cash they can withdraw anytime. Customer money is held apart from the
//   platform's revenue, and every shilling is provable by a DOUBLE-ENTRY LEDGER — the same accounting discipline
//   the rest of RDS uses for "Books balance".
//
// THE ONE INVARIANT (must always hold, to the cent):
//       DESIGNATED (cash held in trust)  ==  sum of all user WALLET balances  +  REVENUE (earned by the platform)
//   Every transaction posts entries that sum to zero, so the invariant is preserved by construction. The
//   reconcile endpoint re-derives every balance from the raw ledger and proves it — a mismatch means a bug or
//   theft, and it is flagged, never hidden.
//
// PHASE 1 = SIMULATED money: top-ups and withdrawals settle instantly in-memory; no real M-Pesa moves yet.
//   Real top-up (STK Push) and withdrawal (B2C) plug into the same tx states (PENDING -> SETTLED / FAILED) later.
//
// IMPORTANT: holding the public's money in a wallet is a regulated activity (CBK e-money / payment service).
//   This module is the accountable engine; going live with real funds needs a CBK licence or a licensed
//   bank/PSP trust account. This is not legal advice.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();

let D = {}, ready = false, file = null, saveTimer = null;
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newId = (p) => `${p}_${now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const fail = (res, code, msg, extra) => res.status(code).json({ success: false, error: msg, ...(extra || {}) });
const kes = (c) => Math.round(c) / 100;
const parseAmt = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) && n > 0 && n <= 10000000 ? Math.round(n * 100) : null; };

// ---------------------------------------------------------------------------
// state (persisted). The LEDGER is the source of truth; `bal` is a cache the reconcile re-derives and checks.
// ---------------------------------------------------------------------------
const blank = () => ({ v: 1, users: {}, phones: {}, sessions: {}, ledger: [], txs: {}, txSeq: 0, bal: {}, stkPending: {}, b2cPending: {} });
let S = blank();
function load() { try { S = Object.assign(blank(), JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') console.error('[WALLET] could not read wallet.snapshot:', e.message); } }
function saveNow() { if (!file) return; try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, file); } catch (e) { console.error('[WALLET] save failed:', e.message); } }
const dirty = () => { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 800); if (saveTimer.unref) saveTimer.unref(); };

// ---------------------------------------------------------------------------
// rate limits + auth
// ---------------------------------------------------------------------------
const hits = new Map();
function limited(key, max, ms) { const t = now(), a = (hits.get(key) || []).filter(x => t - x < ms); if (a.length >= max) { hits.set(key, a); return true; } a.push(t); hits.set(key, a); return false; }
const ipOf = (req) => String(req.ip || (req.socket && req.socket.remoteAddress) || 'x');
const slow = (res, what) => fail(res, 429, `Too many ${what}. Please wait a moment.`);
const bearer = (req) => { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : null; };
function userOf(req) { const t = bearer(req); if (!t || !/^[A-Za-z0-9_-]{30,100}$/.test(t)) return null; const s = S.sessions[sha(t)]; if (!s || s.exp < now()) return null; return S.users[s.uid] || null; }
const auth = (req, res, next) => { const u = userOf(req); if (!u) return fail(res, 401, 'Please sign in.'); req.u = u; next(); };
const adminAuth = (req, res, next) => { const chain = (D.adminAuth || []).slice(); if (!chain.length) return fail(res, 503, 'Not available.'); let i = 0; const nx = (e) => { if (e) return next(e); const f = chain[i++]; if (!f) return next(); f(req, res, nx); }; nx(); };

// ---------------------------------------------------------------------------
// THE LEDGER (double-entry). Raw signed cents per account; asset (DESIGNATED) positive, liability/equity
// (WALLET:*, REVENUE) carried negative so a balanced transaction's postings sum to EXACTLY zero.
//   displayed wallet balance = -(raw WALLET:uid) ; designated = raw DESIGNATED ; revenue = -(raw REVENUE)
// ---------------------------------------------------------------------------
const wacct = (uid) => 'WALLET:' + uid;
const rawBal = (acct) => S.bal[acct] || 0;
const walletBalance = (uid) => -rawBal(wacct(uid));
const designated = () => rawBal('DESIGNATED');
const revenue = () => -rawBal('REVENUE');
function userByPhone(phone) { const id = S.phones[phone]; return id ? S.users[id] : null; }
function ensureUserByPhone(phone, name) { let u = userByPhone(phone); if (!u) { const id = newId('W'); u = { id, phone, name: name || '', createdAt: now() }; S.users[id] = u; S.phones[phone] = id; } return u; }

function makeTx(kind, uid, amountCents, postings, meta) {
    // guard: postings MUST sum to zero (double-entry). Refuse to record an unbalanced transaction.
    const sum = postings.reduce((s, p) => s + p.d, 0);
    if (sum !== 0) throw new Error('refused: unbalanced transaction (postings must sum to zero)');
    S.txSeq++; const id = `WTX-${String(S.txSeq).padStart(8, '0')}`;
    const tx = { id, kind, uid: uid || null, amountCents, feeCents: (meta && meta.feeCents) || 0, status: 'PENDING', postings, meta: meta || {}, createdAt: now(), settledAt: null };
    S.txs[id] = tx; return tx;
}
function settle(tx) {
    if (tx.status !== 'PENDING') return tx;
    for (const p of tx.postings) { S.bal[p.account] = (S.bal[p.account] || 0) + p.d; S.ledger.push({ txId: tx.id, account: p.account, d: p.d, at: now() }); }
    if (S.ledger.length > 500000) S.ledger.splice(0, S.ledger.length - 500000);
    tx.status = 'SETTLED'; tx.settledAt = now();
    if (D.appendAudit) D.appendAudit('WALLET_' + tx.kind, { tx: tx.id, uid: tx.uid, amount: kes(tx.amountCents) });
    return tx;
}
function failTx(tx, reason) { if (tx.status === 'PENDING') { tx.status = 'FAILED'; tx.failedReason = clean(reason, 120); tx.settledAt = now(); } return tx; }

const WITHDRAW_FEE_RATE = Math.min(Math.max(Number(process.env.WALLET_WITHDRAW_FEE_RATE) || 0, 0), 0.1);   // 0..10%, default 0
const txView = (t) => ({ id: t.id, kind: t.kind, status: t.status, amount: kes(t.amountCents), fee: kes(t.feeCents), at: t.createdAt, settledAt: t.settledAt || null, meta: t.meta && t.meta.public ? t.meta.public : undefined });

// ---------------------------------------------------------------------------
// M-PESA (Safaricom Daraja) — STK Push for real top-ups. Configured by env; when not set, top-ups stay simulated.
//   MPESA_ENV=sandbox|production  MPESA_CONSUMER_KEY  MPESA_CONSUMER_SECRET  MPESA_SHORTCODE  MPESA_PASSKEY
//   MPESA_CALLBACK_URL (https ...  /api/wallet/mpesa/callback)   MPESA_TX_TYPE=CustomerPayBillOnline|CustomerBuyGoodsOnline
// ---------------------------------------------------------------------------
const MPESA = {
    env: process.env.MPESA_ENV === 'production' ? 'production' : 'sandbox',
    key: process.env.MPESA_CONSUMER_KEY || '', secret: process.env.MPESA_CONSUMER_SECRET || '',
    shortcode: process.env.MPESA_SHORTCODE || '', passkey: process.env.MPESA_PASSKEY || '', tillNumber: process.env.MPESA_TILL_NUMBER || '',
    callbackUrl: process.env.MPESA_CALLBACK_URL || '', txType: process.env.MPESA_TX_TYPE || 'CustomerPayBillOnline',
    // B2C (paying money OUT to a phone): needs an Initiator + encrypted SecurityCredential generated from the Daraja portal.
    initiator: process.env.MPESA_INITIATOR_NAME || '', securityCred: process.env.MPESA_SECURITY_CREDENTIAL || '',
    b2cShortcode: process.env.MPESA_B2C_SHORTCODE || process.env.MPESA_SHORTCODE || '', b2cCommand: process.env.MPESA_B2C_COMMAND || 'BusinessPayment',
    b2cResultUrl: process.env.MPESA_B2C_RESULT_URL || '', b2cTimeoutUrl: process.env.MPESA_B2C_TIMEOUT_URL || ''
};
const mpesaBase = () => MPESA.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const mpesaEnvConfigured = () => !!(MPESA.key && MPESA.secret && MPESA.shortcode && MPESA.passkey && MPESA.callbackUrl);
const mpesaConfigured = () => !!D.mpesaClient || mpesaEnvConfigured();        // D.mpesaClient lets tests inject a fake
const mpesaClient = () => D.mpesaClient || { stkPush: darajaStkPush };
function mpesaTs() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
async function darajaToken() {
    const auth = Buffer.from(MPESA.key + ':' + MPESA.secret).toString('base64');
    const r = await fetch(mpesaBase() + '/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: 'Basic ' + auth } });
    const d = await r.json().catch(() => null); if (!d || !d.access_token) throw new Error('M-Pesa auth failed'); return d.access_token;
}
// Build the STK Push body. PAYBILL uses the paybill number for everything; a TILL (Buy Goods) uses the store number
// for the password + BusinessShortCode and the till number as PartyB. MPESA_SHORTCODE is the store/HO number; MPESA_TILL_NUMBER the till.
function buildStkBody(ts, { amountKes, phone, accountRef, desc }) {
    const msisdn = String(phone).replace(/^\+/, '');
    const isTill = MPESA.txType === 'CustomerBuyGoodsOnline';
    const storeNo = MPESA.shortcode;                              // the number the passkey was issued against
    const partyB = isTill ? (MPESA.tillNumber || MPESA.shortcode) : MPESA.shortcode;
    const password = Buffer.from(storeNo + MPESA.passkey + ts).toString('base64');
    return { BusinessShortCode: storeNo, Password: password, Timestamp: ts, TransactionType: MPESA.txType, Amount: Math.round(amountKes),
        PartyA: msisdn, PartyB: partyB, PhoneNumber: msisdn, CallBackURL: MPESA.callbackUrl, AccountReference: String(accountRef).slice(0, 12), TransactionDesc: String(desc || 'Wallet top-up').slice(0, 13) };
}
async function darajaStkPush({ amountKes, phone, accountRef, desc }) {
    const token = await darajaToken(), ts = mpesaTs();
    const body = buildStkBody(ts, { amountKes, phone, accountRef, desc });
    const r = await fetch(mpesaBase() + '/mpesa/stkpush/v1/processrequest', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => null);
    if (d && d.ResponseCode === '0' && d.CheckoutRequestID) return { ok: true, checkoutId: d.CheckoutRequestID };
    return { ok: false, error: (d && (d.errorMessage || d.ResponseDescription)) || 'STK push failed' };
}
const b2cEnvConfigured = () => !!(MPESA.key && MPESA.secret && MPESA.initiator && MPESA.securityCred && MPESA.b2cShortcode && MPESA.b2cResultUrl);
const b2cConfigured = () => !!(D.mpesaClient && D.mpesaClient.b2cSend) || b2cEnvConfigured();
const b2cClient = () => D.mpesaClient || { stkPush: darajaStkPush, b2cSend: darajaB2C };
async function darajaB2C({ amountKes, phone, remarks, occasion }) {
    const token = await darajaToken(), msisdn = String(phone).replace(/^\+/, '');
    const body = { InitiatorName: MPESA.initiator, SecurityCredential: MPESA.securityCred, CommandID: MPESA.b2cCommand, Amount: Math.round(amountKes),
        PartyA: MPESA.b2cShortcode, PartyB: msisdn, Remarks: String(remarks || 'Wallet withdrawal').slice(0, 100), QueueTimeOutURL: MPESA.b2cTimeoutUrl || MPESA.b2cResultUrl, ResultURL: MPESA.b2cResultUrl, Occasion: String(occasion || '').slice(0, 100) };
    const r = await fetch(mpesaBase() + '/mpesa/b2c/v1/paymentrequest', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => null);
    if (d && d.ResponseCode === '0' && (d.ConversationID || d.OriginatorConversationID)) return { ok: true, conversationId: d.ConversationID || d.OriginatorConversationID };
    return { ok: false, error: (d && (d.errorMessage || d.ResponseDescription)) || 'B2C request failed' };
}
// return money reserved for a withdrawal back to the user (the payout never left): WITHDRAW_PENDING -> WALLET:U
function reverseReserve(origTx, uid, amtCents, reason) {
    const tx = makeTx('WITHDRAW_REVERSAL', uid, amtCents, [{ account: 'WITHDRAW_PENDING', d: +amtCents }, { account: wacct(uid), d: -amtCents }], { public: { via: 'MPESA_B2C', state: 'REVERSED', ref: origTx ? origTx.id : null } });
    settle(tx);
    if (origTx) origTx.meta.public = Object.assign({}, origTx.meta.public, { state: 'FAILED', reason: clean(reason, 120) });
    return tx;
}

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------
router.init = function init(deps) {
    D = deps || {}; if (!D.dataDir) throw new Error('wallet module needs dataDir');
    fs.mkdirSync(D.dataDir, { recursive: true }); file = path.join(D.dataDir, 'wallet.snapshot'); load(); ready = true;
    process.on('exit', () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveNow(); });
};
router.use((req, res, next) => (ready ? next() : fail(res, 503, 'The wallet is starting. Try again in a moment.')));

// ---------------------------------------------------------------------------
// SIGN IN (phone + one-time code via the server's OTP system; 1234 in test mode)
// ---------------------------------------------------------------------------
router.post('/auth/request-code', (req, res) => {
    const b = req.body || {};
    const phone = D.normalizePhone ? D.normalizePhone(String(b.phone || '')) : String(b.phone || '');
    if (!/^\+\d{9,15}$/.test(phone)) return fail(res, 400, 'Enter a valid phone number, for example 0712 345 678.');
    if (limited('code:' + phone, 3, 600000) || limited('codeip:' + ipOf(req), 10, 3600000)) return slow(res, 'code requests');
    const email = (typeof b.email === 'string' && /.+@.+\..+/.test(b.email.trim())) ? b.email.trim().slice(0, 120) : null;
    const channels = Array.isArray(b.channels) ? b.channels.map(x => String(x).toLowerCase()).filter(x => ['sms', 'whatsapp', 'email'].includes(x)) : null;
    D.issueOtp(phone, { email, channels: channels && channels.length ? channels : null });
    res.json({ success: true, phone, message: D.testMode ? 'Test mode: use code 1234.' : 'We sent your code to the channel(s) you chose.' });
});
router.post('/auth/verify', (req, res) => {
    const b = req.body || {}, phone = D.normalizePhone ? D.normalizePhone(String(b.phone || '')) : String(b.phone || ''), code = String(b.code || '').trim();
    if (!/^\+\d{9,15}$/.test(phone) || !/^\d{4,6}$/.test(code)) return fail(res, 400, 'Enter your phone number and the code you received.');
    if (limited('verify:' + ipOf(req), 30, 600000)) return slow(res, 'attempts');
    if (!D.checkOtp(phone, code)) return fail(res, 400, 'That code is wrong or has expired.');
    let u = S.phones[phone] && S.users[S.phones[phone]];
    if (!u) { const id = newId('W'); u = { id, phone, name: clean(b.name, 60) || '', createdAt: now() }; S.users[id] = u; S.phones[phone] = id; if (D.appendAudit) D.appendAudit('WALLET_ACCOUNT_CREATED', { uid: id }); }
    const tok = crypto.randomBytes(32).toString('base64url'); S.sessions[sha(tok)] = { uid: u.id, at: now(), exp: now() + 12 * 3600000 };
    for (const [h, s] of Object.entries(S.sessions)) if (s.exp < now()) delete S.sessions[h];
    dirty(); res.json({ success: true, token: tok, me: meView(u) });
});
router.post('/auth/logout', (req, res) => { const t = bearer(req); if (t) delete S.sessions[sha(t)]; dirty(); res.json({ success: true }); });
function meView(u) { return { id: u.id, name: u.name, phone: u.phone, balance: kes(walletBalance(u.id)), currency: 'KES' }; }
router.get('/me', auth, (req, res) => res.json({ success: true, me: meView(req.u) }));

// ---------------------------------------------------------------------------
// TOP UP  (Phase 1: simulated — settles instantly. Real = M-Pesa STK Push, settled on callback.)
//   postings: DESIGNATED +X (cash in), WALLET:U -X (we now owe the user X)  -> sum 0
// ---------------------------------------------------------------------------
router.post('/topup', auth, (req, res) => {
    const u = req.u; if (limited('topup:' + u.id, 60, 3600000)) return slow(res, 'top-ups');
    const amt = parseAmt(req.body && req.body.amount); if (amt === null) return fail(res, 400, 'Enter a valid amount in KES.');
    if (mpesaConfigured() && !(req.body && req.body.method === 'simulate')) {
        // REAL top-up: an STK Push prompt is sent to the phone; the balance is credited only when M-Pesa confirms (callback).
        const amountKes = Math.max(1, Math.round(amt / 100)), amtC = amountKes * 100;
        const tx = makeTx('TOPUP', u.id, amtC, [{ account: 'DESIGNATED', d: +amtC }, { account: wacct(u.id), d: -amtC }], { public: { via: 'MPESA_STK' } });   // stays PENDING until the callback
        mpesaClient().stkPush({ amountKes, phone: u.phone, accountRef: u.id, desc: 'Wallet top-up' })
            .then((r) => { if (r && r.ok) { S.stkPending[r.checkoutId] = tx.id; tx.meta.checkoutId = r.checkoutId; dirty(); if (!res.headersSent) res.json({ success: true, pending: true, tx: txView(tx), message: 'Check your phone and enter your M-Pesa PIN to complete the top-up.' }); }
                            else { failTx(tx, (r && r.error) || 'STK push failed'); dirty(); if (!res.headersSent) fail(res, 502, 'Could not start the M-Pesa payment: ' + ((r && r.error) || 'try again')); } })
            .catch((e) => { failTx(tx, e.message); dirty(); if (!res.headersSent) fail(res, 502, 'M-Pesa is not reachable right now. Please try again.'); });
        return;
    }
    const tx = makeTx('TOPUP', u.id, amt, [{ account: 'DESIGNATED', d: +amt }, { account: wacct(u.id), d: -amt }], { public: { via: 'SIMULATED' } });
    settle(tx);     // no M-Pesa configured: Phase 1 instant simulated settle
    dirty(); res.json({ success: true, tx: txView(tx), balance: kes(walletBalance(u.id)) });
});
// poll a top-up's status (the UI calls this after an STK Push to see when the balance is credited)
router.get('/topup/:txId', auth, (req, res) => { const t = S.txs[req.params.txId]; if (!t || t.uid !== req.u.id) return fail(res, 404, 'Not found.'); res.json({ success: true, tx: txView(t), balance: kes(walletBalance(req.u.id)) }); });
// M-Pesa STK callback (Safaricom posts here). Public: matched by the unguessable CheckoutRequestID. Always acks so retries stop.
router.post('/mpesa/callback', (req, res) => {
    try {
        const cb = req.body && req.body.Body && req.body.Body.stkCallback;
        if (cb && cb.CheckoutRequestID) {
            const txId = S.stkPending[cb.CheckoutRequestID], tx = txId && S.txs[txId];
            if (tx && tx.status === 'PENDING') {
                if (Number(cb.ResultCode) === 0) {
                    let receipt = null; try { const it = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || []; const r = it.find(x => x.Name === 'MpesaReceiptNumber'); receipt = r && r.Value; } catch (e) {}
                    tx.meta.public = { via: 'MPESA', receipt: receipt || null }; settle(tx);
                } else failTx(tx, 'M-Pesa: ' + (cb.ResultDesc || 'not completed'));
                delete S.stkPending[cb.CheckoutRequestID]; dirty();
            }
        }
    } catch (e) {}
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ---------------------------------------------------------------------------
// WITHDRAW  (Phase 1: simulated — real = M-Pesa B2C from the float). Cannot go negative.
//   amount A leaves the wallet; fee F -> REVENUE; user receives A-F in cash.
//   postings: WALLET:U +A (we owe A less), DESIGNATED -(A-F) (cash out), REVENUE -F (we earned F) -> sum 0
// ---------------------------------------------------------------------------
router.post('/withdraw', auth, (req, res) => {
    const u = req.u; if (limited('wd:' + u.id, 30, 3600000)) return slow(res, 'withdrawals');
    const amt = parseAmt(req.body && req.body.amount); if (amt === null) return fail(res, 400, 'Enter a valid amount in KES.');
    if (walletBalance(u.id) < amt) return fail(res, 409, `Not enough balance. You have KES ${kes(walletBalance(u.id))}.`);
    const fee = Math.min(amt, Math.round(amt * WITHDRAW_FEE_RATE));
    if (b2cConfigured() && !(req.body && req.body.method === 'simulate')) {
        // REAL payout: reserve the money OUT of the wallet at once (so it can't be double-spent), then send via M-Pesa B2C.
        // The cash only leaves the designated trust account when M-Pesa confirms; a failed payout returns the money to the wallet.
        const tx = makeTx('WITHDRAW', u.id, amt, [{ account: wacct(u.id), d: +amt }, { account: 'WITHDRAW_PENDING', d: -amt }], { feeCents: fee, public: { via: 'MPESA_B2C', state: 'PROCESSING', netToUser: kes(amt - fee) } });
        settle(tx);
        b2cClient().b2cSend({ amountKes: Math.round((amt - fee) / 100), phone: u.phone, remarks: 'RDS wallet withdrawal', occasion: tx.id })
            .then((r) => { if (r && r.ok) { S.b2cPending[r.conversationId] = { txId: tx.id, uid: u.id, amt, fee }; dirty(); if (!res.headersSent) res.json({ success: true, pending: true, tx: txView(tx), received: kes(amt - fee), message: 'Sending KES ' + kes(amt - fee) + ' to your M-Pesa. You will get an SMS when it arrives.' }); }
                          else { reverseReserve(tx, u.id, amt, (r && r.error) || 'payout failed'); dirty(); if (!res.headersSent) fail(res, 502, 'Could not start the M-Pesa payout: ' + ((r && r.error) || 'try again') + '. Your balance was not touched.'); } })
            .catch((e) => { reverseReserve(tx, u.id, amt, e.message); dirty(); if (!res.headersSent) fail(res, 502, 'M-Pesa payout is not reachable right now. Your balance was not touched.'); });
        return;
    }
    const tx = makeTx('WITHDRAW', u.id, amt, [{ account: wacct(u.id), d: +amt }, { account: 'DESIGNATED', d: -(amt - fee) }, { account: 'REVENUE', d: -fee }], { feeCents: fee, public: { via: 'SIMULATED', netToUser: kes(amt - fee) } });
    settle(tx);     // no B2C configured: Phase 1 instant simulated payout
    dirty(); res.json({ success: true, tx: txView(tx), balance: kes(walletBalance(u.id)), received: kes(amt - fee) });
});
// M-Pesa B2C result (Safaricom posts the final payout outcome here). Public: matched by the unguessable ConversationID.
router.post('/mpesa/b2c/result', (req, res) => {
    try {
        const R = req.body && req.body.Result;
        if (R && (R.ConversationID || R.OriginatorConversationID)) {
            const key = S.b2cPending[R.ConversationID] ? R.ConversationID : (S.b2cPending[R.OriginatorConversationID] ? R.OriginatorConversationID : null);
            const p = key && S.b2cPending[key];
            if (p) {
                const orig = S.txs[p.txId];
                if (Number(R.ResultCode) === 0) {
                    let receipt = null; try { const it = (R.ResultParameters && R.ResultParameters.ResultParameter) || []; const rc = it.find(x => x.Key === 'TransactionReceipt'); receipt = rc && rc.Value; } catch (e) {}
                    // the cash really left: reduce the trust account by the net, book the fee, clear the reservation
                    const tx = makeTx('WITHDRAW_SETTLE', null, p.amt, [{ account: 'WITHDRAW_PENDING', d: +p.amt }, { account: 'DESIGNATED', d: -(p.amt - p.fee) }, { account: 'REVENUE', d: -p.fee }], { feeCents: p.fee, public: { via: 'MPESA_B2C', receipt: receipt || null } });
                    settle(tx);
                    if (orig) orig.meta.public = Object.assign({}, orig.meta.public, { state: 'PAID', receipt: receipt || null });
                } else {
                    reverseReserve(orig, p.uid, p.amt, 'M-Pesa: ' + (R.ResultDesc || 'payout failed'));
                }
                delete S.b2cPending[key]; dirty();
            }
        }
    } catch (e) {}
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});
router.post('/mpesa/b2c/timeout', (req, res) => { res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); });

// ---------------------------------------------------------------------------
// TRANSFER wallet-to-wallet (money stays inside the designated account; only who is owed changes)
//   postings: WALLET:FROM +A, WALLET:TO -A  -> sum 0 ; designated & revenue unchanged
// ---------------------------------------------------------------------------
router.post('/transfer', auth, (req, res) => {
    const u = req.u, b = req.body || {}; if (limited('xfer:' + u.id, 60, 3600000)) return slow(res, 'transfers');
    const toPhone = D.normalizePhone ? D.normalizePhone(String(b.toPhone || '')) : String(b.toPhone || '');
    if (!/^\+\d{9,15}$/.test(toPhone)) return fail(res, 400, 'Enter the recipient phone number.');
    const toId = S.phones[toPhone]; if (!toId || toId === u.id) return fail(res, 400, toId === u.id ? 'You cannot send to yourself.' : 'That number does not have a wallet yet.');
    const amt = parseAmt(b.amount); if (amt === null) return fail(res, 400, 'Enter a valid amount in KES.');
    if (walletBalance(u.id) < amt) return fail(res, 409, `Not enough balance. You have KES ${kes(walletBalance(u.id))}.`);
    const tx = makeTx('TRANSFER', u.id, amt, [{ account: wacct(u.id), d: +amt }, { account: wacct(toId), d: -amt }], { public: { to: toPhone.slice(0, 5) + '***' + toPhone.slice(-2) } });
    settle(tx);
    dirty(); res.json({ success: true, tx: txView(tx), balance: kes(walletBalance(u.id)) });
});

router.get('/transactions', auth, (req, res) => {
    const mine = Object.values(S.txs).filter(t => t.uid === req.u.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
    res.json({ success: true, balance: kes(walletBalance(req.u.id)), transactions: mine.map(txView) });
});

// ---------------------------------------------------------------------------
// RECONCILE — the mathematical proof. Re-derives every balance from the raw ledger (ignoring the cache),
// checks the cache matches, that the whole ledger sums to zero, that DESIGNATED = wallets + REVENUE, and that
// no wallet is negative. Returns balanced:true only if ALL hold.
// ---------------------------------------------------------------------------
function reconcile() {
    const derived = {};
    for (const e of S.ledger) derived[e.account] = (derived[e.account] || 0) + e.d;
    // every SETTLED tx's postings sum to zero (double-entry integrity)
    let txImbalance = 0; for (const t of Object.values(S.txs)) if (t.status === 'SETTLED') { const s = t.postings.reduce((a, p) => a + p.d, 0); if (s !== 0) txImbalance++; }
    const totalRaw = Object.values(derived).reduce((a, b) => a + b, 0);
    let walletsRaw = 0, negatives = 0; const perUser = [];
    for (const uid of Object.keys(S.users)) { const bal = -(derived[wacct(uid)] || 0); walletsRaw += bal; if (bal < 0) negatives++; perUser.push({ uid, balance: kes(bal) }); }
    const designatedD = derived['DESIGNATED'] || 0, revenueD = -(derived['REVENUE'] || 0), heldD = -(derived['HOLD'] || 0), vatD = -(derived['VAT'] || 0), reservedD = -(derived['WITHDRAW_PENDING'] || 0);
    let platformHeldRaw = 0; for (const [a, d] of Object.entries(derived)) if (a !== 'DESIGNATED' && !a.startsWith('WALLET:')) platformHeldRaw += d;
    const platformHeld = -platformHeldRaw;
    // cache matches the ledger?
    const accts = new Set([...Object.keys(S.bal), ...Object.keys(derived)]); let cacheOk = true;
    for (const a of accts) if ((S.bal[a] || 0) !== (derived[a] || 0)) cacheOk = false;
    const equationHolds = designatedD === (walletsRaw + platformHeld);
    const balanced = totalRaw === 0 && equationHolds && cacheOk && negatives === 0 && txImbalance === 0;
    return { balanced, designated: kes(designatedD), walletsTotal: kes(walletsRaw), revenue: kes(revenueD), held: kes(heldD), vat: kes(vatD), reserved: kes(reservedD), platformHeld: kes(platformHeld),
        checks: { ledgerSumsToZero: totalRaw === 0, equationHolds, cacheMatchesLedger: cacheOk, noNegativeWallets: negatives === 0, everyTxBalanced: txImbalance === 0 },
        users: Object.keys(S.users).length, settledTx: Object.values(S.txs).filter(t => t.status === 'SETTLED').length };
}
router.get('/admin/reconcile', adminAuth, (req, res) => res.json({ success: true, reconcile: reconcile() }));
router.get('/admin/overview', adminAuth, (req, res) => {
    const r = reconcile(), t0 = now() - 86400000, txs = Object.values(S.txs);
    res.json({ success: true, reconcile: r, users: Object.keys(S.users).length,
        topups24h: txs.filter(t => t.kind === 'TOPUP' && t.createdAt >= t0).length, withdrawals24h: txs.filter(t => t.kind === 'WITHDRAW' && t.createdAt >= t0).length,
        pending: txs.filter(t => t.status === 'PENDING').length, failed: txs.filter(t => t.status === 'FAILED').length,
        accounts: Object.entries(S.bal).map(([a, d]) => ({ account: a, raw: d })).slice(0, 2000) });
});

// ---------------------------------------------------------------------------
// ADMIN — M-Pesa connection check (owner only). Same idea as check-mpesa.js, but as a route.
//   GET  /api/wallet/admin/mpesa/status    -> is M-Pesa configured, and does the token work (no secrets leaked)
//   POST /api/wallet/admin/mpesa/test-stk  -> fire one test STK push {phone?, amount?} and return Safaricom's reply
// ---------------------------------------------------------------------------
const _maskKey = (s) => !s ? null : (String(s).length <= 6 ? '***' : String(s).slice(0, 3) + '…' + String(s).slice(-3));
router.get('/admin/mpesa/status', adminAuth, async (req, res) => {
    const out = {
        environment: MPESA.env, txType: MPESA.txType, shortcode: MPESA.shortcode || null, till: MPESA.tillNumber || null,
        consumerKey: _maskKey(MPESA.key), passkey: _maskKey(MPESA.passkey), callbackUrl: MPESA.callbackUrl || null,
        topUpConfigured: mpesaConfigured(), payoutConfigured: b2cConfigured(),
        callbackLooksPublic: /^https:\/\//.test(MPESA.callbackUrl || '') && !/YOUR_PUBLIC_HTTPS|YOUR_DOMAIN/.test(MPESA.callbackUrl || '')
    };
    if (!mpesaEnvConfigured()) { out.token = { ok: false, reason: 'Top-up keys not set — running in simulated mode.' }; return res.json({ success: true, mpesa: out }); }
    try { const t = await darajaToken(); out.token = { ok: !!t }; } catch (e) { out.token = { ok: false, error: e.message }; }
    res.json({ success: true, mpesa: out });
});
router.post('/admin/mpesa/test-stk', adminAuth, async (req, res) => {
    if (!mpesaEnvConfigured()) return fail(res, 400, 'M-Pesa top-up keys are not set (simulated mode). Set MPESA_* in .env first.');
    const raw = String((req.body && req.body.phone) || '254708374149');
    const phone = (D.normalizePhone ? D.normalizePhone(raw) : raw).replace(/^\+/, '');
    const amountKes = Math.max(1, Math.round(Number((req.body && req.body.amount) || 1)));
    try { const r = await darajaStkPush({ amountKes, phone, accountRef: 'RDS-TEST', desc: 'RDS test' }); res.json({ success: !!r.ok, result: r, sentTo: phone, amountKes }); }
    catch (e) { fail(res, 502, 'STK test failed: ' + e.message); }
});

function walletStats() {
    const r = reconcile(), t0 = now() - 86400000, txs = Object.values(S.txs);
    return { users: Object.keys(S.users).length, designated: r.designated, walletsTotal: r.walletsTotal, revenue: r.revenue, held: r.held, vat: r.vat, platformHeld: r.platformHeld, balanced: r.balanced, mpesaLive: mpesaConfigured(), b2cLive: b2cConfigured(), pendingTopups: Object.keys(S.stkPending || {}).length, pendingPayouts: Object.keys(S.b2cPending || {}).length, reserved: r.reserved,
        topups24h: txs.filter(t => t.kind === 'TOPUP' && t.createdAt >= t0).length, withdrawals24h: txs.filter(t => t.kind === 'WITHDRAW' && t.createdAt >= t0).length, pending: txs.filter(t => t.status === 'PENDING').length };
}

// ---- pay FROM a wallet / refund TO a wallet, by phone (other modules call these through server deps) ----
router.chargeByPhone = function (phone, amountCents, opts) {
    opts = opts || {}; amountCents = Math.round(Number(amountCents) || 0); if (!(amountCents > 0)) return { ok: false, error: 'INVALID_AMOUNT' };
    const u = userByPhone(phone); if (!u) return { ok: false, error: 'NO_WALLET' };
    if (walletBalance(u.id) < amountCents) return { ok: false, error: 'INSUFFICIENT', balance: kes(walletBalance(u.id)) };
    const acct = opts.account === 'REVENUE' ? 'REVENUE' : 'HOLD';
    const tx = makeTx(opts.kind || 'CHARGE', u.id, amountCents, [{ account: wacct(u.id), d: +amountCents }, { account: acct, d: -amountCents }], { public: { ref: opts.ref || null, memo: clean(opts.memo, 80) || null } });
    settle(tx); dirty(); return { ok: true, balance: kes(walletBalance(u.id)), tx: tx.id };
};
router.refundByPhone = function (phone, amountCents, opts) {
    opts = opts || {}; amountCents = Math.round(Number(amountCents) || 0); if (!(amountCents > 0)) return { ok: false, error: 'INVALID_AMOUNT' };
    const u = ensureUserByPhone(phone); const acct = opts.account === 'REVENUE' ? 'REVENUE' : 'HOLD';
    const tx = makeTx(opts.kind || 'REFUND', u.id, amountCents, [{ account: wacct(u.id), d: -amountCents }, { account: acct, d: +amountCents }], { public: { ref: opts.ref || null, memo: clean(opts.memo, 80) || null } });
    settle(tx); dirty(); return { ok: true, balance: kes(walletBalance(u.id)), tx: tx.id };
};
const heldNow = () => -rawBal('HOLD');
// ---------------------------------------------------------------------------
// SETTLEMENT — when an order is fulfilled, money moves OUT of HOLD to the parties who earned it.
//   shop is paid 100% the moment the rider collects (hand-over); rider + platform + KRA VAT are paid on delivery.
//   Every call is ONE balanced transaction, and nothing can be paid out that is not actually held.
// ---------------------------------------------------------------------------
// to a party's own wallet (the shop at hand-over, the rider on delivery): HOLD -> WALLET:user
router.settleToWalletByPhone = function (phone, amountCents, opts) {
    opts = opts || {}; amountCents = Math.round(Number(amountCents) || 0);
    if (!(amountCents > 0)) return { ok: true, skipped: true, reason: 'ZERO' };
    if (heldNow() < amountCents) return { ok: false, error: 'INSUFFICIENT_HOLD', held: kes(heldNow()) };
    const u = ensureUserByPhone(phone, opts.name);
    const tx = makeTx(opts.kind || 'SETTLE', u.id, amountCents, [{ account: 'HOLD', d: +amountCents }, { account: wacct(u.id), d: -amountCents }], { public: { via: 'SETTLEMENT', role: opts.role || null, ref: opts.ref || null } });
    settle(tx); dirty(); return { ok: true, balance: kes(walletBalance(u.id)), tx: tx.id };
};
// to a platform account (the app's own fee income, or VAT ring-fenced for KRA): HOLD -> REVENUE | VAT
router.settleToAccountFromHold = function (amountCents, account, opts) {
    opts = opts || {}; amountCents = Math.round(Number(amountCents) || 0);
    account = account === 'VAT' ? 'VAT' : account === 'REVENUE' ? 'REVENUE' : null;
    if (!account) return { ok: false, error: 'BAD_ACCOUNT' };
    if (!(amountCents > 0)) return { ok: true, skipped: true, reason: 'ZERO' };
    if (heldNow() < amountCents) return { ok: false, error: 'INSUFFICIENT_HOLD', held: kes(heldNow()) };
    const tx = makeTx(opts.kind || 'SETTLE', null, amountCents, [{ account: 'HOLD', d: +amountCents }, { account, d: -amountCents }], { public: { via: 'SETTLEMENT', account, ref: opts.ref || null } });
    settle(tx); dirty(); return { ok: true, tx: tx.id };
};
router.heldTotal = () => kes(heldNow());
router.balanceByPhone = function (phone) { const u = userByPhone(phone); return u ? kes(walletBalance(u.id)) : 0; };
router.walletStats = walletStats;
router.reconcile = reconcile;
router._test = { state: () => S, reset: () => { S = blank(); hits.clear(); }, walletBalance, designated, revenue, buildStkBody, MPESA };
module.exports = router;