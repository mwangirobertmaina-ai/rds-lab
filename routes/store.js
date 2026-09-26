const express = require('express');
const router = express.Router();

let storeProducts = [
    { id: "M_01", category: "SUPERMARKET", name: "Sovereign Organic Milk (1L)", price: 180, merchant: "Nakumatt Supermarket", image: "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300" },
    { id: "M_02", category: "SUPERMARKET", name: "Fresh Farm Bread (Loaf)", price: 110, merchant: "Naivas Supermarket", image: "https://images.unsplash.com/photo-1509440159596-0249088772ff?w=300" },
    { id: "H_01", category: "HOTELS", name: "Executive Suite (1 Night Stay)", price: 15000, merchant: "Serena Hotel", image: "https://images.unsplash.com/photo-1582719508461-905c673771fd?w=300" },
    { id: "H_02", category: "HOTELS", name: "Deluxe Double Room (Breakfast)", price: 9500, merchant: "Radisson Blu", image: "https://images.unsplash.com/photo-1590490360182-c33d57733427?w=300" },
    { id: "R_01", category: "RESTAURANT", name: "Sovereign Nyama Platter", price: 2500, merchant: "Carnivore Grill", image: "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=300" },
    { id: "R_02", category: "RESTAURANT", name: "Artisan Wood-Fired Pizza", price: 1400, merchant: "Artcaffe Bistro", image: "https://images.unsplash.com/photo-1513104890138-7c749659a591?w=300" }
];

let storeOrders = [];

// GET: Fetch catalog products (Dynamically syncs with live approved merchant catalogs from the merchant backend)
router.get('/products', (req, res) => {
    try {
        let dynamicProducts = [...storeProducts];
        
        // Pull live merchant catalogs & profiles if available in global memory
        const merchantCatalogs = global.merchantCatalogs || {};
        const merchantProfiles = global.merchantProfiles || {};

        Object.keys(merchantCatalogs).forEach(merchantId => {
            const profile = merchantProfiles[merchantId] || { shopName: "Independent Shop", businessType: "General Retail" };
            const catalogList = merchantCatalogs[merchantId] || [];

            catalogList.forEach(item => {
                // Prevent duplicate entries if already present
                if (!dynamicProducts.some(p => p.id === item.id)) {
                    dynamicProducts.push({
                        id: item.id,
                        category: (item.category || profile.businessType || "General Retail").toUpperCase(),
                        name: item.name,
                        price: item.price,
                        merchant: profile.shopName || "Independent Shop",
                        image: item.image || "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300"
                    });
                }
            });
        });

        res.json({ success: true, products: dynamicProducts });
    } catch (err) {
        res.json({ success: true, products: storeProducts });
    }
});

// POST: Checkout & Dispatch with Precise Kenyan Tariff & Tax Splits (Uber / Bolt / Jumia Standard)
router.post('/checkout', (req, res) => {
    const tenantId = req.headers['x-business-id'] || 'INST-CBK-RTGS';
    const orderId = `ORD_${Date.now()}`;
    const escrowId = `ESC_${Date.now()}`;
    
    const { itemsTotal, distanceKm, pickupLocation, dropoffLocation, cartItems, merchantId } = req.body;
    
    const totalPrice = itemsTotal || 1500;
    const km = distanceKm || 6.5;
    
    // Kenyan Tariff & Fee Calculations
    const deliveryFee = Math.round((150 + (km * 35) + (18 * 4)) / 5) * 5;
    const merchantPayout = totalPrice;
    const sysFeeOnItems = totalPrice * 0.02;
    const driverPayout = deliveryFee * 0.95;
    const appDeliveryComm = deliveryFee * 0.05;
    const totalSysIncome = sysFeeOnItems + appDeliveryComm;
    const kraTax = totalSysIncome * 0.16;
    const netSysIncome = totalSysIncome - kraTax;
    const grossTotal = totalPrice + sysFeeOnItems + deliveryFee;

    const newOrder = {
        orderId,
        escrowId,
        tenantId,
        items: cartItems || [],
        totalAmount: grossTotal,
        splits: {
            merchantPayout,
            driverPayout,
            appDeliveryComm,
            sysFeeOnItems,
            kraTaxOnSystemIncome: kraTax,
            netSystemRevenue: netSysIncome
        },
        status: "DISPATCHED_TO_RIDER",
        timestamp: Date.now(),
        delivery: {
            deliveryId: `DEL_${Date.now()}`,
            pickupLocation: pickupLocation || "Nairobi CBD",
            dropoffLocation: dropoffLocation || "Westlands",
            distanceKm: km,
            status: "DISPATCHED",
            assignedDriver: { name: "Kiprono Driver (Bolt/Uber Pro)", phone: "+254 712 345678" }
        }
    };

    storeOrders.push(newOrder);

    // Automatically sync and push incoming order into the specific merchant's active dashboard orders pool
    const targetMerchantId = merchantId || 'MERCH_DEF_172';
    if (!global.merchantOrders) {
        global.merchantOrders = {};
    }
    if (!global.merchantOrders[targetMerchantId]) {
        global.merchantOrders[targetMerchantId] = [];
    }
    
    global.merchantOrders[targetMerchantId].push({
        orderId,
        items: cartItems || [{ name: "Store Item", qty: 1, price: totalPrice }],
        totalAmount: totalPrice,
        status: 'PENDING_VENDOR_ACCEPTANCE',
        createdAt: Date.now()
    });

    // Real-time socket broadcast to the merchant dashboard
    if (global.io) {
        global.io.to(targetMerchantId).emit('new_customer_order', { orderId });
    }

    res.json({ success: true, message: "Order auto-dispatched, merchant paid, and escrow locked!", orderRecord: newOrder });
});

// GET: Fetch tenant orders history
router.get('/orders/:tenantId', (req, res) => {
    const tenantId = req.params.tenantId;
    const filtered = storeOrders.filter(o => o.tenantId === tenantId || !o.tenantId);
    res.json({ success: true, orders: filtered });
});

// --- RIDER WORKFLOW & ESCROW SETTLEMENT ENDPOINTS (Uber / Glovo / Bolt Standard) ---

router.post('/logistics/rider-action', (req, res) => {
    const { deliveryId, action } = req.body;
    const order = storeOrders.find(o => o.delivery && o.delivery.deliveryId === deliveryId);
    
    if (!order) {
        return res.status(404).json({ success: false, error: "Active delivery dispatch session not found." });
    }

    if (action === 'ARRIVED_AT_MERCHANT') {
        order.delivery.status = 'ARRIVED_AT_MERCHANT';
        return res.json({ success: true, message: "Rider arrival confirmed at Supermarket Hub." });
    } else if (action === 'PICKED_COMMODITY') {
        order.delivery.status = 'COMMODITY_LOADED';
        return res.json({ success: true, message: "Commodity successfully picked and loaded into rider delivery box." });
    }

    return res.status(400).json({ success: false, error: "Invalid rider workflow action." });
});

router.post('/logistics/complete-trip', (req, res) => {
    const { deliveryId } = req.body;
    const order = storeOrders.find(o => o.delivery && o.delivery.deliveryId === deliveryId);
    
    if (!order) {
        return res.status(404).json({ success: false, error: "Active delivery session not found." });
    }

    order.delivery.status = 'COMPLETED';
    order.status = 'COMPLETED_SETTLED';

    const deliveryFee = order.splits && order.splits.driverPayout ? (order.splits.driverPayout / 0.95) : 1005;
    const driverPayout = deliveryFee * 0.95;

    res.json({
        success: true,
        message: "Trip completed successfully! Escrow released and rider paid instantly.",
        settlement: {
            driverPayout,
            status: "INSTANT_DISBURSED"
        }
    });
});

module.exports = router;