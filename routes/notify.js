'use strict';
// ============================================================================
// routes/notify.js — multi-channel notifications / OTP delivery.
//
//   Channels:  SMS (Africa's Talking or a webhook) · WhatsApp (Meta Cloud API) · Email (HTTP provider or SMTP)
//   Each channel has TWO gates:
//     1. configured?  -> do we have the keys for it (from .env)
//     2. switched on?  -> the owner's toggle in Master Control (switches192.notify)
//   A channel delivers only when it is BOTH configured AND switched on.
//
//   This lets the owner switch OFF the expensive SMS while users still get the code
//   on WhatsApp (same phone number, cheaper) and Email.
//
// .env keys:
//   SMS:      SMS_PROVIDER=africastalking (AT_USERNAME, AT_API_KEY, AT_SENDER_ID) | webhook (SMS_WEBHOOK_URL, SMS_WEBHOOK_TOKEN)
//   WhatsApp: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID [, WHATSAPP_TEMPLATE, WHATSAPP_TEMPLATE_LANG]
//   Email:    EMAIL_FROM + (EMAIL_API_URL [, EMAIL_API_KEY])  OR  EMAIL_FROM + SMTP_URL (needs nodemailer)
// ============================================================================
let D = {};
function init(deps) { D = deps || {}; }

const norm = (p) => (D.normalizePhone ? D.normalizePhone(String(p || '')) : String(p || ''));
const waNum = (p) => norm(p).replace(/^\+/, '');                 // WhatsApp/Cloud API wants digits, no '+'

const CFG = {
    sms: { provider: (process.env.SMS_PROVIDER || '').toLowerCase() },
    whatsapp: { token: process.env.WHATSAPP_TOKEN || '', phoneId: process.env.WHATSAPP_PHONE_ID || '', template: process.env.WHATSAPP_TEMPLATE || '', lang: process.env.WHATSAPP_TEMPLATE_LANG || 'en_US' },
    email: { from: process.env.EMAIL_FROM || '', httpUrl: process.env.EMAIL_API_URL || '', httpToken: process.env.EMAIL_API_KEY || '', smtp: process.env.SMTP_URL || '' }
};

// ---- is each channel configured? (dep predicate wins, else env) ------------
const smsConfigured = () => !!D.smsSend ? true : (D.smsConfigured ? !!D.smsConfigured() : false);
const waConfigured = () => !!D.waSend || (!!CFG.whatsapp.token && !!CFG.whatsapp.phoneId);
const emailConfigured = () => !!D.emailSend || (!!CFG.email.from && (!!CFG.email.httpUrl || !!CFG.email.smtp));

// ---- owner toggles (default: a channel is ON unless explicitly turned off) --
const toggles = () => { const s = (D.getSwitches && D.getSwitches()) || {}; return { sms: s.sms !== false, whatsapp: s.whatsapp !== false, email: s.email !== false }; };
const CH = ['sms', 'whatsapp', 'email'];
const cleanPrefer = (prefer) => { if (!Array.isArray(prefer)) return null; const s = prefer.map(x => String(x).toLowerCase()).filter(x => CH.includes(x)); return s.length ? new Set(s) : null; };
const active = (prefer) => { const t = toggles(), want = cleanPrefer(prefer), allow = (ch) => !want || want.has(ch);
    return { sms: t.sms && smsConfigured() && allow('sms'), whatsapp: t.whatsapp && waConfigured() && allow('whatsapp'), email: t.email && emailConfigured() && allow('email') }; };

// ---- channel senders (each returns { ok, ... }; injectable for tests) ------
async function sendSms(to, text) {
    if (D.smsSend) return D.smsSend(to, text);
    return { ok: false, error: 'sms not configured' };                         // real SMS lives in the server (sendSms191); passed in as D.smsSend
}
async function sendWhatsApp(toDigits, text, opts) {
    if (D.waSend) return D.waSend(toDigits, text, opts);
    if (!waConfigured() || typeof fetch !== 'function') return { ok: false, error: 'whatsapp not configured' };
    const url = 'https://graph.facebook.com/v19.0/' + CFG.whatsapp.phoneId + '/messages';
    let body;
    if (opts && opts.kind === 'otp' && CFG.whatsapp.template) {                 // a pre-approved template is required to message outside the 24h window
        body = { messaging_product: 'whatsapp', to: toDigits, type: 'template', template: { name: CFG.whatsapp.template, language: { code: CFG.whatsapp.lang }, components: [{ type: 'body', parameters: [{ type: 'text', text: String((opts && opts.code) || '') }] }] } };
    } else {
        body = { messaging_product: 'whatsapp', to: toDigits, type: 'text', text: { body: text } };
    }
    try {
        const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + CFG.whatsapp.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => null);
        if (r.ok && d && d.messages) return { ok: true, id: d.messages[0] && d.messages[0].id };
        return { ok: false, error: (d && d.error && d.error.message) || ('HTTP ' + r.status) };
    } catch (e) { return { ok: false, error: e.message }; }
}
async function sendEmail(to, subject, text) {
    if (D.emailSend) return D.emailSend(to, subject, text);
    if (CFG.email.httpUrl && typeof fetch === 'function') {
        try {
            const h = { 'Content-Type': 'application/json' }; if (CFG.email.httpToken) h.Authorization = 'Bearer ' + CFG.email.httpToken;
            const r = await fetch(CFG.email.httpUrl, { method: 'POST', headers: h, body: JSON.stringify({ from: CFG.email.from, to, subject, text }) });
            const t = await r.text().catch(() => '');
            return r.ok ? { ok: true } : { ok: false, error: 'HTTP ' + r.status + ' ' + String(t).slice(0, 120) };
        } catch (e) { return { ok: false, error: e.message }; }
    }
    if (CFG.email.smtp) {
        let nodemailer; try { nodemailer = require('nodemailer'); } catch (e) { return { ok: false, error: 'SMTP set but nodemailer is not installed (run: npm i nodemailer)' }; }
        try { const tx = nodemailer.createTransport(CFG.email.smtp); await tx.sendMail({ from: CFG.email.from, to, subject, text }); return { ok: true }; }
        catch (e) { return { ok: false, error: e.message }; }
    }
    return { ok: false, error: 'email not configured' };
}

// ---- the one entry point: deliver a message over every ACTIVE channel ------
async function send({ phone, email, text, subject, kind, code, prefer }) {
    const a = active(prefer), results = {}, attempted = [];
    const jobs = [];
    if (a.sms && phone) { attempted.push('sms'); jobs.push(Promise.resolve().then(() => sendSms(norm(phone), text)).then(r => results.sms = r, e => results.sms = { ok: false, error: e.message })); }
    if (a.whatsapp && phone) { attempted.push('whatsapp'); jobs.push(Promise.resolve().then(() => sendWhatsApp(waNum(phone), text, { kind, code })).then(r => results.whatsapp = r, e => results.whatsapp = { ok: false, error: e.message })); }
    if (a.email && email) { attempted.push('email'); jobs.push(Promise.resolve().then(() => sendEmail(email, subject || 'RDS', text)).then(r => results.email = r, e => results.email = { ok: false, error: e.message })); }
    await Promise.all(jobs);
    const delivered = Object.values(results).some(r => r && r.ok);
    return { ok: delivered, attempted, results, channels: a };
}
function sendOtp({ phone, email, code, prefer }) {
    const text = 'Your RDS verification code is ' + code + '. It expires in 5 minutes.';
    return send({ phone, email, text, subject: 'Your RDS code', kind: 'otp', code, prefer });
}

// ---- what Master Control shows: configured + on + active per channel -------
function status() {
    const t = toggles();
    return {
        sms: { configured: smsConfigured(), on: t.sms, active: t.sms && smsConfigured(), provider: CFG.sms.provider || null },
        whatsapp: { configured: waConfigured(), on: t.whatsapp, active: t.whatsapp && waConfigured() },
        email: { configured: emailConfigured(), on: t.email, active: t.email && emailConfigured() },
        note: (smsConfigured() || waConfigured() || emailConfigured()) ? null : 'No channel is configured yet — codes are simulated. Add SMS/WhatsApp/Email keys in .env to send for real.'
    };
}

module.exports = { init, send, sendOtp, status, _test: { active, toggles, smsConfigured, waConfigured, emailConfigured } };