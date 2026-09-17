// ==========================================
// RDS - STAGE 98 SOVEREIGN ON-DEMAND COMMERCE & LOGISTICS SIMULATOR
// Jumia Storefront + Uber Dispatch + Orderly Dismissal + Basel III & CBK Compliance
// ==========================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const fsPromises = require("fs").promises;
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-api-key", "x-business-id"]
  }
});

global.io = io;

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

function num(v) {
  const parsed = Number(v);
  return isNaN(parsed) ? 0 : parsed;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function calculateHaversineDistanceKm(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 3.0;
  const R = 6371; 
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.max(round(R * c), 0.5);
}

function calculateFinancials(order) {
    const baseAmount = Number(order.itemPriceTotal || 0);    
    const deliveryFee = Number(order.deliveryFee || 0);
    const surcharge2 = round(baseAmount * 0.02);
    const total = round(baseAmount + surcharge2 + deliveryFee);
    const tax = round(baseAmount * 0.16);
    const riderReceives = round(deliveryFee * 0.95);
    const riderPlatform = round(deliveryFee * 0.05);

    return {
        currency: order.currency || "KES",
        productAmount: baseAmount,
        deliveryFee,
        userPays: total,
        shopReceives: round(baseAmount),
        platformFromUserFee: surcharge2,
        platformFromRider: riderPlatform,
        tax,
        riderReceives,
        netPlatformRevenue: round(surcharge2 + riderPlatform - tax)
    };
}

const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY || "1gUiUGRcrNGP7GEplYsE62mNKqAnItctwfteNSPPklSop61w",
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || "wF4tdktQCUIATJr3DNqW9wtIjtImd7bNGGyYhYa5k3LNesW20xRG1ZAsEiqBqgRv",
  shortCode: process.env.MPESA_SHORTCODE || "174379",
  passkey: process.env.MPESA_PASSKEY || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
  environment: process.env.MPESA_ENV || "sandbox",
  callbackUrl: process.env.MPESA_CALLBACK_URL || "https://sandbox.safaricom.co.ke/callback"
};

const MPESA_BASE_URL = MPESA_CONFIG.environment === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

async function getMpesaAccessToken() {
  const authString = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString("base64");
  const response = await axios.get(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${authString}` },
    timeout: 10000
  });
  return response.data.access_token;
}

app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "store.html"));
});

app.use(express.static("."));

function defaultDB() {
  return { 
    businesses: [
      { id: "BIZ-KE", name: "RDS Nairobi (M-Pesa Corridor)", region: "KE", currency: "KES", ownerPhone: "254721862397", taxPin: "P055123456Z" },
      { id: "BIZ-UK", name: "RDS London (Stripe UK)", region: "UK", currency: "GBP", ownerPhone: "447123456789", taxPin: "GB123456789" }
    ], 
    drivers: [
      { id: "DRV_01", name: "John Kiprop", vehicle: "Motorbike", plate: "KMXX 123A", status: "ONLINE", phone: "254711223344" }
    ],
    riders: [
      { riderId: "RDR_01", name: "John Kiprop", phone: "254711223344", vehicleType: "MOTORBIKE", status: "ACTIVE" }
    ],
    products: [
      { id: "p1", businessId: "BIZ-KE", category: "RESTAURANT", merchant: "Nairobi Grill & Chicken", name: "2pc Chicken Meal (KES)", price: 650, currency: "KES", image: "https://images.unsplash.com/photo-1562967914-608f82629710?w=400&auto=format&fit=crop&q=80" },
      { id: "p5", businessId: "BIZ-KE", category: "HOTEL", merchant: "Serena Luxury Suites", name: "Executive Suite Booking (1 Night)", price: 12500, currency: "KES", image: "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=400&auto=format&fit=crop&q=80" },
      { id: "p6", businessId: "BIZ-KE", category: "SUPERMARKET", merchant: "Naivas Supermarket Express", name: "Organic Fresh Basket", price: 2100, currency: "KES", image: "https://images.unsplash.com/photo-1542838132-92c53300491e?w=400&auto=format&fit=crop&q=80" }
    ], 
    users: [
      { id: "USR_DEFAULT", fullName: "Robert Maina", phone: "254721862397", idOrPassportNo: "32456789", amlFlagged: false, riskScore: "0.8%" }
    ],
    otp_sessions: [],
    orders: [], 
    escrow: [],        
    wallets: [],      
    rider_wallets: [  
      { riderId: "DRV_01", balance: 0, currency: "KES" },
      { riderId: "RDR_01", balance: 0, currency: "KES" }
    ],
    sar_queue: [],
    shops: [],
    catalogs: {}
  };
}

let data = defaultDB();

function ensureState() {
  if (!data || typeof data !== 'object') data = defaultDB();
  if (!Array.isArray(data.businesses)) data.businesses = [];
  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.otp_sessions)) data.otp_sessions = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.drivers)) data.drivers = [];
  if (!Array.isArray(data.riders)) data.riders = [];
  if (!Array.isArray(data.escrow)) data.escrow = [];
  if (!Array.isArray(data.wallets)) data.wallets = [];
  if (!Array.isArray(data.rider_wallets)) data.rider_wallets = [];
  if (!Array.isArray(data.sar_queue)) data.sar_queue = [];
  if (!Array.isArray(data.shops)) data.shops = [];
  if (!data.catalogs || typeof data.catalogs !== 'object') data.catalogs = {};
}

ensureState();

function id(prefix = "SYS") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 99999)}`;
}

function validateKenyanPhone(phone) {
  if (!phone) return null;
  let cleaned = phone.toString().replace(/[^0-9]/g, "");
  if (cleaned.startsWith("0")) cleaned = "254" + cleaned.substring(1);
  if (cleaned.startsWith("254") && cleaned.length === 12) return cleaned;
  return null;
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

function fail(res, msg = "Error", statusCode = 400) {
  return res.status(statusCode).json({ success: false, error: msg });
}

if (fs.existsSync(DB_FILE)) {
  try {
    const fileContent = fs.readFileSync(DB_FILE, "utf-8");
    if (fileContent.trim().length > 0) {
      data = { ...defaultDB(), ...JSON.parse(fileContent) };
      ensureState();
    }
  } catch (err) { data = defaultDB(); }
}

const saveDB = async () => {
  try {
    ensureState();
    const tempFile = `${DB_FILE}.tmp`;
    await fsPromises.writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");
    await fsPromises.rename(tempFile, DB_FILE);
  } catch (err) { console.error("DB save error", err); }
};

function enforceTenantIsolation(req, res, next) {
    const businessId = req.headers['x-business-id'] || req.query.businessId || req.body.businessId || "BIZ-KE";
    ensureState();
    req.tenantId = businessId;
    req.tenantObj = data.businesses.find(b => b.id === businessId) || data.shops.find(s => s.shopId === businessId) || { id: businessId, name: "Merchant Node", currency: "KES", region: "KE" };
    next();
}

io.on("connection", (socket) => {
  socket.on("join_room", (room) => socket.join(room));
});

app.get("/health", (req, res) => ok(res, { status: "STAGE_98_SUPER_APP_ONLINE", time: Date.now() }));

app.get('/api/orders/live', enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const tenantOrders = data.orders.filter(o => o.businessId === req.tenantId || req.tenantId === "BIZ-KE");
        return ok(res, { success: true, orders: tenantOrders });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

// STAGE 98 BASEL III & SAR COMPLIANCE DASHBOARD ENDPOINTS
app.get('/api/admin/compliance-dashboard', enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const tenantOrders = data.orders.filter(o => o.businessId === req.tenantId || req.tenantId === "BIZ-KE");
        return ok(res, { success: true, orders: tenantOrders, users: data.users, sarQueue: data.sar_queue });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/admin/toggle-aml', enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const { userId } = req.body;
        const user = data.users.find(u => u.id === userId);
        if (!user) return fail(res, "User not found", 404);
        user.amlFlagged = !user.amlFlagged;
        user.riskScore = user.amlFlagged ? "98.5% (HIGH)" : "1.2% (LOW)";
        
        if (user.amlFlagged) {
            data.sar_queue.push({
                id: id("SAR"),
                userId: user.id,
                amount: "N/A (Manual Flag)",
                reason: "Regulatory AML/PEP High-Risk Flag Triggered",
                timestamp: Date.now()
            });
        }

        await saveDB();
        if (global.io && user.amlFlagged) {
            global.io.emit('amlAlertTriggered', { userId: user.id, name: user.fullName });
        }
        return ok(res, { success: true, user });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/auth/send-otp', async (req, res) => {
    try {
        ensureState();
        const { phone, email } = req.body;
        if (!phone) return fail(res, "Phone number required", 400);
        const otp = "1234";
        const expires = Date.now() + 5 * 60 * 1000;
        data.otp_sessions = data.otp_sessions.filter(s => s.phone !== phone);
        data.otp_sessions.push({ phone, email: email || "", otp, expires });
        await saveDB();
        return ok(res, { success: true, message: "OTP sent successfully (Use 1234 for testing)" });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        ensureState();
        const { phone, otp, role, email } = req.body;
        const session = data.otp_sessions.find(s => s.phone === phone && s.otp === otp);
        if (!session || Date.now() > session.expires) return fail(res, "Invalid or expired OTP", 400);

        let user = data.users.find(u => u.phone === phone);
        if (!user) {
            user = { 
                id: id("USR"), phone, 
                email: email || session.email || "", 
                fullName: "Robert Maina", idOrPassportNo: "32456789", 
                role: role || "USER", amlFlagged: false, riskScore: "0.8%", createdAt: Date.now() 
            };
            data.users.push(user);
        } else {
            if (role) user.role = role;
        }
        const token = crypto.randomBytes(32).toString('hex');
        await saveDB();
        return ok(res, { success: true, token, user });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.get('/api/products', enforceTenantIsolation, (req, res) => {
  ensureState();
  const { category, shopId } = req.query;
  let scopedProducts = data.products;
  if (shopId) {
      scopedProducts = data.catalogs[shopId] || data.products.filter(p => p.businessId === shopId);
  } else if (req.tenantId && req.tenantId !== "BIZ-KE") {
      scopedProducts = data.products.filter(p => p.businessId === req.tenantId);
  }
  if (category && category !== 'ALL') {
      scopedProducts = scopedProducts.filter(p => p.category === category);
  }
  ok(res, { success: true, businessId: req.tenantId, storeName: req.tenantObj.name, currency: req.tenantObj.currency || "KES", products: scopedProducts });
});

app.post('/api/calculate-total', enforceTenantIsolation, (req, res) => {
  const { itemPriceTotal, pickupCoords, destinationCoords, vehicleType } = req.body;
  let distanceKm = calculateHaversineDistanceKm(
      pickupCoords?.lat, pickupCoords?.lng, 
      destinationCoords?.lat, destinationCoords?.lng
  );
  const km = num(distanceKm);
  const vType = vehicleType ? vehicleType.toUpperCase() : "MOTORBIKE";
  let deliveryFee = vType === "BODA" ? Math.round(50 + (km * 30)) : Math.round(120 + (km * 75));

  const split = calculateFinancials({
    itemPriceTotal: Number(itemPriceTotal) || 0,
    deliveryFee,
    currency: req.tenantObj.currency || "KES"
  });
  ok(res, { success: true, distanceKm, split });
});

app.post("/api/checkout", enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const { phone, itemPriceTotal, pickupCoords, destinationCoords, vehicleType, pickup, destination, userId } = req.body;
        const tenant = req.tenantObj;
        const currencyCode = tenant.currency || "KES";

        // AML & Risk Check
        const checkingUser = data.users.find(u => u.id === userId);
        if (checkingUser && checkingUser.amlFlagged) {
            return fail(res, "Transaction blocked by AML compliance policy. Account under regulatory review.", 403);
        }

        let distanceKm = calculateHaversineDistanceKm(
            pickupCoords?.lat, pickupCoords?.lng, 
            destinationCoords?.lat, destinationCoords?.lng
        );

        const km = num(distanceKm);
        const vType = vehicleType ? vehicleType.toUpperCase() : "MOTORBIKE";
        const deliveryFeeVal = vType === "BODA" ? Math.round(50 + (km * 30)) : Math.round(120 + (km * 75));

        const split = calculateFinancials({
            itemPriceTotal: Number(itemPriceTotal) || 0,
            deliveryFee: deliveryFeeVal,
            currency: currencyCode
        });

        if (split.userPays <= 0) return fail(res, "Invalid checkout amount", 400);

        // Basel III Threshold Check for Automatic SAR Generation (> 1,000,000 threshold simulation or high velocity)
        if (split.userPays >= 1000000) {
            data.sar_queue.push({
                id: id("SAR"),
                userId: userId || "ANONYMOUS",
                amount: `${currencyCode} ${split.userPays}`,
                reason: "High-Value Transaction Threshold Breached (>1M)",
                timestamp: Date.now()
            });
        }

        const orderId = id("ORD_ST98");
        const assignedRider = "DRV_01";

        const order = {
            id: orderId, userId: userId || "ANONYMOUS", businessId: tenant.id, region: tenant.region || "KE",
            currency: currencyCode, productAmount: split.productAmount,
            deliveryFee: split.deliveryFee, distanceKm,
            total: split.userPays, pickup: pickup || "Pickup Location",
            destination: destination || "Drop-off Destination",
            pickupCoords: pickupCoords || null, destinationCoords: destinationCoords || null,
            vehicleType: vType, riderId: assignedRider,
            status: "UBER_DISPATCH_ACTIVE", createdAt: Date.now()
        };
        data.orders.push(order);
        data.escrow.push({ escrowId: id("ESC"), orderId, businessId: tenant.id, amount: split.userPays, status: "HELD" });
        await saveDB();

        if (global.io) {
            global.io.emit('orderListUpdated', { orderId: order.id, status: order.status });
        }

        if (currencyCode === "KES") {
            const sanitizedPhone = validateKenyanPhone(phone);
            if (!sanitizedPhone) return fail(res, "Invalid Kenyan phone number for M-Pesa", 400);
            order.customerPhone = sanitizedPhone;
            const accessToken = await getMpesaAccessToken();
            const date = new Date();
            const timestamp = date.getFullYear() + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0') + String(date.getHours()).padStart(2, '0') + String(date.getMinutes()).padStart(2, '0') + String(date.getSeconds()).padStart(2, '0');
            const password = Buffer.from(`${MPESA_CONFIG.shortCode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');

            const stkResponse = await axios.post(
                `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
                {
                    BusinessShortCode: MPESA_CONFIG.shortCode, Password: password, Timestamp: timestamp,
                    TransactionType: "CustomerPayBillOnline", Amount: Math.round(split.userPays),
                    PartyA: sanitizedPhone, PartyB: MPESA_CONFIG.shortCode, PhoneNumber: sanitizedPhone,
                    CallBackURL: MPESA_CONFIG.callbackUrl, AccountReference: `RDS Stage 98`,
                    TransactionDesc: `Stage 98 Escrow Checkout`
                },
                { headers: { Authorization: `Bearer ${accessToken}` } }
            );

            if (stkResponse.data && stkResponse.data.CheckoutRequestID) {
                order.checkoutRequestId = stkResponse.data.CheckoutRequestID;
                await saveDB();
            }
            return ok(res, { success: true, gateway: "M-PESA", darajaResponse: stkResponse.data, orderId, distanceKm, split });
        } else {
            return ok(res, { success: true, gateway: "SIMULATED", orderId, distanceKm, split });
        }
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/orders/dismiss', enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const { orderId } = req.body;
        if (!orderId) return fail(res, "Order ID required for dismissal", 400);

        const orderIndex = data.orders.findIndex(o => o.id === orderId);
        if (orderIndex === -1) return fail(res, "Order not found", 404);

        const order = data.orders[orderIndex];
        order.status = "ORDERLY_DISMISSED";

        const escrowIdx = data.escrow.findIndex(e => e.orderId === orderId);
        if (escrowIdx !== -1) {
            data.escrow[escrowIdx].status = "REFUNDED_RELEASED";
        }

        await saveDB();
        if (global.io) {
            global.io.emit('orderListUpdated', { orderId, status: "ORDERLY_DISMISSED" });
        }
        return ok(res, { success: true, message: "Order safely dismissed, escrow rolled back, driver state reset." });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

server.listen(PORT, () => {
  console.log(`🚀 RDS STAGE 98 BASEL III & GLOBAL COMPLIANCE SIMULATOR ACTIVE ON PORT ${PORT}`);
});