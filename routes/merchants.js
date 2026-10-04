'use strict';
// ============================================================================
// routes/merchants.js — STAGE 192 SHOP ORDER LIFECYCLE (loaded by server.js, mounted at /api/merchant BEFORE the older inline routes)
//
// THE SHOP'S JOURNEY, one step per button:
//   1. NEW ORDER        the customer's order rings the shop.                          [Accept] [Decline]
//   2. ACCEPTED_PACKING the shop accepted and packs the order. Stock is deducted.     [Call rider]
//   3. AWAITING_DRIVER  the shop pressed "Call rider": the job appears on rider radar.
//   4. rider accepts, drives to the shop and presses "I've arrived".
//   5. HANDED_TO_RIDER  the shop presses "Hand over" -> the shop is PAID IN FULL AT ONCE (items total, 100%).
//                       Only now can the rider press "I have the order".
//   6. the rider delivers with the customer's PIN -> the rider is paid, the platform books its income
//                       (done by routes/driver.js; the order becomes COMPLETED & PAID OUT).
//
// Rules this file enforces:
//   - "Call rider" needs an accepted order. Hand-over needs a rider who has ARRIVED. No arrival, no hand-over, no payment.
//   - The shop is paid exactly once per order (double clicks and retries cannot pay twice).
//   - Once handed over, the order cannot be cancelled or given back: the shop has been paid.
//   - Money goes to the shop wallet; if MERCHANT_AUTO_PAYOUT is on (default) and payments are in test mode, it is sent out at once.
//
// This module knows nothing about the ledger or compliance. It announces neutral events (afterHandover, afterMerchantPayout)
// through D.orderEvents(); server.js decides who listens.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
let D = {};
function init(deps) { D = deps || {}; }

const DEFAULT_MERCHANT = 'MERCH_DEF_172';
const CANCELLED = new Set(['CANCELLED_BY_CUSTOMER', 'REJECTED_BY_VENDOR', 'ORDERLY_DISMISSED', 'CANCELLED']);
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];
const isSafeKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,80}$/.test(v) && !PROTO_KEYS.includes(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const ordersOf = (id) => (global.merchantOrders && has(global.merchantOrders, id) ? global.merchantOrders[id] : []) || [];
const money2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });
const auth = (req, res, next) => (D.softAuth ? D.softAuth(D.ACTOR_ROLES.MERCHANT)(req, res, next) : next());
const events = () => { try { return (D.orderEvents && D.orderEvents()) || null; } catch (e) { return null; } };
const emit = (room, ev, payload) => { try { if (D.emitSafe191) D.emitSafe191(room, ev, payload); } catch (e) {} };
const MIN_PAYOUT = 100, MAX_PAYOUT = 250000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function target(req, res) {
    const b = req.body || {}, v = (b.merchantId === undefined || b.merchantId === null || b.merchantId === '') ? DEFAULT_MERCHANT : b.merchantId;
    const id = D.pickKey ? D.pickKey(v, DEFAULT_MERCHANT) : (isSafeKey(v) ? String(v) : null);
    if (!id) { bad(res, 'Invalid merchantId.'); return null; }
    if (D.ownsMerchant && !D.ownsMerchant(req, id)) { bad(res, 'Forbidden.', 403); return null; }
    if (D.isTenantActive && !D.isTenantActive(id)) { bad(res, 'Merchant account suspended.', 403); return null; }
    return id;
}
function findOrder(res, id, orderId) {
    if (!isSafeKey(orderId)) { bad(res, 'Invalid orderId.'); return null; }
    const o = ordersOf(id).find(x => x && x.orderId === orderId);
    if (!o) { res.status(404).json({ success: false, error: 'Order ID not found.' }); return null; }
    return o;
}
const customerOrder = (orderId) => { const r = D.findOrderRefs191 ? D.findOrderRefs191(orderId) : null; return r && r.active[0] ? r.active[0].order : null; };
const shopName = (id) => (global.merchantProfiles && global.merchantProfiles[id] && global.merchantProfiles[id].shopName) || 'Merchant Store';
// what the shop is owed for this order: the items total, 100%. Taken from the CUSTOMER's order record (the source of truth).
function itemsDue(order) {
    const src = customerOrder(order.orderId), b = src && src.breakdown;
    const v = b ? (b.commodityCost !== undefined ? b.commodityCost : b.shopOwnerPayout) : order.shopOwnerPayout;
    return money2(v);
}
function deductStock(merchantId, order) {
    if (order.stockDeducted) return;
    const catalogs = global.merchantCatalogs || {}, catalog = has(catalogs, merchantId) ? catalogs[merchantId] : null;
    if (Array.isArray(catalog)) {
        for (const it of (Array.isArray(order.items) ? order.items : [])) {
            const qty = Math.max(1, Math.floor(Number(it && it.qty) || 1));
            const stockItem = it && it.id ? catalog.find(c => c && c.id === it.id) : catalog.find(c => c && String(c.name).toLowerCase() === String((it && it.name) || '').toLowerCase());
            if (stockItem && stockItem.stock !== undefined && Number.isFinite(Number(stockItem.stock))) stockItem.stock = Math.max(0, Number(stockItem.stock) - qty);
        }
    }
    order.stockDeducted = true;
}
function stamp(orderId, patch) {          // share facts (not the shop's own status) with every record of the order
    if (D.setDeliveryState191) D.setDeliveryState191(orderId, patch);
    for (const d of (D.findDispatchesById191 ? D.findDispatchesById191(orderId) : [])) Object.assign(d, patch);
}
const wallets = () => D.getWallets();
const earnings = () => D.getEarnings();
const payouts = () => D.getPayouts();
function sendPayout(merchantId, amount, auto) {
    const W = wallets(), bal = money2(W[merchantId] || 0), amt = money2(amount);
    if (!(amt > 0) || amt > bal + 0.0001) throw new Error('Insufficient shop wallet balance.');
    W[merchantId] = money2(bal - amt);
    const prof = (global.merchantProfiles && global.merchantProfiles[merchantId]) || {}, now = Date.now();
    const rec = { payoutId: `MPAY_${now}_${crypto.randomInt(1000, 10000)}`, merchantId, phone: prof.phone || null, amount: amt, status: 'SIMULATED_SENT', mode: 'SIMULATED', auto: !!auto, at: now };
    payouts().push(rec); if (payouts().length > 50000) payouts().shift();
    if (D.appendAudit) D.appendAudit('SHOP_PAYOUT', { payoutId: rec.payoutId, merchantId, amount: rec.amount, auto: !!auto });
    try { const EV = events(); if (EV && EV.afterMerchantPayout) EV.afterMerchantPayout(rec); } catch (e) {}
    return rec;
}

// ---------------------------------------------------------------------------
// 1 -> 2  ACCEPT (the shop packs; the rider is NOT called yet)
// ---------------------------------------------------------------------------
router.post('/orders/accept', auth, (req, res) => {
    const id = target(req, res); if (!id) return;
    const order = findOrder(res, id, req.body && req.body.orderId); if (!order) return;
    if (order.status !== 'PENDING_VENDOR_ACCEPTANCE') return bad(res, `Order is ${order.status}, cannot accept.`, 409);
    order.status = 'ACCEPTED_PACKING'; order.acceptedAt = Date.now();
    deductStock(id, order);
    if (D.appendAudit) D.appendAudit('SHOP_ACCEPTED', { orderId: order.orderId, merchantId: id });
    emit(id, 'merchant_order_update', order); emit('order:' + order.orderId, 'order_status_update', { orderId: order.orderId, status: order.status }); emit(null, 'orderListUpdated', { orderId: order.orderId });
    res.json({ success: true, message: `Order ${order.orderId} accepted. Pack it, then press "Call rider".`, order });
});

// ---------------------------------------------------------------------------
// 2 -> 3  CALL RIDER (the order appears on rider radar)
// ---------------------------------------------------------------------------
router.post('/orders/call-driver', auth, (req, res) => {
    const id = target(req, res); if (!id) return;
    const order = findOrder(res, id, req.body && req.body.orderId); if (!order) return;
    if (CANCELLED.has(order.status)) return bad(res, 'This order was cancelled.', 409);
    if (order.status === 'PENDING_VENDOR_ACCEPTANCE') return bad(res, 'Accept the order first, then call a rider.', 409);
    if (order.status === 'HANDED_TO_RIDER' || order.status === 'COMPLETED & PAID OUT') return bad(res, 'This order was already handed to a rider.', 409);
    if (order.status !== 'ACCEPTED_PACKING' && order.status !== 'AWAITING_DRIVER_PICKUP') return bad(res, `Order is ${order.status}, cannot call a rider.`, 409);
    const copies = D.findDispatchesById191 ? D.findDispatchesById191(order.orderId) : [];
    if (copies.some(x => x.status === 'ACCEPTED_BY_DRIVER')) return bad(res, 'A rider has already accepted this order.', 409);
    if (copies.some(x => x.status === 'PENDING_DRIVER_ACCEPTANCE')) return bad(res, 'A rider has already been called. Waiting for one to accept.', 409);
    const src = customerOrder(order.orderId), b = (src && src.breakdown) || {};
    if (!src || !(Number(b.riderShare) > 0) || !src.pinHash) return bad(res, 'The customer order record is incomplete, so a rider cannot be called. Contact support.', 409);
    const now = Date.now();
    const dispatch = {
        id: order.orderId, orderId: order.orderId, isDirectRide: false, merchantId: id, pickup: shopName(id), pickupCoords: src.pickupCoords,
        destination: src.destination, destinationCoords: src.destinationCoords, vehicleType: src.vehicleType, currency: 'KES',
        items: order.items, total: src.total, totalAmount: src.total, deliveryFee: b.deliveryFee, riderPayout: b.riderShare,
        distanceKm: src.distanceKm, etaMin: src.etaMin, customerPhone: src.customerPhone, pinSalt: src.pinSalt, pinHash: src.pinHash,
        status: 'PENDING_DRIVER_ACCEPTANCE', dispatchedAt: now
    };
    if (!global.driverQueue) global.driverQueue = [];
    global.driverQueue.push(dispatch);
    order.status = 'AWAITING_DRIVER_PICKUP'; order.calledAt = now; order.callCount = (order.callCount || 0) + 1;
    if (D.appendAudit) D.appendAudit('SHOP_CALLED_RIDER', { orderId: order.orderId, merchantId: id, attempt: order.callCount });
    emit(id, 'merchant_order_update', order); emit(null, 'new_driver_dispatch', dispatch); emit(null, 'orderListUpdated', dispatch); emit('order:' + order.orderId, 'order_status_update', { orderId: order.orderId, status: order.status });
    res.json({ success: true, message: `Rider called for order ${order.orderId}. You will see them here as soon as one accepts.`, order });
});

// ---------------------------------------------------------------------------
// 4 -> 5  HAND OVER: the rider has ARRIVED; the shop hands the order over and is paid in full at that moment
// ---------------------------------------------------------------------------
router.post('/orders/complete-handover', auth, (req, res) => {
    const id = target(req, res); if (!id) return;
    const order = findOrder(res, id, req.body && req.body.orderId); if (!order) return;
    if (CANCELLED.has(order.status)) return bad(res, 'This order was cancelled and cannot be handed over.', 409);
    if (order.shopPaid192 || order.status === 'HANDED_TO_RIDER' || order.status === 'COMPLETED & PAID OUT') return bad(res, 'This order was already handed over and you have been paid.', 409);
    if (order.status === 'PENDING_VENDOR_ACCEPTANCE') return bad(res, 'Accept the order before handing it over.', 409);
    if (order.status === 'ACCEPTED_PACKING') return bad(res, 'Press "Call rider" first, so a rider can come and collect the order.', 409);
    if (order.status !== 'AWAITING_DRIVER_PICKUP') return bad(res, `Order is ${order.status}, cannot hand over.`, 409);
    const copies = D.findDispatchesById191 ? D.findDispatchesById191(order.orderId) : [];
    const job = copies.find(x => x.status === 'ACCEPTED_BY_DRIVER');
    if (!job) return bad(res, 'No rider has accepted this order yet. You are paid the moment you hand it over to the rider.', 409);
    if (job.stage !== 'ARRIVED_PICKUP') return bad(res, 'The rider is on the way but has not arrived yet. Hand over when they arrive.', 409);
    const amount = itemsDue(order);
    if (!(amount > 0)) return bad(res, 'There is no amount to pay for this order. Contact support.', 409);

    // ---- one synchronous block: the shop cannot be paid twice ----
    const now = Date.now();
    order.shopPaid192 = true; order.status = 'HANDED_TO_RIDER'; order.handoverAt = now; order.paidToShop = amount;
    stamp(order.orderId, { handoverAt: now, paidToShop: amount });
    const W = wallets(); W[id] = money2((W[id] || 0) + amount);
    const earn = { earningId: `SHOP_${now}_${crypto.randomInt(1000, 10000)}`, merchantId: id, orderId: order.orderId, amount, at: now };
    earnings().push(earn); if (earnings().length > 50000) earnings().shift();
    if (D.appendAudit) D.appendAudit('SHOP_PAID', { orderId: order.orderId, merchantId: id, amount, riderId: job.driverId || null });
    const src = customerOrder(order.orderId);
    try { const EV = events(); if (EV && EV.afterHandover && src) EV.afterHandover(src); } catch (e) { /* listeners record their own failures; the shop is paid regardless */ }

    let sent = null;
    if (D.autoPayout && D.autoPayout() && (!D.paymentsMode || D.paymentsMode() === 'simulated')) { try { sent = sendPayout(id, amount, true); } catch (e) { sent = null; } }
    if (D.markDirty) D.markDirty();
    emit(id, 'merchant_order_update', order); emit('order:' + order.orderId, 'order_status_update', { orderId: order.orderId, status: order.status }); emit(null, 'orderListUpdated', { orderId: order.orderId });
    res.json({
        success: true, order, paid: amount, balance: money2(W[id] || 0), sentToMpesa: !!sent, payoutId: sent ? sent.payoutId : null,
        message: sent ? `Handed over. KES ${amount.toFixed(2)} paid in full and sent to your M-Pesa (test mode: no real money moved).` : `Handed over. KES ${amount.toFixed(2)} paid in full to your shop wallet.`
    });
});

// ---------------------------------------------------------------------------
// shop wallet
// ---------------------------------------------------------------------------
function ownWallet(req, res, rawId) {
    const id = D.pickKey ? D.pickKey(rawId, null) : (isSafeKey(rawId) ? rawId : null);
    if (!id) { bad(res, 'Invalid merchantId.'); return null; }
    if (D.ownsMerchant && !D.ownsMerchant(req, id)) { bad(res, 'Forbidden.', 403); return null; }
    return id;
}
router.get('/wallet/:merchantId', auth, (req, res) => {
    const id = ownWallet(req, res, req.params.merchantId); if (!id) return;
    const mine = earnings().filter(e => e.merchantId === id), out = payouts().filter(p => p.merchantId === id), t0 = D.eatDayStart191 ? D.eatDayStart191() : 0;
    const sum = (l, since) => money2(l.filter(x => x.at >= since).reduce((s, x) => s + (Number(x.amount) || 0), 0));
    res.json({
        success: true, merchantId: id, currency: 'KES', balance: money2(wallets()[id] || 0), autoPayout: !!(D.autoPayout && D.autoPayout()), minPayout: MIN_PAYOUT,
        paymentsMode: D.paymentsMode ? D.paymentsMode() : 'simulated', today: { paid: sum(mine, t0), orders: mine.filter(x => x.at >= t0).length }, allTime: { paid: sum(mine, 0), orders: mine.length, withdrawn: sum(out, 0) },
        history: [...mine.map(e => ({ id: e.earningId, kind: 'PAID_AT_HANDOVER', amount: e.amount, ref: e.orderId, at: e.at })), ...out.map(p => ({ id: p.payoutId, kind: p.auto ? 'SENT_TO_MPESA (auto)' : 'WITHDRAWAL', amount: -p.amount, ref: p.payoutId, status: p.status, at: p.at }))].sort((a, b) => b.at - a.at).slice(0, 60)
    });
});
router.post('/wallet/payout', auth, (req, res) => {
    const id = target(req, res); if (!id) return;
    const amt = Number(req.body && req.body.amount);
    if (!Number.isFinite(amt) || amt <= 0 || Math.round(amt * 100) !== amt * 100) return bad(res, 'Enter a valid amount.');
    if (amt < MIN_PAYOUT) return bad(res, `The minimum withdrawal is KES ${MIN_PAYOUT}.`);
    if (amt > MAX_PAYOUT) return bad(res, `The maximum per withdrawal is KES ${MAX_PAYOUT.toLocaleString()}.`);
    if ((D.paymentsMode ? D.paymentsMode() : 'simulated') !== 'simulated') return bad(res, 'Live M-Pesa payouts are not configured on this server.', 501);
    if (amt > money2(wallets()[id] || 0)) return bad(res, 'Insufficient wallet balance.');
    // the one-minute limit protects against repeated MANUAL withdrawals; the automatic transfer at hand-over does not count
    if (payouts().some(p => p.merchantId === id && !p.auto && Date.now() - p.at < 60 * 1000)) return bad(res, 'Please wait a minute between withdrawals.', 429);
    const rec = sendPayout(id, amt, false); if (D.markDirty) D.markDirty();
    const ph = String(rec.phone || ''), masked = ph.length > 6 ? ph.slice(0, 4) + '***' + ph.slice(-3) : ph;
    res.json({ success: true, message: `KES ${rec.amount.toFixed(2)} sent to ${masked} (test mode: no real money moved).`, payoutId: rec.payoutId, amount: rec.amount, remainingBalance: money2(wallets()[id] || 0) });
});

module.exports = router;
module.exports.init = init;