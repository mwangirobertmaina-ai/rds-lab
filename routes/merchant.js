const express = require('express');
const router = express.Router();

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
        businessType: "SUPERMARKET",
        phone: "+254712345678",
        mpesaPhone: "+254712345678",
        loginToken: "1234"
    }
};

let merchantOrders = {
    'MERCH_DEF_172': [
        {
            orderId: 'ORD_' + Math.floor(100000 + Math.random() * 900000),
            items: [{ name: "Sovereign Organic Milk (1L)", qty: 2, price: 180 }],
            totalAmount: 360,
            status: 'PENDING_VENDOR_ACCEPTANCE',
            createdAt: Date.now()
        }
    ]
}; 

if (!global.driverQueue) {
    global.driverQueue = [];
}
if (!global.activeDispatches) {
    global.activeDispatches = {};
}

global.merchantOrders = merchantOrders;

router.get('/all-tenants', (req, res) => {
    try {
        const tenants = approvedMerchants.map(m => ({
            merchantId: m.merchantId,
            shopName: m.shopName,
            businessType: m.businessType || 'GENERAL_RETAIL',
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

router.post('/register', (req, res) => {
    const { shopName, businessType, regNumber, ownerName, phone, mpesaPhone, email, gpsLat, gpsLon, passportImage, storePhoto } = req.body;
    
    const verticalKey = (businessType || 'GENERAL').toUpperCase().replace(/[^A-Z0-9]/g, '_').substring(0, 10);
    const merchantId = `MERCH_${verticalKey}_${Date.now()}`;
    
    const passportUrl = passportImage && (passportImage.startsWith('data:image') || passportImage.startsWith('http'))
        ? passportImage 
        : 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300';

    const storePhotoUrl = storePhoto && (storePhoto.startsWith('data:image') || storePhoto.startsWith('http'))
        ? storePhoto 
        : 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300';

    const application = {
        merchantId, 
        shopName, 
        businessType: businessType || 'General Retail', 
        regNumber, 
        ownerName, 
        phone, 
        mpesaPhone: mpesaPhone || phone,
        email: email || 'mwangirobertmaina@gmail.com',
        gpsLat: gpsLat || -1.2863, 
        gpsLon: gpsLon || 36.8172,
        passportUrl,       
        storePhotoUrl,       
        status: 'PENDING_ADMIN_APPROVAL', 
        createdAt: Date.now()
    };
    
    pendingMerchants.push(application);
    res.json({ success: true, message: `Registration submitted for ${shopName}! Awaiting admin review.` });
});

router.get('/approve/:merchantId', (req, res) => {
    const { merchantId } = req.params;
    const index = pendingMerchants.findIndex(m => m.merchantId === merchantId);
    if (index === -1) return res.status(404).send("<h3>Merchant application not found or already processed.</h3>");

    const merchant = pendingMerchants.splice(index, 1)[0];
    merchant.status = 'APPROVED';
    merchant.loginToken = "1234"; 
    approvedMerchants.push(merchant);
    
    merchantProfiles[merchantId] = merchant;
    if (!merchantCatalogs[merchantId]) {
        merchantCatalogs[merchantId] = [
            { id: `${merchantId}_1`, name: "Initial Store Item", category: merchant.businessType || "General Retail", price: 500, stock: 20, image: "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300" }
        ];
    }
    if (!merchantOrders[merchantId]) merchantOrders[merchantId] = [];

    res.send(`
        <div style="font-family: Arial; padding: 40px; background: #0b0f19; color: #fff; text-align: center;">
            <h1 style="color: #00ff88;">✅ Independent Shop Approved!</h1>
            <p>Shop Name: <strong>${merchant.shopName}</strong> (${merchant.businessType})</p>
            <p>Owner: <strong>${merchant.ownerName}</strong> | Phone: <strong>${merchant.phone}</strong></p>
            <p>Generated SMS Login Token: <strong style="color: #38bdf8; font-size: 28px;">${merchant.loginToken}</strong></p>
        </div>
    `);
});

router.post('/login', (req, res) => {
    const { phone, token } = req.body;
    let merchant = approvedMerchants.find(m => m.phone === phone);
    
    if (!merchant && phone === '+254712345678') {
        merchant = merchantProfiles['MERCH_DEF_172'];
    }

    if (!merchant) {
        return res.status(404).json({ success: false, error: "Phone number not registered or approved." });
    }

    if (merchant.loginToken !== token) {
        return res.status(401).json({ success: false, error: "Invalid SMS login token. Use 1234 for test account." });
    }

    res.json({ 
        success: true, 
        message: "Login successful!", 
        merchantId: merchant.merchantId, 
        shopName: merchant.shopName, 
        businessType: merchant.businessType 
    });
});

router.get('/catalog/:merchantId', (req, res) => {
    const { merchantId } = req.params;
    const catalog = merchantCatalogs[merchantId] || merchantCatalogs['MERCH_DEF_172'];
    const profile = merchantProfiles[merchantId] || merchantProfiles['MERCH_DEF_172'];
    res.json({ success: true, profile, catalog });
});

router.post('/catalog/update', (req, res) => {
    const { merchantId, itemId, name, category, price, stock, image } = req.body;
    const targetId = merchantId || 'MERCH_DEF_172';
    if (!merchantCatalogs[targetId]) merchantCatalogs[targetId] = [];

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
            category: category || 'General Retail',
            price: Number(price) || 500,
            stock: Number(stock) || 10,
            image: image || 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300'
        });
    }

    res.json({ success: true, message: "Tenant catalog updated successfully!", catalog: merchantCatalogs[targetId] });
});

router.post('/catalog/delete', (req, res) => {
    const { merchantId, itemId } = req.body;
    const targetId = merchantId || 'MERCH_DEF_172';
    if (merchantCatalogs[targetId]) {
        merchantCatalogs[targetId] = merchantCatalogs[targetId].filter(i => i.id !== itemId);
    }
    res.json({ success: true, message: "Catalog item deleted successfully!", catalog: merchantCatalogs[targetId] || [] });
});

router.get('/orders/:merchantId', (req, res) => {
    const { merchantId } = req.params;
    const orders = merchantOrders[merchantId] || [];
    res.json({ success: true, orders });
});

router.post('/orders/new', (req, res) => {
    const { merchantId, items, totalAmount } = req.body;
    const targetId = merchantId || 'MERCH_DEF_172';
    if (!merchantOrders[targetId]) merchantOrders[targetId] = [];

    const newOrder = {
        orderId: 'ORD_' + Math.floor(100000 + Math.random() * 900000),
        items: items || [{ name: "General Commodity", qty: 1, price: totalAmount || 500 }],
        totalAmount: totalAmount || 500,
        status: 'PENDING_VENDOR_ACCEPTANCE',
        createdAt: Date.now()
    };

    merchantOrders[targetId].push(newOrder);

    // INSTANT SOCKET RINGER EMIT TO MERCHANT ROOM
    if (global.io) {
        global.io.to(targetId).emit('new_customer_order', newOrder);
        global.io.emit('orderListUpdated', newOrder);
    }

    res.json({ success: true, message: "New customer order placed and merchant alerted!", order: newOrder });
});

router.post('/orders/accept', (req, res) => {
    const { merchantId, orderId } = req.body;
    const targetId = merchantId || 'MERCH_DEF_172';

    if (!merchantOrders[targetId]) {
        return res.status(404).json({ success: false, error: "Merchant orders pool not found." });
    }

    const orderIndex = merchantOrders[targetId].findIndex(o => o.orderId === orderId);
    if (orderIndex === -1) {
        return res.status(404).json({ success: false, error: "Order ID not found." });
    }

    const order = merchantOrders[targetId][orderIndex];
    order.status = 'AWAITING_DRIVER_PICKUP';
    order.acceptedAt = Date.now();

    if (order.items && merchantCatalogs[targetId]) {
        order.items.forEach(orderedItem => {
            const stockItem = merchantCatalogs[targetId].find(c => c.name.toLowerCase() === orderedItem.name.toLowerCase());
            if (stockItem) {
                stockItem.stock = Math.max(0, stockItem.stock - (orderedItem.qty || 1));
            }
        });
    }

    const dispatchPayload = {
        id: order.orderId,
        orderId: order.orderId,
        isDirectRide: false,
        merchantId: targetId,
        pickup: (merchantProfiles[targetId] && merchantProfiles[targetId].shopName) || 'Merchant Store',
        destination: 'Customer Dropoff Point',
        currency: 'KES',
        items: order.items,
        total: order.totalAmount,
        totalAmount: order.totalAmount,
        status: 'PENDING_DRIVER_ACCEPTANCE',
        dispatchedAt: Date.now()
    };

    global.driverQueue.push(dispatchPayload);

    if (!global.activeDispatches[targetId]) global.activeDispatches[targetId] = [];
    global.activeDispatches[targetId].push(dispatchPayload);

    if (global.io) {
        global.io.to(targetId).emit('merchant_order_update', order);
        global.io.emit('new_driver_dispatch', dispatchPayload);
        global.io.emit('orderListUpdated', dispatchPayload);
    }

    res.json({ success: true, message: `Order ${orderId} packed and dispatched to driver radar!`, order });
});

router.post('/orders/complete-handover', (req, res) => {
    const { merchantId, orderId } = req.body;
    const targetId = merchantId || 'MERCH_DEF_172';

    if (!merchantOrders[targetId]) {
        return res.status(404).json({ success: false, error: "Merchant orders pool not found." });
    }

    const orderIndex = merchantOrders[targetId].findIndex(o => o.orderId === orderId);
    if (orderIndex === -1) {
        return res.status(404).json({ success: false, error: "Order ID not found." });
    }

    const order = merchantOrders[targetId][orderIndex];
    order.status = 'COMPLETED & PAID OUT';
    order.completedAt = Date.now();

    if (global.io) {
        global.io.to(targetId).emit('merchant_order_update', order);
        global.io.emit('orderListUpdated', order);
    }

    res.json({ success: true, message: `Order ${orderId} successfully handed over, dispatched, and paid out immediately!`, order });
});

router.get('/driver/queue', (req, res) => {
    res.json({ success: true, queue: global.driverQueue || [] });
});

router.post('/driver/accept', (req, res) => {
    const { orderId, driverId } = req.body;
    const index = global.driverQueue.findIndex(o => o.orderId === orderId);
    if (index !== -1) {
        const order = global.driverQueue.splice(index, 1)[0];
        order.status = 'DRIVER_EN_ROUTE_TO_MERCHANT';
        order.driverId = driverId || 'DRIVER_RIDER_01';

        for (let mId in merchantOrders) {
            let found = merchantOrders[mId].find(o => o.orderId === orderId);
            if (found) {
                found.status = 'DRIVER_EN_ROUTE_TO_MERCHANT';
                if (global.io) global.io.to(mId).emit('merchant_order_update', found);
            }
        }
        
        if (global.io) {
            global.io.emit('order_assigned_to_driver', order);
            global.io.emit('orderListUpdated', order);
        }
        return res.json({ success: true, message: "Order claimed by driver successfully! Driver is heading to your store.", order });
    }
    res.status(404).json({ success: false, error: "Order no longer available in queue." });
});

module.exports = router;