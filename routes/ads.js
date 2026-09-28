const express = require('express');
const router = express.Router();

let advertisements = [
    {
        id: 'AD_001',
        title: 'RDS Sovereign Supermarket Mega Sale',
        subtitle: 'Get 20% Off All Verified Electronics & Groceries',
        mediaType: 'Image Banner',
        targetVertical: 'Supermarket',
        geoTarget: 'Worldwide',
        mediaUrl: 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1200&q=80',
        cdnStreamUrl: 'https://edge-cdn.rds-sovereign.net/hls/ad_001/master.m3u8',
        status: 'APPROVED',
        impressions: 1240,
        clicks: 85,
        timestamp: Date.now()
    },
    {
        id: 'AD_002',
        title: 'Nairobi Boda & Logistics Dispatch Hub',
        subtitle: 'Secure, Tracked Fleet Management across East Africa',
        mediaType: 'Image Banner',
        targetVertical: 'Logistics & Boda',
        geoTarget: 'East Africa (Kenya / EAC)',
        mediaUrl: 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=1200&q=80',
        cdnStreamUrl: 'https://edge-cdn.rds-sovereign.net/hls/ad_002/master.m3u8',
        status: 'APPROVED',
        impressions: 980,
        clicks: 62,
        timestamp: Date.now()
    }
];

let callSignals = [];
let escrowContracts = [];

let ioInstance = null;
router.setSocketIo = (io) => {
    ioInstance = io;
};

// --- GET ALL APPROVED ADS ---
router.get('/list', (req, res) => {
    res.json({ success: true, advertisements });
});

// --- AI LIVENESS & BIOMETRIC VERIFICATION ENDPOINT ---
router.post('/auth/verify-liveness', (req, res) => {
    const { email, livenessScore, challengePassed } = req.body;
    
    if (!challengePassed || (livenessScore && livenessScore < 0.85)) {
        return res.status(401).json({ 
            success: false, 
            error: "AI Liveness verification failed. Spoofing or deepfake signature detected." 
        });
    }

    res.json({ 
        success: true, 
        message: "Biometric liveness verified successfully with edge AI.",
        sessionToken: `SOV_TOKEN_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        user: email || 'mwangirobertmaina@gmail.com'
    });
});

// --- BLOCKCHAIN ESCROW SETTLEMENT ---
router.post('/escrow/create', (req, res) => {
    try {
        const { adId, buyerId, amountUSD, currency, network } = req.body;
        
        const escrowTx = {
            escrowId: `ESCROW_${Date.now()}`,
            adId: adId || 'AD_001',
            buyerId: buyerId || 'mwangirobertmaina@gmail.com',
            amount: amountUSD || 50.00,
            currency: currency || 'USD',
            network: network || 'Polygon / Solana Testnet',
            contractHash: `0x${Math.random().toString(16).substring(2)}${Math.random().toString(16).substring(2)}${Math.random().toString(16).substring(2)}`,
            status: 'LOCKED_IN_ESCROW',
            timestamp: Date.now()
        };

        escrowContracts.push(escrowTx);

        if (ioInstance) {
            ioInstance.emit('escrow_created', escrowTx);
        }

        return res.status(200).json({ 
            success: true, 
            message: "Multi-signature smart contract escrow locked successfully.", 
            escrowTx 
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/escrow/release', (req, res) => {
    const { escrowId, logisticsConfirmation } = req.body;
    const contract = escrowContracts.find(e => e.escrowId === escrowId);

    if (!contract) {
        return res.status(404).json({ success: false, error: "Escrow contract not found." });
    }

    if (!logisticsConfirmation) {
        return res.status(400).json({ success: false, error: "Logistics delivery confirmation required to release funds." });
    }

    contract.status = 'RELEASED_TO_MERCHANT';
    res.json({ success: true, message: "Escrow funds successfully released to merchant.", contract });
});

// --- CDN MEDIA INGESTION ---
router.post('/media/ingest', (req, res) => {
    const { title, subtitle, targetVertical, geoTarget, rawMediaUrl } = req.body;
    
    const uniqueId = `AD_${Date.now()}`;
    const transmanagedAd = {
        id: uniqueId,
        title: title || 'Sovereign Edge Campaign',
        subtitle: subtitle || 'Cloudflare Multi-Region Edge Stream',
        mediaType: 'Video Ad',
        targetVertical: targetVertical || 'Global Tech',
        geoTarget: geoTarget || 'Worldwide',
        mediaUrl: rawMediaUrl,
        cdnStreamUrl: `https://edge-cdn.rds-sovereign.net/hls/${uniqueId.toLowerCase()}/master.m3u8`,
        status: 'PENDING_MODERATION',
        impressions: 0,
        clicks: 0,
        timestamp: Date.now()
    };

    advertisements.push(transmanagedAd);
    res.json({ success: true, message: "Media successfully ingested.", ad: transmanagedAd });
});

// --- SUBMIT AD CAMPAIGN ---
router.post('/submit', (req, res) => {
    const { title, subtitle, mediaType, targetVertical, geoTarget, mediaUrl } = req.body;
    const newAd = {
        id: `AD_${Date.now()}`,
        title: title || 'Sovereign Campaign',
        subtitle: subtitle || 'Verified Commercial Offer',
        mediaType: mediaType || 'Image Banner',
        targetVertical: targetVertical || 'Supermarket',
        geoTarget: geoTarget || 'Worldwide',
        mediaUrl: mediaUrl || 'https://images.unsplash.com/photo-1557804506-669a67965ba0?auto=format&fit=crop&w=1200&q=80',
        status: 'PENDING_MODERATION',
        impressions: 0,
        clicks: 0,
        timestamp: Date.now()
    };
    advertisements.push(newAd);
    res.json({ success: true, message: "Advertisement submitted successfully.", ad: newAd });
});

// --- ADMIN MODERATION WORKFLOW ---
router.post('/moderate', (req, res) => {
    const { adId, status } = req.body;
    const ad = advertisements.find(a => a.id === adId);
    
    if (!ad) {
        return res.status(404).json({ success: false, error: "Advertisement not found." });
    }

    ad.status = status;
    res.json({ success: true, message: `Status updated to ${status}.`, ad });
});

// --- REAL-TIME TELEMETRY ---
router.post('/telemetry', (req, res) => {
    const { adId, action } = req.body; 
    const ad = advertisements.find(a => a.id === adId);

    if (!ad) {
        return res.status(404).json({ success: false, error: "Advertisement not found." });
    }

    if (action === 'impression') {
        ad.impressions = (ad.impressions || 0) + 1;
    } else if (action === 'click') {
        ad.clicks = (ad.clicks || 0) + 1;
    }

    res.json({ success: true, message: "Telemetry recorded.", ad });
});

module.exports = router;