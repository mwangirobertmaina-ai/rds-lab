'use strict';
// ============================================================================
// routes/ads.js — STAGE 192 RDS SOCIAL (feed, reels, messages, sponsored posts). Mounted by server.js at /api/ads.
//
// What it does: phone sign-in (the server's own OTP system: SMS in production, 1234 in test mode), profiles with unique
// @handles, photo / video / text posts, a ranked "For You" feed and a "Following" feed, likes, comments, shares, views,
// follows, blocks, hashtags and mentions, search and trending, notifications, private 1:1 messages with read receipts,
// sponsored posts with impressions / clicks, reporting with automatic hiding, and an owner moderation API.
//
// Security rules this file enforces (each one fixes a problem in the previous version):
//   - The login code is NEVER returned to the browser. Sessions are random 256-bit tokens; only their SHA-256 is stored.
//   - Every write needs a signed-in user, and the author is always the signed-in user (never taken from the request).
//   - Uploads are checked by their real bytes (JPEG/PNG/WEBP/GIF/MP4/MOV/WEBM), size-limited, renamed, stored outside the
//     web folder and served with nosniff + a sandbox CSP, so an upload can never become a web page or a script.
//   - The server returns text only; the page escapes everything it shows.
//   - Per-user and per-address limits on codes, posts, comments, likes, messages, follows and reports.
//   - Realtime events go only to the signed-in person's own room. The old "broadcast every call to everyone" relay is gone.
// Data lives in DATA_DIR (social.snapshot + social-media/). Nothing is kept in the project folder.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();

let D = {}, io = null, ready = false, dir = null, mediaDir = null, file = null, saveTimer = null;
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newId = (p) => `${p}_${now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const fail = (res, code, msg, extra) => res.status(code).json({ success: false, error: msg, ...(extra || {}) });
const okId = (v, p) => typeof v === 'string' && new RegExp(`^${p}_[a-z0-9]{8,40}$`).test(v);

// ---------------------------------------------------------------------------
// state (persisted)
// ---------------------------------------------------------------------------
const blank = () => ({ v: 1, users: {}, handles: {}, phones: {}, sessions: {}, posts: {}, order: [], likes: {}, comments: {}, follows: {}, followers: {}, notifs: {}, convs: {}, pairs: {}, msgs: {}, reads: {}, blocks: {}, reports: [], media: {}, views: {}, bans: {}, stories: {}, storyViews: {}, reposts: {}, saves: {}, campaigns: {} });
let S = blank();
function load() {
    try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); S = Object.assign(blank(), raw); }
    catch (e) { if (e.code !== 'ENOENT') console.error('[SOCIAL] could not read social.snapshot:', e.message); }
}
function saveNow() {
    if (!file) return;
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, file); }
    catch (e) { console.error('[SOCIAL] save failed:', e.message); }
}
const dirty = () => { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 800); if (saveTimer.unref) saveTimer.unref(); };

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------
const hits = new Map();
function limited(key, max, windowMs) {
    const t = now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(t); hits.set(key, arr);
    if (hits.size > 50000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > 86400000) hits.delete(k);
    return false;
}
const ipOf = (req) => String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
const slow = (res, what) => fail(res, 429, `Too many ${what}. Please wait a little and try again.`);
const LIM = { story: [30, 86400000], campaign: [10, 86400000], group: [10, 86400000], code: [3, 600000], codeIp: [10, 3600000], verifyIp: [30, 600000], post: [20, 3600000], upload: [30, 3600000], comment: [60, 3600000], like: [600, 3600000], follow: [200, 3600000], msg: [40, 60000], msgDay: [2000, 86400000], report: [20, 86400000], share: [100, 3600000] };

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
const SESSION_DAYS = 30;
function bearer(req) { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : null; }
function userOfToken(tok) {
    if (!tok || !/^[A-Za-z0-9_-]{30,100}$/.test(tok)) return null;
    const s = S.sessions[sha(tok)]; if (!s || s.exp < now()) return null;
    const u = S.users[s.uid]; return u && !u.deleted ? u : null;
}
function issueSession(uid) {
    const tok = crypto.randomBytes(32).toString('base64url');
    S.sessions[sha(tok)] = { uid, at: now(), exp: now() + SESSION_DAYS * 86400000 };
    const mine = Object.entries(S.sessions).filter(([, s]) => s.uid === uid).sort((a, b) => b[1].at - a[1].at);
    mine.slice(10).forEach(([h]) => delete S.sessions[h]);                         // at most 10 devices
    return tok;
}
const soft = (req, res, next) => { req.su = userOfToken(bearer(req)); next(); };
function auth(req, res, next) {
    const u = userOfToken(bearer(req));
    if (!u) return fail(res, 401, 'Please sign in.');
    if (S.bans[u.id]) return fail(res, 403, 'This account has been suspended for breaking the community rules.');
    req.su = u; next();
}
const adminAuth = (req, res, next) => {
    const chain = (D.adminAuth || []).slice();
    if (!chain.length) return fail(res, 503, 'Moderation is not available on this server.');
    let i = 0; const nx = (e) => { if (e) return next(e); const f = chain[i++]; if (!f) return next(); f(req, res, nx); }; nx();
};

// ---------------------------------------------------------------------------
// views of things (the only shapes that ever leave the server)
// ---------------------------------------------------------------------------
const mediaUrl = (mid) => (mid ? `/api/ads/media/${mid}` : null);
function userCard(u) { if (!u) return null; return { id: u.id, name: u.name, handle: u.handle, avatar: mediaUrl(u.avatar), verified: !!u.verified }; }
const blockedBetween = (a, b) => !!(a && b && ((S.blocks[a] && S.blocks[a][b]) || (S.blocks[b] && S.blocks[b][a])));
const follows = (a, b) => !!(a && S.follows[a] && S.follows[a][b]);
const countOf = (m) => Object.keys(m || {}).length;
// reactions (Facebook-style). Stored as S.likes[pid][uid] = { r, at }; older data stored a timestamp, which reads as 'like'.
const REACTS = ['like', 'love', 'haha', 'wow', 'sad', 'angry'];
const reactType = (v) => (v ? (typeof v === 'object' && v.r ? v.r : 'like') : null);
function reactBreakdown(L) { const o = {}; for (const k in (L || {})) { const t = reactType(L[k]); if (t) o[t] = (o[t] || 0) + 1; } return o; }
function postView(p, viewer) {
    const m = p.mediaId ? S.media[p.mediaId] : null, vid = viewer && viewer.id;
    return {
        id: p.id, author: userCard(S.users[p.uid]), caption: p.caption, hashtags: p.hashtags || [], createdAt: p.createdAt, editedAt: p.editedAt || null,
        media: m ? { kind: m.kind, url: mediaUrl(m.id), mime: m.mime } : null, style: p.style || null,
        counts: { likes: countOf(S.likes[p.id]), comments: (S.comments[p.id] || []).filter(c => !c.deleted).length, shares: p.shares || 0, views: p.views || 0, reposts: countOf(S.reposts[p.id]) },
        liked: !!(vid && S.likes[p.id] && S.likes[p.id][vid]), myReaction: vid && S.likes[p.id] ? reactType(S.likes[p.id][vid]) : null, reactions: reactBreakdown(S.likes[p.id]), mine: vid === p.uid, followingAuthor: follows(vid, p.uid),
        reposted: !!(vid && S.reposts[p.id] && S.reposts[p.id][vid]), saved: !!(vid && S.saves[vid] && S.saves[vid][p.id]),
        quote: p.quoteOf ? quoteView(p.quoteOf, viewer) : null,
        sponsored: p.sponsored ? { label: p.sponsored.label, ctaText: p.sponsored.ctaText, ctaUrl: p.sponsored.ctaUrl } : null, status: p.status
    };
}
function quoteView(id, viewer) {
    const q = S.posts[id];
    if (!q || q.status !== 'LIVE' || !visible(q, viewer)) return { id, unavailable: true };
    const m = q.mediaId ? S.media[q.mediaId] : null;
    return { id: q.id, author: userCard(S.users[q.uid]), caption: q.caption, createdAt: q.createdAt, style: q.style || null, media: m ? { kind: m.kind, url: mediaUrl(m.id), mime: m.mime } : null };
}
const visible = (p, viewer) => p && (p.status === 'LIVE' || (viewer && viewer.id === p.uid && p.status === 'HIDDEN')) && S.users[p.uid] && !S.users[p.uid].deleted && !S.bans[p.uid] && !blockedBetween(viewer && viewer.id, p.uid);

// ---------------------------------------------------------------------------
// notifications + realtime (only to the person's own room)
// ---------------------------------------------------------------------------
function emitTo(uid, ev, payload) { try { if (io) io.to('social:' + uid).emit(ev, payload); } catch (e) {} }
function notify(uid, n) {
    if (!uid || uid === n.from || !S.users[uid] || blockedBetween(uid, n.from)) return;
    const list = S.notifs[uid] || (S.notifs[uid] = []);
    if (n.type === 'like' && list.some(x => x.type === 'like' && x.from === n.from && x.postId === n.postId)) return;   // one like notice per person per post
    const rec = { id: newId('N'), type: n.type, from: n.from, postId: n.postId || null, text: clean(n.text, 140), at: now(), read: false };
    list.unshift(rec); if (list.length > 200) list.length = 200;
    emitTo(uid, 'social:notification', { ...rec, fromUser: userCard(S.users[n.from]) }); dirty();
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------
const HANDLE_RE = /^[a-z0-9_.]{3,24}$/, RESERVED = new Set(['admin', 'administrator', 'rds', 'rdsadmin', 'support', 'help', 'official', 'owner', 'root', 'system', 'moderator', 'security', 'mpesa', 'safaricom', 'kra', 'cbk']);
const tagsOf = (t) => [...new Set((String(t).match(/#[\p{L}\p{N}_]{2,40}/gu) || []).map(x => x.slice(1).toLowerCase()))].slice(0, 20);
const mentionsOf = (t) => [...new Set((String(t).match(/@[a-z0-9_.]{3,24}/gi) || []).map(x => x.slice(1).toLowerCase()))].slice(0, 10);
function normHandle(h) { return String(h || '').trim().replace(/^@/, '').toLowerCase(); }
function handleProblem(h, uid) {
    if (!HANDLE_RE.test(h)) return 'A username is 3 to 24 letters, numbers, dots or underscores.';
    if (RESERVED.has(h) || /^rds/.test(h)) return 'That username is reserved.';
    if (S.handles[h] && S.handles[h] !== uid) return 'That username is taken.';
    return null;
}
function freeHandle(base) { let b = normHandle(base).replace(/[^a-z0-9_.]/g, '').slice(0, 16); if (b.length < 3 || RESERVED.has(b) || /^rds/.test(b)) b = 'user'; let h = b; while (S.handles[h]) h = b + crypto.randomInt(1000, 99999); return h; }
function safeCtaUrl(u) {
    const s = String(u || '').trim();
    if (/^\/(user|store|merchant|ads)(\/|\?|$)[A-Za-z0-9_\-./?=&%]*$/.test(s)) return s;          // inside RDS (e.g. a shop on /user)
    try { const x = new URL(s); if (x.protocol === 'https:' && !x.username && !x.password) return x.toString(); } catch (e) {}
    return null;
}

// ---------------------------------------------------------------------------
// INIT (called by server.js)
// ---------------------------------------------------------------------------
router.init = function init(deps) {
    D = deps || {};
    dir = D.dataDir; if (!dir) throw new Error('ads module needs dataDir');
    mediaDir = path.join(dir, 'social-media'); file = path.join(dir, 'social.snapshot');
    fs.mkdirSync(mediaDir, { recursive: true });
    load(); ready = true;
    const sw = setInterval(() => { try { sweepStories(); Object.values(S.campaigns).forEach(syncCampaign); dirty(); } catch (e) {} }, 10 * 60000); if (sw.unref) sw.unref();
    process.on('exit', () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveNow(); });
};
router.use((req, res, next) => (ready ? next() : fail(res, 503, 'The social feed is starting. Try again in a moment.')));

// ---------------------------------------------------------------------------
// ACCOUNTS
// ---------------------------------------------------------------------------
router.post('/auth/request-code', (req, res) => {
    const phone = D.normalizePhone ? D.normalizePhone(String((req.body && req.body.phone) || '')) : String((req.body && req.body.phone) || '');
    if (!/^\+\d{9,15}$/.test(phone)) return fail(res, 400, 'Enter a valid phone number, for example 0712 345 678.');
    if (limited('code:' + phone, ...LIM.code) || limited('codeip:' + ipOf(req), ...LIM.codeIp)) return slow(res, 'code requests');
    D.issueOtp(phone);                                                   // SMS in production; never returned to the browser
    res.json({ success: true, phone, message: D.testMode ? 'Test mode: use code 1234.' : `We sent a code by SMS to ${phone.slice(0, 5)}***${phone.slice(-3)}.` });
});
router.post('/auth/verify', (req, res) => {
    const b = req.body || {}, phone = D.normalizePhone ? D.normalizePhone(String(b.phone || '')) : String(b.phone || ''), code = String(b.code || '').trim();
    if (!/^\+\d{9,15}$/.test(phone) || !/^\d{4,6}$/.test(code)) return fail(res, 400, 'Enter your phone number and the code you received.');
    if (limited('verifyip:' + ipOf(req), ...LIM.verifyIp)) return slow(res, 'attempts');
    if (!D.checkOtp(phone, code)) return fail(res, 400, 'That code is wrong or has expired. Request a new one.');
    let u = S.phones[phone] && S.users[S.phones[phone]], isNew = false;
    if (u && S.bans[u.id]) return fail(res, 403, 'This account has been suspended for breaking the community rules.');
    if (!u) {
        isNew = true;
        const id = newId('U'), handle = freeHandle(b.handle || 'user');
        u = { id, phone, name: clean(b.name, 50) || 'New user', handle, bio: '', avatar: null, createdAt: now() };
        S.users[id] = u; S.handles[handle] = id; S.phones[phone] = id;
        if (D.appendAudit) D.appendAudit('SOCIAL_ACCOUNT_CREATED', { uid: id });
    }
    const token = issueSession(u.id); dirty();
    res.json({ success: true, token, isNew, user: meView(u) });
});
function meView(u) {
    const notifs = S.notifs[u.id] || [];
    const unreadMsgs = Object.values(S.convs).filter(c => c.members.includes(u.id)).reduce((s, c) => s + (S.msgs[c.id] || []).filter(m => m.from !== u.id && m.at > ((S.reads[c.id] || {})[u.id] || 0)).length, 0);
    return { ...userCard(u), bio: u.bio, phone: u.phone, counts: { posts: S.order.filter(id => S.posts[id] && S.posts[id].uid === u.id && S.posts[id].status !== 'REMOVED').length, followers: countOf(S.followers[u.id]), following: countOf(S.follows[u.id]) }, unread: { notifications: notifs.filter(n => !n.read).length, messages: unreadMsgs } };
}
router.get('/me', auth, (req, res) => res.json({ success: true, user: meView(req.su) }));
router.patch('/me', auth, (req, res) => {
    const u = req.su, b = req.body || {};
    if (b.name !== undefined) { const n = clean(b.name, 50); if (n.length < 2) return fail(res, 400, 'Your name needs at least 2 characters.'); u.name = n; }
    if (b.handle !== undefined) { const h = normHandle(b.handle), p = handleProblem(h, u.id); if (p) return fail(res, 400, p); if (h !== u.handle) { delete S.handles[u.handle]; S.handles[h] = u.id; u.handle = h; } }
    if (b.bio !== undefined) u.bio = clean(b.bio, 160);
    if (b.avatarMediaId !== undefined) {
        if (b.avatarMediaId === null) u.avatar = null;
        else { const m = S.media[b.avatarMediaId]; if (!m || m.uid !== u.id || m.kind !== 'image') return fail(res, 400, 'Upload a photo first.'); u.avatar = m.id; m.usedAs = 'avatar'; }
    }
    dirty(); res.json({ success: true, user: meView(u) });
});
router.post('/auth/logout', (req, res) => { const t = bearer(req); if (t) delete S.sessions[sha(t)]; dirty(); res.json({ success: true }); });
router.post('/auth/delete-account', auth, (req, res) => {
    if (!req.body || req.body.confirm !== 'DELETE') return fail(res, 400, 'Type DELETE to confirm.');
    const u = req.su, id = u.id;
    for (const p of Object.values(S.posts)) if (p.uid === id) removePost(p, 'ACCOUNT_DELETED');
    for (const pid of Object.keys(S.likes)) delete S.likes[pid][id];
    for (const pid of Object.keys(S.comments)) S.comments[pid] = S.comments[pid].filter(c => c.uid !== id);
    for (const t of Object.keys(S.follows[id] || {})) { if (S.followers[t]) delete S.followers[t][id]; }
    for (const f of Object.keys(S.followers[id] || {})) { if (S.follows[f]) delete S.follows[f][id]; }
    delete S.follows[id]; delete S.followers[id]; delete S.notifs[id]; delete S.blocks[id];
    for (const c of Object.values(S.convs)) if (c.members.includes(id)) S.msgs[c.id] = (S.msgs[c.id] || []).filter(m => m.from !== id);
    for (const m of Object.values(S.media)) if (m.uid === id) deleteMediaFile(m);
    for (const [h, s] of Object.entries(S.sessions)) if (s.uid === id) delete S.sessions[h];
    delete S.handles[u.handle]; delete S.phones[u.phone];
    S.users[id] = { id, deleted: true, deletedAt: now(), name: 'Deleted user', handle: 'deleted' };
    if (D.appendAudit) D.appendAudit('SOCIAL_ACCOUNT_DELETED', { uid: id });
    dirty(); res.json({ success: true, message: 'Your account and your posts were deleted.' });
});

// ---------------------------------------------------------------------------
// MEDIA: upload (raw body, checked by its real bytes) and serving (with Range for video)
// ---------------------------------------------------------------------------
const MAX_IMAGE = (Number(process.env.SOCIAL_MAX_IMAGE_MB) || 15) * 1048576, MAX_VIDEO = (Number(process.env.SOCIAL_MAX_VIDEO_MB) || 150) * 1048576;
function sniff(b) {
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
    if (b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { kind: 'image', mime: 'image/png', ext: 'png' };
    if (b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' };
    if (b.length >= 6 && /^GIF8[79]a$/.test(b.slice(0, 6).toString('latin1'))) return { kind: 'image', mime: 'image/gif', ext: 'gif' };
    if (b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return { kind: 'video', mime: 'video/webm', ext: 'webm' };
    if (b.length >= 12 && b.slice(4, 8).toString('latin1') === 'ftyp') { const brand = b.slice(8, 12).toString('latin1'); return brand === 'qt  ' ? { kind: 'video', mime: 'video/quicktime', ext: 'mov' } : { kind: 'video', mime: 'video/mp4', ext: 'mp4' }; }
    return null;
}
function deleteMediaFile(m) { try { fs.unlinkSync(path.join(mediaDir, `${m.id}.${m.ext}`)); } catch (e) {} m.deleted = true; }
router.post('/media', auth, (req, res) => {
    if (limited('upload:' + req.su.id, ...LIM.upload)) return slow(res, 'uploads');
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_VIDEO) return fail(res, 413, `That file is too big. Videos can be up to ${Math.round(MAX_VIDEO / 1048576)} MB.`);
    const id = newId('M'), tmp = path.join(mediaDir, id + '.part');
    let size = 0, head = Buffer.alloc(0), aborted = false;
    const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    const stop = (code, msg) => { if (aborted) return; aborted = true; try { req.unpipe && req.unpipe(out); } catch (e) {} out.once('close', () => fs.unlink(tmp, () => {})); out.destroy(); if (!res.headersSent) fail(res, code, msg); };
    req.on('data', (chunk) => {
        if (aborted) return; size += chunk.length;
        if (head.length < 32) head = Buffer.concat([head, chunk.slice(0, 32 - head.length)]);
        if (size > MAX_VIDEO) return stop(413, `That file is too big. Videos can be up to ${Math.round(MAX_VIDEO / 1048576)} MB.`);
        if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('error', () => stop(400, 'The upload was interrupted.'));
    req.on('aborted', () => stop(400, 'The upload was interrupted.'));
    req.on('end', () => {
        if (aborted) return;
        out.end(() => {
            if (aborted) return;
            const t = sniff(head);
            if (!size) return stop(400, 'The file is empty.');
            if (!t) return stop(415, 'Only photos (JPG, PNG, WEBP, GIF) and videos (MP4, MOV, WEBM) can be uploaded.');
            if (t.kind === 'image' && size > MAX_IMAGE) return stop(413, `Photos can be up to ${Math.round(MAX_IMAGE / 1048576)} MB.`);
            try { fs.renameSync(tmp, path.join(mediaDir, `${id}.${t.ext}`)); } catch (e) { return stop(500, 'The file could not be saved.'); }
            S.media[id] = { id, uid: req.su.id, kind: t.kind, mime: t.mime, ext: t.ext, size, at: now() }; dirty();
            res.json({ success: true, mediaId: id, kind: t.kind, mime: t.mime, size });
        });
    });
});
router.get('/media/:id', (req, res) => {
    const id = req.params.id; if (!okId(id, 'M')) return res.status(404).end();
    const m = S.media[id]; if (!m || m.deleted) return res.status(404).end();
    const inUse = m.usedAs === 'avatar' ? (S.users[m.uid] && S.users[m.uid].avatar === m.id)
        : m.usedAs === 'story' ? Object.values(S.stories).some(s => s.mediaId === id && s.expiresAt > now() && !s.deleted)
        : m.usedAs === 'message' ? false                                   // chat photos are private: served only to chat members (see /conversations/:id/media)
        : Object.values(S.posts).some(p => p.mediaId === id && p.status === 'LIVE');
    if (!inUse) return res.status(404).end();
    const fp = path.join(mediaDir, `${m.id}.${m.ext}`); let st; try { st = fs.statSync(fp); } catch (e) { return res.status(404).end(); }
    res.setHeader('Content-Type', m.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('Cache-Control', 'public, max-age=86400'); res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] !== '' || range[2] !== '')) {
        let start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]), end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
        end = Math.min(end, st.size - 1);
        if (!(start <= end) || start >= st.size) { res.setHeader('Content-Range', `bytes */${st.size}`); return res.status(416).end(); }
        res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`); res.setHeader('Content-Length', end - start + 1);
        return fs.createReadStream(fp, { start, end }).pipe(res);
    }
    res.setHeader('Content-Length', st.size); fs.createReadStream(fp).pipe(res);
});

// ---------------------------------------------------------------------------
// POSTS
// ---------------------------------------------------------------------------
const STYLES = ['sunset', 'ocean', 'forest', 'night', 'candy'];
router.post('/posts', auth, (req, res) => {
    const u = req.su, b = req.body || {}, caption = clean(b.caption, 2200);
    if (limited('post:' + u.id, ...LIM.post)) return slow(res, 'posts');
    let m = null;
    if (b.mediaId) {
        m = S.media[b.mediaId];
        if (!m || m.deleted || m.uid !== u.id) return fail(res, 400, 'Upload the photo or video first.');
        if (m.usedAs) return fail(res, 409, 'That file is already used.');
    }
    if (!m && caption.length < 1) return fail(res, 400, 'Write something or add a photo or video.');
    const id = newId('P'), p = { id, uid: u.id, caption, mediaId: m ? m.id : null, style: !m ? (STYLES.includes(b.style) ? b.style : 'night') : null, hashtags: tagsOf(caption), createdAt: now(), shares: 0, views: 0, status: 'LIVE', reports: 0 };
    if (m) m.usedAs = 'post';
    S.posts[id] = p; S.order.unshift(id);
    for (const h of mentionsOf(caption)) { const to = S.handles[h]; if (to) notify(to, { type: 'mention', from: u.id, postId: id, text: caption.slice(0, 100) }); }
    dirty(); res.json({ success: true, post: postView(p, u) });
});
const RANK = (p) => { const ageH = (now() - p.createdAt) / 3600000; const e = countOf(S.likes[p.id]) * 2 + (S.comments[p.id] || []).length * 3 + (p.shares || 0) * 4 + (p.views || 0) * 0.05 + 1; return e / Math.pow(ageH + 2, 1.4); };
router.get('/feed', soft, (req, res) => {
    const me = req.su, tab = req.query.tab === 'following' ? 'following' : 'foryou', cursor = Math.max(parseInt(req.query.cursor, 10) || 0, 0), limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
    if (tab === 'following' && !me) return fail(res, 401, 'Sign in to see the people you follow.');
    let list = S.order.map(id => S.posts[id]).filter(p => p && p.status === 'LIVE' && visible(p, me));
    let reposter = {};
    if (tab === 'following') {
        const items = new Map();
        for (const p of list) if (follows(me.id, p.uid) || p.uid === me.id) items.set(p.id, { p, at: p.createdAt, by: null });
        for (const p of list) for (const [uid, at] of Object.entries(S.reposts[p.id] || {})) {
            if (uid === p.uid || !(follows(me.id, uid) || uid === me.id) || !S.users[uid] || S.users[uid].deleted || blockedBetween(me.id, uid)) continue;
            const cur = items.get(p.id); if (!cur || at > cur.at) items.set(p.id, { p, at, by: uid });
        }
        const sorted = [...items.values()].sort((x, y) => y.at - x.at); list = sorted.map(x => x.p); sorted.forEach(x => { if (x.by) reposter[x.p.id] = x.by; });
    } else {
        const organic = list.filter(p => !p.sponsored).sort((a, b) => RANK(b) - RANK(a)), ads = list.filter(p => p.sponsored);
        // sponsored posts: the first after the 2nd post, then one after every 5 more; with very few posts they go at the end
        list = []; let ai = 0; organic.forEach((p, i) => { list.push(p); if (ads.length && (i === 1 || (i > 1 && (i - 1) % 5 === 0))) list.push(ads[ai++ % ads.length]); });
        if (organic.length < 2) list.push(...ads);
    }
    const page = list.slice(cursor, cursor + limit);
    res.json({ success: true, tab, posts: page.map(p => ({ ...postView(p, me), repostedBy: reposter[p.id] ? userCard(S.users[reposter[p.id]]) : null })), nextCursor: cursor + limit < list.length ? cursor + limit : null });
});
function livePost(req, res) { const p = S.posts[req.params.id]; if (!okId(req.params.id, 'P') || !p || !visible(p, req.su)) { fail(res, 404, 'This post is not available.'); return null; } return p; }
router.get('/posts/:id', soft, (req, res) => { const p = livePost(req, res); if (p) res.json({ success: true, post: postView(p, req.su) }); });
router.patch('/posts/:id', auth, (req, res) => {
    const p = livePost(req, res); if (!p) return; if (p.uid !== req.su.id) return fail(res, 403, 'You can only edit your own posts.');
    const c = clean(req.body && req.body.caption, 2200); if (!c && !p.mediaId) return fail(res, 400, 'A text post needs some text.');
    p.caption = c; p.hashtags = tagsOf(c); p.editedAt = now(); dirty(); res.json({ success: true, post: postView(p, req.su) });
});
function removePost(p, why) { p.status = 'REMOVED'; p.removedAt = now(); p.removedWhy = why; if (p.mediaId && S.media[p.mediaId]) deleteMediaFile(S.media[p.mediaId]); }
router.delete('/posts/:id', auth, (req, res) => {
    const p = S.posts[req.params.id]; if (!okId(req.params.id, 'P') || !p || p.status === 'REMOVED') return fail(res, 404, 'This post is not available.');
    if (p.uid !== req.su.id) return fail(res, 403, 'You can only delete your own posts.');
    removePost(p, 'DELETED_BY_AUTHOR'); dirty(); res.json({ success: true, message: 'Post deleted.' });
});
router.post('/posts/:id/like', auth, (req, res) => {
    const p = livePost(req, res); if (!p) return; if (limited('like:' + req.su.id, ...LIM.like)) return slow(res, 'likes');
    const L = S.likes[p.id] || (S.likes[p.id] = {}), uid = req.su.id, b = req.body || {};
    const reaction = REACTS.includes(b.reaction) ? b.reaction : null;
    const had = reactType(L[uid]);
    if (reaction) { if (had === reaction) delete L[uid]; else { L[uid] = { r: reaction, at: now() }; if (!had) notify(p.uid, { type: 'like', from: uid, postId: p.id }); } }
    else { const want = typeof b.like === 'boolean' ? b.like : !L[uid]; if (want) { const wasNew = !L[uid]; if (reactType(L[uid]) !== 'like') L[uid] = { r: 'like', at: now() }; if (wasNew) notify(p.uid, { type: 'like', from: uid, postId: p.id }); } else delete L[uid]; }
    dirty(); res.json({ success: true, liked: !!L[uid], myReaction: reactType(L[uid]), likes: countOf(L), reactions: reactBreakdown(L) });
});
router.post('/posts/:id/view', soft, (req, res) => {
    const p = livePost(req, res); if (!p) return;
    const key = p.id + ':' + (req.su ? req.su.id : 'ip:' + sha(ipOf(req)).slice(0, 16)), t = now();
    if (!S.views[key] || t - S.views[key] > 6 * 3600000) {
        S.views[key] = t; p.views = (p.views || 0) + 1;
        if (p.sponsored) { p.sponsored.impressions = (p.sponsored.impressions || 0) + 1; const c = p.sponsored.campaignId && S.campaigns[p.sponsored.campaignId]; if (c && c.status === 'ACTIVE') { c.impressions++; syncCampaign(c); } }
        dirty();
    }
    if (Object.keys(S.views).length > 100000) for (const [k, v] of Object.entries(S.views)) if (t - v > 6 * 3600000) delete S.views[k];
    res.json({ success: true, views: p.views });
});
router.post('/posts/:id/share', soft, (req, res) => {
    const p = livePost(req, res); if (!p) return; if (limited('share:' + (req.su ? req.su.id : ipOf(req)), ...LIM.share)) return slow(res, 'shares');
    p.shares = (p.shares || 0) + 1; dirty(); res.json({ success: true, shares: p.shares, url: `/ads?post=${p.id}` });
});
router.post('/posts/:id/cta', soft, (req, res) => {
    const p = livePost(req, res); if (!p) return; if (!p.sponsored) return fail(res, 404, 'This post has no link.');
    p.sponsored.clicks = (p.sponsored.clicks || 0) + 1; const c = p.sponsored.campaignId && S.campaigns[p.sponsored.campaignId]; if (c) c.clicks++;
    dirty(); res.json({ success: true, url: p.sponsored.ctaUrl });
});
// comments
router.get('/posts/:id/comments', soft, (req, res) => {
    const p = livePost(req, res); if (!p) return; const me = req.su;
    const all = (S.comments[p.id] || []).filter(c => !c.deleted && S.users[c.uid] && !S.users[c.uid].deleted && !blockedBetween(me && me.id, c.uid));
    const view = (c) => ({ id: c.id, text: c.text, at: c.at, author: userCard(S.users[c.uid]), mine: !!(me && c.uid === me.id), canDelete: !!(me && (c.uid === me.id || p.uid === me.id)), parentId: c.parentId || null, likes: countOf(c.likes), liked: !!(me && c.likes && c.likes[me.id]) });
    const repliesByParent = {}; for (const c of all) if (c.parentId) (repliesByParent[c.parentId] || (repliesByParent[c.parentId] = [])).push(view(c));
    const tops = all.filter(c => !c.parentId).slice(-200).map(c => ({ ...view(c), replies: (repliesByParent[c.id] || []).slice(-50) }));
    res.json({ success: true, comments: tops });
});
router.post('/posts/:id/comments', auth, (req, res) => {
    const p = livePost(req, res); if (!p) return; if (limited('comment:' + req.su.id, ...LIM.comment)) return slow(res, 'comments');
    const text = clean(req.body && req.body.text, 500); if (!text) return fail(res, 400, 'Write a comment first.');
    const list = (S.comments[p.id] || (S.comments[p.id] = []));
    let parentId = null; const pid = req.body && req.body.parentId;
    if (pid) { const par = list.find(x => x.id === pid && !x.deleted); if (!par) return fail(res, 404, 'That comment is no longer there.'); parentId = par.parentId || par.id; }   // replies always attach to the top-level comment (one level deep)
    const c = { id: newId('C'), uid: req.su.id, text, at: now(), parentId };
    list.push(c);
    notify(p.uid, { type: 'comment', from: req.su.id, postId: p.id, text });
    if (parentId) { const par = list.find(x => x.id === parentId); if (par && par.uid !== req.su.id) notify(par.uid, { type: 'reply', from: req.su.id, postId: p.id, text }); }
    for (const h of mentionsOf(text)) { const to = S.handles[h]; if (to && to !== p.uid) notify(to, { type: 'mention', from: req.su.id, postId: p.id, text }); }
    dirty(); res.json({ success: true, comment: { id: c.id, text, at: c.at, author: userCard(req.su), mine: true, canDelete: true, parentId, likes: 0, liked: false, replies: [] } });
});
router.post('/posts/:id/comments/:cid/like', auth, (req, res) => {
    const p = S.posts[req.params.id], c = p && (S.comments[p.id] || []).find(x => x.id === req.params.cid && !x.deleted);
    if (!c) return fail(res, 404, 'Comment not found.');
    const L = c.likes || (c.likes = {}), uid = req.su.id, want = req.body && typeof req.body.like === 'boolean' ? req.body.like : !L[uid];
    if (want) { if (!L[uid]) { L[uid] = now(); if (c.uid !== uid) notify(c.uid, { type: 'like', from: uid, postId: p.id }); } } else delete L[uid];
    dirty(); res.json({ success: true, liked: !!L[uid], likes: countOf(L) });
});
router.delete('/posts/:id/comments/:cid', auth, (req, res) => {
    const p = S.posts[req.params.id], c = p && (S.comments[p.id] || []).find(x => x.id === req.params.cid && !x.deleted);
    if (!c) return fail(res, 404, 'Comment not found.');
    if (c.uid !== req.su.id && p.uid !== req.su.id) return fail(res, 403, 'You can only delete your own comments, or comments on your posts.');
    c.deleted = true; c.text = ''; dirty(); res.json({ success: true });
});
// reports (3 different people reporting a post hides it until a moderator decides)
const REASONS = ['spam', 'scam', 'nudity', 'violence', 'hate', 'harassment', 'false_information', 'other'];
router.post('/posts/:id/report', auth, (req, res) => {
    const p = livePost(req, res); if (!p) return; if (p.uid === req.su.id) return fail(res, 400, 'You cannot report your own post.');
    if (limited('report:' + req.su.id, ...LIM.report)) return slow(res, 'reports');
    const reason = REASONS.includes(req.body && req.body.reason) ? req.body.reason : 'other';
    if (S.reports.some(r => r.type === 'post' && r.targetId === p.id && r.by === req.su.id && r.status === 'OPEN')) return res.json({ success: true, message: 'You already reported this post. Thank you.' });
    S.reports.push({ id: newId('R'), type: 'post', targetId: p.id, by: req.su.id, reason, note: clean(req.body && req.body.note, 300), at: now(), status: 'OPEN' });
    const reporters = new Set(S.reports.filter(r => r.type === 'post' && r.targetId === p.id && r.status === 'OPEN').map(r => r.by));
    p.reports = reporters.size; if (reporters.size >= 3 && p.status === 'LIVE') p.status = 'HIDDEN';
    dirty(); res.json({ success: true, message: 'Thank you. Our team will review this post.' });
});

// ---------------------------------------------------------------------------
// PEOPLE
// ---------------------------------------------------------------------------
function userById(req, res) { const u = S.users[req.params.id]; if (!okId(req.params.id, 'U') || !u || u.deleted || S.bans[u.id]) { fail(res, 404, 'User not found.'); return null; } return u; }
router.get('/users/:handle', soft, (req, res) => {
    const uid = S.handles[normHandle(req.params.handle)], u = uid && S.users[uid], me = req.su;
    if (!u || u.deleted || S.bans[u.id] || blockedBetween(me && me.id, u.id)) return fail(res, 404, 'User not found.');
    const posts = S.order.map(id => S.posts[id]).filter(p => p && p.uid === u.id && visible(p, me) && p.status === 'LIVE');
    res.json({ success: true, user: { ...userCard(u), bio: u.bio, joinedAt: u.createdAt, counts: { posts: posts.length, followers: countOf(S.followers[u.id]), following: countOf(S.follows[u.id]), likes: posts.reduce((s, p) => s + countOf(S.likes[p.id]), 0) }, isMe: !!(me && me.id === u.id), isFollowing: follows(me && me.id, u.id), followsYou: follows(u.id, me && me.id), blocked: !!(me && S.blocks[me.id] && S.blocks[me.id][u.id]) }, posts: posts.slice(0, 60).map(p => postView(p, me)) });
});
router.post('/users/:id/follow', auth, (req, res) => {
    const t = userById(req, res); if (!t) return; const me = req.su;
    if (t.id === me.id) return fail(res, 400, 'You cannot follow yourself.');
    if (blockedBetween(me.id, t.id)) return fail(res, 403, 'You cannot follow this account.');
    if (limited('follow:' + me.id, ...LIM.follow)) return slow(res, 'follows');
    const F = S.follows[me.id] || (S.follows[me.id] = {}), R = S.followers[t.id] || (S.followers[t.id] = {});
    const want = req.body && typeof req.body.follow === 'boolean' ? req.body.follow : !F[t.id];
    if (want && !F[t.id]) { F[t.id] = now(); R[me.id] = now(); notify(t.id, { type: 'follow', from: me.id }); } else if (!want) { delete F[t.id]; delete R[me.id]; }
    dirty(); res.json({ success: true, following: !!F[t.id], followers: countOf(R) });
});
router.post('/users/:id/block', auth, (req, res) => {
    const t = userById(req, res); if (!t) return; const me = req.su; if (t.id === me.id) return fail(res, 400, 'You cannot block yourself.');
    const B = S.blocks[me.id] || (S.blocks[me.id] = {}), want = req.body && typeof req.body.block === 'boolean' ? req.body.block : !B[t.id];
    if (want) { B[t.id] = now(); for (const [a, b] of [[me.id, t.id], [t.id, me.id]]) { if (S.follows[a]) delete S.follows[a][b]; if (S.followers[b]) delete S.followers[b][a]; } } else delete B[t.id];
    dirty(); res.json({ success: true, blocked: !!B[t.id] });
});
router.post('/users/:id/report', auth, (req, res) => {
    const t = userById(req, res); if (!t) return; if (t.id === req.su.id) return fail(res, 400, 'You cannot report yourself.');
    if (limited('report:' + req.su.id, ...LIM.report)) return slow(res, 'reports');
    S.reports.push({ id: newId('R'), type: 'user', targetId: t.id, by: req.su.id, reason: REASONS.includes(req.body && req.body.reason) ? req.body.reason : 'other', note: clean(req.body && req.body.note, 300), at: now(), status: 'OPEN' });
    dirty(); res.json({ success: true, message: 'Thank you. Our team will review this account.' });
});

// ---------------------------------------------------------------------------
// DISCOVER
// ---------------------------------------------------------------------------
// people to follow: accounts you don't follow yet, most-followed and newest first (so a new user is never alone)
router.get('/discover/people', soft, (req, res) => {
    const me = req.su;
    let list = Object.values(S.users).filter(u => !u.deleted && !S.bans[u.id] && (!me || (u.id !== me.id && !follows(me.id, u.id) && !blockedBetween(me.id, u.id))));
    list.sort((a, b) => (countOf(S.followers[b.id]) - countOf(S.followers[a.id])) || (b.createdAt - a.createdAt));
    res.json({ success: true, people: list.slice(0, 30).map(u => ({ ...userCard(u), bio: u.bio || '', followers: countOf(S.followers[u.id]), posts: S.order.filter(id => S.posts[id] && S.posts[id].uid === u.id && S.posts[id].status === 'LIVE').length, isFollowing: follows(me && me.id, u.id), isMe: !!(me && me.id === u.id) })) });
});
router.get('/search', soft, (req, res) => {
    const q = clean(req.query.q, 60).toLowerCase(), me = req.su; if (q.length < 1) return res.json({ success: true, users: [], posts: [] });
    const tag = q.replace(/^#/, ''), word = q.replace(/^[@#]/, '');
    const users = Object.values(S.users).filter(u => !u.deleted && !S.bans[u.id] && !blockedBetween(me && me.id, u.id) && (u.handle.includes(word) || String(u.name).toLowerCase().includes(word))).slice(0, 20)
        .map(u => ({ ...userCard(u), bio: u.bio, followers: countOf(S.followers[u.id]), isFollowing: follows(me && me.id, u.id), isMe: !!(me && me.id === u.id) }));
    const posts = S.order.map(id => S.posts[id]).filter(p => p && p.status === 'LIVE' && visible(p, me) && ((p.hashtags || []).includes(tag) || String(p.caption).toLowerCase().includes(q))).slice(0, 30).map(p => postView(p, me));
    res.json({ success: true, users, posts });
});
router.get('/trending', soft, (req, res) => {
    const since = now() - 7 * 86400000, counts = {};
    for (const id of S.order) { const p = S.posts[id]; if (!p || p.status !== 'LIVE' || p.createdAt < since) continue; for (const h of p.hashtags || []) counts[h] = (counts[h] || 0) + 1 + countOf(S.likes[p.id]) * 0.1; }
    const tags = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([tag, score]) => ({ tag, posts: S.order.filter(id => S.posts[id] && S.posts[id].status === 'LIVE' && (S.posts[id].hashtags || []).includes(tag)).length, score: Math.round(score * 10) / 10 }));
    const people = Object.values(S.users).filter(u => !u.deleted && !S.bans[u.id] && !(req.su && req.su.id === u.id)).sort((a, b) => countOf(S.followers[b.id]) - countOf(S.followers[a.id])).slice(0, 10).map(u => ({ ...userCard(u), followers: countOf(S.followers[u.id]), isFollowing: follows(req.su && req.su.id, u.id) }));
    res.json({ success: true, tags, people });
});

// ---------------------------------------------------------------------------
// NOTIFICATIONS
// ---------------------------------------------------------------------------
router.get('/notifications', auth, (req, res) => {
    const list = (S.notifs[req.su.id] || []).filter(n => S.users[n.from] && !S.users[n.from].deleted).slice(0, 100);
    res.json({ success: true, unread: list.filter(n => !n.read).length, notifications: list.map(n => ({ ...n, fromUser: userCard(S.users[n.from]), post: n.postId && S.posts[n.postId] && S.posts[n.postId].status === 'LIVE' ? { id: n.postId, thumb: S.posts[n.postId].mediaId && S.media[S.posts[n.postId].mediaId] && S.media[S.posts[n.postId].mediaId].kind === 'image' ? mediaUrl(S.posts[n.postId].mediaId) : null } : null })) });
});
router.post('/notifications/read', auth, (req, res) => { (S.notifs[req.su.id] || []).forEach(n => { n.read = true; }); dirty(); res.json({ success: true }); });

// ---------------------------------------------------------------------------
// MESSAGES (1:1)
// ---------------------------------------------------------------------------
const pairKey = (a, b) => [a, b].sort().join('|');
function convOf(req, res) { const c = S.convs[req.params.id]; if (!okId(req.params.id, 'K') || !c || !c.members.includes(req.su.id)) { fail(res, 404, 'Conversation not found.'); return null; } return c; }
function convView(c, me) {
    const msgs = S.msgs[c.id] || [], last = msgs[msgs.length - 1], lastRead = (S.reads[c.id] || {})[me.id] || 0;
    const lastV = last ? { text: last.text || (last.mediaId ? (S.media[last.mediaId] && S.media[last.mediaId].kind === 'video' ? '🎥 Video' : '📷 Photo') : (last.sharedPostId ? '📎 Shared a post' : '')), at: last.at, mine: last.from === me.id, system: !!last.system, from: last.system ? null : (S.users[last.from] ? S.users[last.from].name : '') } : null;
    const base = { id: c.id, last: lastV, unread: msgs.filter(m => m.from !== me.id && m.at > lastRead).length, updatedAt: c.lastAt };
    if (c.type === 'group') return { ...base, type: 'group', name: c.name, with: null, members: c.members.filter(m => S.users[m] && !S.users[m].deleted).map(m => ({ ...userCard(S.users[m]), admin: (c.admins || []).includes(m) })), isAdmin: (c.admins || []).includes(me.id), blocked: false };
    const other = S.users[c.members.find(m => m !== me.id)];
    return { ...base, type: 'dm', with: userCard(other), blocked: blockedBetween(me.id, other && other.id) };
}
router.get('/conversations', auth, (req, res) => {
    const me = req.su, list = Object.values(S.convs).filter(c => c.members.includes(me.id) && (S.msgs[c.id] || []).length && (c.type === 'group' || c.members.every(m => S.users[m] && !S.users[m].deleted))).sort((a, b) => b.lastAt - a.lastAt);
    res.json({ success: true, conversations: list.slice(0, 100).map(c => convView(c, me)) });
});
router.post('/conversations', auth, (req, res) => {
    const me = req.su, to = S.users[req.body && req.body.userId];
    if (!to || to.deleted || S.bans[to.id] || to.id === me.id) return fail(res, 404, 'User not found.');
    if (blockedBetween(me.id, to.id)) return fail(res, 403, 'You cannot message this account.');
    const k = pairKey(me.id, to.id); let c = S.pairs[k] && S.convs[S.pairs[k]];
    if (!c) { c = { id: newId('K'), members: [me.id, to.id], createdAt: now(), lastAt: now() }; S.convs[c.id] = c; S.pairs[k] = c.id; dirty(); }
    res.json({ success: true, conversation: convView(c, me) });
});
const msgView = (m, me, c) => {
    const others = c.members.filter(x => x !== m.from), R = S.reads[c.id] || {}, seenBy = others.filter(x => (R[x] || 0) >= m.at).length;
    const md = m.mediaId && S.media[m.mediaId] && !S.media[m.mediaId].deleted ? { kind: S.media[m.mediaId].kind, url: `/api/ads/conversations/${c.id}/media/${m.mediaId}` } : null;
    let sharedPost;
    if (m.sharedPostId) { const sp = S.posts[m.sharedPostId]; if (sp && sp.status === 'LIVE') { const spm = sp.mediaId ? S.media[sp.mediaId] : null; sharedPost = { id: sp.id, caption: (sp.caption || '').slice(0, 140), author: userCard(S.users[sp.uid]), thumb: spm && spm.kind === 'image' && !spm.deleted ? mediaUrl(spm.id) : null }; } else sharedPost = { unavailable: true }; }
    return { id: m.id, text: m.text, at: m.at, mine: m.from === me.id, system: !!m.system, media: md, sharedPost, forwarded: !!m.forwarded, from: c.type === 'group' && !m.system ? userCard(S.users[m.from]) : undefined,
        seen: m.from === me.id && others.length > 0 && seenBy === others.length, seenBy: c.type === 'group' && m.from === me.id ? seenBy : undefined };
};
router.get('/conversations/:id/messages', auth, (req, res) => {
    const c = convOf(req, res); if (!c) return; const before = Number(req.query.before) || Infinity;
    const list = (S.msgs[c.id] || []).filter(m => m.at < before).slice(-50);
    res.json({ success: true, conversation: convView(c, req.su), messages: list.map(m => msgView(m, req.su, c)), more: (S.msgs[c.id] || []).filter(m => m.at < before).length > 50 });
});
router.post('/conversations/:id/messages', auth, (req, res) => {
    const c = convOf(req, res); if (!c) return; const me = req.su, group = c.type === 'group', other = group ? null : c.members.find(m => m !== me.id);
    if (!group && blockedBetween(me.id, other)) return fail(res, 403, 'You cannot message this account.');
    if (limited('msg:' + me.id, ...LIM.msg) || limited('msgday:' + me.id, ...LIM.msgDay)) return slow(res, 'messages');
    const text = clean(req.body && req.body.text, 2000), mid = req.body && req.body.mediaId;
    const sid = req.body && req.body.postId, forwarded = !!(req.body && req.body.forwarded);
    let md = null, sp = null;
    if (mid) { md = S.media[mid]; if (!md || md.deleted || md.uid !== me.id || !(md.kind === 'image' || md.kind === 'video')) return fail(res, 400, 'Upload the photo or video first.'); if (md.usedAs) return fail(res, 409, 'That file is already used.'); }
    if (sid) { if (!okId(String(sid), 'P') || !(sp = S.posts[sid]) || sp.status !== 'LIVE') return fail(res, 400, 'That post is no longer available to share.'); }
    if (!text && !md && !sp) return fail(res, 400, 'Write a message first.');
    if (md) { md.usedAs = 'message'; md.convId = c.id; }
    const m = { id: newId('X'), from: me.id, text, at: now(), mediaId: md ? md.id : null, sharedPostId: sp ? sp.id : null, forwarded }, list = S.msgs[c.id] || (S.msgs[c.id] = []);
    list.push(m); if (list.length > 5000) list.shift(); c.lastAt = m.at;
    (S.reads[c.id] || (S.reads[c.id] = {}))[me.id] = m.at;
    for (const to of c.members.filter(x => x !== me.id)) emitTo(to, 'social:message', { conversationId: c.id, message: { ...msgView(m, S.users[to] || { id: to }, c), mine: false }, from: userCard(me) });
    dirty(); res.json({ success: true, message: msgView(m, me, c) });
});
router.post('/conversations/:id/read', auth, (req, res) => {
    const c = convOf(req, res); if (!c) return; const t = now(); (S.reads[c.id] || (S.reads[c.id] = {}))[req.su.id] = t;
    for (const to of c.members.filter(m => m !== req.su.id)) emitTo(to, 'social:read', { conversationId: c.id, at: t, by: req.su.id }); dirty(); res.json({ success: true });
});


// ---------------------------------------------------------------------------
// REPOSTS, QUOTES, SAVES (like X)
// ---------------------------------------------------------------------------
router.post('/posts/:id/repost', auth, (req, res) => {
    const p = livePost(req, res); if (!p) return; if (limited('like:' + req.su.id, ...LIM.like)) return slow(res, 'reposts');
    const R = S.reposts[p.id] || (S.reposts[p.id] = {}), uid = req.su.id, want = req.body && typeof req.body.repost === 'boolean' ? req.body.repost : !R[uid];
    if (want && !R[uid]) { R[uid] = now(); notify(p.uid, { type: 'repost', from: uid, postId: p.id }); } else if (!want) delete R[uid];
    dirty(); res.json({ success: true, reposted: !!R[uid], reposts: countOf(R) });
});
router.post('/posts/:id/quote', auth, (req, res) => {
    const q = livePost(req, res); if (!q) return; const u = req.su;
    if (limited('post:' + u.id, ...LIM.post)) return slow(res, 'posts');
    const caption = clean(req.body && req.body.caption, 2200); if (!caption) return fail(res, 400, 'Add your comment to quote this post.');
    const id = newId('P'), p = { id, uid: u.id, caption, mediaId: null, style: null, quoteOf: q.id, hashtags: tagsOf(caption), createdAt: now(), shares: 0, views: 0, status: 'LIVE', reports: 0 };
    S.posts[id] = p; S.order.unshift(id);
    notify(q.uid, { type: 'quote', from: u.id, postId: id, text: caption.slice(0, 100) });
    for (const h of mentionsOf(caption)) { const to = S.handles[h]; if (to && to !== q.uid) notify(to, { type: 'mention', from: u.id, postId: id, text: caption.slice(0, 100) }); }
    dirty(); res.json({ success: true, post: postView(p, u) });
});
router.post('/posts/:id/save', auth, (req, res) => {
    const p = livePost(req, res); if (!p) return; const Sv = S.saves[req.su.id] || (S.saves[req.su.id] = {});
    const want = req.body && typeof req.body.save === 'boolean' ? req.body.save : !Sv[p.id];
    if (want) Sv[p.id] = now(); else delete Sv[p.id];
    if (countOf(Sv) > 2000) { const oldest = Object.entries(Sv).sort((a, b) => a[1] - b[1])[0]; delete Sv[oldest[0]]; }
    dirty(); res.json({ success: true, saved: !!Sv[p.id] });
});
router.get('/saved', auth, (req, res) => {
    const me = req.su, list = Object.entries(S.saves[me.id] || {}).sort((a, b) => b[1] - a[1]).map(([id]) => S.posts[id]).filter(p => p && p.status === 'LIVE' && visible(p, me));
    res.json({ success: true, posts: list.slice(0, 100).map(p => postView(p, me)) });
});

// ---------------------------------------------------------------------------
// STORIES / STATUS (24 hours, like WhatsApp Status and Instagram Stories)
// ---------------------------------------------------------------------------
const STORY_MS = 24 * 3600000;
function sweepStories() {
    const t = now();
    for (const s of Object.values(S.stories)) if (!s.deleted && s.expiresAt <= t) { s.deleted = true; if (s.mediaId && S.media[s.mediaId]) deleteMediaFile(S.media[s.mediaId]); delete S.storyViews[s.id]; }
    for (const [id, s] of Object.entries(S.stories)) if (s.deleted && t - s.expiresAt > 7 * 86400000) delete S.stories[id];
}
const storyItem = (s, me) => {
    const m = s.mediaId ? S.media[s.mediaId] : null;
    return { id: s.id, media: m && !m.deleted ? { kind: m.kind, url: mediaUrl(m.id), mime: m.mime } : null, text: s.text || '', style: s.style || null, createdAt: s.createdAt, expiresAt: s.expiresAt,
        seen: !!(me && S.storyViews[s.id] && S.storyViews[s.id][me.id]), viewers: me && me.id === s.uid ? countOf(S.storyViews[s.id]) : undefined };
};
router.post('/stories', auth, (req, res) => {
    const u = req.su, b = req.body || {}; if (limited('story:' + u.id, ...LIM.story)) return slow(res, 'stories');
    let m = null;
    if (b.mediaId) { m = S.media[b.mediaId]; if (!m || m.deleted || m.uid !== u.id) return fail(res, 400, 'Upload the photo or video first.'); if (m.usedAs) return fail(res, 409, 'That file is already used.'); }
    const text = clean(b.text, 300); if (!m && !text) return fail(res, 400, 'Add a photo, a video or some text.');
    const id = newId('T'), t = now(), s = { id, uid: u.id, mediaId: m ? m.id : null, text, style: !m ? (STYLES.includes(b.style) ? b.style : 'sunset') : null, createdAt: t, expiresAt: t + STORY_MS };
    if (m) m.usedAs = 'story';
    S.stories[id] = s; dirty(); res.json({ success: true, story: storyItem(s, u) });
});
router.get('/stories', soft, (req, res) => {
    sweepStories(); const me = req.su, t = now(), byUser = new Map();
    for (const s of Object.values(S.stories)) {
        if (s.deleted || s.expiresAt <= t) continue; const u = S.users[s.uid];
        if (!u || u.deleted || S.bans[u.id] || blockedBetween(me && me.id, u.id)) continue;
        if (me && !(u.id === me.id || follows(me.id, u.id))) continue;               // signed in: you and the people you follow
        if (!byUser.has(u.id)) byUser.set(u.id, []); byUser.get(u.id).push(s);
    }
    const out = [...byUser.entries()].map(([uid, list]) => { const items = list.sort((a, b) => a.createdAt - b.createdAt).map(s => storyItem(s, me)); return { user: userCard(S.users[uid]), isMe: !!(me && me.id === uid), items, allSeen: items.every(i => i.seen), latest: items[items.length - 1].createdAt }; })
        .sort((a, b) => (b.isMe - a.isMe) || (a.allSeen - b.allSeen) || (b.latest - a.latest)).slice(0, 50);
    res.json({ success: true, stories: out });
});
function storyOf(req, res) { const s = S.stories[req.params.id]; if (!okId(req.params.id, 'T') || !s || s.deleted || s.expiresAt <= now() || !S.users[s.uid] || blockedBetween(req.su && req.su.id, s.uid)) { fail(res, 404, 'This story has expired.'); return null; } return s; }
router.post('/stories/:id/view', auth, (req, res) => {
    const s = storyOf(req, res); if (!s) return;
    if (s.uid !== req.su.id) { const V = S.storyViews[s.id] || (S.storyViews[s.id] = {}); if (!V[req.su.id]) { V[req.su.id] = now(); dirty(); } }
    res.json({ success: true });
});
router.get('/stories/:id/viewers', auth, (req, res) => {
    const s = storyOf(req, res); if (!s) return; if (s.uid !== req.su.id) return fail(res, 403, 'Only the owner can see who viewed a story.');
    const V = S.storyViews[s.id] || {}; res.json({ success: true, viewers: Object.entries(V).sort((a, b) => b[1] - a[1]).filter(([uid]) => S.users[uid] && !S.users[uid].deleted).map(([uid, at]) => ({ ...userCard(S.users[uid]), at })) });
});
router.delete('/stories/:id', auth, (req, res) => {
    const s = storyOf(req, res); if (!s) return; if (s.uid !== req.su.id) return fail(res, 403, 'You can only delete your own story.');
    s.deleted = true; s.expiresAt = now(); if (s.mediaId && S.media[s.mediaId]) deleteMediaFile(S.media[s.mediaId]); delete S.storyViews[s.id]; dirty(); res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GROUP CHATS (like WhatsApp groups) and private chat photos
// ---------------------------------------------------------------------------
const GROUP_MAX = 64;
function sysMsg(c, text) { const m = { id: newId('X'), from: null, system: true, text: clean(text, 200), at: now() }; (S.msgs[c.id] || (S.msgs[c.id] = [])).push(m); c.lastAt = m.at; for (const to of c.members) emitTo(to, 'social:message', { conversationId: c.id, message: { id: m.id, text: m.text, at: m.at, system: true, mine: false } }); }
router.post('/groups', auth, (req, res) => {
    const me = req.su, b = req.body || {}; if (limited('group:' + me.id, ...LIM.group)) return slow(res, 'new groups');
    const name = clean(b.name, 50); if (name.length < 2) return fail(res, 400, 'Give the group a name.');
    const ids = [...new Set((Array.isArray(b.userIds) ? b.userIds : []).filter(x => typeof x === 'string'))].filter(id => S.users[id] && !S.users[id].deleted && !S.bans[id] && id !== me.id && !blockedBetween(me.id, id));
    if (!ids.length) return fail(res, 400, 'Add at least one person.'); if (ids.length + 1 > GROUP_MAX) return fail(res, 400, `A group can have up to ${GROUP_MAX} people.`);
    const c = { id: newId('K'), type: 'group', name, members: [me.id, ...ids], admins: [me.id], createdBy: me.id, createdAt: now(), lastAt: now() };
    S.convs[c.id] = c; sysMsg(c, `${me.name} created the group "${name}"`);
    if (D.appendAudit) D.appendAudit('SOCIAL_GROUP_CREATED', { conversationId: c.id, by: me.id, members: c.members.length });
    dirty(); res.json({ success: true, conversation: convView(c, me) });
});
function groupOf(req, res) { const c = convOf(req, res); if (!c) return null; if (c.type !== 'group') { fail(res, 400, 'This is not a group.'); return null; } return c; }
router.post('/groups/:id/members', auth, (req, res) => {
    const c = groupOf(req, res); if (!c) return; const me = req.su, b = req.body || {};
    if (!(c.admins || []).includes(me.id)) return fail(res, 403, 'Only group admins can add or remove people.');
    const add = (Array.isArray(b.add) ? b.add : []).filter(id => typeof id === 'string' && S.users[id] && !S.users[id].deleted && !S.bans[id] && !c.members.includes(id) && !blockedBetween(me.id, id));
    const remove = (Array.isArray(b.remove) ? b.remove : []).filter(id => c.members.includes(id) && id !== me.id);
    if (c.members.length + add.length - remove.length > GROUP_MAX) return fail(res, 400, `A group can have up to ${GROUP_MAX} people.`);
    for (const id of add) { c.members.push(id); sysMsg(c, `${me.name} added ${S.users[id].name}`); }
    for (const id of remove) { c.members = c.members.filter(x => x !== id); c.admins = (c.admins || []).filter(x => x !== id); sysMsg(c, `${me.name} removed ${S.users[id] ? S.users[id].name : 'a member'}`); emitTo(id, 'social:removed', { conversationId: c.id }); }
    if (b.makeAdmin && c.members.includes(b.makeAdmin) && !(c.admins || []).includes(b.makeAdmin)) { c.admins.push(b.makeAdmin); sysMsg(c, `${S.users[b.makeAdmin].name} is now an admin`); }
    dirty(); res.json({ success: true, conversation: convView(c, me) });
});
router.post('/groups/:id/leave', auth, (req, res) => {
    const c = groupOf(req, res); if (!c) return; const me = req.su;
    c.members = c.members.filter(x => x !== me.id); c.admins = (c.admins || []).filter(x => x !== me.id);
    if (c.members.length && !c.admins.length) c.admins.push(c.members[0]);               // a group always keeps an admin
    sysMsg(c, `${me.name} left`); dirty(); res.json({ success: true });
});
router.get('/conversations/:id/media/:mid', auth, (req, res) => {
    const c = convOf(req, res); if (!c) return; const m = S.media[req.params.mid];
    if (!okId(req.params.mid, 'M') || !m || m.deleted || m.usedAs !== 'message' || m.convId !== c.id) return res.status(404).end();
    const fp = path.join(mediaDir, `${m.id}.${m.ext}`); let st; try { st = fs.statSync(fp); } catch (e) { return res.status(404).end(); }
    res.setHeader('Content-Type', m.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600'); res.setHeader('Content-Length', st.size); fs.createReadStream(fp).pipe(res);
});

// ---------------------------------------------------------------------------
// SELF-SERVE ADVERTISING: anyone promotes their own post with a budget; pay per 1,000 views
// ---------------------------------------------------------------------------
const CPM_KES = Number(process.env.SOCIAL_AD_CPM_KES) > 0 ? Number(process.env.SOCIAL_AD_CPM_KES) : 50;     // KES per 1,000 counted views
const REVIEW = process.env.ADS_REQUIRE_REVIEW === 'true';
const kes = (c) => Math.round(c) / 100;
function spentOf(c) { return Math.min(c.budgetC, Math.floor(c.impressions * c.cpmC / 1000)); }
function setSponsor(c, on) {
    const p = S.posts[c.postId]; if (!p) return;
    if (on) p.sponsored = { label: 'Sponsored', ctaText: c.ctaText, ctaUrl: c.ctaUrl, impressions: (p.sponsored && p.sponsored.impressions) || 0, clicks: (p.sponsored && p.sponsored.clicks) || 0, campaignId: c.id, since: now() };
    else if (p.sponsored && p.sponsored.campaignId === c.id) p.sponsored = null;
}
function finish(c, status) { c.status = status; c.endedAt = now(); c.spentC = spentOf(c); c.refundC = c.budgetC - c.spentC; setSponsor(c, false); if (D.appendAudit) D.appendAudit('SOCIAL_CAMPAIGN_ENDED', { campaignId: c.id, status, spent: kes(c.spentC), refund: kes(c.refundC) }); }
function syncCampaign(c) {
    if (!['ACTIVE', 'PAUSED', 'PENDING_REVIEW'].includes(c.status)) return c;
    c.spentC = spentOf(c);
    const p = S.posts[c.postId];
    if (!p || p.status !== 'LIVE') finish(c, 'STOPPED');                          // the post was removed, hidden or deleted
    else if (c.spentC >= c.budgetC) finish(c, 'COMPLETED');
    else if (now() >= c.endsAt) finish(c, 'COMPLETED');
    return c;
}
const campView = (c) => { syncCampaign(c); const p = S.posts[c.postId], m = p && p.mediaId ? S.media[p.mediaId] : null;
    return { id: c.id, status: c.status, budget: kes(c.budgetC), spent: kes(c.spentC), remaining: kes(c.budgetC - c.spentC), refund: c.refundC != null ? kes(c.refundC) : null, cpm: kes(c.cpmC),
        impressions: c.impressions, clicks: c.clicks, ctr: c.impressions ? Math.round(c.clicks / c.impressions * 10000) / 100 : 0, ctaText: c.ctaText, ctaUrl: c.ctaUrl, createdAt: c.createdAt, endsAt: c.endsAt,
        payment: c.payment, post: p ? { id: p.id, caption: p.caption, thumb: m && m.kind === 'image' && p.status === 'LIVE' ? mediaUrl(m.id) : null, status: p.status } : null }; };
router.post('/campaigns', auth, (req, res) => {
    const me = req.su, b = req.body || {}; if (limited('campaign:' + me.id, ...LIM.campaign)) return slow(res, 'new campaigns');
    if (D.paymentsMode && D.paymentsMode() !== 'simulated') return fail(res, 501, 'Paying for ads with M-Pesa is not connected yet on this server.');
    const p = S.posts[b.postId]; if (!okId(String(b.postId || ''), 'P') || !p || p.status !== 'LIVE' || p.uid !== me.id) return fail(res, 404, 'Choose one of your own live posts to promote.');
    if (Object.values(S.campaigns).some(c => c.postId === p.id && ['ACTIVE', 'PAUSED', 'PENDING_REVIEW'].includes(syncCampaign(c).status))) return fail(res, 409, 'This post is already being promoted.');
    const budget = Number(b.budget), days = Number(b.days || 7);
    if (!Number.isInteger(budget) || budget < 100 || budget > 500000) return fail(res, 400, 'The budget must be a whole number of shillings between KES 100 and KES 500,000.');
    if (!Number.isInteger(days) || days < 1 || days > 30) return fail(res, 400, 'Run the ad for 1 to 30 days.');
    const url = safeCtaUrl(b.ctaUrl); if (!url) return fail(res, 400, 'The link must be an https address, or a page inside RDS such as /user?shop=M1.');
    const t = now(), c = { id: newId('A'), uid: me.id, postId: p.id, budgetC: budget * 100, cpmC: Math.round(CPM_KES * 100), spentC: 0, impressions: 0, clicks: 0, ctaText: clean(b.ctaText, 30) || 'Learn more', ctaUrl: url,
        status: REVIEW ? 'PENDING_REVIEW' : 'ACTIVE', createdAt: t, endsAt: t + days * 86400000, payment: { mode: 'SIMULATED', amount: budget, ref: 'SIM-' + crypto.randomBytes(4).toString('hex').toUpperCase(), note: 'Test mode: no real money moved.' } };
    S.campaigns[c.id] = c; if (c.status === 'ACTIVE') setSponsor(c, true);
    if (D.appendAudit) D.appendAudit('SOCIAL_CAMPAIGN_CREATED', { campaignId: c.id, uid: me.id, postId: p.id, budget, days, status: c.status });
    dirty(); res.json({ success: true, campaign: campView(c), message: c.status === 'ACTIVE' ? `Your ad is live. About ${Math.floor(budget / CPM_KES * 1000).toLocaleString('en-US')} views for KES ${budget.toLocaleString('en-US')} (test mode: no real money moved).` : 'Your ad was sent for review. It starts as soon as it is approved.' });
});
router.get('/campaigns', auth, (req, res) => {
    const list = Object.values(S.campaigns).filter(c => c.uid === req.su.id).sort((a, b) => b.createdAt - a.createdAt).map(campView);
    const tot = list.reduce((s, c) => ({ spent: s.spent + c.spent, impressions: s.impressions + c.impressions, clicks: s.clicks + c.clicks }), { spent: 0, impressions: 0, clicks: 0 });
    dirty(); res.json({ success: true, cpm: CPM_KES, campaigns: list, totals: { ...tot, spent: Math.round(tot.spent * 100) / 100, ctr: tot.impressions ? Math.round(tot.clicks / tot.impressions * 10000) / 100 : 0 } });
});
router.post('/campaigns/:id', auth, (req, res) => {
    const c = S.campaigns[req.params.id]; if (!okId(req.params.id, 'A') || !c || c.uid !== req.su.id) return fail(res, 404, 'Campaign not found.');
    syncCampaign(c); const act = String((req.body && req.body.action) || '');
    if (act === 'pause') { if (c.status !== 'ACTIVE') return fail(res, 409, `This ad is ${c.status.toLowerCase().replace('_', ' ')}.`); c.status = 'PAUSED'; setSponsor(c, false); }
    else if (act === 'resume') { if (c.status !== 'PAUSED') return fail(res, 409, `This ad is ${c.status.toLowerCase().replace('_', ' ')}.`); c.status = 'ACTIVE'; setSponsor(c, true); }
    else if (act === 'stop') { if (!['ACTIVE', 'PAUSED', 'PENDING_REVIEW'].includes(c.status)) return fail(res, 409, 'This ad has already ended.'); finish(c, 'STOPPED'); }
    else return fail(res, 400, 'action must be pause, resume or stop.');
    dirty(); res.json({ success: true, campaign: campView(c), message: act === 'stop' ? `Ad stopped. KES ${kes(c.refundC).toFixed(2)} unspent (test mode: no real money moved).` : `Ad ${act}d.` });
});
router.get('/admin/campaigns', adminAuth, (req, res) => res.json({ success: true, campaigns: Object.values(S.campaigns).sort((a, b) => b.createdAt - a.createdAt).slice(0, 300).map(c => ({ ...campView(c), advertiser: userCard(S.users[c.uid]) })) }));
router.post('/admin/campaigns/:id', adminAuth, (req, res) => {
    const c = S.campaigns[req.params.id]; if (!c) return fail(res, 404, 'Campaign not found.'); syncCampaign(c);
    const act = String((req.body && req.body.action) || ''), by = (req.user && (req.user.email || req.user.sub)) || 'owner';
    if (act === 'approve') { if (c.status !== 'PENDING_REVIEW') return fail(res, 409, 'Only ads waiting for review can be approved.'); c.status = 'ACTIVE'; setSponsor(c, true); }
    else if (act === 'reject') { if (c.status !== 'PENDING_REVIEW') return fail(res, 409, 'Only ads waiting for review can be rejected.'); finish(c, 'REJECTED'); }
    else if (act === 'stop') { if (!['ACTIVE', 'PAUSED', 'PENDING_REVIEW'].includes(c.status)) return fail(res, 409, 'This ad has already ended.'); finish(c, 'STOPPED'); }
    else return fail(res, 400, 'action must be approve, reject or stop.');
    if (D.appendAudit) D.appendAudit('SOCIAL_CAMPAIGN_' + act.toUpperCase(), { campaignId: c.id, by }); dirty(); res.json({ success: true, campaign: campView(c) });
});

// ---------------------------------------------------------------------------
// MODERATION + SPONSORED POSTS (owner only)
// ---------------------------------------------------------------------------
router.get('/admin/stats', adminAuth, (req, res) => res.json({ success: true, stats: stats() }));
router.get('/admin/reports', adminAuth, (req, res) => {
    const st = String(req.query.status || 'OPEN').toUpperCase();
    res.json({ success: true, reports: S.reports.filter(r => st === 'ALL' || r.status === st).slice(-300).reverse().map(r => ({ ...r, reporter: userCard(S.users[r.by]), target: r.type === 'post' ? (S.posts[r.targetId] ? { id: r.targetId, caption: S.posts[r.targetId].caption, status: S.posts[r.targetId].status, author: userCard(S.users[S.posts[r.targetId].uid]), media: S.posts[r.targetId].mediaId ? { kind: (S.media[S.posts[r.targetId].mediaId] || {}).kind } : null } : null) : userCard(S.users[r.targetId]) })) });
});
router.post('/admin/reports/:id', adminAuth, (req, res) => {
    const r = S.reports.find(x => x.id === req.params.id); if (!r) return fail(res, 404, 'Report not found.');
    const act = String((req.body && req.body.action) || ''), by = (req.user && (req.user.email || req.user.sub)) || 'owner';
    const related = S.reports.filter(x => x.type === r.type && x.targetId === r.targetId && x.status === 'OPEN');
    if (act === 'dismiss') { related.forEach(x => { x.status = 'DISMISSED'; x.decidedBy = by; x.decidedAt = now(); }); if (r.type === 'post' && S.posts[r.targetId] && S.posts[r.targetId].status === 'HIDDEN') S.posts[r.targetId].status = 'LIVE'; }
    else if (act === 'remove' && r.type === 'post') { const p = S.posts[r.targetId]; if (p) removePost(p, 'REMOVED_BY_MODERATOR'); related.forEach(x => { x.status = 'ACTIONED'; x.decidedBy = by; x.decidedAt = now(); }); }
    else if (act === 'ban') { const uid = r.type === 'post' ? (S.posts[r.targetId] || {}).uid : r.targetId; if (!uid) return fail(res, 404, 'Account not found.'); S.bans[uid] = { at: now(), by, reason: r.reason }; for (const [h, s] of Object.entries(S.sessions)) if (s.uid === uid) delete S.sessions[h]; related.forEach(x => { x.status = 'ACTIONED'; x.decidedBy = by; x.decidedAt = now(); }); }
    else return fail(res, 400, 'action must be dismiss, remove (posts) or ban.');
    if (D.appendAudit) D.appendAudit('SOCIAL_MODERATION', { reportId: r.id, action: act, target: r.targetId, by });
    dirty(); res.json({ success: true, message: `Done: ${act}.` });
});
router.post('/admin/posts/:id/sponsor', adminAuth, (req, res) => {
    const p = S.posts[req.params.id]; if (!okId(req.params.id, 'P') || !p || p.status !== 'LIVE') return fail(res, 404, 'Post not found.');
    const b = req.body || {}, by = (req.user && (req.user.email || req.user.sub)) || 'owner';
    if (b.remove === true) { p.sponsored = null; dirty(); return res.json({ success: true, message: 'No longer sponsored.' }); }
    const url = safeCtaUrl(b.ctaUrl); if (!url) return fail(res, 400, 'The link must be an https address or a page inside RDS such as /user?shop=M1.');
    p.sponsored = { label: clean(b.label, 30) || 'Sponsored', ctaText: clean(b.ctaText, 30) || 'Learn more', ctaUrl: url, impressions: (p.sponsored && p.sponsored.impressions) || 0, clicks: (p.sponsored && p.sponsored.clicks) || 0, since: now(), by };
    if (D.appendAudit) D.appendAudit('SOCIAL_SPONSORED', { postId: p.id, by }); dirty();
    res.json({ success: true, message: 'The post is now sponsored and appears in the For You feed.', sponsored: p.sponsored });
});

// ---------------------------------------------------------------------------
// the previous version's endpoints: kept answering, safely
// ---------------------------------------------------------------------------
router.get('/list', soft, (req, res) => res.json({ success: true, advertisements: S.order.map(id => S.posts[id]).filter(p => p && p.status === 'LIVE' && visible(p, req.su)).slice(0, 50).map(p => postView(p, req.su)) }));
for (const p of ['/auth/dispatch-otp', '/auth/verify-security-challenge', '/auth/session-validate', '/media/upload-file', '/media/upload-snapshot', '/media/ingest', '/telemetry']) {
    router.post(p, (req, res) => fail(res, 410, 'This version of the app is out of date. Please reload the page.'));
}

// ---------------------------------------------------------------------------
// stats for the master control, and realtime
// ---------------------------------------------------------------------------
function stats() {
    const t0 = now() - 86400000, users = Object.values(S.users).filter(u => !u.deleted), posts = Object.values(S.posts);
    const live = posts.filter(p => p.status === 'LIVE'), sp = live.filter(p => p.sponsored);
    return {
        users: users.length, newUsers24h: users.filter(u => u.createdAt >= t0).length, banned: Object.keys(S.bans).length,
        posts: live.length, posts24h: live.filter(p => p.createdAt >= t0).length, hidden: posts.filter(p => p.status === 'HIDDEN').length,
        likes: Object.values(S.likes).reduce((s, m) => s + countOf(m), 0), comments: Object.values(S.comments).reduce((s, l) => s + l.filter(c => !c.deleted).length, 0),
        messages24h: Object.values(S.msgs).reduce((s, l) => s + l.filter(m => m.at >= t0).length, 0), reportsOpen: S.reports.filter(r => r.status === 'OPEN').length,
        sponsored: sp.length, impressions: sp.reduce((s, p) => s + (p.sponsored.impressions || 0), 0), clicks: sp.reduce((s, p) => s + (p.sponsored.clicks || 0), 0),
        mediaMB: Math.round(Object.values(S.media).filter(m => !m.deleted).reduce((s, m) => s + (m.size || 0), 0) / 1048576),
        stories: Object.values(S.stories).filter(s => !s.deleted && s.expiresAt > now()).length, groups: Object.values(S.convs).filter(c => c.type === 'group').length,
        campaignsActive: Object.values(S.campaigns).filter(c => c.status === 'ACTIVE').length, campaignsInReview: Object.values(S.campaigns).filter(c => c.status === 'PENDING_REVIEW').length,
        adSpend: Math.round(Object.values(S.campaigns).reduce((s, c) => s + spentOf(c), 0)) / 100
    };
}
router.stats = stats;
router.setSocketIo = (server) => {
    io = server;
    io.on('connection', (socket) => {
        const join = (tok) => { const u = userOfToken(tok); if (u && !S.bans[u.id]) { socket.join('social:' + u.id); socket.data = socket.data || {}; socket.data.socialUid = u.id; } };
        try { join(socket.handshake && socket.handshake.auth && socket.handshake.auth.socialToken); } catch (e) {}
        socket.on('social:auth', (tok) => { try { join(tok); } catch (e) {} });
        socket.on('social:typing', (p) => {
            try { const uid = socket.data && socket.data.socialUid, c = p && S.convs[p.conversationId]; if (!uid || !c || !c.members.includes(uid)) return; for (const to of c.members.filter(m => m !== uid)) emitTo(to, 'social:typing', { conversationId: c.id, name: S.users[uid] ? S.users[uid].name : '' }); } catch (e) {}
        });
        // ---- voice / video call signalling (WebRTC). The server only RELAYS; media is peer-to-peer and never touches the server. ----
        // Allowed signal types. 'ring' starts a call; 'offer'/'answer'/'ice' carry the WebRTC handshake; 'accept'/'reject'/'end'/'busy'/'cancel' end or progress it.
        const CALL_TYPES = new Set(['ring', 'offer', 'answer', 'ice', 'accept', 'reject', 'end', 'busy', 'cancel']);
        socket.on('social:call', (p) => {
            try {
                const uid = socket.data && socket.data.socialUid; if (!uid) return;
                if (!p || typeof p !== 'object' || !CALL_TYPES.has(p.type)) return;
                const c = S.convs[p.conversationId];
                if (!c || c.type === 'group' || !c.members.includes(uid)) return;     // 1:1 calls only, and only inside your own conversation
                const to = c.members.find(m => m !== uid); if (!to || S.bans[to]) return;
                if (p.callId && (typeof p.callId !== 'string' || p.callId.length > 64)) return;
                // relay exactly what is needed to the callee's own room; never broadcast
                emitTo(to, 'social:call', { type: p.type, conversationId: c.id, callId: p.callId || null, video: !!p.video, sdp: p.sdp, candidate: p.candidate, from: uid, fromUser: userCard(S.users[uid]) });
            } catch (e) {}
        });
    });
};
router._test = { state: () => S, reset: () => { S = blank(); hits.clear(); }, sniff, safeCtaUrl, saveNow, file: () => file };
module.exports = router;