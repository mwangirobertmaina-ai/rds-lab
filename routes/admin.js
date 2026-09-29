const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// In-memory state for admin / sovereign operations
let sovereignVerifications = [];
let sovereignTransactions = [];
let sovereignAuditStream = [];
let lanTrafficLogs = [
    { timestamp: new Date().toLocaleTimeString(), clientIp: "127.0.0.1", method: "GET", endpoint: "/api/admin/dashboard", status: "200 OK" }
];
let connectedPeripheralsList = [
    { peripheralId: "PERIPH_CAM_01", deviceType: "Biometric Face Camera", connectionMode: "Wired USB 3.0", docHashSnippet: "e3b0c442...98fc1c14", timestamp: Date.now() },
    { peripheralId: "PERIPH_POS_02", deviceType: "NFC Terminal Reader", connectionMode: "Bluetooth BLE", docHashSnippet: "8f434346...1a2b3c4d", timestamp: Date.now() }
];

router.get('/dashboard', (req, res) => {
    res.json({ success: true, message: "Admin active" });
});

router.get('/status', (req, res) => {
    res.json({ success: true, status: 'Operational', securityKernel: 'Active' });
});

router.get('/compliance-dashboard', (req, res) => {
    res.json({
        success: true,
        localIdVerificationsCount: sovereignVerifications.length,
        transactionsCount: sovereignTransactions.length,
        lanTrafficLogsCount: lanTrafficLogs.length,
        aiApprovedIntentsCount: 12,
        shadowTrapsCount: 2,
        makerCheckerCount: 4,
        sarQueueCount: 0,
        posWebhooksCount: 5,
        didPassesCount: 8,
        compliancePushCount: 3,
        vaultBlocksCount: sovereignAuditStream.length,
        verifications: sovereignVerifications,
        transactions: sovereignTransactions,
        corridors: [
            { id: "INST-CBK-RTGS", name: "Central Bank of Kenya", type: "CENTRAL_BANK", currency: "KES", status: "APPROVED_ACTIVE" },
            { id: "INST-MPESA", name: "M-Pesa Mobile Money Hub", type: "MOBILE_MONEY", currency: "KES", status: "APPROVED_ACTIVE" },
            { id: "INST-EQUITY", name: "Equity Bank Commercial Node", type: "COMMERCIAL_BANK", currency: "KES", status: "APPROVED_ACTIVE" }
        ]
    });
});

router.get('/lan-traffic-logs', (req, res) => {
    res.json({ success: true, lanTrafficLogs });
});

router.get('/sovereign-vault', (req, res) => {
    res.json({ success: true, vaultBlocks: sovereignAuditStream });
});

router.post('/toggle-tenant-status', (req, res) => {
    const { tenantId, status } = req.body;
    res.json({ success: true, message: `Tenant ${tenantId} status successfully updated to ${status}.` });
});

router.post('/request-tenant-corridor', (req, res) => {
    const { businessName } = req.body;
    res.json({ success: true, message: `Tenant corridor request for "${businessName}" submitted successfully for owner approval.` });
});

module.exports = router;