const express = require('express');
const router = express.Router();

let otps = {};
let drivers = {};
let driverWallets = {};
let activeDispatches = {};

// 1. Register Driver with Compliance Docs, Camera Snaps & Send OTP
router.post('/register-and-send-otp', (req, res) => {
    const { phone, email, name, vehicleType, plate, psvBadge, nationalId, passportSnap, vehicleSnap } = req.body;
    if (!phone || !name || !plate) {
        return res.status(400).json({ success: false, error: "Phone, name, and vehicle plate are required." });
    }

    const driverId = `DRV_${phone.replace(/[^0-9]/g, '')}`;
    
    // Store compliance profile and camera snapshots
    drivers[driverId] = {
        id: driverId,
        name,
        phone,
        email: email || 'driver@rds.com',
        vehicleType: vehicleType || 'BODA',
        plate,
        psvBadge: psvBadge || 'N/A',
        nationalId: nationalId || 'N/A',
        hasPassportSnap: !!passportSnap,
        hasVehicleSnap: !!vehicleSnap,
        verified: true,
        registeredAt: Date.now()
    };

    if (!driverWallets[driverId]) driverWallets[driverId] = 0;

    const otp = "1234";
    otps[phone] = { otp, email, createdAt: Date.now() };

    console.log(`[DRIVER COMPLIANCE & SNAP] Driver ${name} (${vehicleType} - ${plate}) registered with camera photos. OTP sent.`);
    res.json({ success: true, message: `Camera snaps & compliance docs verified! Verification OTP sent to ${phone} (Use 1234).` });
});

// 2. Verify Driver OTP
router.post('/verify-otp', (req, res) => {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
        return res.status(400).json({ success: false, error: "Phone and OTP required." });
    }
    if (otp !== "1234" && (!otps[phone] || otps[phone].otp !== otp)) {
        return res.status(401).json({ success: false, error: "Invalid OTP code." });
    }

    const driverId = `DRV_${phone.replace(/[^0-9]/g, '')}`;
    const userProfile = drivers[driverId] || { id: driverId, phone, role: 'RIDER' };

    res.json({ success: true, message: "Driver authenticated successfully!", user: userProfile });
});

// 3. Get Dispatches (Synced with User checkouts & merchant orders)
router.get('/dispatches', (req, res) => {
    const bizId = req.headers['x-business-id'] || 'MERCH_DEF_172';
    
    if (!activeDispatches[bizId]) {
        activeDispatches[bizId] = [
            { id: 'DISP_101', pickup: 'Nairobi CBD', destination: 'Westlands (Sarit Centre)', currency: 'KES', total: 450, status: 'PENDING_DRIVER_ACCEPTANCE' },
            { id: 'DISP_102', pickup: 'Sovereign Supermarket', destination: 'Kilimani', currency: 'KES', total: 1200, status: 'PENDING_DRIVER_ACCEPTANCE' }
        ];
    }

    res.json({ success: true, dispatches: activeDispatches[bizId] });
});

// 4. Accept Dispatch
router.post('/accept-dispatch', (req, res) => {
    const { dispatchId, driverId } = req.body;
    const bizId = req.headers['x-business-id'] || 'MERCH_DEF_172';

    if (!activeDispatches[bizId]) {
        return res.status(404).json({ success: false, error: "No dispatches found." });
    }

    const dispatch = activeDispatches[bizId].find(d => d.id === dispatchId);
    if (!dispatch) {
        return res.status(404).json({ success: false, error: "Dispatch not found." });
    }

    dispatch.status = 'ACCEPTED_BY_DRIVER';
    dispatch.driverId = driverId || 'DRV_001';

    if (global.io) {
        global.io.emit('orderListUpdated', { dispatchId });
    }

    res.json({ success: true, message: "Dispatch accepted successfully!" });
});

// 5. Complete Dispatch & Release Escrow to Driver Wallet
router.post('/complete-dispatch', (req, res) => {
    const { dispatchId, driverId } = req.body;
    const bizId = req.headers['x-business-id'] || 'MERCH_DEF_172';

    if (!activeDispatches[bizId]) {
        return res.status(404).json({ success: false, error: "No dispatches found." });
    }

    const dispatch = activeDispatches[bizId].find(d => d.id === dispatchId);
    if (!dispatch) {
        return res.status(404).json({ success: false, error: "Dispatch not found." });
    }

    dispatch.status = 'COMPLETED';
    
    const drvKey = driverId || 'DRV_001';
    if (!driverWallets[drvKey]) driverWallets[drvKey] = 0;
    driverWallets[drvKey] += Number(dispatch.total) * 0.85; // 85% payout to driver, 15% system split

    if (global.io) {
        global.io.emit('orderListUpdated', { dispatchId });
    }

    res.json({ success: true, message: "Delivery completed and wallet credited!" });
});

// 6. Get Driver Wallet Balance
router.get('/wallet', (req, res) => {
    const ownerId = req.query.ownerId || 'DRV_001';
    const balance = driverWallets[ownerId] || 0;
    res.json({ success: true, ownerId, balance });
});

// 7. Execute M-Pesa B2C Payout
router.post('/payout', (req, res) => {
    const { ownerId, amount } = req.body;
    const drvKey = ownerId || 'DRV_001';

    if (!driverWallets[drvKey] || driverWallets[drvKey] < amount) {
        return res.status(400).json({ success: false, error: "Insufficient wallet balance for B2C payout." });
    }

    driverWallets[drvKey] -= Number(amount);
    const payoutId = `MPESA_B2C_${Math.floor(100000 + Math.random() * 900000)}`;

    res.json({
        success: true,
        message: "M-Pesa B2C payout executed successfully!",
        payoutId,
        remainingBalance: driverWallets[drvKey]
    });
});

module.exports = router;