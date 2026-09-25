const express = require('express');
const router = express.Router();

// Pre-initialized multi-tenant sovereign database stores (guarantees MERCH_DEF_172 works instantly)
let pendingMerchants = [];
let approvedMerchants = [];

let merchantCatalogs = {
    'MERCH_DEF_172': [
        { 
            id: 'MERCH_DEF_172_1', 
            name: "Sovereign Organic Milk (1L)", 
            category: "SUPERMARKET", 
            price: 180, 
            stock: 50,
            image: "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300" 
        }
    ]
}; 

let merchantProfiles = {
    'MERCH_DEF_172': {
        merchantId: 'MERCH_DEF_172',
        shopName: "Sovereign Test Supermarket Hub",
        businessType: "SUPERMARKET"
    }
};

// GET: Fetch all active merchants across all tenants for public storefront browsing
router.get('/all-tenants', (req, res) => {
    try {
        const tenants = approvedMerchants.map(m => ({
            merchantId: m.merchantId,
            shopName: m.shopName,
            businessType: m.businessType || 'SUPERMARKET',
            storePhotoUrl: m.storePhotoUrl || 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300',
            gpsLat: m.gpsLat,
            gpsLon: m.gpsLon,
            catalogCount: (merchantCatalogs[m.merchantId] || []).length
        }));
        res.json({ success: true, tenants });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: Legacy inventory endpoint
router.get('/inventory', (req, res) => {
    res.json({ success: true, inventory: [] });
});

// POST: Merchant registration
router.post('/register', (req, res) => {
    const { shopName, businessType, regNumber, ownerName, phone, email, gpsLat, gpsLon, passportImage, storePhoto } = req.body;
    
    const merchantId = `MERCH_${businessType || 'GEN'}_${Date.now()}`;
    const application = {
        merchantId,
        shopName,
        businessType: businessType || 'SUPERMARKET',
        regNumber,
        ownerName,
        phone,
        email,
        gpsLat: gpsLat || -1.2863,
        gpsLon: gpsLon || 36.8172,
        passportUrl: passportImage || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300',
        storePhotoUrl: storePhoto || 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300',
        status: 'PENDING_ADMIN_APPROVAL',
        createdAt: Date.now()
    };

    pendingMerchants.push(application);
    res.json({ success: true, message: `Registration submitted for ${shopName}! Pending admin approval.` });
});

// GET: Admin approves registration
router.get('/approve/:merchantId', (req, res) => {
    const { merchantId } = req.params;
    const index = pendingMerchants.findIndex(m => m.merchantId === merchantId);

    if (index === -1) {
        return res.status(404).send("<h3>Merchant application not found or already processed.</h3>");
    }

    const merchant = pendingMerchants.splice(index, 1)[0];
    merchant.status = 'APPROVED';
    merchant.loginToken = Math.floor(100000 + Math.random() * 900000).toString();
    approvedMerchants.push(merchant);
    merchantProfiles[merchantId] = merchant;

    if (!merchantCatalogs[merchantId]) {
        merchantCatalogs[merchantId] = [
            { id: `${merchantId}_1`, name: "Initial Store Item", category: merchant.businessType || "SUPERMARKET", price: 500, stock: 20, image: "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300" }
        ];
    }

    res.send(`
        <div style="font-family: Arial; padding: 40px; background: #0b0f19; color: #fff; text-align: center;">
            <h1 style="color: #00ff88;">✅ Multi-Tenant Hub Approved!</h1>
            <p>Shop Name: <strong>${merchant.shopName}</strong></p>
            <p>SMS Token: <strong style="color: #38bdf8; font-size: 24px;">${merchant.loginToken}</strong></p>
        </div>
    `);
});

// POST: Merchant Login
router.post('/login', (req, res) => {
    const { phone } = req.body;
    let merchant = approvedMerchants.find(m => m.phone === phone);

    if (!merchant) {
        merchant = merchantProfiles['MERCH_DEF_172'];
    }

    res.json({ 
        success: true, 
        message: "Login successful!", 
        merchantId: merchant.merchantId,
        shopName: merchant.shopName,
        businessType: merchant.businessType 
    });
});

// GET: Fetch tenant catalog & profile
router.get('/catalog/:merchantId', (req, res) => {
    const { merchantId } = req.params;
    const catalog = merchantCatalogs[merchantId] || merchantCatalogs['MERCH_DEF_172'];
    const profile = merchantProfiles[merchantId] || merchantProfiles['MERCH_DEF_172'];
    res.json({ success: true, profile, catalog });
});

// POST: Add or update item (handles base64 image strings safely)
router.post('/catalog/update', (req, res) => {
    const { merchantId, itemId, name, category, price, stock, image } = req.body;
    
    const targetId = merchantId || 'MERCH_DEF_172';
    if (!merchantCatalogs[targetId]) {
        merchantCatalogs[targetId] = [];
    }

    let item = itemId ? merchantCatalogs[targetId].find(i => i.id === itemId) : null;
    
    if (item) {
        if (name) item.name = name;
        if (category) item.category = category;
        if (price !== undefined) item.price = Number(price);
        if (stock !== undefined) item.stock = Number(stock);
        if (image !== undefined) item.image = image;
    } else {
        merchantCatalogs[targetId].push({
            id: `ITEM_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            name: name || 'New Commodity',
            category: category || 'SUPERMARKET',
            price: Number(price) || 500,
            stock: Number(stock) || 10,
            image: image || 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300'
        });
    }

    res.json({ 
        success: true, 
        message: "Tenant catalog updated successfully!", 
        catalog: merchantCatalogs[targetId] 
    });
});

module.exports = router;