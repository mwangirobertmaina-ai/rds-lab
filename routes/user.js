const express = require('express');
const router = express.Router();

// In-memory data stores for the User Portal backend
let otps = {};
let users = {};
let activeOrders = {};

// Haversine formula for distance calculation in kilometers
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Number((R * c).toFixed(2));
}

// 1. Send SMS OTP Route
router.post('/send-otp', (req, res) => {
    const { phone, email } = req.body;
    if (!phone) {
        return res.status(400).json({ success: false, error: "Phone number is required." });
    }
    
    const otp = "1234";
    otps[phone] = { otp, email, createdAt: Date.now() };

    console.log(`[SMS GATEWAY] OTP code ${otp} sent to phone ${phone} for email ${email || 'anonymous'}`);
    res.json({ success: true, message: `Verification OTP successfully sent to ${phone} (Use 1234 for test).` });
});

// 2. Verify OTP & Authenticate User Route
router.post('/verify-otp', (req, res) => {
    const { phone, otp, role, email } = req.body;
    
    if (!phone || !otp) {
        return res.status(400).json({ success: false, error: "Phone and OTP are required." });
    }

    if (otp !== "1234" && (!otps[phone] || otps[phone].otp !== otp)) {
        return res.status(401).json({ success: false, error: "Invalid or expired OTP code." });
    }

    const userId = `USR_${phone.replace(/[^0-9]/g, '')}`;
    const userProfile = {
        id: userId,
        phone,
        email: email || 'robert.maina@rds.com',
        role: role || 'USER',
        verifiedAt: Date.now()
    };

    users[userId] = userProfile;

    res.json({
        success: true,
        message: "Authentication successful!",
        user: userProfile
    });
});

// 3. Get All Available Merchant Shops & Tenants (Multi-vertical with robust fallbacks)
router.get('/tenants', (req, res) => {
    try {
        const defaultProfiles = {
            'MERCH_DEF_172': {
                merchantId: 'MERCH_DEF_172',
                shopName: "Sovereign Supermarket",
                businessType: "SUPERMARKET",
                phone: "+254712345678",
                gpsLat: -1.2863,
                gpsLon: 36.8172,
                banner: 'https://images.unsplash.com/photo-1578916171728-46686eac8d58?w=500'
            },
            'MERCH_JAVA_88': {
                merchantId: 'MERCH_JAVA_88',
                shopName: "Java House Restaurant",
                businessType: "RESTAURANT",
                phone: "+254722334455",
                gpsLat: -1.2789,
                gpsLon: 36.8123,
                banner: 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=500'
            },
            'MERCH_SANK_99': {
                merchantId: 'MERCH_SANK_99',
                shopName: "Sankara Luxury Hotel",
                businessType: "HOTEL",
                phone: "+254733445566",
                gpsLat: -1.2650,
                gpsLon: 36.8020,
                banner: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=500'
            }
        };

        const merchantProfiles = (global.merchantProfiles && Object.keys(global.merchantProfiles).length > 0) 
            ? global.merchantProfiles 
            : defaultProfiles;

        const defaultCatalogs = {
            'MERCH_DEF_172': [
                { id: 'K_1', name: 'Sovereign Organic Milk (1L)', category: 'SUPERMARKET', price: 180, merchant: 'Sovereign Supermarket', image: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300' },
                { id: 'K_2', name: 'Prime Beef Steak (1kg)', category: 'SUPERMARKET', price: 950, merchant: 'Sovereign Supermarket', image: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?w=300' }
            ],
            'MERCH_JAVA_88': [
                { id: 'J_1', name: 'Java House Coffee Pack', category: 'RESTAURANT', price: 650, merchant: 'Java House', image: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=300' },
                { id: 'J_2', name: 'Artisan Burger & Fries', category: 'RESTAURANT', price: 850, merchant: 'Java House', image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300' }
            ],
            'MERCH_SANK_99': [
                { id: 'S_1', name: 'Sankara Luxury Suite Pass', category: 'HOTEL', price: 12500, merchant: 'Sankara Hotel', image: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=300' }
            ]
        };

        const merchantCatalogs = (global.merchantCatalogs && Object.keys(global.merchantCatalogs).length > 0)
            ? global.merchantCatalogs
            : defaultCatalogs;

        const tenants = Object.keys(merchantProfiles).map(id => ({
            merchantId: id,
            shopName: merchantProfiles[id].shopName,
            businessType: merchantProfiles[id].businessType || 'GENERAL_RETAIL',
            gpsLat: merchantProfiles[id].gpsLat || -1.2863,
            gpsLon: merchantProfiles[id].gpsLon || 36.8172,
            banner: merchantProfiles[id].banner || 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=500',
            catalog: merchantCatalogs[id] || []
        }));

        res.json({ success: true, tenants });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Get Products Catalog for Storefront (Filtered by Tenant & Category)
router.get('/products', (req, res) => {
    const merchantId = req.headers['x-business-id'] || req.query.merchantId || 'MERCH_DEF_172';
    const currency = 'KES';

    const defaultCatalogs = {
        'MERCH_DEF_172': [
            { id: 'K_1', name: 'Sovereign Organic Milk (1L)', category: 'SUPERMARKET', price: 180, merchant: 'Sovereign Supermarket', image: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300' },
            { id: 'K_2', name: 'Prime Beef Steak (1kg)', category: 'SUPERMARKET', price: 950, merchant: 'Sovereign Supermarket', image: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?w=300' }
        ],
        'MERCH_JAVA_88': [
            { id: 'J_1', name: 'Java House Coffee Pack', category: 'RESTAURANT', price: 650, merchant: 'Java House', image: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=300' },
            { id: 'J_2', name: 'Artisan Burger & Fries', category: 'RESTAURANT', price: 850, merchant: 'Java House', image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300' }
        ],
        'MERCH_SANK_99': [
            { id: 'S_1', name: 'Sankara Luxury Suite Pass', category: 'HOTEL', price: 12500, merchant: 'Sankara Hotel', image: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=300' }
        ]
    };

    let products = [];
    const sourceCatalogs = (global.merchantCatalogs && Object.keys(global.merchantCatalogs).length > 0) 
        ? global.merchantCatalogs 
        : defaultCatalogs;

    if (sourceCatalogs[merchantId]) {
        products = sourceCatalogs[merchantId];
    } else {
        products = defaultCatalogs['MERCH_DEF_172'];
    }

    const { category } = req.query;
    if (category && category !== 'ALL') {
        products = products.filter(p => p.category.toUpperCase() === category.toUpperCase());
    }

    res.json({ success: true, currency, products });
});

// 5. Calculate Total Financial Split (2% System Fee calculated strictly on top of commodity/fare cost)
router.post('/calculate-total', (req, res) => {
    const { itemPriceTotal, pickupCoords, destinationCoords, vehicleType } = req.body;
    
    const commodityCost = Number(itemPriceTotal) || 0;
    
    const pLat = (pickupCoords && pickupCoords.lat) || -1.286389;
    const pLng = (pickupCoords && pickupCoords.lng) || 36.817223;
    const dLat = (destinationCoords && destinationCoords.lat) || -1.265556;
    const dLng = (destinationCoords && destinationCoords.lng) || 36.802778;
    
    const distanceKm = calculateHaversineDistance(pLat, pLng, dLat, dLng);

    const baseDeliveryFee = vehicleType === 'CAR' ? 300 : 150;
    const perKmRate = vehicleType === 'CAR' ? 75 : 45;
    const deliveryFee = Number((baseDeliveryFee + (distanceKm * perKmRate)).toFixed(2));

    // 2% system platform fee calculated strictly on top of the commodity/fare cost
    const systemFee = Number((commodityCost * 0.02).toFixed(2));

    // KRA Tax (16% VAT applied on the system service fee)
    const tax = Number((systemFee * 0.16).toFixed(2));

    // Total user pays = Commodity/Fare Cost (100%) + System Fee (2% on top) + Delivery Fee + Tax
    const userPays = Number((commodityCost + systemFee + deliveryFee + tax).toFixed(2));

    res.json({
        success: true,
        distanceKm,
        split: {
            productAmount: commodityCost,
            systemFee,
            deliveryFee,
            tax,
            userPays
        }
    });
});

// 6. Checkout & Engage Escrow / Dispatch to Selected Merchant or Ride Driver
router.post('/checkout', (req, res) => {
    const { phone, itemPriceTotal, pickupCoords, destinationCoords, vehicleType, pickup, destination, businessId, userId, items } = req.body;
    
    const commodityCost = Number(itemPriceTotal) || 0;
    const pLat = (pickupCoords && pickupCoords.lat) || -1.286389;
    const pLng = (pickupCoords && pickupCoords.lng) || 36.817223;
    const dLat = (destinationCoords && destinationCoords.lat) || -1.265556;
    const dLng = (destinationCoords && destinationCoords.lng) || 36.802778;
    
    const distanceKm = calculateHaversineDistance(pLat, pLng, dLat, dLng);
    const baseDeliveryFee = vehicleType === 'CAR' ? 300 : 150;
    const perKmRate = vehicleType === 'CAR' ? 75 : 45;
    const deliveryFee = Number((baseDeliveryFee + (distanceKm * perKmRate)).toFixed(2));
    
    const systemFee = Number((commodityCost * 0.02).toFixed(2));
    const tax = Number((systemFee * 0.16).toFixed(2));
    const total = Number((commodityCost + systemFee + deliveryFee + tax).toFixed(2));
    
    const currency = 'KES';
    const orderId = `ORD_${Math.floor(100000 + Math.random() * 900000)}`;

    const assignedDrivers = [
        { name: "John Kiprop", vehicle: "Honda Ace (KBX 420Y)", phone: "+254711223344" },
        { name: "David Ochieng", vehicle: "Toyota Vitz (KDD 910Z)", phone: "+254722334455" },
        { name: "Mercy Wanjiku", vehicle: "Yamaha Crux (KMC 112A)", phone: "+254733445566" }
    ];
    const assignedDriver = assignedDrivers[Math.floor(Math.random() * assignedDrivers.length)];

    const newOrder = {
        id: orderId,
        userId: userId || 'ANONYMOUS',
        phone,
        pickup: pickup || 'Nairobi CBD',
        destination: destination || 'Westlands',
        currency,
        total,
        breakdown: { commodityCost, systemFee, deliveryFee, tax },
        assignedDriver,
        status: 'SECURED_IN_ESCROW',
        createdAt: Date.now()
    };

    const targetMerchant = businessId || 'MERCH_DEF_172';
    if (!activeOrders[targetMerchant]) {
        activeOrders[targetMerchant] = [];
    }
    activeOrders[targetMerchant].push(newOrder);

    if (!global.merchantOrders) global.merchantOrders = {};
    if (!global.merchantOrders[targetMerchant]) global.merchantOrders[targetMerchant] = [];
    
    global.merchantOrders[targetMerchant].push({
        orderId,
        items: items || [{ name: 'Ride / Storefront Items', qty: 1, price: commodityCost }],
        totalAmount: total,
        assignedDriver,
        status: 'PENDING_VENDOR_ACCEPTANCE',
        createdAt: Date.now()
    });

    if (global.io) {
        global.io.to(targetMerchant).emit('new_customer_order', { orderId, totalAmount: total, assignedDriver });
        global.io.emit('orderListUpdated', { orderId });
    }

    console.log(`[ESCROW CHECKOUT] Order/Ride ${orderId} confirmed with driver ${assignedDriver.name}. Total: ${currency} ${total}`);

    res.json({
        success: true,
        message: "Order and rider dispatch successfully confirmed!",
        orderId,
        total,
        assignedDriver
    });
});

// 7. Get Live Orders & Rider Telemetry for User
router.get('/orders/live', (req, res) => {
    const merchantId = req.headers['x-business-id'] || 'MERCH_DEF_172';
    const orders = activeOrders[merchantId] || [];
    res.json({ success: true, orders });
});

// 8. Orderly Dismissal & Rollback Route
router.post('/orders/dismiss', (req, res) => {
    const { orderId, businessId } = req.body;
    const bizKey = businessId || 'MERCH_DEF_172';

    if (!activeOrders[bizKey]) {
        return res.status(404).json({ success: false, error: "Order pool not found." });
    }

    const order = activeOrders[bizKey].find(o => o.id === orderId);
    if (!order) {
        return res.status(404).json({ success: false, error: "Order ID not found." });
    }

    order.status = 'ORDERLY_DISMISSED';
    order.dismissedAt = Date.now();

    if (global.io) {
        global.io.emit('orderListUpdated', { orderId });
    }

    res.json({
        success: true,
        message: `Order ${orderId} successfully dismissed and funds rolled back from escrow.`
    });
});

module.exports = router;