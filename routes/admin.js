const express = require('express');
const router = express.Router();

// ============================================================================
// HARDENED admin router.
// This module holds NO security logic or state of its own. server.js injects the
// strict auth middlewares, the tamper-evident audit chain and the live state via
// router.configure(...). Until configured, every route FAILS CLOSED with 503, so
// mounting it by mistake can never expose an unauthenticated admin surface.
// ============================================================================

let ctx = null;

router.configure = function configure(deps) {
    const required = ['authenticate', 'requireAdmin', 'requireOwner', 'appendAudit', 'verifyAuditChain', 'getState', 'isSafeKey'];
    const missing = required.filter(k => typeof deps[k] !== 'function');
    if (missing.length) throw new Error(`admin router misconfigured, missing: ${missing.join(', ')}`);
    ctx = deps;
};

// Fail closed if not configured
router.use((req, res, next) => {
    if (!ctx) return res.status(503).json({ success: false, error: 'Admin module not configured.' });
    next();
});

// Every route below requires a valid signed token (dynamic dispatch so the injected functions are used)
router.use((req, res, next) => ctx.authenticate(req, res, next));

const readOnly = (req, res, next) => ctx.requireAdmin(req, res, next);   // admin or auditor
const ownerOnly = (req, res, next) => ctx.requireOwner(req, res, next);  // sovereign admin only (writes)

const TENANT_STATUSES = ['APPROVED_ACTIVE', 'APPROVED', 'SUSPENDED', 'REVOKED'];
const fail = (res, code, msg) => res.status(code).json({ success: false, error: msg });
const serverError = (res, err) => {
    console.error('[ADMIN]', err && err.stack ? err.stack : err);
    return fail(res, 500, process.env.NODE_ENV === 'production' ? 'Internal server error.' : err.message);
};

router.get('/dashboard', readOnly, (req, res) => {
    res.json({ success: true, message: "Admin active" });
});

router.get('/status', readOnly, (req, res) => {
    const integrity = ctx.verifyAuditChain();
    res.json({
        success: true,
        status: integrity.valid ? 'Operational' : 'DEGRADED_AUDIT_INTEGRITY',
        securityKernel: 'Active',
        auditChain: integrity
    });
});

router.get('/compliance-dashboard', readOnly, (req, res) => {
    const s = ctx.getState();
    const baseCorridors = [
        { id: "INST-CBK-RTGS", name: "Central Bank of Kenya", type: "CENTRAL_BANK", currency: "KES", status: "APPROVED_ACTIVE" },
        { id: "INST-MPESA", name: "M-Pesa Mobile Money Hub", type: "MOBILE_MONEY", currency: "KES", status: "APPROVED_ACTIVE" },
        { id: "INST-EQUITY", name: "Equity Bank Commercial Node", type: "COMMERCIAL_BANK", currency: "KES", status: "APPROVED_ACTIVE" }
    ];
    res.json({
        success: true,
        localIdVerificationsCount: s.verifications.length,
        transactionsCount: s.transactions.length,
        lanTrafficLogsCount: s.lanTrafficLogs.length,
        // Static placeholders (no engine behind them yet); flagged so nobody reads them as live data
        aiApprovedIntentsCount: 12,
        shadowTrapsCount: 2,
        makerCheckerCount: 4,
        sarQueueCount: 0,
        posWebhooksCount: 5,
        didPassesCount: 8,
        compliancePushCount: 3,
        placeholderMetrics: ["aiApprovedIntentsCount", "shadowTrapsCount", "makerCheckerCount", "sarQueueCount", "posWebhooksCount", "didPassesCount", "compliancePushCount"],
        vaultBlocksCount: s.auditStream.length,
        auditChainValid: ctx.verifyAuditChain().valid,
        verifications: s.verifications,
        transactions: s.transactions,
        corridors: baseCorridors.map(c => ({ ...c, status: (s.corridorStatus && s.corridorStatus[c.id]) || c.status }))
    });
});

router.get('/lan-traffic-logs', readOnly, (req, res) => {
    res.json({ success: true, lanTrafficLogs: ctx.getState().lanTrafficLogs });
});

router.get('/sovereign-vault', readOnly, (req, res) => {
    res.json({ success: true, vaultBlocks: ctx.getState().auditStream });
});

// ============================================================================
// --- FULLY ACTIVATED TENANT OWNER MANAGEMENT ENDPOINTS ---
// ============================================================================
router.get('/tenants', readOnly, (req, res) => {
    try {
        const mProfiles = global.merchantProfiles || {};
        const tenantsList = Object.keys(mProfiles).map(id => ({
            merchantId: id,
            shopName: mProfiles[id].shopName || "Independent Shop",
            businessType: mProfiles[id].businessType || "GENERAL",
            phone: mProfiles[id].phone || "+254712345678",
            status: mProfiles[id].status || "APPROVED_ACTIVE"
            // loginToken, passport and other PII are deliberately never returned
        }));
        res.json({ success: true, tenants: tenantsList });
    } catch (err) {
        serverError(res, err);
    }
});

router.post('/toggle-tenant-status', ownerOnly, (req, res) => {
    const { tenantId, status } = req.body || {};
    // Original: status defaulted to SUSPENDED when omitted, any string was accepted, and it
    // reported success even for tenants that do not exist. Now all three are rejected.
    if (!ctx.isSafeKey(tenantId)) return fail(res, 400, 'Valid tenantId is required.');
    if (!TENANT_STATUSES.includes(status)) return fail(res, 400, `status must be one of ${TENANT_STATUSES.join(', ')}.`);

    const profiles = global.merchantProfiles || {};
    if (!Object.prototype.hasOwnProperty.call(profiles, tenantId)) return fail(res, 404, 'Tenant not found.');

    const previousStatus = profiles[tenantId].status || 'APPROVED_ACTIVE';
    profiles[tenantId].status = status;

    // Goes through the shared hash chain (previousHash-linked, persisted) instead of a private unlinked array
    ctx.appendAudit('TENANT_STATUS_TOGGLE', {
        tenantId, previousStatus, newStatus: status, by: req.user.email || req.user.sub
    });

    res.json({ success: true, message: `Tenant ${tenantId} status successfully updated to ${status}.`, previousStatus });
});

router.post('/request-tenant-corridor', ownerOnly, (req, res) => {
    const { businessName } = req.body || {};
    if (typeof businessName !== 'string' || !businessName.trim()) return fail(res, 400, 'businessName is required.');
    const name = businessName.replace(/[<>\u0000-\u001f]/g, '').trim().substring(0, 120);

    const record = { requestId: `CORR_${Date.now()}`, businessName: name, requestedBy: req.user.email || req.user.sub, status: 'PENDING_OWNER_APPROVAL' };
    ctx.appendAudit('TENANT_CORRIDOR_REQUEST', record);
    res.json({ success: true, message: `Tenant corridor request for "${name}" submitted successfully for owner approval.`, requestId: record.requestId });
});

module.exports = router;