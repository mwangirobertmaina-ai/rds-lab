const express = require('express');
const router = express.Router();

// ============================================================================
// HARDENED: this module no longer owns any state or crypto of its own.
// server.js injects the shared auth middleware, the ONE tamper-evident audit
// chain and the shared stores via router.init(ctx). Until init() runs, every
// route fails closed with 503 (previously: fully open, with a private,
// unlinked audit array that diverged from the server's ledger).
// ============================================================================
let ctx = null;

router.init = function init(deps) {
    const required = ['verifyToken', 'requireAdmin', 'requireSuperAdmin', 'appendAudit', 'verifyAuditChain', 'state'];
    const missing = required.filter(k => !deps || !deps[k]);
    if (missing.length) throw new Error(`admin router init missing: ${missing.join(', ')}`);
    ctx = deps;
};

router.use((req, res, next) => {
    if (!ctx) return res.status(503).json({ success: false, error: "Admin module not initialised." });
    next();
});
router.use((req, res, next) => ctx.verifyToken(req, res, next)); // 401 without a valid signed token

const adminOnly = (req, res, next) => ctx.requireAdmin(req, res, next);          // admin or auditor (read)
const superOnly = (req, res, next) => ctx.requireSuperAdmin(req, res, next);     // SOVEREIGN_ADMIN (write)

const TENANT_STATUSES = ['APPROVED_ACTIVE', 'SUSPENDED', 'REVOKED'];
const BASE_CORRIDORS = [
    { id: "INST-CBK-RTGS", name: "Central Bank of Kenya", type: "CENTRAL_BANK", currency: "KES", status: "APPROVED_ACTIVE" },
    { id: "INST-MPESA", name: "M-Pesa Mobile Money Hub", type: "MOBILE_MONEY", currency: "KES", status: "APPROVED_ACTIVE" },
    { id: "INST-EQUITY", name: "Equity Bank Commercial Node", type: "COMMERCIAL_BANK", currency: "KES", status: "APPROVED_ACTIVE" }
];
const isSafeKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+-]{1,80}$/.test(v) &&
    !['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'].includes(v);
const clean = (v, max = 120) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, '').trim().substring(0, max);
const fail = (res, code, msg) => res.status(code).json({ success: false, error: msg });

// Auditors are read-only and don't need full national ID numbers
function maskId(id) {
    const s = String(id || '');
    return s.length <= 3 ? '***' : '*'.repeat(s.length - 3) + s.slice(-3);
}

router.get('/dashboard', adminOnly, (req, res) => {
    res.json({ success: true, message: "Admin active" });
});

router.get('/status', adminOnly, (req, res) => {
    res.json({ success: true, status: 'Operational', securityKernel: 'Active' });
});

router.get('/compliance-dashboard', adminOnly, (req, res) => {
    const s = ctx.state();
    const isAuditor = req.user.role !== 'SOVEREIGN_ADMIN';
    const corridorStatus = ctx.corridorStatus || {};
    res.json({
        success: true,
        localIdVerificationsCount: s.verifications.length,
        transactionsCount: s.transactions.length,
        lanTrafficLogsCount: s.lanTrafficLogs.length,
        // Static placeholders: no engine backs these yet (flagged, values unchanged)
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
        verifications: isAuditor ? s.verifications.map(v => ({ ...v, nationalIdNumber: maskId(v.nationalIdNumber) })) : s.verifications,
        transactions: s.transactions,
        corridors: BASE_CORRIDORS.map(c => ({ ...c, status: corridorStatus[c.id] || c.status }))
    });
});

router.get('/lan-traffic-logs', adminOnly, (req, res) => {
    res.json({ success: true, lanTrafficLogs: ctx.state().lanTrafficLogs });
});

router.get('/sovereign-vault', adminOnly, (req, res) => {
    const stream = ctx.state().auditStream;
    // Optional paging (?offset=&limit=). No params => full chain, as before.
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const limit = Math.min(parseInt(req.query.limit, 10) || stream.length, 5000);
    res.json({ success: true, total: stream.length, vaultBlocks: stream.slice(offset, offset + limit) });
});

// ============================================================================
// --- FULLY ACTIVATED TENANT OWNER MANAGEMENT ENDPOINTS ---
// ============================================================================
router.get('/tenants', adminOnly, (req, res) => {
    try {
        const mProfiles = global.merchantProfiles || {};
        const tenantsList = Object.keys(mProfiles).map(id => ({
            merchantId: id,
            shopName: mProfiles[id].shopName || "Independent Shop",
            businessType: mProfiles[id].businessType || "GENERAL",
            phone: mProfiles[id].phone || "+254712345678",
            status: mProfiles[id].status || "APPROVED_ACTIVE"
        }));
        res.json({ success: true, tenants: tenantsList });
    } catch (err) {
        console.error('[admin/tenants]', err);
        res.status(500).json({ success: false, error: "Internal error." });
    }
});

router.post('/toggle-tenant-status', superOnly, (req, res) => {
    const { tenantId } = req.body;
    const status = req.body.status || 'SUSPENDED'; // original default preserved
    if (!isSafeKey(tenantId)) return fail(res, 400, "Valid tenantId required.");
    if (!TENANT_STATUSES.includes(status)) return fail(res, 400, `status must be one of ${TENANT_STATUSES.join(', ')}.`);

    const isMerchant = !!(global.merchantProfiles && Object.prototype.hasOwnProperty.call(global.merchantProfiles, tenantId));
    const isCorridor = BASE_CORRIDORS.some(c => c.id === tenantId);
    // HARDENED: previously reported success even for tenants that don't exist
    if (!isMerchant && !isCorridor) return fail(res, 404, "Tenant not found.");

    const previous = isMerchant ? (global.merchantProfiles[tenantId].status || 'APPROVED_ACTIVE') : ((ctx.corridorStatus || {})[tenantId] || 'APPROVED_ACTIVE');
    if (isMerchant) global.merchantProfiles[tenantId].status = status;
    if (isCorridor && ctx.corridorStatus) ctx.corridorStatus[tenantId] = status;

    // HARDENED: goes into the shared hash chain, with actor and before/after state
    ctx.appendAudit('TENANT_STATUS_TOGGLE', { tenantId, previousStatus: previous, newStatus: status, by: req.user.email || req.user.sub });

    res.json({ success: true, message: `Tenant ${tenantId} status successfully updated to ${status}.` });
});

router.post('/request-tenant-corridor', (req, res) => {
    const { businessName } = req.body;
    if (!businessName || typeof businessName !== 'string') return fail(res, 400, "businessName is required.");
    const record = {
        requestId: `CORR_${Date.now()}`,
        businessName: clean(businessName),
        requestedBy: req.user.email || req.user.sub,
        status: 'PENDING_OWNER_APPROVAL',
        createdAt: Date.now()
    };
    if (Array.isArray(ctx.corridorRequests)) ctx.corridorRequests.push(record);
    ctx.appendAudit('TENANT_CORRIDOR_REQUEST', record);
    res.json({ success: true, message: `Tenant corridor request for "${record.businessName}" submitted successfully for owner approval.` });
});

module.exports = router;