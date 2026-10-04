'use strict';
// ============================================================================
// routes/store.js — STAGE 192 MASTER CONTROL (additive; loaded by server.js)
//
// This file is the OWNER'S MASTER SWITCHBOARD for the whole project. The page is store.html (at /store).
// Master API (admin sign-in; switching needs the SOVEREIGN_ADMIN role), mounted at /api/store/master:
//   GET  /overview /finance /reconcile /alerts     live view, statistics, books, KRA VAT
//   GET  /switches                                 every panel's on/off state + traffic
//   POST /panels/set {panel,on,message}            switch one panel: customer, merchant, driver, ads, printer, admin
//   POST /panels/all {on,message}                  emergency stop / resume (admin and this master control stay on)
//   GET  /people/customers|riders|shops?q=         everyone, with their numbers and switch state
//   POST /people/customers/set {userId|phone,active,reason}   switch one customer on or off
//   POST /people/riders/set    {driverId,active,reason}       switch one rider on or off
//   POST /people/shops/set     {merchantId,active,reason}     switch one shop on or off
// gate() runs before every other route (server.js mounts it first) and enforces the switches on every page and API.
// The store helpers kept from before: priceGuard (server-verified prices), POST /quote, and the retired old checkout.
//
// MONEY RULES (amounts summed in whole cents, so totals are exact):
//   customer pays = items + 2% service fee + delivery fee;  shop = 100% of items;  rider = 95% of delivery fee
//   platform income = what is left;  VAT (KRA) = income x rate / (1 + rate);  net = income - VAT
// ============================================================================
const express = require('express');
const router = express.Router();
let D = {};
function init(deps) { D = deps || {}; }

const DEFAULT_MERCHANT = 'MERCH_DEF_172';

const PRICING = Object.freeze({
    currency: 'KES',
    baseFee: 150, perKm: 35, surcharge: 72, roundTo: 5,   // fee = round((150 + km*35 + 18*4)/5)*5
    serviceFeeRate: 0.02, driverShare: 0.95, appCommissionRate: 0.05, kraRate: 0.16,
    roadFactor: 1.4, minKm: 4, defaultKm: 6.5, maxKm: 500,
    maxAmount: 10000000, maxQty: 99, maxLines: 100
});

const BUILTIN = new Map([
    { id: 'M_01', category: 'SUPERMARKET', name: 'Sovereign Organic Milk (1L)', price: 180 },
    { id: 'M_02', category: 'SUPERMARKET', name: 'Fresh Farm Bread (Loaf)', price: 110 },
    { id: 'H_01', category: 'HOTELS', name: 'Executive Suite (1 Night Stay)', price: 15000 },
    { id: 'H_02', category: 'HOTELS', name: 'Deluxe Double Room (Breakfast)', price: 9500 },
    { id: 'R_01', category: 'RESTAURANT', name: 'Sovereign Nyama Platter', price: 2500 },
    { id: 'R_02', category: 'RESTAURANT', name: 'Artisan Wood-Fired Pizza', price: 1400 }
].map(p => [p.id, p]));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];
const isSafeKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,80}$/.test(v) && !PROTO_KEYS.includes(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const money2 = (n) => Number(Number(n).toFixed(2));
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });
const isLat = (v) => Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 90;
const isLng = (v) => Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 180;
const hasCoord = (c) => !!c && typeof c === 'object' && c.lat !== undefined && c.lng !== undefined && isLat(c.lat) && isLng(c.lng);

function isTenantActive(id) {
    const profiles = global.merchantProfiles || {};
    const corridors = global.corridorStatus || {};
    const st = has(profiles, id) ? profiles[id].status : undefined;
    const cs = has(corridors, id) ? corridors[id] : undefined;
    return st !== 'SUSPENDED' && st !== 'REVOKED' && cs !== 'SUSPENDED' && cs !== 'REVOKED';
}

function findProduct(id) {
    if (BUILTIN.has(id)) {
        const p = BUILTIN.get(id);
        return { id: p.id, name: p.name, price: p.price, stock: null, merchantId: DEFAULT_MERCHANT };
    }
    const catalogs = global.merchantCatalogs || {};
    for (const merchantId of Object.keys(catalogs)) {
        if (!isTenantActive(merchantId)) continue;
        const item = (catalogs[merchantId] || []).find(i => i && i.id === id);
        if (item) {
            const price = Number(item.price);
            if (!Number.isFinite(price) || price < 0) return null;
            const stock = item.stock === undefined || item.stock === null ? null : Number(item.stock);
            return { id: item.id, name: String(item.name || 'Item').slice(0, 120), price, stock: Number.isFinite(stock) ? stock : null, merchantId };
        }
    }
    return null;
}

// Same distance formula as the server's calculateAccurateDrivingDistance (x1.4, min 4 km).
function drivingKm(lat1, lon1, lat2, lon2) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    const straight = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Number(Math.max(straight * PRICING.roadFactor, PRICING.minKm).toFixed(1));
}

// Same formulas as the inline POST /api/store/checkout (business math unchanged).
function compute(items, km, distanceSource) {
    const P = PRICING;
    const deliveryFee = Math.round((P.baseFee + km * P.perKm + P.surcharge) / P.roundTo) * P.roundTo;
    const merchantPayout = items;
    const serviceFee = items * P.serviceFeeRate;
    const driverPayout = deliveryFee * P.driverShare;
    const appCommission = deliveryFee * P.appCommissionRate;
    const systemIncome = serviceFee + appCommission;
    const kraTax = systemIncome * P.kraRate / (1 + P.kraRate);   // VAT contained in the (VAT-inclusive) platform income
    const total = items + serviceFee + deliveryFee;
    const distributed = merchantPayout + driverPayout + appCommission + serviceFee;
    return {
        currency: P.currency,
        itemsTotal: money2(items),
        distanceKm: km,
        distanceSource,
        deliveryFee: money2(deliveryFee),
        serviceFee: money2(serviceFee),
        total: money2(total),
        splits: {
            merchantPayout: money2(merchantPayout),
            driverPayout: money2(driverPayout),
            appCommission: money2(appCommission),
            systemIncome: money2(systemIncome),
            kraTax: money2(kraTax),
            netRevenue: money2(systemIncome - kraTax)
        },
        ledgerBalanced: Math.abs(total - distributed) < 0.01
    };
}

// ---------------------------------------------------------------------------
// 1. priceGuard — runs before the inline checkout handler
// ---------------------------------------------------------------------------
function priceGuard(req, res, next) {
    const b = req.body;
    if (!b || typeof b !== 'object') return bad(res, 'Invalid request body.');
    const cart = b.cartItems;
    if (!Array.isArray(cart) || cart.length === 0) return bad(res, 'Your cart is empty.');
    if (cart.length > PRICING.maxLines) return bad(res, `Too many cart lines (max ${PRICING.maxLines}).`);

    const wanted = new Map();
    for (const raw of cart) {
        if (!raw || !isSafeKey(raw.id)) return bad(res, 'Invalid item in cart.');
        const qty = Number(raw.qty);
        if (!Number.isInteger(qty) || qty < 1) return bad(res, `Invalid quantity for ${raw.id}.`);
        const merged = (wanted.get(raw.id) || 0) + qty;
        if (merged > PRICING.maxQty) return bad(res, `Maximum ${PRICING.maxQty} per item.`);
        wanted.set(raw.id, merged);
    }

    let merchantId = null;
    let total = 0;
    const lines = [];
    for (const [id, qty] of wanted) {
        const p = findProduct(id);
        if (!p) return bad(res, `"${id}" is no longer available.`, 400);
        if (merchantId === null) merchantId = p.merchantId;
        else if (merchantId !== p.merchantId) return bad(res, 'One order can only contain items from one shop.');
        if (p.stock !== null && qty > p.stock) return bad(res, p.stock <= 0 ? `${p.name} is out of stock.` : `Only ${p.stock} of ${p.name} left.`, 409);
        total += p.price * qty;
        lines.push({ id: p.id, name: p.name, price: p.price, qty });
    }

    if (b.merchantId !== undefined && b.merchantId !== null && b.merchantId !== '') {
        if (!isSafeKey(b.merchantId)) return bad(res, 'Invalid merchantId.');
        if (b.merchantId !== merchantId) return bad(res, 'Cart items do not belong to the selected shop.');
    }
    if (!isTenantActive(merchantId)) return bad(res, 'This shop is currently unavailable.', 403);

    total = money2(total);
    if (!(total > 0)) return bad(res, 'Invalid cart total.'); // inline checkout treats 0 as a 1500 default
    if (total > PRICING.maxAmount) return bad(res, 'Order total is above the allowed limit.');

    // Overwrite client-supplied money with server-verified values.
    req.body.itemsTotal = total;
    req.body.merchantId = merchantId;
    req.body.cartItems = lines;
    next();
}

// ---------------------------------------------------------------------------
// 2. POST /api/store/quote — public, authoritative preview
// ---------------------------------------------------------------------------
router.post('/quote', (req, res) => {
    const b = req.body || {};
    const items = b.itemsTotal === undefined || b.itemsTotal === null || b.itemsTotal === '' ? 0 : Number(b.itemsTotal);
    if (!Number.isFinite(items) || items < 0 || items > PRICING.maxAmount) return bad(res, 'itemsTotal must be between 0 and 10,000,000.');

    if (b.merchantId !== undefined && b.merchantId !== null && b.merchantId !== '') {
        if (!isSafeKey(b.merchantId)) return bad(res, 'Invalid merchantId.');
        if (!isTenantActive(b.merchantId)) return bad(res, 'This shop is currently unavailable.', 403);
    }

    let km = null, source = null;
    if (b.distanceKm !== undefined && b.distanceKm !== null && b.distanceKm !== '') {
        const n = Number(b.distanceKm);
        if (!Number.isFinite(n) || n < 0 || n > PRICING.maxKm) return bad(res, `distanceKm must be between 0 and ${PRICING.maxKm}.`);
        if (n > 0) { km = n; source = 'CLIENT'; }
    }
    if (km === null && hasCoord(b.pickup) && hasCoord(b.dropoff)) {
        km = drivingKm(Number(b.pickup.lat), Number(b.pickup.lng), Number(b.dropoff.lat), Number(b.dropoff.lng));
        source = 'COORDINATES';
    }
    if (km === null) { km = PRICING.defaultKm; source = 'DEFAULT'; }

    res.json({ success: true, quote: compute(items, km, source) });
});

// ---------------------------------------------------------------------------
// STAGE 192: one order path. The old store checkout used a different delivery tariff, no map
// coordinates and no delivery PIN, and its rider routes could mark a trip settled without a PIN.
// Customers now order through /api/user/checkout (the RDS app at /user).
// ---------------------------------------------------------------------------
const retired = (req, res) => bad(res, 'This endpoint was retired. Place orders in the RDS app at /user (it uses /api/user/checkout).', 410);
router.post('/checkout', retired);
router.post('/logistics/rider-action', retired);
router.post('/logistics/complete-trip', retired);


// ============================================================================
// MASTER CONTROL
// ============================================================================
const PANEL_DEFS = [
    { key: 'customer', title: 'Customer app', pages: ['/user'], files: ['/user.html'], api: [/^\/api\/user(\/|$)/] },
    { key: 'merchant', title: 'Shop console', pages: ['/merchant'], files: ['/merchant.html'], api: [/^\/api\/merchant(\/|$)/] },
    { key: 'driver', title: 'Rider app', pages: ['/driver'], files: ['/driver.html'], api: [/^\/api\/driver(\/|$)/] },
    { key: 'ads', title: 'Ads', pages: ['/ads', '/'], files: ['/ads.html'], api: [/^\/api\/ads(\/|$)/] },
    { key: 'printer', title: 'Printer', pages: ['/print'], files: ['/print.html', '/public/print.html'], api: [/^\/api\/print(\/|$)/, /^\/api\/middleware\/intercept-print/] },
    { key: 'admin', title: 'Admin', pages: ['/admin'], files: ['/admin.html'], api: [/^\/api\/admin(\/|$)/, /^\/api\/(audit|compliance|kyc|cashier|hardware|ai)(\/|$)/] }
];
const PAGE_INDEX = new Map();
PANEL_DEFS.forEach(p => { p.pages.forEach(x => PAGE_INDEX.set(x, p.key)); p.files.forEach(x => PAGE_INDEX.set(x, p.key)); });
const S = () => (D.getSwitches ? D.getSwitches() : { panels: {}, users: {} });
function panelState(key) { const p = (S().panels || {})[key]; return { on: !p || p.on !== false, message: (p && p.message) || '', at: (p && p.at) || null, by: (p && p.by) || null }; }
function panelOfPath(path) {
    if (PAGE_INDEX.has(path)) return PAGE_INDEX.get(path);
    for (const p of PANEL_DEFS) if (p.api.some(re => re.test(path))) return p.key;
    return null;
}
const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function offPage(res, title, msg) {
    res.status(503).set({ 'Retry-After': '300', 'Cache-Control': 'no-store' }).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escH(title)} is switched off</title><body style="font-family:system-ui;background:#0b0f19;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;padding:24px;max-width:420px"><div style="font-size:3rem">⏸️</div><h1 style="margin:10px 0">${escH(title)} is temporarily switched off</h1><p style="color:#9ca3af">${escH(msg)}</p></div></body>`);
}
// Runs before every other route. Enforces panel switches and switched-off customers.
function gate(req, res, next) {
    try {
        if (req.method === 'OPTIONS' || !D.getSwitches) return next();
        const sw = D.getSwitches(), path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
        const key = panelOfPath(path);
        if (key) {
            const p = sw.panels && sw.panels[key];
            if (p && p.on === false) {
                const def = PANEL_DEFS.find(x => x.key === key), msg = p.message || `${def.title} is temporarily switched off. Please try again later.`;
                if (path.startsWith('/api/')) { res.set('Retry-After', '300'); return res.status(503).json({ success: false, code: 'PANEL_OFF', panel: key, error: msg }); }
                return offPage(res, def.title, msg);
            }
        }
        const users = sw.users;
        if (users && path.startsWith('/api') && Object.keys(users).length) {
            const h = req.headers.authorization;
            if (h && h.startsWith('Bearer ') && D.verifyJwt) { const pl = D.verifyJwt(h.slice(7).trim()); if (pl && pl.userId && Object.prototype.hasOwnProperty.call(users, pl.userId)) return res.status(403).json({ success: false, code: 'ACCOUNT_SUSPENDED', error: 'Your account has been suspended. Please contact support.' }); }
            if ((path === '/api/user/send-otp' || path === '/api/user/verify-otp') && req.body && typeof req.body.phone === 'string' && D.normalizePhone) {
                const id = 'USR_' + D.normalizePhone(req.body.phone).replace(/[^0-9]/g, '');
                if (Object.prototype.hasOwnProperty.call(users, id)) return res.status(403).json({ success: false, code: 'ACCOUNT_SUSPENDED', error: 'Your account has been suspended. Please contact support.' });
            }
        }
    } catch (e) { /* the gate must never take the server down */ }
    next();
}

const MASTER = (function () {
    const router = express.Router();
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const CANCEL = new Set(['CANCELLED_BY_CUSTOMER', 'REJECTED_BY_VENDOR', 'ORDERLY_DISMISSED', 'CANCELLED']);
const cents = (x) => Math.round(Number(x || 0) * 100);
const fromC = (c) => Math.round(c) / 100;
const sumC = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const rate = () => (Number.isFinite(D.vatRate) ? D.vatRate : 0.16);
const vatOfC = (incomeC) => Math.round(incomeC * rate() / (1 + rate()));
const DAY = 86400000, HOUR = 3600000;


// ---------------------------------------------------------------------------
// orders, normalised to whole cents
// ---------------------------------------------------------------------------
function stateOf(o) {
    const st = String(o.status || '');
    if (CANCEL.has(st)) return 'CANCELLED';
    if (st === 'COMPLETED_SETTLED' || o.deliveryStatus === 'DELIVERED' || /COMPLETED/.test(st)) return 'DONE';
    return 'OPEN';
}
function orders() {
    const out = [], ao = D.getActiveOrders() || {};
    for (const key of Object.keys(ao)) for (const o of (ao[key] || [])) {
        const b = o.breakdown || {}, ride = key === 'DIRECT_RIDES';
        const itemsC = cents(b.commodityCost !== undefined ? b.commodityCost : b.shopOwnerPayout);
        const feeC = cents(b.deliveryFee), riderC = cents(b.riderShare), totalC = cents(o.total);
        const modern = b.serviceFee !== undefined;
        out.push({
            id: o.id, source: 'APP', kind: ride ? 'RIDE' : 'SHOP', merchantId: ride ? null : key, userId: o.userId || null, driverId: o.driverId || null,
            createdAt: o.createdAt || 0, completedAt: o.completedAt || o.deliveredAt || o.createdAt || 0, state: stateOf(o), status: o.status, deliveryStatus: o.deliveryStatus || null,
            refundStatus: o.refundStatus || null, vehicle: o.vehicleType || null,
            totalC, itemsC, svcC: modern ? cents(b.serviceFee) : 0, feeC, riderC, appC: modern ? cents(b.appCommission) : feeC - riderC,
            platformC: totalC - itemsC - riderC,                    // cash truth: money in minus money out
            storedTaxC: b.tax !== undefined ? cents(b.tax) : null, legacy: !modern, fields: { hasBreakdown: !!o.breakdown },
            handedOver: !!o.handoverAt, handoverAt: o.handoverAt || null, paidToShopC: o.paidToShop !== undefined ? cents(o.paidToShop) : null
        });
    }
    for (const o of (D.getStoreOrders() || [])) {                   // legacy /store checkout orders (retired)
        const s = o.splits || {}, riderC = cents(s.driverPayout), itemsC = cents(s.merchantPayout), totalC = cents(o.totalAmount);
        out.push({
            id: o.orderId, source: 'LEGACY_STORE', kind: 'SHOP', merchantId: o.tenantId || null, userId: o.userId || null, driverId: o.driverId || null,
            createdAt: o.timestamp || 0, completedAt: o.deliveredAt || o.timestamp || 0, state: stateOf(o), status: o.status, deliveryStatus: o.deliveryStatus || (o.delivery && o.delivery.status) || null,
            refundStatus: o.refundStatus || null, vehicle: 'BODA', totalC, itemsC, svcC: cents(s.sysFeeOnItems), feeC: riderC + cents(s.appDeliveryComm), riderC, appC: cents(s.appDeliveryComm),
            platformC: totalC - itemsC - riderC, storedTaxC: s.kraTaxOnSystemIncome !== undefined ? cents(s.kraTaxOnSystemIncome) : null, legacy: true, fields: { hasBreakdown: true }
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// reconciliation: the proof that the books balance
// ---------------------------------------------------------------------------
let auditCache = { at: 0, v: null };
function auditInfo() {
    if (Date.now() - auditCache.at > 15000) { try { auditCache = { at: Date.now(), v: D.getAuditInfo() }; } catch (e) { auditCache = { at: Date.now(), v: { valid: false, length: 0 } }; } }
    return auditCache.v;
}
function reconcile() {
    const all = orders(), checks = [], T = 1;               // tolerance: 1 cent
    const mk = (id, label, formula, hard) => ({ id, label, formula, hard, ok: true, checked: 0, failures: [] });
    const c1 = mk('ORDER_TOTAL', 'Customer total is items + 2% service fee + delivery fee', 'total = items + serviceFee + deliveryFee', true);
    const c2 = mk('SERVICE_FEE', 'Service fee is exactly 2% of items', 'serviceFee = round(items x 2%)', true);
    const c3 = mk('RIDER_95', 'Rider share is exactly 95% of the delivery fee', 'riderShare = round(deliveryFee x 95%)', true);
    const c4 = mk('PLATFORM_5', 'Platform commission is the other 5% of the delivery fee', 'appCommission = deliveryFee - riderShare', true);
    const c5 = mk('CONSERVATION', 'Every shilling is accounted for', 'shop + rider + platform = customer paid', true);
    const c6 = mk('RIDER_LEDGER', 'Every delivered order paid its rider exactly once', 'one ledger credit = riderShare', true);
    const c7 = mk('WALLETS', 'Each rider wallet = earnings - withdrawals', 'wallet = sum(credits) - sum(payouts)', true);
    const c8 = mk('PAYOUT_CAP', 'No rider withdrew more than they earned', 'sum(payouts) <= sum(credits)', true);
    const c9 = mk('NO_PAYOUT_UNLESS_DONE', 'No rider credit exists for an order that was not delivered', 'credit => order delivered', true);
    const c10 = mk('AUDIT_CHAIN', 'The tamper-proof audit chain is intact', 'every block links to the one before', true);
    const c11 = mk('LEGACY_2PCT', 'Old orders placed before the 2% fix (information only)', 'platform paid out the 2% it never collected', false);
    const c12 = mk('STORED_VAT', 'Old orders that stored VAT with the earlier formula (information only)', 'stored tax vs income x 16/116', false);
    checks.push(c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12);
    const fail = (c, id, msg) => { c.ok = false; if (c.failures.length < 25) c.failures.push({ ref: id, detail: msg }); };

    const ledger = D.getLedger() || [], byDispatch = new Map();
    for (const e of ledger) { const a = byDispatch.get(e.dispatchId) || []; a.push(e); byDispatch.set(e.dispatchId, a); }
    let legacyShortfallC = 0, legacyCount = 0, taxDiff = 0, taxCount = 0;

    for (const o of all) {
        if (o.source !== 'APP') continue;
        if (o.legacy) {
            legacyCount++; c11.checked++; legacyShortfallC += Math.round(o.itemsC * 0.02);
            c11.ok = false; if (c11.failures.length < 25) c11.failures.push({ ref: o.id, detail: `Customer paid ${fromC(o.totalC)}; the 2% service fee (${fromC(Math.round(o.itemsC * 0.02))}) was never charged on this order` });
        } else {
            c1.checked++; if (Math.abs(o.totalC - (o.itemsC + o.svcC + o.feeC)) > T) fail(c1, o.id, `total ${fromC(o.totalC)} vs ${fromC(o.itemsC + o.svcC + o.feeC)}`);
            c2.checked++; if (Math.abs(o.svcC - Math.round(o.itemsC * 0.02)) > T) fail(c2, o.id, `serviceFee ${fromC(o.svcC)} vs ${fromC(Math.round(o.itemsC * 0.02))}`);
            c3.checked++; if (Math.abs(o.riderC - Math.round(o.feeC * 0.95)) > T) fail(c3, o.id, `riderShare ${fromC(o.riderC)} vs ${fromC(Math.round(o.feeC * 0.95))}`);
            c4.checked++; if (Math.abs(o.appC - (o.feeC - o.riderC)) > T) fail(c4, o.id, `commission ${fromC(o.appC)} vs ${fromC(o.feeC - o.riderC)}`);
            c5.checked++; if (Math.abs(o.itemsC + o.riderC + o.svcC + o.appC - o.totalC) > T) fail(c5, o.id, `parts ${fromC(o.itemsC + o.riderC + o.svcC + o.appC)} vs paid ${fromC(o.totalC)}`);
        }
        if (o.storedTaxC !== null) { const calc = vatOfC(o.platformC); if (Math.abs(calc - o.storedTaxC) > T) { taxCount++; taxDiff += o.storedTaxC - calc; c12.checked++; c12.ok = false; c12.failures.length < 25 && c12.failures.push({ ref: o.id, detail: `stored VAT ${fromC(o.storedTaxC)} vs correct ${fromC(calc)}` }); } else c12.checked++; }
        if (o.state === 'DONE') {
            c6.checked++; const es = byDispatch.get(o.id) || [];
            if (es.length !== 1) fail(c6, o.id, es.length === 0 ? 'delivered but the rider was never paid' : `rider paid ${es.length} times`);
            else if (Math.abs(cents(es[0].credited) - o.riderC) > T) fail(c6, o.id, `rider credited ${es[0].credited} vs riderShare ${fromC(o.riderC)}`);
        }
    }
    const doneIds = new Set(all.filter(o => o.state === 'DONE').map(o => o.id));
    for (const e of ledger) { c9.checked++; if (e.dispatchId && !doneIds.has(e.dispatchId)) fail(c9, e.dispatchId, `credit ${e.credited} for an order that is not delivered`); }

    const wallets = D.getWallets() || {}, payouts = D.getPayouts() || [];
    const creditC = {}, payC = {};
    for (const e of ledger) creditC[e.driverId] = (creditC[e.driverId] || 0) + cents(e.credited);
    for (const p of payouts) payC[p.driverId] = (payC[p.driverId] || 0) + cents(p.amount);
    const ids = new Set([...Object.keys(wallets), ...Object.keys(creditC), ...Object.keys(payC)]);
    for (const id of ids) {
        c7.checked++; const exp = (creditC[id] || 0) - (payC[id] || 0), act = cents(wallets[id] || 0);
        if (Math.abs(exp - act) > T) fail(c7, id, `wallet ${fromC(act)} vs earned-withdrawn ${fromC(exp)}`);
        c8.checked++; if ((payC[id] || 0) > (creditC[id] || 0) + T) fail(c8, id, `withdrew ${fromC(payC[id])} but earned ${fromC(creditC[id] || 0)}`);
    }
    const a = auditInfo(); c10.checked = a.length || 0; if (!a.valid) fail(c10, 'chain', 'a block does not match the one before it');

    // ----- shops are paid in full, exactly once, at hand-over -----
    if (D.getMerchantEarnings) {
        const s1 = mk('SHOP_PAID_ONCE', 'Every shop is paid once, in full, when it hands the order to the rider', 'paid at hand-over = items total; one payment per order', true);
        const s2 = mk('SHOP_WALLETS', 'Shop wallets add up', 'balance = paid at hand-over - sent to M-Pesa', true);
        checks.push(s1, s2);
        const earn = D.getMerchantEarnings() || [], mpay = D.getMerchantPayouts() || [], mw = D.getMerchantWallets() || {}, byId = new Map(all.map(o => [o.id, o])), seen = new Map();
        for (const e of earn) {
            s1.checked++; seen.set(e.orderId, (seen.get(e.orderId) || 0) + 1);
            const o = byId.get(e.orderId);
            if (!o) fail(s1, e.orderId, 'a shop was paid for an order that does not exist');
            else if (cents(e.amount) !== o.itemsC) fail(s1, e.orderId, `shop paid ${fromC(cents(e.amount))} but the items total is ${fromC(o.itemsC)}`);
            else if (!o.handedOver) fail(s1, e.orderId, 'a shop was paid but the order was never handed over');
        }
        for (const [id, n] of seen) if (n > 1) fail(s1, id, `the shop was paid ${n} times for this order`);
        for (const o of all) if (o.handedOver && !seen.has(o.id)) fail(s1, o.id, 'handed over but the shop has no payment record');
        const shops = new Set([...earn.map(e => e.merchantId), ...mpay.map(p => p.merchantId), ...Object.keys(mw)]);
        for (const m of shops) {
            s2.checked++;
            const inC = sumC(earn.filter(e => e.merchantId === m), e => cents(e.amount)), outC = sumC(mpay.filter(p => p.merchantId === m), p => cents(p.amount)), balC = cents(mw[m] || 0);
            if (balC !== inC - outC) fail(s2, m, `wallet ${fromC(balC)} but paid ${fromC(inC)} - sent ${fromC(outC)} = ${fromC(inC - outC)}`);
            if (balC < 0) fail(s2, m, 'a shop wallet is negative');
        }
    }

    // ----- the ledger must agree with the orders (only orders whose payment was posted to the ledger are compared) -----
    const LV = D.getLedgerView ? D.getLedgerView() : null;
    if (LV && LV.engine) {
        const L = LV.engine, ten = LV.tenant, idem = (L.state.idem && L.state.idem[ten]) || {};
        const l1 = mk('LEDGER_CHAIN', 'The ledger is tamper-proof and balanced', 'every journal links to the one before, and debits = credits', true);
        const l2 = mk('LEDGER_ESCROW', "Customers' money held in the ledger equals open orders", 'ledger 2000 = sum of unpaid-out order totals', true);
        const l3 = mk('LEDGER_SHOPS', 'Shop payables in the ledger equal delivered shop sales', 'ledger 2010 = sum of items on delivered orders', true);
        const l4 = mk('LEDGER_RIDERS', 'Rider payables in the ledger equal rider wallets', 'ledger 2020 = rider earnings - withdrawals', true);
        const l5 = mk('LEDGER_VAT', 'VAT payable (KRA) in the ledger equals the VAT on delivered orders', 'ledger 2030 = sum of income x 16/116', true);
        const l6 = mk('LEDGER_REFUNDS', 'Refunds owed in the ledger equal cancelled paid orders', 'ledger 2050 = sum of cancelled order totals', true);
        const l7 = mk('LEDGER_COVERAGE', 'Every delivered order was settled in the ledger, and no posting failed', 'delivered => settlement journal; failures = 0', true);
        checks.push(l1, l2, l3, l4, l5, l6, l7);
        const v = L.verifyChain(ten), tbl = L.trialBalance(ten); l1.checked = v.entries;
        if (!v.valid) fail(l1, v.brokenAt || 'chain', v.reason); if (!tbl.balanced) fail(l1, 'trial balance', 'debits do not equal credits');
        const bal = (code) => { const a = L.listAccounts(ten).find(x => x.code === code); if (!a) return 0; const b = L.balanceOf(ten, code); return a.normal === 'D' ? b.debit - b.credit : b.credit - b.debit; };
        const covered = all.filter(o => o.source === 'APP' && idem[`ORDER:${o.id}:PAY`]);
        const open = covered.filter(o => o.state === 'OPEN'), done = covered.filter(o => o.state === 'DONE'), canc = covered.filter(o => o.state === 'CANCELLED' && idem[`ORDER:${o.id}:REFUND`]);
        const paidOut = (L.state.journals[ten] || []).filter(e => e.source === 'RIDER_PAYOUT').reduce((s, e) => s + e.totalMinor, 0);
        const shopPaidOut = (L.state.journals[ten] || []).filter(e => e.source === 'SHOP_PAYOUT').reduce((s, e) => s + e.totalMinor, 0);
        const handed = (o) => !!idem[`ORDER:${o.id}:HANDOVER`];
        const exp = { escrow: sumC(open, o => o.totalC - (handed(o) ? o.itemsC : 0)), shops: sumC(covered.filter(o => o.state === 'DONE' || (o.state === 'OPEN' && handed(o))), o => o.itemsC) - shopPaidOut, riders: sumC(done, o => o.riderC) - paidOut, vat: sumC(done, o => vatOfC(o.platformC)), refunds: sumC(canc, o => o.totalC) };
        [[l2, '2000', exp.escrow], [l3, '2010', exp.shops], [l4, '2020', exp.riders], [l5, '2030', exp.vat], [l6, '2050', exp.refunds]].forEach(([c, code, e]) => { c.checked = covered.length; const g = bal(code); if (g !== e) fail(c, code, `ledger ${fromC(g)} vs orders ${fromC(e)}`); });
        for (const o of done) { l7.checked++; if (!idem[`ORDER:${o.id}:SETTLE`]) fail(l7, o.id, 'delivered but no settlement journal in the ledger'); }
        for (const o of covered) if (o.handedOver && !handed(o)) fail(l7, o.id, 'the shop was paid at hand-over but there is no hand-over journal in the ledger');
        const fl = L.state.failures || []; if (fl.length) fail(l7, 'posting', `${fl.length} ledger posting failure(s), e.g. ${fl[fl.length - 1].kind} ${fl[fl.length - 1].ref}: ${fl[fl.length - 1].message}`);
    }

    const done = all.filter(o => o.state === 'DONE' && o.source === 'APP' && !o.legacy);
    const eq = { orders: done.length, customerPaid: fromC(sumC(done, o => o.totalC)), shop: fromC(sumC(done, o => o.itemsC)), rider: fromC(sumC(done, o => o.riderC)), platform: fromC(sumC(done, o => o.platformC)) };
    eq.balanced = Math.abs(cents(eq.customerPaid) - cents(eq.shop) - cents(eq.rider) - cents(eq.platform)) <= T * Math.max(1, done.length);
    const hardOk = checks.filter(c => c.hard).every(c => c.ok);
    return { ok: hardOk, generatedAt: Date.now(), checks, identity: eq, legacy: { orders: legacyCount, uncollectedServiceFees: fromC(legacyShortfallC), note: 'Orders placed before the 2% fix never collected the 2% service fee.' }, taxFormulaDifferences: { orders: taxCount, storedMinusCorrect: fromC(taxDiff) } };
}

// ---------------------------------------------------------------------------
// finance
// ---------------------------------------------------------------------------
function window(all, since) {
    const done = all.filter(o => o.state === 'DONE' && o.completedAt >= since);
    const t = { orders: done.length, shopOrders: done.filter(o => o.kind === 'SHOP').length, rides: done.filter(o => o.kind === 'RIDE').length };
    t.customerPaid = sumC(done, o => o.totalC); t.items = sumC(done, o => o.itemsC); t.serviceFees = sumC(done, o => o.svcC);
    t.deliveryFees = sumC(done, o => o.feeC); t.rider = sumC(done, o => o.riderC); t.platform = sumC(done, o => o.platformC);
    t.vat = sumC(done, o => vatOfC(o.platformC)); t.net = t.platform - t.vat;
    t.commission = t.platform - t.serviceFees;
    Object.keys(t).forEach(k => { if (!['orders', 'shopOrders', 'rides'].includes(k)) t[k] = fromC(t[k]); });
    return t;
}
function finance() {
    const all = orders(), now = Date.now(), today = D.eatDayStart();
    const wins = { today: window(all, today), last7: window(all, today - 6 * DAY), last30: window(all, today - 29 * DAY), allTime: window(all, 0) };
    const open = all.filter(o => o.state === 'OPEN'), canc = all.filter(o => o.state === 'CANCELLED'), done = all.filter(o => o.state === 'DONE');
    const wallets = D.getWallets() || {}, payouts = D.getPayouts() || [];
    const walletC = sumC(Object.values(wallets), v => cents(v)), paidC = sumC(payouts, p => cents(p.amount));
    const liabilities = {
        escrowHeld: fromC(sumC(open, o => o.totalC - (o.handedOver ? o.itemsC : 0))), openOrders: open.length,
        refundsDue: fromC(sumC(canc.filter(o => o.refundStatus !== 'REFUNDED'), o => o.totalC)), cancelledOrders: canc.length,
        owedToRiders: fromC(walletC), ridersWithdrawn: fromC(paidC),
        owedToShops: fromC(sumC(Object.values((D.getMerchantWallets && D.getMerchantWallets()) || {}), v => cents(v)) + sumC(done.filter(o => o.kind === 'SHOP' && !o.handedOver), o => o.itemsC)),
        shopsPaidAtHandover: fromC(sumC((D.getMerchantEarnings && D.getMerchantEarnings()) || [], e => cents(e.amount))), shopsSentToMpesa: fromC(sumC((D.getMerchantPayouts && D.getMerchantPayouts()) || [], p => cents(p.amount))),
        legacyShopOrdersUnpaid: done.filter(o => o.kind === 'SHOP' && !o.handedOver).length, vatAccrued: wins.allTime.vat,
        note: 'Shops are paid in full when they hand the order to the rider. Orders delivered before this was built are still shown as owed to the shop. There is no VAT remittance record yet, so KRA appears as fully owed.'
    };
    const days = [];
    for (let i = 13; i >= 0; i--) {
        const s = today - i * DAY, e = s + DAY, d = done.filter(o => o.completedAt >= s && o.completedAt < e);
        const pl = sumC(d, o => o.platformC), vt = sumC(d, o => vatOfC(o.platformC));
        days.push({ day: s, orders: d.length, gmv: fromC(sumC(d, o => o.totalC)), platform: fromC(pl), vat: fromC(vt), net: fromC(pl - vt) });
    }
    const tm = new Map(), tr = new Map();
    for (const o of done) {
        if (o.merchantId) { const m = tm.get(o.merchantId) || { merchantId: o.merchantId, orders: 0, c: 0 }; m.orders++; m.c += o.itemsC; tm.set(o.merchantId, m); }
        if (o.driverId) { const r = tr.get(o.driverId) || { driverId: o.driverId, trips: 0, c: 0 }; r.trips++; r.c += o.riderC; tr.set(o.driverId, r); }
    }
    const profiles = global.merchantProfiles || {}, drivers = D.getDrivers() || {};
    const topShops = [...tm.values()].sort((a, b) => b.c - a.c).slice(0, 10).map(m => ({ merchantId: m.merchantId, name: has(profiles, m.merchantId) ? profiles[m.merchantId].shopName : m.merchantId, orders: m.orders, sales: fromC(m.c) }));
    const topRiders = [...tr.values()].sort((a, b) => b.c - a.c).slice(0, 10).map(r => ({ driverId: r.driverId, name: has(drivers, r.driverId) ? drivers[r.driverId].name : r.driverId, trips: r.trips, earned: fromC(r.c) }));
    const gross = wins.allTime.customerPaid;
    return {
        success: true, currency: 'KES', generatedAt: now, vat: { rate: rate(), basis: 'Platform fee income, VAT-inclusive: VAT = income x rate / (1 + rate)',
            exposureIfFullBasis: fromC(Math.round(cents(gross) * rate() / (1 + rate()))), exposureNote: 'If KRA treated the platform as the principal supplier (a 2025 High Court ruling points that way for some platforms), VAT could apply to the whole customer payment, not only the platform fee. Confirm the correct basis with your accountant.' },
        windows: wins, liabilities, days, topShops, topRiders, byKind: { shop: wins.allTime.shopOrders, ride: wins.allTime.rides },
        disclaimer: 'These are bookkeeping figures computed from your orders. They are not tax advice. Corporate income tax, withholding tax and other KRA obligations are not included.'
    };
}

// ---------------------------------------------------------------------------
// overview + graph
// ---------------------------------------------------------------------------
const GROUPS = [['user', /^\/api\/user/], ['store', /^\/api\/store/], ['merchant', /^\/api\/merchant/], ['driver', /^\/api\/driver/], ['ads', /^\/api\/ads/], ['printer', /^\/api\/(print|middleware)/], ['admin', /^\/api\/(admin|audit|compliance|kyc|cashier|hardware|ai)/], ['auth', /^\/api\/auth/], ['media', /^\/api\/media/]];
function traffic() {
    const m = D.getMetrics(), g = {};
    for (const [k] of GROUPS) g[k] = { requests: 0, errors: 0, ms: 0 };
    g.other = { requests: 0, errors: 0, ms: 0 };
    for (const [label, r] of Object.entries(m.byRoute || {})) {
        const path = label.replace(/^[A-Z]+ /, ''), hit = GROUPS.find(([, re]) => re.test(path)), k = hit ? hit[0] : 'other';
        g[k].requests += r.count; g[k].errors += r.errors; g[k].ms += r.ms;
    }
    for (const k of Object.keys(g)) { g[k].avgMs = g[k].requests ? Number((g[k].ms / g[k].requests).toFixed(1)) : 0; delete g[k].ms; }
    return g;
}
function healthOf(ok, moduleLoaded, panelDeployed, errRate) {
    if (moduleLoaded === false || panelDeployed === false) return 'down';
    if (!ok) return 'warn';
    return errRate > 0.05 ? 'warn' : 'ok';
}
function overview() {
    const now = Date.now(), today = D.eatDayStart(), all = orders(), fin = window(all, today);
    const mods = D.getModuleStatus() || {}, panels = D.getPanels() || [], hits = D.getPanelHits() || {}, tr = traffic(), socks = D.getSocketStats();
    const drivers = D.getDrivers() || {}, presence = D.getPresence() || {}, users = D.getUsers() || {}, profiles = global.merchantProfiles || {}, catalogs = global.merchantCatalogs || {};
    const merchOrders = global.merchantOrders || {};
    const pending = (global.driverQueue || []).filter(d => d.status === 'PENDING_DRIVER_ACCEPTANCE');
    const takeable = (d) => Number(d.riderPayout) > 0 && !!d.pinHash;      // old jobs without a payout or PIN can never be accepted
    const queue = pending.filter(takeable), oldJobs = pending.length - queue.length;
    const activeJobs = new Set(); for (const list of Object.values(global.activeDispatches || {})) for (const d of (list || [])) if (d.status === 'ACCEPTED_BY_DRIVER') activeJobs.add(d.id);
    const pendingVendor = []; for (const [mid, list] of Object.entries(merchOrders)) for (const o of (list || [])) if (o.status === 'PENDING_VENDOR_ACCEPTANCE') pendingVendor.push({ ...o, mid });
    const drvList = Object.values(drivers), approved = drvList.filter(d => d.standing === 'APPROVED').length, suspended = drvList.filter(d => d.standing === 'SUSPENDED' || d.standing === 'REJECTED').length;
    const onlineN = Object.values(presence).filter(p => p && p.online).length;
    const activeShops = Object.keys(profiles).filter(id => D.isTenantActive(id)).length;
    let lowStock = 0, items = 0; for (const list of Object.values(catalogs)) for (const i of (list || [])) { items++; if (i.stock !== undefined && i.stock !== null && Number(i.stock) <= 5) lowStock++; }
    const ratings = D.getRatings() || [], ratingAvg = ratings.length ? Number((ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(2)) : null;
    const ledger = D.getLedger() || [], doneToday = ledger.filter(e => e.at >= today).length;
    const snap = D.getSnapshot(), audit = auditInfo(), samples = D.getSamples() || [], last = samples[samples.length - 1] || { req: 0, err: 0 };
    const m = D.getMetrics(), errRate = m.total ? (m.byClass['5xx'] || 0) / m.total : 0;
    const ph = (p) => hits[p] || { n: 0, last: null };
    const panelOf = (p) => panels.find(x => x.url === p) || { deployed: null };
    const rr = (g) => tr[g] && tr[g].requests ? tr[g].errors / tr[g].requests : 0;

    const ordersToday = all.filter(o => o.createdAt >= today);
    const apps = {
        customer: { title: 'Customer app', panels: ['/user'], deployed: panelOf('/user').deployed, module: mods.user ? mods.user.loaded : null, pageViews: ph('/user').n, lastSeen: ph('/user').last, traffic: { ...tr.user, store: tr.store },
            stats: { customers: Object.keys(users).length, ordersToday: ordersToday.length, openOrders: all.filter(o => o.state === 'OPEN').length, rating: ratingAvg, ratings: ratings.length }, sockets: socks.customers },
        merchant: { title: 'Shop console', panels: ['/merchant'], deployed: panelOf('/merchant').deployed, module: mods.merchants ? mods.merchants.loaded : null, pageViews: ph('/merchant').n, lastSeen: ph('/merchant').last, traffic: tr.merchant,
            stats: { shopsActive: activeShops, shopsTotal: Object.keys(profiles).length, awaitingApproval: (D.getPendingMerchants() || []).length, catalogItems: items, lowStock, ordersWaiting: pendingVendor.length, oldestWaitingMin: pendingVendor.length ? Math.round((now - Math.min(...pendingVendor.map(o => o.createdAt || now))) / 60000) : 0 }, sockets: socks.merchants },
        driver: { title: 'Rider app', panels: ['/driver'], deployed: panelOf('/driver').deployed, module: mods.driver ? mods.driver.loaded : null, pageViews: ph('/driver').n, lastSeen: ph('/driver').last, traffic: tr.driver,
            stats: { riders: drvList.length, approved, awaitingApproval: drvList.length - approved - suspended, suspended, online: onlineN, jobsOnRadar: queue.length, oldJobsRidersCannotTake: oldJobs, activeJobs: activeJobs.size, deliveredToday: doneToday, walletsOwed: fromC(sumC(Object.values(D.getWallets() || {}), v => cents(v))) }, sockets: socks.riders },
        ads: { title: 'Ads', panels: ['/ads', '/'], deployed: panelOf('/ads').deployed, module: mods.ads ? mods.ads.loaded : null, pageViews: ph('/ads').n + ph('/').n, lastSeen: Math.max(ph('/ads').last || 0, ph('/').last || 0) || null, traffic: tr.ads, stats: { note: 'routes/ads.js exposes no business numbers to the control room, so only traffic is shown.' }, sockets: null },
        printer: { title: 'Printer', panels: ['/print'], deployed: panelOf('/print').deployed, module: mods.print ? mods.print.loaded : null, extra: mods.printInterceptor ? mods.printInterceptor.loaded : null, pageViews: ph('/print').n, lastSeen: ph('/print').last, traffic: tr.printer, stats: { note: 'routes/print.js exposes no business numbers, so only traffic is shown.' }, sockets: null },
        admin: { title: 'Admin', panels: ['/admin', '/store'], deployed: panelOf('/admin').deployed, module: mods.admin ? mods.admin.loaded : null, pageViews: ph('/admin').n + ph('/store').n + ph('/owner').n, lastSeen: Math.max(ph('/admin').last || 0, ph('/store').last || 0, ph('/owner').last || 0) || null, traffic: tr.admin,
            stats: { auditBlocks: audit.length, auditChainValid: audit.valid, adminsOnline: Math.max(socks.admins, 1) }, sockets: Math.max(socks.admins, 1) },
        core: { title: 'Server core', uptimeSeconds: Math.floor(process.uptime()), stage: D.stage, version: D.version, requestsTotal: m.total, requestsPerMin: last.req, errors5xx: m.byClass['5xx'] || 0, errorRate: Number((errRate * 100).toFixed(2)), avgMs: m.total ? Number((m.latencyMsSum / m.total).toFixed(1)) : 0, inflight: m.inflight, eventLoopLagMs: Number((D.getLag() || 0).toFixed(1)), memoryMB: Math.round(process.memoryUsage().rss / 1048576), sockets: socks.total,
            snapshot: snap, paymentsMode: D.paymentsMode, driverApprovalRequired: D.approvalRequired, testCredentials: D.testCreds }
    };
    for (const k of ['customer', 'merchant', 'driver', 'ads', 'printer', 'admin']) { const a = apps[k]; a.health = healthOf(true, a.module, a.deployed, rr(k === 'customer' ? 'user' : k)); }
    apps.core.health = (audit.valid && snap.ok !== false && errRate < 0.05) ? 'ok' : 'warn';
    for (const def of PANEL_DEFS) { const a = apps[def.key]; if (!a) continue; const st = panelState(def.key); a.switch = st; if (!st.on) a.health = 'off'; }
    // ---- the social feed reports its own numbers ----
    let social = null; try { social = D.getAdsStats ? D.getAdsStats() : null; } catch (e) { social = null; }
    if (social) { Object.assign(apps.ads.stats || (apps.ads.stats = {}), social); if (apps.ads.health === 'ok' && (social.reportsOpen > 0 || social.hidden > 0)) apps.ads.health = 'warn'; }
    // ---- the admin side (ledger, compliance engine, client registry) reports into this one control room ----
    let comp = null; try { comp = D.getComplianceView ? D.getComplianceView() : null; } catch (e) { comp = null; }
    if (comp) {
        const cs = comp.compliance, lg = comp.ledger, cl = comp.clients, crit = (cs.alertsBySeverity && cs.alertsBySeverity.CRITICAL) || 0;
        Object.assign(apps.admin.stats, { ledgerJournals: lg.journals, ledgerBalanced: lg.trialBalanced && lg.chainValid, pendingApprovals: lg.pending, complianceAlertsOpen: cs.alertsOpen, overdueFilings: cs.overdueCtr + cs.overdueStr, clients: cl.total, highRiskClients: cl.high, unverifiedActive: cl.unverifiedActive });
        if (apps.admin.health !== 'off') apps.admin.health = (!lg.chainValid || !lg.trialBalanced) ? 'down' : (cs.overdueCtr + cs.overdueStr > 0 || crit > 0 || lg.failures > 0 || cl.failures > 0) ? 'warn' : apps.admin.health;
    }

    const sk = tr, rideReq = ordersToday.filter(o => o.kind === 'RIDE').length, shopReq = ordersToday.filter(o => o.kind === 'SHOP').length, deliveredToday = all.filter(o => o.state === 'DONE' && o.completedAt >= today).length;
    const graph = {
        nodes: [
            { id: 'customer', label: 'Customers', sub: `${Object.keys(users).length} signed up`, health: apps.customer.health },
            { id: 'merchant', label: 'Shops', sub: `${activeShops} active`, health: apps.merchant.health },
            { id: 'driver', label: 'Riders', sub: `${onlineN} online`, health: apps.driver.health },
            { id: 'core', label: 'RDS server', sub: `${last.req} req/min`, health: apps.core.health },
            { id: 'admin', label: 'Admin & Compliance', sub: `${Math.max(socks.admins, 1)} online${comp ? ' · ' + comp.compliance.alertsOpen + ' alerts · ' + comp.clients.total + ' clients' : ''}`, health: apps.admin.health },
            { id: 'ads', label: 'Social & Ads', sub: social ? `${social.users} people · ${social.posts} posts${social.campaignsActive ? ' · ' + social.campaignsActive + ' ads running' : ''}${social.reportsOpen ? ' · ' + social.reportsOpen + ' reported' : ''}` : `${sk.ads.requests} requests`, health: apps.ads.health },
            { id: 'printer', label: 'Printer', sub: `${sk.printer.requests} requests`, health: apps.printer.health },
            { id: 'pay', label: 'M-Pesa', sub: D.paymentsMode === 'simulated' ? 'simulated' : 'live', health: D.paymentsMode === 'simulated' ? 'warn' : 'ok' },
            { id: 'sms', label: 'SMS codes', sub: D.smsConfigured ? 'connected' : 'not set up', health: D.smsConfigured ? 'ok' : 'warn' }
        ],
        edges: [
            { from: 'customer', to: 'core', label: `${ordersToday.length} orders today`, value: ordersToday.length },
            { from: 'core', to: 'merchant', label: `${shopReq} shop orders today · ${pendingVendor.length} waiting`, value: shopReq },
            { from: 'merchant', to: 'driver', label: `${queue.length} on radar`, value: queue.length },
            { from: 'customer', to: 'driver', label: `${rideReq} rides today`, value: rideReq },
            { from: 'driver', to: 'customer', label: `${deliveredToday} delivered today`, value: deliveredToday },
            { from: 'core', to: 'pay', label: `KES ${fin.customerPaid.toFixed(2)} paid today`, value: fin.orders },
            { from: 'core', to: 'sms', label: 'login codes', value: 1 },
            { from: 'admin', to: 'core', label: `${sk.admin.requests} admin calls`, value: sk.admin.requests },
            { from: 'ads', to: 'customer', label: `${sk.ads.requests} ad calls`, value: sk.ads.requests },
            { from: 'core', to: 'printer', label: `${sk.printer.requests} print calls`, value: sk.printer.requests }
        ]
    };
    const hourly = [];
    for (let i = 23; i >= 0; i--) { const e = Math.floor(now / HOUR) * HOUR - i * HOUR, d = all.filter(o => o.createdAt >= e && o.createdAt < e + HOUR); hourly.push({ t: e, orders: d.length, gmv: fromC(sumC(d, o => o.totalC)) }); }
    return { success: true, generatedAt: now, currency: 'KES', stage: D.stage, version: D.version,
        kpis: { ordersToday: ordersToday.length, deliveredToday, gmvToday: fin.customerPaid, platformToday: fin.platform, vatToday: fin.vat, netToday: fin.net, openOrders: apps.customer.stats.openOrders, ridersOnline: onlineN, shopsActive: activeShops, reqPerMin: last.req, complianceAlerts: comp ? comp.compliance.alertsOpen : 0, highRiskClients: comp ? comp.clients.high : 0, clientsTotal: comp ? comp.clients.total : 0 },
        compliance: comp, social, apps, graph, hourly, samples, traffic: tr, activity: activity(40), panels: panels.map(p => ({ ...p, hits: (hits[p.url] || { n: 0 }).n, last: (hits[p.url] || {}).last || null })) };
}

function activity(n) {
    const feed = (D.getActivity() || []).filter(a => a.event !== 'ops_heartbeat').slice(-n).map(a => ({ at: a.at, source: 'live', event: a.event, orderId: a.orderId, status: a.status, room: a.room }));
    let tail = []; try { tail = D.getAuditTail(n).map(b => ({ at: b.timestamp, source: 'audit', event: b.actionType })); } catch (e) {}
    return feed.concat(tail).sort((a, b) => b.at - a.at).slice(0, n);
}

function alerts() {
    const out = [], now = Date.now(), add = (sev, id, msg) => out.push({ severity: sev, id, message: msg });
    const rec = reconcile();
    rec.checks.filter(c => c.hard && !c.ok).forEach(c => add('CRITICAL', 'BOOKS_' + c.id, `Books check failed: ${c.label}. ${c.failures.length} problem(s), e.g. ${c.failures[0] ? c.failures[0].ref + ': ' + c.failures[0].detail : ''}`));
    const ov = overview(), a = ov.apps;
    if (a.core.snapshot && a.core.snapshot.ok === false) add('CRITICAL', 'SNAPSHOT', 'Saving server state is failing, so recent orders could be lost on restart.');
    for (const [k, v] of Object.entries(a)) { if (k === 'core') continue; if (v.deployed === false) add('HIGH', 'PANEL_' + k, `${v.title}: the page file is not deployed.`); if (v.module === false) add('HIGH', 'MODULE_' + k, `${v.title}: its server module did not load.`); }
    if (a.merchant.stats.oldestWaitingMin >= 10) add('HIGH', 'SHOP_SLOW', `A shop order has waited ${a.merchant.stats.oldestWaitingMin} minutes for the shop to accept it.`);
    const q = (global.driverQueue || []).filter(d => d.status === 'PENDING_DRIVER_ACCEPTANCE' && Number(d.riderPayout) > 0 && d.pinHash && d.dispatchedAt && now - d.dispatchedAt > 15 * 60000);
    if (q.length) add('HIGH', 'NO_RIDER', `${q.length} job(s) have waited over 15 minutes for a rider.`);
    if (a.driver.stats.awaitingApproval > 0) add('INFO', 'RIDERS_PENDING', `${a.driver.stats.awaitingApproval} rider(s) are waiting for document approval.`);
    if (a.merchant.stats.awaitingApproval > 0) add('INFO', 'SHOPS_PENDING', `${a.merchant.stats.awaitingApproval} shop application(s) are waiting for approval.`);
    if (a.merchant.stats.lowStock > 0) add('INFO', 'LOW_STOCK', `${a.merchant.stats.lowStock} item(s) are low or out of stock.`);
    if (a.core.errorRate > 5) add('HIGH', 'ERRORS', `${a.core.errorRate}% of requests are failing with server errors.`);
    if (a.core.eventLoopLagMs > 200) add('HIGH', 'LAG', `The server is slow to respond (event loop lag ${a.core.eventLoopLagMs} ms).`);
    if (a.core.paymentsMode === 'simulated') add('INFO', 'PAYMENTS_SIM', 'Payments and rider payouts are simulated: no real M-Pesa money moves yet.');
    try { (D.getPosture().findings || []).filter(f => ['CRITICAL', 'HIGH'].includes(f.severity)).forEach(f => add(f.severity, 'CFG_' + f.id, f.message)); } catch (e) {}
    PANEL_DEFS.forEach(def => { const st = panelState(def.key); if (!st.on) add('HIGH', 'OFF_' + def.key, `${def.title} is switched OFF${st.message ? ': ' + st.message : ''}. Users cannot use it until you switch it on.`); });
    const nOff = Object.keys(S().users || {}).length; if (nOff) add('INFO', 'USERS_OFF', `${nOff} customer account(s) are switched off.`);
    let sv = null; try { sv = D.getAdsStats ? D.getAdsStats() : null; } catch (e) {}
    if (sv && sv.campaignsInReview) add('INFO', 'ADS_REVIEW', `${sv.campaignsInReview} ad(s) waiting for your review before they can run (ADS_REQUIRE_REVIEW is on).`);
    if (sv && sv.reportsOpen) add('HIGH', 'SOCIAL_REPORTS', `${sv.reportsOpen} social post / account report(s) waiting for a moderator${sv.hidden ? ` (${sv.hidden} post(s) hidden until reviewed)` : ''}.`);
    let cv = null; try { cv = D.getComplianceView ? D.getComplianceView() : null; } catch (e) {}
    if (cv) {
        const cs = cv.compliance, lg = cv.ledger, cl = cv.clients, crit = (cs.alertsBySeverity && cs.alertsBySeverity.CRITICAL) || 0, hi = (cs.alertsBySeverity && cs.alertsBySeverity.HIGH) || 0;
        if (crit) add('CRITICAL', 'COMP_CRITICAL', `${crit} CRITICAL compliance alert(s) are open (for example a sanctions match). Open the admin console and decide on each one.`);
        if (cs.overdueCtr) add('HIGH', 'COMP_CTR_OVERDUE', `${cs.overdueCtr} cash transaction report(s) are past their filing deadline.`);
        if (cs.overdueStr) add('CRITICAL', 'COMP_STR_OVERDUE', `${cs.overdueStr} suspicious transaction report(s) are past the 2-day deadline.`);
        if (hi) add('HIGH', 'COMP_HIGH', `${hi} HIGH-severity compliance alert(s) are open.`);
        if (lg.failures) add('HIGH', 'LEDGER_FAILURES', `${lg.failures} ledger posting failure(s) recorded${lg.lastFailure ? ': ' + lg.lastFailure.kind + ' ' + lg.lastFailure.ref + ' (' + lg.lastFailure.message + ')' : ''}.`);
        if (cl.failures) add('HIGH', 'REGISTRY_FAILURES', `${cl.failures} client-registry error(s) recorded, for example: ${(cl.failuresRecent[0] || {}).message || 'see the admin console'}.`);
        if (!cl.lastScan || Date.now() - cl.lastScan.at > 15 * 60000) add('HIGH', 'REGISTRY_STALE', cl.lastScan ? 'The client registry has not scanned the platform for over 15 minutes.' : 'The client registry has not scanned the platform yet.');
        if (cl.high) add('INFO', 'CLIENTS_HIGH', `${cl.high} client(s) are rated HIGH risk.`);
        if (cl.unverifiedActive) add('INFO', 'CLIENTS_UNVERIFIED', `${cl.unverifiedActive} active client(s) have not had their ID verified.`);
        if (cl.conflicts) add('INFO', 'CLIENTS_CONFLICT', `${cl.conflicts} client(s) have conflicting identity details for an officer to resolve.`);
        if (cs.kycPending || lg.pending) add('INFO', 'APPROVALS_WAITING', `${cs.kycPending} KYC case(s) and ${lg.pending} journal(s) are waiting for a second person to approve.`);
        if (!cs.sanctionsListLoaded) add('INFO', 'SANCTIONS_NOT_LOADED', 'No sanctions list is loaded, so sanctions screening is NOT effective.');
        if (!cv.enforcement) add('HIGH', 'LIMITS_OFF', 'KYC limits at checkout are switched OFF: unverified clients can place orders of any size.');
    }
    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };
    return out.filter((x, i, arr) => arr.findIndex(y => y.id === x.id) === i).sort((x, y) => (order[x.severity] ?? 9) - (order[y.severity] ?? 9));
}


// ---------------------------------------------------------------------------
// switches and people
// ---------------------------------------------------------------------------
const clean = (v, n) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, n);
const by = (req) => (req.user && (req.user.email || req.user.sub)) || 'admin';
const fail = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });
const dirty = () => { if (D.markDirty) D.markDirty(); };

function switchesView() {
    const tr = traffic(), hits = D.getPanelHits() || {}, panels = D.getPanels() || [], mods = D.getModuleStatus() || {};
    const grp = { customer: 'user', merchant: 'merchant', driver: 'driver', ads: 'ads', printer: 'printer', admin: 'admin' };
    const modKey = { customer: 'user', merchant: 'merchants', driver: 'driver', ads: 'ads', printer: 'print', admin: 'admin' };
    return {
        panels: PANEL_DEFS.map(def => {
            const st = panelState(def.key), t = tr[grp[def.key]] || { requests: 0, errors: 0, avgMs: 0 };
            const views = def.pages.reduce((s, p) => s + ((hits[p] || {}).n || 0), 0), last = Math.max(0, ...def.pages.map(p => (hits[p] || {}).last || 0)) || null;
            const pg = panels.find(p => p.url === def.pages[0]) || {};
            return { key: def.key, title: def.title, pages: def.pages, on: st.on, message: st.message, switchedAt: st.at, switchedBy: st.by, requests: t.requests, errors: t.errors, avgMs: t.avgMs, pageViews: views, lastSeen: last, deployed: pg.deployed === undefined ? null : pg.deployed, moduleLoaded: mods[modKey[def.key]] ? mods[modKey[def.key]].loaded : null };
        }),
        customersOff: Object.entries(S().users || {}).map(([userId, v]) => ({ userId, ...v }))
    };
}
function customers(q) {
    const users = D.getUsers() || {}, sw = S().users || {}, all = orders(), stat = {};
    for (const o of all) { if (!o.userId || o.userId === 'ANONYMOUS') continue; const s = stat[o.userId] || (stat[o.userId] = { orders: 0, delivered: 0, open: 0, spentC: 0, last: 0 }); s.orders++; if (o.state === 'DONE') { s.delivered++; s.spentC += o.totalC; } if (o.state === 'OPEN') s.open++; s.last = Math.max(s.last, o.createdAt || 0); }
    const ids = new Set([...Object.keys(users), ...Object.keys(sw), ...Object.keys(stat)]), needle = String(q || '').toLowerCase();
    return [...ids].map(id => { const u = users[id] || {}, s = stat[id] || { orders: 0, delivered: 0, open: 0, spentC: 0, last: 0 }, off = has(sw, id);
        return { userId: id, phone: u.phone || (sw[id] && sw[id].phone) || '', joinedAt: u.verifiedAt || null, orders: s.orders, delivered: s.delivered, openOrders: s.open, spent: fromC(s.spentC), lastOrderAt: s.last || null, active: !off, reason: off ? sw[id].reason : null, switchedAt: off ? sw[id].at : null };
    }).filter(c => !needle || c.userId.toLowerCase().includes(needle) || String(c.phone).toLowerCase().includes(needle)).sort((a, b) => (b.lastOrderAt || b.joinedAt || 0) - (a.lastOrderAt || a.joinedAt || 0)).slice(0, 200);
}
function riders(q) {
    const drivers = D.getDrivers() || {}, pres = D.getPresence() || {}, wallets = D.getWallets() || {}, ledger = D.getLedger() || [], needle = String(q || '').toLowerCase(), docs = D.getDriverDocs ? D.getDriverDocs() : {};
    const trips = {}, earned = {}; for (const e of ledger) { trips[e.driverId] = (trips[e.driverId] || 0) + 1; earned[e.driverId] = (earned[e.driverId] || 0) + cents(e.credited); }
    return Object.values(drivers).map(d => { const st = d.standing || 'PENDING', working = st === 'APPROVED' || (!D.approvalRequired && st !== 'SUSPENDED' && st !== 'REJECTED');
        return { driverId: d.id, name: d.name, phone: d.phone, vehicle: d.vehicleType === 'CAR' || d.vehicleType === 'CAB' ? 'Cab' : 'Boda', plate: d.plate, status: st, active: working, online: !!(pres[d.id] && pres[d.id].online), docsOnFile: has(docs, d.id) || d.reviewedBy === 'TEST_ACCOUNT', trips: trips[d.id] || 0, earned: fromC(earned[d.id] || 0), wallet: fromC(cents(wallets[d.id] || 0)), reviewNote: d.reviewNote || null };
    }).filter(r => !needle || String(r.name).toLowerCase().includes(needle) || String(r.phone).includes(needle) || String(r.driverId).toLowerCase().includes(needle)).sort((a, b) => (b.online - a.online) || (b.trips - a.trips)).slice(0, 200);
}
function shops(q) {
    const profiles = global.merchantProfiles || {}, catalogs = global.merchantCatalogs || {}, mo = global.merchantOrders || {}, all = orders(), needle = String(q || '').toLowerCase(), stat = {};
    for (const o of all) { if (!o.merchantId) continue; const s = stat[o.merchantId] || (stat[o.merchantId] = { orders: 0, salesC: 0 }); s.orders++; if (o.state === 'DONE') s.salesC += o.itemsC; }
    return Object.keys(profiles).map(id => { const p = profiles[id], list = catalogs[id] || [], waiting = (mo[id] || []).filter(o => o.status === 'PENDING_VENDOR_ACCEPTANCE').length, s = stat[id] || { orders: 0, salesC: 0 };
        return { merchantId: id, name: p.shopName, type: p.businessType, phone: p.phone, active: D.isTenantActive(id), orders: s.orders, sales: fromC(s.salesC), items: list.length, lowStock: list.filter(i => i.stock !== undefined && i.stock !== null && Number(i.stock) <= 5).length, waiting };
    }).filter(s => !needle || String(s.name).toLowerCase().includes(needle) || s.merchantId.toLowerCase().includes(needle) || String(s.phone).includes(needle));
}

router.use((req, res, next) => {
    if (!D.verifyToken || !D.requireAdmin) return fail(res, 'Master control is starting.', 503);
    D.verifyToken(req, res, () => D.requireAdmin(req, res, next));
});
const ownerOnly = (req, res, next) => (D.requireSovereign ? D.requireSovereign(req, res, next) : fail(res, 'Master control is starting.', 503));

router.get('/overview', (req, res) => res.json({ ...overview(), switches: switchesView() }));
router.get('/finance', (req, res) => res.json(finance()));
router.get('/reconcile', (req, res) => res.json({ success: true, ...reconcile() }));
router.get('/alerts', (req, res) => res.json({ success: true, generatedAt: Date.now(), alerts: alerts() }));
router.get('/switches', (req, res) => res.json({ success: true, ...switchesView() }));
router.get('/compliance', (req, res) => { let v = null; try { v = D.getComplianceView ? D.getComplianceView() : null; } catch (e) {} res.json({ success: true, available: !!v, compliance: v }); });
router.post('/compliance/enforcement', ownerOnly, (req, res) => {
    const b = req.body || {}; if (typeof b.on !== 'boolean') return fail(res, 'on must be true or false.');
    if (!D.setEnforcement) return fail(res, 'The compliance engine is not running on this server.', 501);
    D.setEnforcement(b.on); if (D.appendAudit) D.appendAudit('MASTER_KYC_LIMITS_SWITCH', { on: b.on, by: by(req) }); dirty();
    res.json({ success: true, message: `KYC limits at checkout are now ${b.on ? 'ON' : 'OFF'}.`, enforcement: b.on });
});
router.get('/people/customers', (req, res) => res.json({ success: true, customers: customers(req.query.q) }));
router.get('/people/riders', (req, res) => res.json({ success: true, riders: riders(req.query.q) }));
router.get('/people/shops', (req, res) => res.json({ success: true, shops: shops(req.query.q) }));

function setPanel(key, on, message, who) {
    const sw = S(); if (!sw.panels) sw.panels = {};
    sw.panels[key] = { on: !!on, message: on ? '' : clean(message, 200), at: Date.now(), by: who };
    if (D.appendAudit) D.appendAudit('MASTER_PANEL_SWITCH', { panel: key, on: !!on, by: who });
    if (D.emitSafe) D.emitSafe(null, 'panel_status', { panel: key, on: !!on });
}
router.post('/panels/set', ownerOnly, (req, res) => {
    const b = req.body || {}, def = PANEL_DEFS.find(p => p.key === b.panel);
    if (!def) return fail(res, `panel must be one of ${PANEL_DEFS.map(p => p.key).join(', ')}.`);
    if (typeof b.on !== 'boolean') return fail(res, 'on must be true or false.');
    setPanel(def.key, b.on, b.message, by(req)); dirty();
    res.json({ success: true, message: `${def.title} is now ${b.on ? 'ON' : 'OFF'}.`, ...switchesView() });
});
router.post('/panels/all', ownerOnly, (req, res) => {
    const b = req.body || {}; if (typeof b.on !== 'boolean') return fail(res, 'on must be true or false.');
    PANEL_DEFS.filter(p => p.key !== 'admin').forEach(p => setPanel(p.key, b.on, b.message || 'Emergency stop by the owner.', by(req))); dirty();
    res.json({ success: true, message: b.on ? 'Customer, shop, rider, ads and printer panels are ON.' : 'Emergency stop: customer, shop, rider, ads and printer panels are OFF. Admin and master control stay on.', ...switchesView() });
});
router.post('/people/customers/set', ownerOnly, (req, res) => {
    const b = req.body || {}; if (typeof b.active !== 'boolean') return fail(res, 'active must be true or false.');
    let id = typeof b.userId === 'string' ? b.userId : '';
    if (!id && typeof b.phone === 'string' && D.normalizePhone) id = 'USR_' + D.normalizePhone(b.phone).replace(/[^0-9]/g, '');
    if (!/^USR_[0-9]{6,15}$/.test(id)) return fail(res, 'Give a valid userId or phone number.');
    const sw = S(); if (!sw.users) sw.users = {};
    const users = D.getUsers() || {};
    if (!b.active) sw.users[id] = { reason: clean(b.reason, 200) || 'Switched off by the owner', at: Date.now(), by: by(req), phone: (users[id] && users[id].phone) || clean(b.phone, 20) || '' };
    else delete sw.users[id];
    if (D.appendAudit) D.appendAudit('MASTER_CUSTOMER_SWITCH', { userId: id, active: b.active, by: by(req) });
    if (D.emitSafe) D.emitSafe('user:' + id, 'account_status', { active: b.active }); dirty();
    res.json({ success: true, message: `Customer ${id} is now ${b.active ? 'ON' : 'OFF'}.`, userId: id, active: b.active });
});
router.post('/people/riders/set', ownerOnly, (req, res) => {
    const b = req.body || {}, drivers = D.getDrivers() || {};
    if (typeof b.active !== 'boolean' || !has(drivers, b.driverId)) return fail(res, 'Give a valid driverId and active true or false.');
    const d = drivers[b.driverId], docs = D.getDriverDocs ? D.getDriverDocs() : {};
    if (b.active && d.standing !== 'APPROVED' && !(has(docs, d.id) || d.reviewedBy === 'TEST_ACCOUNT')) return fail(res, 'This rider has no documents on file. Review the documents before switching the rider on.', 409);
    d.standing = b.active ? 'APPROVED' : 'SUSPENDED'; d.documentsReviewed = true; d.reviewedAt = Date.now(); d.reviewedBy = by(req); d.reviewNote = b.active ? null : (clean(b.reason, 200) || 'Switched off by the owner'); d.verificationStatus = d.standing;
    if (!b.active && D.getPresence()[d.id]) D.getPresence()[d.id].online = false;
    const activeJob = [...(global.driverQueue || []), ...Object.values(global.activeDispatches || {}).flat()].some(x => x.driverId === d.id && x.status === 'ACCEPTED_BY_DRIVER');
    if (D.appendAudit) D.appendAudit('MASTER_RIDER_SWITCH', { driverId: d.id, active: b.active, by: by(req) });
    if (D.emitSafe) D.emitSafe('drivers', 'driver_standing_changed', { driverId: d.id, standing: d.standing }); dirty();
    res.json({ success: true, message: `${d.name} is now ${b.active ? 'ON' : 'OFF'}.${!b.active && activeJob ? ' They still hold an active job: reassign or cancel it.' : ''}`, driverId: d.id, active: b.active, activeJob });
});
router.post('/people/shops/set', ownerOnly, (req, res) => {
    const b = req.body || {}, profiles = global.merchantProfiles || {};
    if (typeof b.active !== 'boolean' || !has(profiles, b.merchantId)) return fail(res, 'Give a valid merchantId and active true or false.');
    const cs = D.getCorridor(); cs[b.merchantId] = b.active ? 'APPROVED_ACTIVE' : 'SUSPENDED';
    if (b.active && (profiles[b.merchantId].status === 'SUSPENDED' || profiles[b.merchantId].status === 'REVOKED')) profiles[b.merchantId].status = 'APPROVED';
    if (D.appendAudit) D.appendAudit('MASTER_SHOP_SWITCH', { merchantId: b.merchantId, active: b.active, by: by(req) });
    if (D.emitSafe) D.emitSafe(b.merchantId, 'tenant_status_changed', { merchantId: b.merchantId, status: cs[b.merchantId] }); dirty();
    res.json({ success: true, message: `${profiles[b.merchantId].shopName} is now ${b.active ? 'ON' : 'OFF'}.`, merchantId: b.merchantId, active: b.active });
});

function resetPreview() {
    const all = orders(), ledger = D.getLedger() || [], payouts = D.getPayouts() || [];
    return { orders: all.length, open: all.filter(o => o.state === 'OPEN').length, cancelled: all.filter(o => o.state === 'CANCELLED').length, delivered: all.filter(o => o.state === 'DONE').length,
        heldForOpenOrders: fromC(sumC(all.filter(o => o.state === 'OPEN'), o => o.totalC)), jobsOnRadar: (global.driverQueue || []).length, riderEarningsRecords: ledger.length, payoutRecords: payouts.length,
        ratings: (D.getRatings() || []).length, walletsTotal: fromC(sumC(Object.values(D.getWallets() || {}), v => cents(v))), paymentsMode: D.paymentsMode, canReset: D.paymentsMode === 'simulated', phrase: 'RESET TEST DATA' };
}
router.get('/maintenance/preview', (req, res) => res.json({ success: true, ...resetPreview() }));
router.post('/maintenance/reset-test-data', ownerOnly, (req, res) => {
    if (D.paymentsMode !== 'simulated') return fail(res, 'Real payments are switched on, so records cannot be cleared here.', 409);
    if (!req.body || req.body.confirm !== 'RESET TEST DATA') return fail(res, 'Type RESET TEST DATA to confirm.');
    if (typeof D.resetTestData !== 'function') return fail(res, 'Clearing test data is not available on this server.', 501);
    const before = resetPreview(), r = D.resetTestData();
    if (D.appendAudit) D.appendAudit('MASTER_RESET_TEST_DATA', { by: by(req), orders: before.orders, ledger: before.riderEarningsRecords });
    dirty();
    res.json({ success: true, message: `Cleared ${before.orders} test orders, ${before.riderEarningsRecords} rider earnings and all wallets. Customers, riders, shops, products and switches were kept.${r.backup ? ' A backup of the old state was saved.' : ''}`, cleared: before, backup: r.backup });
});

return { router, _test: { resetPreview, orders, reconcile, finance, overview, alerts, vatOfC, cents, customers, riders, shops, switchesView, clearCache: () => { auditCache = { at: 0, v: null }; } } };
})();

router.use('/master', MASTER.router);

module.exports = router;
module.exports.init = init;
module.exports.gate = gate;
module.exports.priceGuard = priceGuard;
module.exports.PRICING = PRICING;
module.exports.PANEL_DEFS = PANEL_DEFS;
module.exports._test = MASTER._test;