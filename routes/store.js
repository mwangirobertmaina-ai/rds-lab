'use strict';
// ============================================================================
// routes/store.js — STAGE 191 STORE EXTENSION (additive; loaded by server.js)
//
// What this file does (server.js keeps its own inline /api/store routes):
//   1. priceGuard  : runs BEFORE the inline POST /api/store/checkout. It rebuilds
//                    itemsTotal from the real catalogue prices, so a customer can
//                    no longer send itemsTotal: 1 for a 15,000 KES room. It also
//                    enforces: non-empty cart, qty 1-99, one shop per order, live
//                    stock, shop not suspended.
//   2. POST /quote : public, authoritative price preview. Uses the SAME formulas
//                    as the inline checkout, so what the customer sees is what
//                    the server charges.
//
// It only uses globals that server.js already publishes (merchantCatalogs,
// merchantProfiles, corridorStatus). No new npm packages.
// KEEP IN SYNC: BUILTIN below mirrors storeProducts in server.js.
// ============================================================================
const express = require('express');
const router = express.Router();

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
    const kraTax = systemIncome * P.kraRate;
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

module.exports = router;
module.exports.priceGuard = priceGuard;
module.exports.PRICING = PRICING;