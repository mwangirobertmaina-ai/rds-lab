'use strict';
// ============================================================================
// routes/user.js — STAGE 191 USER EXTENSION (additive; loaded by server.js)
//
// Mounted BEFORE the inline /api/user routes, so these handlers take over:
//   POST /quote            authoritative price (items 100% + 2% service fee + delivery)
//   POST /calculate-total  same math, old response shape (now includes the 2%)
//   POST /checkout         the real order: prices rebuilt from the shop catalogue,
//                          shop orders ring the merchant, cab/boda go straight to
//                          the driver radar; login required; the 2% is charged on top
//   GET  /orders/live      caller's own orders only (the inline one listed everyone's)
//   POST /orders/dismiss   retired (it let anyone cancel anyone's order)
//   GET  /tariff, GET /orders/:id/pin   rate card; the customer's delivery PIN
//   (rider details + live location come from the existing GET /orders/:id/live route)
// Guards run before inline handlers: cancelGuard, rateGuard.
//
// Server state is injected by server.js through init(deps). Nothing here talks
// to a database or payment provider. Payments are SIMULATED and labelled as such
// in every response until a real provider (M-Pesa Daraja) is wired in.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

let D = {};
function init(deps) { D = deps || {}; }

const CANCELLED = new Set(['CANCELLED_BY_CUSTOMER', 'REJECTED_BY_VENDOR', 'ORDERLY_DISMISSED', 'CANCELLED']);
// ---------------------------------------------------------------------------
// TARIFF (Nairobi). Ride-hailing in Kenya prices by base + distance + time, with a minimum fare.
//  CAR  : Uber's published Nairobi rate card (base 100, KES 42/km, KES 3/min, minimum 300).
//         Bolt Private publishes base 100, 35/km, 3/min, minimum 200 (so this is the higher of the two).
//  BODA : no current public rate card exists for motorbike fares, so these defaults are an estimate
//         positioned below the cab rate. Review them against the market before launch.
// Real Uber/Bolt fares also move with demand and traffic (dynamic pricing); this engine is fixed-rate.
// Override any value without code: set TARIFF_JSON, e.g. {"BODA":{"base":60,"perKm":25,"perMin":2,"min":120}}
// ---------------------------------------------------------------------------
function loadTariff() {
    const t = {
        BODA: { base: 60, perKm: 25, perMin: 2, min: 120, speed: 30 },    // speed = assumed km/h, used to estimate trip minutes
        CAR:  { base: 100, perKm: 42, perMin: 3, min: 300, speed: 22 }
    };
    try {
        const o = process.env.TARIFF_JSON ? JSON.parse(process.env.TARIFF_JSON) : null;
        if (o && typeof o === 'object') for (const v of ['BODA', 'CAR']) {
            if (!o[v] || typeof o[v] !== 'object') continue;
            for (const k of ['base', 'perKm', 'perMin', 'min', 'speed']) {
                const n = Number(o[v][k]);
                if (o[v][k] !== undefined && Number.isFinite(n) && n >= 0 && n <= 5000 && !(k === 'speed' && n < 5)) t[v][k] = n;
            }
        }
    } catch (e) { console.error('[TARIFF] Ignoring invalid TARIFF_JSON:', e.message); }
    return t;
}
const TARIFF = loadTariff();
// VAT (KRA): 16% standard rate. Customers pay a fixed total (items + 2% + delivery) with no separate VAT line, so the
// platform's fee income is VAT-INCLUSIVE and the VAT inside it is income x rate / (1 + rate), not income x rate.
// Override the rate with VAT_RATE (e.g. 0.16) if the law changes. Confirm the VAT basis with your accountant.
const VAT_RATE = (() => { const n = Number(process.env.VAT_RATE); return Number.isFinite(n) && n >= 0 && n < 1 ? n : 0.16; })();
const PRICING = Object.freeze({
    currency: 'KES', tariff: TARIFF, roundTo: 10,
    serviceFeeRate: 0.02, driverShare: 0.95, kraRate: VAT_RATE,
    roadFactor: 1.4, minKm: 1, maxKm: 300, maxAmount: 10000000, maxQty: 99, maxLines: 100
});
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];
const isSafeKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,80}$/.test(v) && !PROTO_KEYS.includes(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const money2 = (n) => Number(Number(n).toFixed(2));
const bad = (res, msg, code = 400, extra) => res.status(code).json({ success: false, error: msg, ...(extra || {}) });
const clean = (v, max) => (D.cleanText ? D.cleanText(v, max) : String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().substring(0, max));
const phoneOk = (v) => (D.isPhone ? D.isPhone(v) : typeof v === 'string' && /^\+?[0-9 ()-]{7,20}$/.test(v));
const validCoord = (c) => !!c && typeof c === 'object' && c.lat !== undefined && c.lng !== undefined &&
    Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng)) && Math.abs(Number(c.lat)) <= 90 && Math.abs(Number(c.lng)) <= 180 &&
    !(Number(c.lat) === 0 && Number(c.lng) === 0);

// Same distance formula as the server (x1.4 road factor, 4 km minimum).
function drivingKm(lat1, lon1, lat2, lon2) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return Number(Math.max(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * PRICING.roadFactor, PRICING.minKm).toFixed(1));
}

// Customer pays: items (100%) + 2% service fee on top + delivery fee.
// Delivery/fare = base + km rate + minute rate, rounded to KES 10, never below the minimum fare.
// Shop receives 100% of items. Rider receives 95% of the delivery fee. Platform keeps 2% of items + 5% of the
// delivery fee, less 16% KRA on that income.
function priceOf(items, km, vehicle) {
    const t = PRICING.tariff[vehicle] || PRICING.tariff.BODA;
    const etaMin = Math.max(1, Math.ceil(km / t.speed * 60));
    const deliveryFee = money2(Math.max(t.min, Math.round((t.base + km * t.perKm + etaMin * t.perMin) / PRICING.roundTo) * PRICING.roundTo));
    const serviceFee = money2(items * PRICING.serviceFeeRate);
    const riderShare = money2(deliveryFee * PRICING.driverShare);
    const appCommission = money2(deliveryFee - riderShare);              // keeps the split exact to the cent
    const systemIncome = money2(serviceFee + appCommission);
    const kraTax = money2(systemIncome * PRICING.kraRate / (1 + PRICING.kraRate));      // VAT contained in the platform income
    return {
        itemsTotal: money2(items), serviceFee, deliveryFee, total: money2(items + serviceFee + deliveryFee),
        riderShare, appCommission, systemIncome, kraTax, netRevenue: money2(systemIncome - kraTax), etaMin, km
    };
}

function resolveCart(merchantId, rawItems) {
    const catalogs = global.merchantCatalogs || {};
    const catalog = has(catalogs, merchantId) ? catalogs[merchantId] : null;
    if (!Array.isArray(catalog)) return { err: ['This shop has no catalogue.', 404] };
    if (!Array.isArray(rawItems) || rawItems.length === 0) return { err: ['Your cart is empty.', 400] };
    if (rawItems.length > PRICING.maxLines) return { err: [`Too many cart lines (max ${PRICING.maxLines}).`, 400] };
    const wanted = new Map();
    for (const raw of rawItems) {
        if (!raw || !isSafeKey(raw.id)) return { err: ['Invalid item in cart.', 400] };
        const qty = Number(raw.qty);
        if (!Number.isInteger(qty) || qty < 1) return { err: [`Invalid quantity for ${raw.id}.`, 400] };
        const merged = (wanted.get(raw.id) || 0) + qty;
        if (merged > PRICING.maxQty) return { err: [`Maximum ${PRICING.maxQty} per item.`, 400] };
        wanted.set(raw.id, merged);
    }
    const lines = []; let subtotal = 0;
    for (const [id, qty] of wanted) {
        const item = catalog.find(i => i && i.id === id);
        const price = item ? Number(item.price) : NaN;
        if (!item || !Number.isFinite(price) || price < 0) return { err: [`"${id}" is no longer available.`, 400] };
        const stock = item.stock === undefined || item.stock === null ? null : Number(item.stock);
        if (stock !== null && Number.isFinite(stock) && qty > stock) {
            return { err: [stock <= 0 ? `${item.name} is out of stock.` : `Only ${stock} of ${item.name} left.`, 409] };
        }
        subtotal += price * qty;
        lines.push({ id: item.id, name: String(item.name || 'Item').slice(0, 120), price, qty });
    }
    subtotal = money2(subtotal);
    if (!(subtotal > 0)) return { err: ['Invalid cart total.', 400] };
    if (subtotal > PRICING.maxAmount) return { err: ['Order total is above the allowed limit.', 400] };
    return { lines, subtotal };
}

// Shared validation + pricing for /quote and /checkout.
function prepare(b) {
    if (!b || typeof b !== 'object') return { err: ['Invalid request.', 400] };
    if (!validCoord(b.destinationCoords)) return { err: ['Choose your drop-off location on the map.', 400] };
    const dest = { lat: Number(b.destinationCoords.lat), lng: Number(b.destinationCoords.lng) };
    const isRide = b.businessId === 'DIRECT_RIDE';
    let vehicle = 'BODA', merchantId = null, profile = null, lines = [], items = 0, pickup;

    if (isRide) {
        const v = String(b.vehicleType || 'BODA').toUpperCase();
        if (!['BODA', 'CAR'].includes(v)) return { err: ['vehicleType must be BODA or CAR.', 400] };
        vehicle = v;
        if (!validCoord(b.pickupCoords)) return { err: ['Choose your pickup location.', 400] };
        pickup = { lat: Number(b.pickupCoords.lat), lng: Number(b.pickupCoords.lng) };
    } else {
        if (!isSafeKey(b.businessId)) return { err: ['Choose a shop.', 400] };
        merchantId = b.businessId;
        const profiles = global.merchantProfiles || {};
        if (!has(profiles, merchantId)) return { err: ['Shop not found.', 404] };
        if (!D.isTenantActive(merchantId)) return { err: ['This shop is currently unavailable.', 403] };
        profile = profiles[merchantId];
        const cart = resolveCart(merchantId, b.items);
        if (cart.err) return { err: cart.err };
        lines = cart.lines; items = cart.subtotal;
        // Pickup is always the shop's own location, never what the browser says.
        pickup = Number.isFinite(Number(profile.gpsLat)) && Number.isFinite(Number(profile.gpsLon))
            ? { lat: Number(profile.gpsLat), lng: Number(profile.gpsLon) } : { lat: -1.2863, lng: 36.8172 };
    }
    const km = drivingKm(pickup.lat, pickup.lng, dest.lat, dest.lng);
    if (km > PRICING.maxKm) return { err: [`That destination is too far (maximum ${PRICING.maxKm} km).`, 400] };
    return { isRide, merchantId, profile, lines, vehicle, pickup, dest, km, price: priceOf(items, km, vehicle) };
}

function quoteView(p) {
    return {
        mode: p.isRide ? 'RIDE' : 'SHOP', currency: PRICING.currency, vehicle: p.vehicle, distanceKm: p.km, etaMin: p.price.etaMin,
        itemsTotal: p.price.itemsTotal, serviceFee: p.price.serviceFee, deliveryFee: p.price.deliveryFee, total: p.price.total,
        splits: { shopReceives: p.price.itemsTotal, riderReceives: p.price.riderShare, appCommission: p.price.appCommission, platformIncome: p.price.systemIncome, kraTax: p.price.kraTax, netRevenue: p.price.netRevenue },
        lines: p.lines, shop: p.profile ? { merchantId: p.merchantId, shopName: p.profile.shopName } : null,
        payment: { mode: 'SIMULATED' }
    };
}

const auth = (req, res, next) => {
    if (!D.softAuth) return bad(res, 'User service is starting. Try again shortly.', 503);
    return D.softAuth(D.ROLES.REGULAR_USER)(req, res, next);
};

// ---------------------------------------------------------------------------
router.post('/quote', (req, res) => {
    const p = prepare(req.body);
    if (p.err) return bad(res, p.err[0], p.err[1]);
    res.json({ success: true, quote: quoteView(p) });
});

router.post('/calculate-total', (req, res) => {          // old shape, corrected total
    const b = req.body || {};
    const items = b.itemPriceTotal === undefined ? 0 : Number(b.itemPriceTotal);
    if (!Number.isFinite(items) || items < 0 || items > PRICING.maxAmount) return bad(res, 'itemPriceTotal must be a non-negative number within limits.');
    if ((b.pickupCoords && !validCoord(b.pickupCoords)) || (b.destinationCoords && !validCoord(b.destinationCoords))) return bad(res, 'Invalid coordinates.');
    const pk = validCoord(b.pickupCoords) ? b.pickupCoords : { lat: -1.286389, lng: 36.817223 };
    const ds = validCoord(b.destinationCoords) ? b.destinationCoords : { lat: -1.215, lng: 36.89 };
    const vehicle = String(b.vehicleType || 'BODA').toUpperCase() === 'CAR' ? 'CAR' : 'BODA';
    const km = drivingKm(Number(pk.lat), Number(pk.lng), Number(ds.lat), Number(ds.lng));
    const pr = priceOf(items, km, vehicle);
    res.json({ success: true, distanceKm: km, split: {
        productAmount: pr.itemsTotal, shopOwnerPayout: pr.itemsTotal, systemCommodityFee: pr.serviceFee, deliveryFee: pr.deliveryFee,
        riderShare: pr.riderShare, appDeliveryCommission: pr.appCommission, systemFee: pr.systemIncome, tax: pr.kraTax,
        netSystemRevenue: pr.netRevenue, userPays: pr.total } });
});

// ---------------------------------------------------------------------------
const burst = new Map();      // userId -> timestamps of recent orders
function newOrderId() {
    for (let i = 0; i < 8; i++) {
        const id = 'ORD_' + crypto.randomInt(100000, 1000000);
        const r = D.findOrderRefs191(id);
        if (!r.merchant.length && !r.store.length && !r.active.length) return id;
    }
    return 'ORD_' + Date.now();
}

router.post('/checkout', auth, (req, res) => {
    if (!req.user || !req.user.userId) return bad(res, 'Please sign in to place an order.', 401);
    const uid = req.user.userId, b = req.body || {};
    const now = Date.now();
    const recent = (burst.get(uid) || []).filter(t => now - t < 10 * 60 * 1000);
    if (recent.length >= 10) return bad(res, 'Too many orders in a short time. Please wait a few minutes.', 429);

    // F2 across restarts: the same Idempotency-Key from the same customer returns the ORIGINAL order, even after a server restart
    // (server.js also caches replies in memory, but that cache is empty after a restart; the order record is not).
    const idemRaw = (req.headers || {})['idempotency-key'], idemKey = typeof idemRaw === 'string' && /^[A-Za-z0-9_.:-]{8,100}$/.test(idemRaw) ? idemRaw : null;
    if (idemKey) {
        const act = D.getActiveOrders();
        for (const k of Object.keys(act || {})) for (const o of (act[k] || [])) if (o && o.userId === uid && o.idemKey === idemKey) {
            res.set('Idempotent-Replay', 'true');
            return res.json({ success: true, replayed: true, orderId: o.id, mode: k === 'DIRECT_RIDES' ? 'RIDE' : 'SHOP', total: o.total, deliveryPin: o.deliveryPin, etaMin: o.etaMin, payment: { mode: 'SIMULATED', status: 'SIMULATED_PAID' }, message: 'This order was already placed.' });
        }
    }
    const p = prepare(b);
    if (p.err) return bad(res, p.err[0], p.err[1]);

    const profileUser = (D.getUsers && D.getUsers()[uid]) || null;
    if (b.mpesaPhone !== undefined && !phoneOk(b.mpesaPhone)) return bad(res, 'Invalid M-Pesa phone number.');
    const phone = b.mpesaPhone || (profileUser && profileUser.phone) || null;
    if (!phone) return bad(res, 'An M-Pesa phone number is required.');

    const active = D.getActiveOrders();
    if (p.isRide) {
        const open = (active.DIRECT_RIDES || []).filter(o => o.userId === uid && o.status === 'DISPATCHED_STRAIGHT_TO_DRIVER' && !o.deliveryStatus);
        if (open.length >= 2) return bad(res, 'You already have ride requests waiting for a rider.', 409);
    }

    const orderId = newOrderId();
    const destLabel = clean(b.destination, 200) || 'Pinned location';
    const pickupLabel = p.isRide ? (clean(b.pickup, 200) || 'Pickup point') : p.profile.shopName;
    const pr = p.price;
    // EXTENSION POINT (optional): whoever runs the server may subscribe to order events and veto an order here.
    // This module knows nothing about who listens. If nobody does, or the listener fails, the order simply goes ahead.
    try {
        const EV = D.orderEvents && D.orderEvents();
        if (EV && EV.beforeOrder) { const g = EV.beforeOrder({ userId: uid, phones: [phone, profileUser && profileUser.phone], totalMinor: Math.round(pr.total * 100) }); if (g && g.ok === false) return res.status(403).json({ success: false, error: g.message, code: g.code }); }
    } catch (e) { /* a failing listener must never stop an order */ }
    const breakdown = {
        commodityCost: pr.itemsTotal, shopOwnerPayout: pr.itemsTotal, deliveryFee: pr.deliveryFee, riderShare: pr.riderShare,
        systemFee: pr.systemIncome, tax: pr.kraTax, serviceFee: pr.serviceFee, appCommission: pr.appCommission, netRevenue: pr.netRevenue
    };
    const payment = { method: 'MPESA', phone, amount: pr.total, mode: 'SIMULATED', status: 'SIMULATED_PAID', at: now };
    // Delivery PIN: the customer reads it to the rider at hand-over. The rider cannot be paid without it.
    const deliveryPin = String(crypto.randomInt(1000, 10000));
    const pinSalt = crypto.randomBytes(8).toString('hex');
    const pinHash = crypto.createHash('sha256').update(pinSalt + deliveryPin).digest('hex');
    const customerPhone = (profileUser && profileUser.phone) || phone;
    const order = {
        id: orderId, userId: uid, phone, customerPhone, pickup: pickupLabel, destination: destLabel, pickupCoords: p.pickup, destinationCoords: p.dest,
        vehicleType: p.vehicle, currency: PRICING.currency, total: pr.total, breakdown, payment, items: p.lines,
        distanceKm: p.km, etaMin: pr.etaMin, deliveryPin, pinSalt, pinHash, idemKey,
        status: p.isRide ? 'DISPATCHED_STRAIGHT_TO_DRIVER' : 'HELD_IN_ESCROW_PENDING_PACKAGING', createdAt: now
    };

    if (p.isRide) {
        // CAB / BODA: user -> rider directly, no merchant involved.
        const dispatch = {
            id: orderId, orderId, isDirectRide: true, pickup: pickupLabel, destination: destLabel,
            pickupCoords: p.pickup, destinationCoords: p.dest, vehicleType: p.vehicle, currency: PRICING.currency,
            total: pr.total, totalAmount: pr.total, deliveryFee: pr.deliveryFee, riderPayout: pr.riderShare,
            distanceKm: p.km, etaMin: pr.etaMin, customerPhone, pinSalt, pinHash, merchantId: null,
            status: 'PENDING_DRIVER_ACCEPTANCE', dispatchedAt: now
        };
        if (!global.driverQueue) global.driverQueue = [];
        global.driverQueue.push(dispatch);
        if (!active.DIRECT_RIDES) active.DIRECT_RIDES = [];
        active.DIRECT_RIDES.push(order);
        if (global.io) { global.io.emit('new_driver_dispatch', dispatch); global.io.emit('orderListUpdated', { orderId }); }
    } else {
        // SHOP ORDER: user -> merchant (rings the merchant console) -> rider after the shop accepts.
        if (!active[p.merchantId]) active[p.merchantId] = [];
        active[p.merchantId].push(order);
        if (!global.merchantOrders) global.merchantOrders = {};
        if (!global.merchantOrders[p.merchantId]) global.merchantOrders[p.merchantId] = [];
        // The merchant only sees what it needs. PIN, rider payout and customer phone stay on the customer's order record.
        const merchantOrder = {
            orderId, userId: uid, items: p.lines, totalAmount: pr.total, shopOwnerPayout: pr.itemsTotal,
            status: 'PENDING_VENDOR_ACCEPTANCE', createdAt: now
        };
        global.merchantOrders[p.merchantId].push(merchantOrder);
        if (global.io) {
            global.io.to(p.merchantId).emit('new_customer_order', { orderId, items: p.lines, totalAmount: pr.total, shopOwnerPayout: pr.itemsTotal });
            global.io.emit('orderListUpdated', { orderId });
        }
    }
    recent.push(now); burst.set(uid, recent);
    if (D.appendAudit) D.appendAudit('USER_ORDER_PLACED', { orderId, mode: p.isRide ? 'RIDE' : 'SHOP', merchantId: p.merchantId, total: pr.total });
    try { const EV = D.orderEvents && D.orderEvents(); if (EV && EV.afterOrder) EV.afterOrder(order); } catch (e) { /* listeners record their own failures; an order must never fail because of them */ }

    res.json({
        success: true, orderId, mode: p.isRide ? 'RIDE' : 'SHOP', total: pr.total, deliveryPin, etaMin: pr.etaMin, quote: quoteView(p), payment: { mode: 'SIMULATED', status: 'SIMULATED_PAID' },
        message: p.isRide ? 'Ride requested. Looking for a rider.' : `Order sent to ${p.profile.shopName}. The shop has been alerted.`
    });
});

// ---------------------------------------------------------------------------
// How many drivers of this kind are free and online near the pickup (like the cars on Bolt's or Uber's map, but counts only:
// no driver identity or position ever leaves the server). Same rules as the driver radar: online, allowed to work, not busy,
// within 20 km of the pickup when both positions are known.
router.get('/drivers-nearby', (req, res) => {
    const want = ['CAR', 'CAB'].includes(String(req.query.vehicle || '').toUpperCase()) ? 'CAR' : 'BODA';
    const at = { lat: Number(req.query.lat), lng: Number(req.query.lng) }, haveAt = validCoord(at);
    const drivers = D.getDrivers ? D.getDrivers() : {}, pres = D.getPresence ? D.getPresence() : {}, locs = D.getLocations ? D.getLocations() : {};
    const approval = !!(D.requireApproval && D.requireApproval()), now = Date.now(), busy = new Set();
    for (const list of Object.values(global.activeDispatches || {})) for (const d of (list || [])) if (d && d.status === 'ACCEPTED_BY_DRIVER' && d.driverId) busy.add(d.driverId);
    let available = 0, nearest = null;
    for (const d of Object.values(drivers || {})) {
        if (!d || !d.id || !has(pres, d.id) || !pres[d.id] || !pres[d.id].online || busy.has(d.id)) continue;
        if (d.standing === 'SUSPENDED' || d.standing === 'REJECTED' || (approval && d.standing !== 'APPROVED')) continue;
        if ((['CAR', 'CAB'].includes(String(d.vehicleType || '').toUpperCase()) ? 'CAR' : 'BODA') !== want) continue;
        const l = has(locs, d.id) ? locs[d.id] : null; let km = null;
        if (haveAt && l && now - l.at < 120000) { km = drivingKm(l.lat, l.lng, at.lat, at.lng); if (km > 20 * PRICING.roadFactor) continue; }
        available++; if (km !== null && (nearest === null || km < nearest)) nearest = km;
    }
    res.json({ success: true, vehicle: want, available, nearestKm: nearest, etaMin: nearest === null ? null : Math.max(1, Math.ceil(nearest / PRICING.tariff[want].speed * 60)) });
});

router.get('/tariff', (req, res) => {
    res.json({ success: true, tariff: PRICING.tariff, roundTo: PRICING.roundTo, roadFactor: PRICING.roadFactor, minKm: PRICING.minKm,
        serviceFeeRate: PRICING.serviceFeeRate, riderShare: PRICING.driverShare, currency: PRICING.currency });
});

// The customer's delivery PIN (owner only, while the order is open).
router.get('/orders/:orderId/pin', auth, (req, res) => {
    const id = req.params.orderId;
    if (!isSafeKey(id)) return bad(res, 'Invalid orderId.');
    if (!req.user || !req.user.userId) return bad(res, 'Please sign in.', 401);
    const refs = D.findOrderRefs191(id);
    const base = refs.active[0] && refs.active[0].order;
    if (!base) return bad(res, 'Order not found.', 404);
    if (req.user.role !== D.ROLES.SOVEREIGN_ADMIN && base.userId !== req.user.userId) return bad(res, 'Forbidden.', 403);
    if (CANCELLED.has(base.status) || base.deliveryStatus === 'DELIVERED' || /COMPLETED/.test(String(base.status))) return res.json({ success: true, pin: null });
    res.json({ success: true, pin: base.deliveryPin || null });
});

router.get('/orders/live', auth, (req, res) => {
    if (!req.user || !req.user.userId) return bad(res, 'Please sign in.', 401);
    res.json({ success: true, orders: D.normalizedOrders191().filter(o => o.userId === req.user.userId) });
});

router.post('/orders/dismiss', (req, res) => bad(res, 'This action was retired. Use /api/user/orders/cancel.', 410));

// ---------------------------------------------------------------------------
// Guards that run before the inline handlers
// ---------------------------------------------------------------------------
function cancelGuard(req, res, next) {
    const id = req.body && req.body.orderId;
    if (!isSafeKey(id) || !D.orderView191) return next();
    const v = D.orderView191(id, false);
    if (!v || CANCELLED.has(v.status)) return next();                        // inline handler answers 404 / 409
    if (v.deliveryStatus === 'DELIVERED' || /COMPLETED/.test(String(v.status)) || v.vendorStatus === 'COMPLETED & PAID OUT') {
        return bad(res, 'This order is already complete and cannot be cancelled.', 409);
    }
    if (v.merchantId) {
        if (v.vendorStatus && v.vendorStatus !== 'PENDING_VENDOR_ACCEPTANCE') return bad(res, 'The shop has already accepted this order. Please contact support to cancel.', 409);
    } else if (v.deliveryStatus && v.deliveryStatus !== 'DELIVERED') {
        return bad(res, 'A rider is already on the way. Please contact the rider or support.', 409);
    }
    next();
}

function rateGuard(req, res, next) {
    const id = req.body && req.body.orderId;
    if (!isSafeKey(id) || !D.orderView191) return next();
    const v = D.orderView191(id, false);
    if (!v) return next();
    const done = v.deliveryStatus === 'DELIVERED' || /COMPLETED/.test(String(v.status)) || v.vendorStatus === 'COMPLETED & PAID OUT';
    if (!done) return bad(res, 'You can rate an order once it has been delivered.', 409);
    const ratings = D.getRatings ? D.getRatings() : [];
    if (ratings.some(r => r.orderId === id)) return bad(res, 'This order was already rated.', 409);
    next();
}

module.exports = router;
module.exports.init = init;
module.exports.cancelGuard = cancelGuard;
module.exports.rateGuard = rateGuard;
module.exports.PRICING = PRICING;
module.exports.priceOf = priceOf;
module.exports.TARIFF = TARIFF;
module.exports.VAT_RATE = VAT_RATE;