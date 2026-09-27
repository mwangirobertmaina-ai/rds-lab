const express = require('express');
const router = express.Router();

let otps = {};
let users = {};
let activeOrders = {};

function calculateAccurateDrivingDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const straightLineKm = R * c;
    const adjustedKm = Math.max(straightLineKm * 1.4, 4.0);
    return Number(adjustedKm.toFixed(1));
}

router.post('/send-otp', (req, res) => {
    const { phone, email } = req.body;
    if (!phone) {
        return res.status(400).json({ success: false, error: "Phone number is required." });
    }
    const otp = "1234";
    otps[phone] = { otp, email, createdAt: Date.now() };
    res.json({ success: true, message: `Verification OTP sent to ${phone} (Use 1234 for test).` });
});

router.post('/verify-otp', (req, res) => {
    const { phone, otp, role, email } = req.body;
    if (!phone || !otp) {
        return res.status(400).json({ success: false, error: "Phone and OTP are required." });
    }
    if (otp !== "1234" && (!otps[phone] || otps[phone].otp !== otp)) {
        return res.status(401).json({ success: false, error: "Invalid or expired OTP code." });
    }
    const userId = `USR_${phone.replace(/[^0-9]/g, '')}`;
    const userProfile = { id: userId, phone, email: email || 'robert.maina@rds.com', role: role || 'USER', verifiedAt: Date.now() };
    users[userId] = userProfile;
    res.json({ success: true, message: "Authentication successful!", user: userProfile });
});

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
            }
        };
        const merchantProfiles = (global.merchantProfiles && Object.keys(global.merchantProfiles).length > 0) ? global.merchantProfiles : defaultProfiles;
        const defaultCatalogs = {
            'MERCH_DEF_172': [
                { id: 'K_1', name: 'Sovereign Organic Milk (1L)', category: 'SUPERMARKET', price: 180, merchant: 'Sovereign Supermarket', image: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300' }
            ]
        };
        const merchantCatalogs = (global.merchantCatalogs && Object.keys(global.merchantCatalogs).length > 0) ? global.merchantCatalogs : defaultCatalogs;
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

router.get('/products', (req, res) => {
    const merchantId = req.headers['x-business-id'] || req.query.merchantId || 'MERCH_DEF_172';
    const currency = 'KES';
    const defaultCatalogs = {
        'MERCH_DEF_172': [
            { id: 'K_1', name: 'Sovereign Organic Milk (1L)', category: 'SUPERMARKET', price: 180, merchant: 'Sovereign Supermarket', image: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300' },
            { id: 'K_2', name: 'Prime Beef Steak (1kg)', category: 'SUPERMARKET', price: 950, merchant: 'Sovereign Supermarket', image: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?w=300' }
        ]
    };
    const sourceCatalogs = (global.merchantCatalogs && Object.keys(global.merchantCatalogs).length > 0) ? global.merchantCatalogs : defaultCatalogs;
    let products = sourceCatalogs[merchantId] || defaultCatalogs['MERCH_DEF_172'];
    const { category } = req.query;
    if (category && category !== 'ALL') {
        products = products.filter(p => p.category.toUpperCase() === category.toUpperCase());
    }
    res.json({ success: true, currency, products });
});

router.post('/calculate-total', (req, res) => {
    const { itemPriceTotal, pickupCoords, destinationCoords, vehicleType } = req.body;
    const commodityCost = Number(itemPriceTotal) || 0;
    const pLat = (pickupCoords && pickupCoords.lat) || -1.286389;
    const pLng = (pickupCoords && pickupCoords.lng) || 36.817223;
    const dLat = (destinationCoords && destinationCoords.lat) || -1.215000;
    const dLng = (destinationCoords && destinationCoords.lng) || 36.890000;
    
    const distanceKm = calculateAccurateDrivingDistance(pLat, pLng, dLat, dLng);
    const isCar = (vehicleType || '').toUpperCase() === 'CAR';
    const baseDeliveryFee = isCar ? 350 : 200;
    const perKmRate = isCar ? 65 : 40;
    const deliveryFee = Number((baseDeliveryFee + (distanceKm * perKmRate)).toFixed(2));

    const shopOwnerPayout = Number((commodityCost * 1.00).toFixed(2)); // 100% commodity payout released upon dispatch
    const systemCommodityFee = Number((commodityCost * 0.02).toFixed(2)); 
    const riderShare = Number((deliveryFee * 0.95).toFixed(2));             
    const appDeliveryCommission = Number((deliveryFee * 0.05).toFixed(2));  

    const totalSystemIncome = Number((systemCommodityFee + appDeliveryCommission).toFixed(2));
    const kraTax = Number((totalSystemIncome * 0.16).toFixed(2)); 
    const netSystemRevenue = Number((totalSystemIncome - kraTax).toFixed(2));
    const userPays = Number((commodityCost + deliveryFee).toFixed(2));

    res.json({
        success: true,
        distanceKm,
        split: {
            productAmount: commodityCost,
            shopOwnerPayout,
            systemCommodityFee,
            deliveryFee,
            riderShare,
            appDeliveryCommission,
            systemFee: totalSystemIncome,
            tax: kraTax,
            netSystemRevenue,
            userPays
        }
    });
});

router.post('/checkout', (req, res) => {
    const { phone, itemPriceTotal, pickupCoords, destinationCoords, vehicleType, pickup, destination, businessId, userId, items } = req.body;
    const commodityCost = Number(itemPriceTotal) || 0;
    const pLat = (pickupCoords && pickupCoords.lat) || -1.286389;
    const pLng = (pickupCoords && pickupCoords.lng) || 36.817223;
    const dLat = (destinationCoords && destinationCoords.lat) || -1.215000;
    const dLng = (destinationCoords && destinationCoords.lng) || 36.890000;
    
    const distanceKm = calculateAccurateDrivingDistance(pLat, pLng, dLat, dLng);
    const isCar = (vehicleType || '').toUpperCase() === 'CAR';
    const baseDeliveryFee = isCar ? 350 : 200;
    const perKmRate = isCar ? 65 : 40;
    const deliveryFee = Number((baseDeliveryFee + (distanceKm * perKmRate)).toFixed(2));
    
    const shopOwnerPayout = Number((commodityCost * 1.00).toFixed(2));
    const systemCommodityFee = Number((commodityCost * 0.02).toFixed(2));
    const riderShare = Number((deliveryFee * 0.95).toFixed(2));
    const appDeliveryCommission = Number((deliveryFee * 0.05).toFixed(2));
    const totalSystemIncome = Number((systemCommodityFee + appDeliveryCommission).toFixed(2));
    const kraTax = Number((totalSystemIncome * 0.16).toFixed(2));
    
    const total = Number((commodityCost + deliveryFee).toFixed(2));
    const currency = 'KES';
    const orderId = `ORD_${Math.floor(100000 + Math.random() * 900000)}`;

    const assignedDrivers = [
        { name: "John Kiprop", vehicle: "Honda Ace (KBX 420Y)", phone: "+254711223344", payout: riderShare },
        { name: "David Ochieng", vehicle: "Toyota Vitz (KDD 910Z)", phone: "+254722334455", payout: riderShare }
    ];
    const assignedDriver = assignedDrivers[Math.floor(Math.random() * assignedDrivers.length)];

    const resolvedItems = (items && items.length > 0) ? items : [{ name: `${isCar ? 'Cab' : 'Boda'} Ride`, qty: 1, price: total }];

    const newOrder = {
        id: orderId,
        userId: userId || 'ANONYMOUS',
        phone,
        pickup: pickup || 'Nairobi CBD',
        destination: destination || 'Kasarani',
        currency,
        total,
        breakdown: {
            commodityCost,
            shopOwnerPayout,
            deliveryFee,
            riderShare,
            systemFee: totalSystemIncome,
            tax: kraTax
        },
        assignedDriver,
        status: 'HELD_IN_ESCROW_PENDING_PACKAGING',
        createdAt: Date.now()
    };

    const targetMerchant = businessId || 'MERCH_DEF_172';
    if (!activeOrders[targetMerchant]) activeOrders[targetMerchant] = [];
    activeOrders[targetMerchant].push(newOrder);

    if (!global.merchantOrders) global.merchantOrders = {};
    if (!global.merchantOrders[targetMerchant]) global.merchantOrders[targetMerchant] = [];
    global.merchantOrders[targetMerchant].push({
        orderId,
        items: resolvedItems,
        totalAmount: total,
        shopOwnerPayout,
        assignedDriver,
        status: 'PENDING_VENDOR_ACCEPTANCE',
        createdAt: Date.now()
    });

    if (global.io) {
        global.io.to(targetMerchant).emit('new_customer_order', { orderId, totalAmount: total, shopOwnerPayout, assignedDriver });
        global.io.emit('orderListUpdated', { orderId });
    }

    res.json({ success: true, message: "Full gross amount secured in escrow. Awaiting merchant packaging and dispatch.", orderId, total, assignedDriver });
});

router.get('/orders/live', (req, res) => {
    const merchantId = req.headers['x-business-id'] || 'MERCH_DEF_172';
    const orders = activeOrders[merchantId] || [];
    res.json({ success: true, orders });
});

router.post('/orders/dismiss', (req, res) => {
    const { orderId, businessId } = req.body;
    const bizKey = businessId || 'MERCH_DEF_172';
    if (!activeOrders[bizKey]) return res.status(404).json({ success: false, error: "Order pool not found." });
    const order = activeOrders[bizKey].find(o => o.id === orderId);
    if (!order) return res.status(404).json({ success: false, error: "Order ID not found." });
    order.status = 'ORDERLY_DISMISSED';
    if (global.io) global.io.emit('orderListUpdated', { orderId });
    res.json({ success: true, message: `Order ${orderId} dismissed and escrow rolled back.` });
});

module.exports = router;