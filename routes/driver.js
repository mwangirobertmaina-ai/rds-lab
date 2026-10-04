'use strict';
// ============================================================================
// routes/driver.js — STAGE 192 DRIVER EXTENSION (additive; loaded by server.js)
//
// Mounted BEFORE the inline /api/driver routes, so these handlers take over:
//   GET  /dispatches, /queue       job radar (only approved + online riders; no fake seeded job)
//   POST /accept-dispatch          atomic, one active job per rider, vehicle must match for rides
//   POST /arrived, /picked-up      job progress (customer, shop and admin all see it live)
//   POST /complete-dispatch        needs the customer's 4-digit delivery PIN; pays the rider 95% of the delivery fee
//   POST /release, /dispatch/release  give a job back (only before pickup, only the rider who holds it)
//   POST /login-otp                sign-in code for riders who are already registered
//   POST /status                   go online / offline (approved riders only)
//   GET  /wallet, /wallet/history  balance, earnings, payouts (caller's own only)
//   POST /payout                   withdraw to the rider's own registered M-Pesa number (SIMULATED until Daraja)
//
// Money rule: rider earns 95% of the delivery fee, platform keeps 5% (shop 2% fee is separate, on items).
// The inline version paid 85% of the whole basket and showed a fake KES 450 job that could be completed
// repeatedly under different x-business-id headers. Neither exists here.
// Server state is injected by server.js through init(deps).
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

let D = {};
function init(deps) { D = deps || {}; }

const MIN_PAYOUT = 100, MAX_PAYOUT = 150000, MAX_RADAR_KM = 20, ARRIVE_MAX_KM = 1.0, PIN_MAX_FAILS = 5, RELEASE_LIMIT = 3;
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];
const isSafeKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,80}$/.test(v) && !PROTO_KEYS.includes(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const money2 = (n) => Number(Number(n).toFixed(2));
const bad = (res, msg, code = 400, extra) => res.status(code).json({ success: false, error: msg, ...(extra || {}) });
const normVehicle = (v) => (String(v || 'BODA').toUpperCase() === 'CAB' || String(v || '').toUpperCase() === 'CAR') ? 'CAR' : 'BODA';
const hav = (a, b, c, d) => { const r = Math.PI / 180, dl = (c - a) * r, dn = (d - b) * r, x = Math.sin(dl / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dn / 2) ** 2; return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); };
const hashPin = (salt, pin) => crypto.createHash('sha256').update(String(salt) + String(pin)).digest('hex');
const sameHash = (a, b) => { try { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); } catch (e) { return false; } };

const auth = (req, res, next) => {
    if (!D.softAuth) return bad(res, 'Driver service is starting. Try again shortly.', 503);
    D.softAuth(D.ACTOR_ROLES.RIDER)(req, res, (err) => {
        if (err) return next(err);
        if (!req.user || !req.user.driverId) return bad(res, 'Please sign in as a rider.', 401);
        next();
    });
};
const driverOf = (id) => { const all = D.getDrivers(); return has(all, id) ? all[id] : null; };
function workBlock(d) {
    if (!d) return 'Complete rider registration first.';
    if (d.standing === 'SUSPENDED') return 'Your rider account is suspended. Please contact support.';
    if (d.standing === 'REJECTED') return 'Your rider application was not approved. Please contact support.';
    if (D.requireApproval && D.requireApproval() && d.standing !== 'APPROVED') return 'Your documents are being reviewed. You can take jobs once you are approved.';
    return null;
}
const locOf = (id) => { const l = D.getLocations()[id]; return l && Date.now() - l.at < 120000 ? l : null; };
const online = (id) => { const p = D.getPresence()[id]; return !!(p && p.online); };

function allCopies() {
    const out = [];
    for (const d of (global.driverQueue || [])) out.push(d);
    for (const list of Object.values(global.activeDispatches || {})) for (const d of (list || [])) out.push(d);
    return out;
}
const activeJobOf = (id) => allCopies().find(d => d.status === 'ACCEPTED_BY_DRIVER' && d.driverId === id) || null;

function jobView(d, mine) {
    const v = {
        id: d.id, orderId: d.orderId || d.id, kind: d.isDirectRide ? 'RIDE' : 'DELIVERY', isDirectRide: !!d.isDirectRide,
        vehicleType: normVehicle(d.vehicleType), pickup: d.pickup || null, destination: d.destination || null,
        pickupCoords: d.pickupCoords || null, destinationCoords: d.destinationCoords || null,
        distanceKm: d.distanceKm == null ? null : d.distanceKm, etaMin: d.etaMin == null ? null : d.etaMin,
        fare: d.deliveryFee == null ? null : d.deliveryFee, earn: d.riderPayout == null ? null : d.riderPayout, currency: d.currency || 'KES',
        status: d.status, stage: d.stage || null, dispatchedAt: d.dispatchedAt || null, acceptedAt: d.acceptedAt || null,
        handedOver: !!d.handoverAt, waitingForShop: !d.isDirectRide && !!d.merchantId && !d.handoverAt
    };
    if (mine) v.customerPhone = d.customerPhone || null;      // only the assigned rider ever sees this
    return v;
}
const payable = (d) => Number(d.riderPayout) > 0 && !!d.pinHash && !!d.pinSalt;

function notify(id, deliveryStatus) {
    const refs = D.findOrderRefs191(id);
    D.emitSafe191('order:' + id, 'order_status_update', { orderId: id, deliveryStatus });
    refs.merchant.forEach(x => D.emitSafe191(x.merchantId, 'merchant_order_update', x.order));
    refs.active.forEach(x => { if (x.order.userId) D.emitSafe191('user:' + x.order.userId, 'order_status_update', { orderId: id, deliveryStatus }); });
    D.emitSafe191(null, 'orderListUpdated', { orderId: id });
}

// ---------------------------------------------------------------------------
// sign-in for riders who are already registered (the inline router only had register-and-send-otp)
// ---------------------------------------------------------------------------
const otpCooldown = new Map();
router.post('/login-otp', (req, res) => {
    const phone = String((req.body && req.body.phone) || '').trim();
    if (!(D.isPhone && D.isPhone(phone))) return bad(res, 'Enter a valid phone number.');
    const id = `DRV_${phone.replace(/[^0-9]/g, '')}`;
    if (!has(D.getDrivers(), id) && !(D.ensureTestRider && D.ensureTestRider(phone))) return bad(res, 'No rider account found for this number. Please register first.', 404);
    const now = Date.now();
    if (now - (otpCooldown.get(id) || 0) < 30000) return bad(res, 'Please wait 30 seconds before asking for another code.', 429);
    otpCooldown.set(id, now);
    D.sendOtp(phone);
    res.json({ success: true, message: `We sent a code to ${phone}.` });
});

// ---------------------------------------------------------------------------
// radar
// ---------------------------------------------------------------------------
function radarFor(me, d) {
    const now = Date.now(), q = global.driverQueue || [];
    for (let i = q.length - 1; i >= 0; i--) if (q[i].status !== 'PENDING_DRIVER_ACCEPTANCE' || (q[i].dispatchedAt && now - q[i].dispatchedAt > 6 * 3600 * 1000)) q.splice(i, 1);
    const loc = locOf(me), myVeh = normVehicle(d.vehicleType);
    return q.filter(j => payable(j) && (!j.isDirectRide || normVehicle(j.vehicleType) === myVeh))
        .map(j => { const dist = loc && j.pickupCoords ? hav(loc.lat, loc.lng, j.pickupCoords.lat, j.pickupCoords.lng) : null; return { j, dist }; })
        .filter(x => x.dist === null || x.dist <= MAX_RADAR_KM)
        .sort((a, b) => (a.dist === null ? 1e9 : a.dist) - (b.dist === null ? 1e9 : b.dist) || (a.j.dispatchedAt || 0) - (b.j.dispatchedAt || 0))
        .slice(0, 20)
        .map(x => ({ ...jobView(x.j, false), distanceToPickupKm: x.dist === null ? null : Number(x.dist.toFixed(1)) }));
}
function dispatchesHandler(req, res) {
    const me = req.user.driverId, d = driverOf(me), blk = workBlock(d);
    if (blk) return res.json({ success: true, blocked: blk, online: false, active: null, dispatches: [] });
    const isOn = online(me), act = activeJobOf(me);
    const list = isOn && !act ? radarFor(me, d) : [];
    res.json({ success: true, blocked: null, online: isOn, vehicleType: normVehicle(d.vehicleType), active: act ? jobView(act, true) : null, dispatches: act ? [jobView(act, true)] : list, balance: money2(D.getWallets()[me] || 0) });
}
router.get('/dispatches', auth, dispatchesHandler);
router.get('/queue', auth, (req, res) => dispatchesHandler(req, res));

router.post('/status', auth, (req, res) => {
    const me = req.user.driverId, d = driverOf(me), want = !!(req.body && req.body.online === true);
    if (want) { const blk = workBlock(d); if (blk) return bad(res, blk, 403); }
    else if (activeJobOf(me)) return bad(res, 'Finish your current job before going offline.', 409);
    D.getPresence()[me] = { online: want, at: Date.now() };
    if (D.markDirty) D.markDirty();
    res.json({ success: true, driverId: me, online: want });
});

// ---------------------------------------------------------------------------
// job lifecycle
// ---------------------------------------------------------------------------
router.post('/accept-dispatch', auth, (req, res) => {
    const me = req.user.driverId, d = driverOf(me), blk = workBlock(d);
    if (blk) return bad(res, blk, 403);
    if (!online(me)) return bad(res, 'Go online to accept jobs.', 409);
    const id = req.body && req.body.dispatchId;
    if (!isSafeKey(id)) return bad(res, 'Invalid dispatchId.');
    if (activeJobOf(me)) return bad(res, 'Finish your current job first.', 409);
    const copies = D.findDispatchesById191(id);
    if (!copies.length) return bad(res, 'Job not found.', 404);
    const job = copies.find(x => x.status === 'PENDING_DRIVER_ACCEPTANCE');
    if (!job) return bad(res, 'This job was already taken.', 409);
    if (!payable(job)) return bad(res, 'This job is not available.', 409);
    if (job.isDirectRide && normVehicle(job.vehicleType) !== normVehicle(d.vehicleType)) return bad(res, `This ride needs a ${normVehicle(job.vehicleType) === 'CAR' ? 'cab' : 'boda'}.`, 403);
    const now = Date.now();
    copies.forEach(x => { x.status = 'ACCEPTED_BY_DRIVER'; x.driverId = me; x.acceptedAt = now; x.stage = 'ACCEPTED'; x.pinFails = 0; });
    const q = global.driverQueue || [];
    for (let i = q.length - 1; i >= 0; i--) if (q[i].id === id) q.splice(i, 1);
    const key = job.merchantId || 'DIRECT_RIDES';
    if (!global.activeDispatches) global.activeDispatches = {};
    if (!global.activeDispatches[key]) global.activeDispatches[key] = [];
    if (!global.activeDispatches[key].some(x => x.id === id)) global.activeDispatches[key].push(job);
    D.setDeliveryState191(id, { deliveryStatus: 'DRIVER_ASSIGNED', driverId: me });
    notify(id, 'DRIVER_ASSIGNED');
    D.appendAudit('DRIVER_ACCEPTED', { dispatchId: id, driverId: me });
    res.json({ success: true, message: job.isDirectRide ? 'Ride accepted. Head to the pickup point.' : 'Delivery accepted. Head to the shop.', job: jobView(job, true) });
});

function myJob(req, res) {
    const id = req.body && req.body.dispatchId;
    if (!isSafeKey(id)) { bad(res, 'Invalid dispatchId.'); return null; }
    const copies = D.findDispatchesById191(id);
    const job = copies.find(x => x.status === 'ACCEPTED_BY_DRIVER' && x.driverId === req.user.driverId);
    if (!job) {
        if (copies.some(x => x.status === 'COMPLETED' && x.driverId === req.user.driverId)) bad(res, 'This job was already completed.', 409);
        else if (copies.length) bad(res, 'This job is not assigned to you.', 403);
        else bad(res, 'Job not found.', 404);
        return null;
    }
    return { id, copies, job };
}
router.post('/arrived', auth, (req, res) => {
    const m = myJob(req, res); if (!m) return;
    if (m.job.stage !== 'ACCEPTED') return bad(res, 'Arrival was already confirmed.', 409);
    const loc = locOf(req.user.driverId);
    if (loc && m.job.pickupCoords) { const km = hav(loc.lat, loc.lng, m.job.pickupCoords.lat, m.job.pickupCoords.lng); if (km > ARRIVE_MAX_KM) return bad(res, `You are ${km.toFixed(1)} km from the pickup point. Get closer before confirming arrival.`, 409); }
    m.copies.forEach(x => { x.stage = 'ARRIVED_PICKUP'; });
    D.setDeliveryState191(m.id, { deliveryStatus: 'ARRIVED_AT_PICKUP', driverId: req.user.driverId });
    notify(m.id, 'ARRIVED_AT_PICKUP');
    res.json({ success: true, message: 'Arrival confirmed.', job: jobView(m.job, true) });
});
router.post('/picked-up', auth, (req, res) => {
    const m = myJob(req, res); if (!m) return;
    if (!['ACCEPTED', 'ARRIVED_PICKUP'].includes(m.job.stage)) return bad(res, 'Pickup was already confirmed.', 409);
    if (!m.job.isDirectRide && m.job.merchantId && !m.job.handoverAt) return bad(res, m.job.stage === 'ARRIVED_PICKUP' ? 'Wait for the shop to hand the order over. The shop presses "Hand over" while you are there.' : 'Go to the shop and press "I\'ve arrived" first. The shop hands the order over when you are there.', 409);
    m.copies.forEach(x => { x.stage = 'PICKED_UP'; x.pickedUpAt = Date.now(); });
    D.setDeliveryState191(m.id, { deliveryStatus: 'PICKED_UP', driverId: req.user.driverId });
    notify(m.id, 'PICKED_UP');
    res.json({ success: true, message: m.job.isDirectRide ? 'Trip started.' : 'Pickup confirmed. Head to the customer.', job: jobView(m.job, true) });
});

router.post(['/release', '/dispatch/release'], auth, (req, res) => {
    const m = myJob(req, res); if (!m) return;
    const me = req.user.driverId, d = driverOf(me);
    if (m.job.stage === 'PICKED_UP') return bad(res, 'You already picked up this job. Complete it or contact support.', 409);
    if (m.job.handoverAt) return bad(res, 'The shop has already handed this order to you and been paid. Please deliver it or contact support.', 409);
    const day = Date.now() - 24 * 3600 * 1000;
    d.releases = (d.releases || []).filter(t => t > day);
    if (d.releases.length >= RELEASE_LIMIT) return bad(res, 'You have given back too many jobs today. Please contact support.', 429);
    d.releases.push(Date.now());
    m.copies.forEach(x => { x.status = 'PENDING_DRIVER_ACCEPTANCE'; delete x.driverId; delete x.acceptedAt; delete x.stage; delete x.pinFails; });
    if (!global.driverQueue) global.driverQueue = [];
    if (!global.driverQueue.some(x => x.id === m.id)) global.driverQueue.push(m.job);
    D.setDeliveryState191(m.id, { deliveryStatus: null, driverId: null });
    notify(m.id, null);
    D.appendAudit('DRIVER_RELEASED', { dispatchId: m.id, driverId: me });
    res.json({ success: true, message: 'Job returned to the radar.' });
});

router.post('/complete-dispatch', auth, (req, res) => {
    const m = myJob(req, res); if (!m) return;
    const me = req.user.driverId, job = m.job, id = m.id;
    if (job.settled192) return bad(res, 'This job was already settled.', 409);
    if (job.stage !== 'PICKED_UP') return bad(res, job.isDirectRide ? 'Start the trip first.' : 'Confirm pickup first.', 409);
    const pin = String((req.body && req.body.pin) || '').trim();
    if (!/^\d{4}$/.test(pin)) return bad(res, "Enter the customer's 4-digit delivery PIN.");
    if ((job.pinFails || 0) >= PIN_MAX_FAILS) return bad(res, 'Too many wrong PIN attempts. Contact support to complete this job.', 423);
    if (!sameHash(hashPin(job.pinSalt, pin), job.pinHash)) {
        const fails = (job.pinFails || 0) + 1;
        m.copies.forEach(x => { x.pinFails = fails; });
        D.appendAudit('DRIVER_PIN_FAILED', { dispatchId: id, driverId: me, fails });
        return bad(res, fails >= PIN_MAX_FAILS ? 'Too many wrong PIN attempts. Contact support to complete this job.' : `Wrong PIN. ${PIN_MAX_FAILS - fails} tries left.`, 403);
    }
    const earn = money2(job.riderPayout);
    if (!(earn > 0)) return bad(res, 'This job has no payout set. Contact support.', 409);
    const fee = money2(job.deliveryFee != null ? job.deliveryFee : earn / 0.95);
    const platformFee = money2(fee - earn);
    const now = Date.now();

    // settle (single synchronous block: no double credit possible)
    m.copies.forEach(x => { x.settled192 = true; x.status = 'COMPLETED'; x.stage = 'DELIVERED'; x.completedAt = now; });
    const wallets = D.getWallets();
    wallets[me] = money2((wallets[me] || 0) + earn);
    const ledger = D.getLedger();
    ledger.push({ entryId: `LED_${now}_${crypto.randomInt(0, 1000)}`, driverId: me, dispatchId: id, kind: 'DELIVERY_EARNING', gross: fee, credited: earn, platformFee, at: now });
    if (ledger.length > 20000) ledger.shift();
    const q = global.driverQueue || [];
    for (let i = q.length - 1; i >= 0; i--) if (q[i].id === id) q.splice(i, 1);
    D.setDeliveryState191(id, { deliveryStatus: 'DELIVERED', deliveredAt: now, driverId: me });
    const refs = D.findOrderRefs191(id);
    refs.active.forEach(x => { x.order.status = 'COMPLETED_SETTLED'; x.order.completedAt = now; });
    refs.merchant.forEach(x => { x.order.status = 'COMPLETED & PAID OUT'; x.order.completedAt = now; });
    D.appendAudit('DRIVER_EARNING', { dispatchId: id, driverId: me, earned: earn, platformFee });
    try { const EV = D.orderEvents && D.orderEvents(); if (EV && EV.afterDelivery && refs.active[0]) EV.afterDelivery(refs.active[0].order); } catch (e) { /* a failing listener never blocks the rider's payment */ }
    notify(id, 'DELIVERED');
    D.emitSafe191('admins', 'dispatch_completed', { dispatchId: id, driverId: me });
    res.json({ success: true, message: `Job complete. KES ${earn.toFixed(2)} added to your wallet.`, earned: earn, platformFee, balance: wallets[me] });
});

// ---------------------------------------------------------------------------
// wallet & payouts
// ---------------------------------------------------------------------------
router.get('/wallet', auth, (req, res) => {
    const me = req.user.driverId, mine = D.getLedger().filter(e => e.driverId === me), today = D.eatDayStart191();
    const sum = (since) => money2(mine.filter(e => e.at >= since).reduce((s, e) => s + (Number(e.credited) || 0), 0));
    res.json({ success: true, ownerId: me, currency: 'KES', balance: money2(D.getWallets()[me] || 0),
        today: { earned: sum(today), trips: mine.filter(e => e.at >= today).length }, allTime: { earned: sum(0), trips: mine.length }, minPayout: MIN_PAYOUT,
        paymentsMode: D.paymentsMode ? D.paymentsMode() : 'simulated' });
});
router.get('/wallet/history', auth, (req, res) => {
    const me = req.user.driverId;
    const rows = [
        ...D.getLedger().filter(e => e.driverId === me).map(e => ({ id: e.entryId, kind: 'EARNING', amount: e.credited, ref: e.dispatchId, at: e.at })),
        ...D.getPayouts().filter(p => p.driverId === me).map(p => ({ id: p.payoutId, kind: 'PAYOUT', amount: -p.amount, ref: p.payoutId, status: p.status, at: p.at }))
    ].sort((a, b) => b.at - a.at);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1), limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    res.json({ success: true, page, limit, total: rows.length, entries: rows.slice((page - 1) * limit, page * limit) });
});
router.post('/payout', auth, (req, res) => {
    const me = req.user.driverId, d = driverOf(me);
    if (!d) return bad(res, 'Complete rider registration first.', 403);
    if (d.standing === 'SUSPENDED' || d.standing === 'REJECTED') return bad(res, 'Payouts are on hold for this account. Please contact support.', 403);
    const amt = Number(req.body && req.body.amount);
    if (!Number.isFinite(amt) || amt <= 0 || Math.round(amt * 100) !== amt * 100) return bad(res, 'Enter a valid amount.');
    if (amt < MIN_PAYOUT) return bad(res, `The minimum withdrawal is KES ${MIN_PAYOUT}.`);
    if (amt > MAX_PAYOUT) return bad(res, `The maximum per withdrawal is KES ${MAX_PAYOUT.toLocaleString()}.`);
    if ((D.paymentsMode ? D.paymentsMode() : 'simulated') !== 'simulated') return bad(res, 'Live M-Pesa payouts are not configured on this server.', 501);
    const wallets = D.getWallets(), bal = money2(wallets[me] || 0);
    if (amt > bal) return bad(res, 'Insufficient wallet balance.', 400);
    const payouts = D.getPayouts(), now = Date.now();
    if (payouts.some(p => p.driverId === me && now - p.at < 60 * 1000)) return bad(res, 'Please wait a minute between withdrawals.', 429);
    wallets[me] = money2(bal - amt);
    const rec = { payoutId: `PAY_${now}_${crypto.randomInt(1000, 10000)}`, driverId: me, phone: d.phone, amount: money2(amt), status: 'SIMULATED_SENT', mode: 'SIMULATED', at: now };
    payouts.push(rec); if (payouts.length > 50000) payouts.shift();
    D.appendAudit('DRIVER_PAYOUT', { payoutId: rec.payoutId, driverId: me, amount: rec.amount });
    try { const EV = D.orderEvents && D.orderEvents(); if (EV && EV.afterPayout) EV.afterPayout(rec); } catch (e) {}
    if (D.markDirty) D.markDirty();
    const ph = String(d.phone || ''); const masked = ph.length > 6 ? ph.slice(0, 4) + '***' + ph.slice(-3) : ph;
    res.json({ success: true, message: `KES ${rec.amount.toFixed(2)} sent to ${masked} (test mode: no real money moved).`, payoutId: rec.payoutId, amount: rec.amount, to: masked, mode: 'SIMULATED', remainingBalance: wallets[me] });
});

module.exports = router;
module.exports.init = init;
module.exports.hashPin = hashPin;
module.exports.workBlock = workBlock;