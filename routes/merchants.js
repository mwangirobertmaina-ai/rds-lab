'use strict';
// ============================================================================
// routes/merchants.js — STAGE 191 MERCHANT EXTENSION (additive; loaded by server.js)
//
// server.js keeps its own inline /api/merchant routes (register, approve, login,
// catalog, orders, accept, reject, handover, stats, profile, bulk-stock, CSV).
// This file adds two safety hooks that run around the inline handlers:
//
//   1. handoverGuard : blocks POST /api/merchant/orders/complete-handover unless
//                      the order was accepted first and is not cancelled. Before
//                      this, a shop could mark a never-accepted order complete.
//   2. stockOnAccept : after a successful POST /api/merchant/orders/accept it
//                      deducts the ordered quantities from the shop's catalogue
//                      stock (by item id; by exact name for older orders), once
//                      per order, and builds the rider's job from the customer's order
//                      (address, coordinates, rider payout, delivery PIN hash).
//
// Uses only globals that server.js publishes (merchantOrders, merchantCatalogs).
// No routes are mounted from here; the exported router is empty on purpose.
// ============================================================================
const express = require('express');
const router = express.Router();
let D = {};
function init(deps) { D = deps || {}; }

const DEFAULT_MERCHANT = 'MERCH_DEF_172';
const CANCELLED = new Set(['CANCELLED_BY_CUSTOMER', 'REJECTED_BY_VENDOR', 'ORDERLY_DISMISSED', 'CANCELLED']);
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];
const isSafeKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,80}$/.test(v) && !PROTO_KEYS.includes(v);
const ordersOf = (id) => (global.merchantOrders && Object.prototype.hasOwnProperty.call(global.merchantOrders, id) ? global.merchantOrders[id] : []) || [];

// Same defaulting as the inline handlers: missing merchantId => the default shop.
function targetMerchant(req) {
    const b = req.body || {};
    const v = (b.merchantId === undefined || b.merchantId === null || b.merchantId === '') ? DEFAULT_MERCHANT : b.merchantId;
    return isSafeKey(v) ? String(v) : null;
}

function handoverGuard(req, res, next) {
    const merchantId = targetMerchant(req);
    const orderId = req.body && req.body.orderId;
    if (!merchantId || !isSafeKey(orderId)) return next();          // inline handler returns its own validation error
    const order = ordersOf(merchantId).find(o => o && o.orderId === orderId);
    if (!order) return next();                                      // inline handler returns its own 404
    if (CANCELLED.has(order.status)) {
        return res.status(409).json({ success: false, error: 'This order was cancelled and cannot be handed over.' });
    }
    if (order.status === 'PENDING_VENDOR_ACCEPTANCE') {
        return res.status(409).json({ success: false, error: 'Accept the order before handing it over.' });
    }
    next();
}

function stockOnAccept(req, res, next) {
    const merchantId = targetMerchant(req);
    const orderId = req.body && req.body.orderId;
    res.on('finish', () => {
        try {
            if (res.statusCode !== 200 || !merchantId || !isSafeKey(orderId)) return;
            const order = ordersOf(merchantId).find(o => o && o.orderId === orderId);
            if (!order || order.stockDeducted) return;
            const catalogs = global.merchantCatalogs || {};
            const catalog = Object.prototype.hasOwnProperty.call(catalogs, merchantId) ? catalogs[merchantId] : null;
            if (!Array.isArray(catalog)) return;
            for (const it of (Array.isArray(order.items) ? order.items : [])) {
                const qty = Math.max(1, Math.floor(Number(it && it.qty) || 1));
                const stockItem = it && it.id
                    ? catalog.find(c => c && c.id === it.id)
                    : catalog.find(c => c && String(c.name).toLowerCase() === String((it && it.name) || '').toLowerCase());
                if (stockItem && stockItem.stock !== undefined && Number.isFinite(Number(stockItem.stock))) {
                    stockItem.stock = Math.max(0, Number(stockItem.stock) - qty);
                }
            }
            order.stockDeducted = true;
            // Hand the rider's job everything it needs, taken from the CUSTOMER's order record.
            // The inline accept route hard-codes "Customer Dropoff Point"; the PIN hash and customer phone
            // never pass through the merchant's own order record.
            const refs = D.findOrderRefs191 ? D.findOrderRefs191(orderId) : null;
            const src = refs && refs.active[0] && refs.active[0].order;
            if (src) {
                const patch = {
                    destination: src.destination, destinationCoords: src.destinationCoords, pickupCoords: src.pickupCoords,
                    vehicleType: src.vehicleType, distanceKm: src.distanceKm, etaMin: src.etaMin, merchantId,
                    deliveryFee: src.breakdown && src.breakdown.deliveryFee, riderPayout: src.breakdown && src.breakdown.riderShare,
                    customerPhone: src.customerPhone, pinSalt: src.pinSalt, pinHash: src.pinHash
                };
                Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);
                const touch = (d) => { if (d && d.id === orderId) Object.assign(d, patch); };
                (global.driverQueue || []).forEach(touch);
                Object.values(global.activeDispatches || {}).forEach(list => (list || []).forEach(touch));
            }
        } catch (e) { /* never let a hook break a response */ }
    });
    next();
}

module.exports = router;
module.exports.handoverGuard = handoverGuard;
module.exports.stockOnAccept = stockOnAccept;
module.exports.init = init;