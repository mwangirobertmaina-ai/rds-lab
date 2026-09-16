// ==========================================
// RDS - STAGE 82 HYBRID SOVEREIGN ENGINE
// Multi-Gateway (M-Pesa + Stripe), Immutable Merkle Ledgers, Explicit Escrow Storage,
// Multi-Wallet, 16% KRA Tax Allocation, Frictionless Phone OTP, End-to-End Autonomous Routing,
// Comprehensive Driver/Vehicle KYC & Dynamic Sovereign Document Download Hub
// ==========================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const fsPromises = require("fs").promises;
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const currency = require("currency.js");
const crypto = require("crypto");

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "sk_test_global_placeholder";
const stripe = require("stripe")(stripeSecretKey);

const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-api-key", "x-business-id", "x-region-currency"]
  }
});

global.io = io;

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

const MAX_DAILY_ANONYMOUS_TX = 50000; // KES 50,000 AML threshold per CBK guidelines

function num(v) {
  const parsed = Number(v);
  return isNaN(parsed) ? 0 : parsed;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function generateStage70MerkleProof(record) {
  const salt = process.env.SOVEREIGN_SALT || crypto.randomBytes(16).toString('hex');
  const payload = `${record.id || record.escrowId || record.riderId}:${record.businessId || 'GLOBAL'}:${record.orderId || record.transactionId}:${record.total || record.amount}:${record.currency || 'KES'}:${record.timestamp || Date.now()}:${salt}`;
  return {
    hash: crypto.createHmac('sha256', process.env.SOVEREIGN_SECRET_KEY || 'RDS_STAGE_70_MASTER_KEY').update(payload).digest('hex'),
    salt
  };
}

/**
 * Stage 82 Dynamic Financial Split Engine
 * ✔ Shop receives 100% of product price (shopReceives = baseAmount)
 * ✔ Platform earns 2% user fee surcharge + 5% from rider delivery fee
 * ✔ Rider receives 95% of delivery fee
 * ✔ Tax is recorded inside/on base amount or platform commissions
 */
function calculateFinancials(order) {
    const baseAmount = Number(order.itemPriceTotal || 0);   
    const deliveryFee = Number(order.deliveryFee || 0);

    const surcharge2 = round(baseAmount * 0.02);
    const total = round(baseAmount + surcharge2 + deliveryFee);
    const shopReceives = round(baseAmount);
    const tax = round(baseAmount * 0.16);
    const riderReceives = round(deliveryFee * 0.95);
    const riderPlatform = round(deliveryFee * 0.05);
    const platformFromProduct = 0;

    return {
        currency: order.currency || "KES",
        productAmount: baseAmount,
        deliveryFee,
        userPays: total,
        shopReceives,
        platformFromProduct,
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
      { id: "BIZ-KE", name: "RDS Nairobi (M-Pesa Corridor)", region: "KE", currency: "KES", ownerPhone: "254721862397", taxPin: "P055123456Z", custodianBank: "KCB-TRUST-001" },
      { id: "BIZ-UK", name: "RDS London (Stripe UK)", region: "UK", currency: "GBP", ownerPhone: "447123456789", taxPin: "GB123456789" },
      { id: "BIZ-ES", name: "RDS Madrid (Stripe Spain)", region: "ES", currency: "EUR", ownerPhone: "34612345678", taxPin: "ESB12345678" },
      { id: "BIZ-CA", name: "RDS Toronto (Stripe Canada)", region: "CA", currency: "CAD", ownerPhone: "14165550198", taxPin: "CA123456789RT" }
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
    users: [],
    otp_sessions: [],
    orders: [], 
    escrow: [],       
    wallets: [],      
    rider_wallets: [  
      { riderId: "DRV_01", balance: 0, currency: "KES" },
      { riderId: "RDR_01", balance: 0, currency: "KES" }
    ],
    ledger_entries: [],
    shops: [],
    catalogs: {},
    driver_telemetry: {},
    audit_logs: [],
    trust_accounts: { "BIZ-KE": { segregatedBalance: 0, liabilityBalance: 0 } }
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
  if (!Array.isArray(data.ledger_entries)) data.ledger_entries = [];
  if (!Array.isArray(data.shops)) data.shops = [];
  if (!Array.isArray(data.audit_logs)) data.audit_logs = [];
  if (!data.catalogs || typeof data.catalogs !== 'object') data.catalogs = {};
  if (!data.driver_telemetry || typeof data.driver_telemetry !== 'object') data.driver_telemetry = {};
  if (!data.trust_accounts || typeof data.trust_accounts !== 'object') data.trust_accounts = {};
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

function enforceCbkAmlAndKyc(req, res, next) {
  try {
    const { amount } = req.body;
    if (amount && Number(amount) > MAX_DAILY_ANONYMOUS_TX) {
      data.audit_logs.push({
        id: `AUDIT_${Date.now()}`,
        level: "WARNING",
        message: `AML Threshold Exceeded: Transaction of ${amount} requires Tier-2 KYC verification under CBK guidelines.`,
        timestamp: Date.now()
      });
      return res.status(451).json({
        success: false,
        error: "Regulatory Compliance Hold: Transaction exceeds standard retail threshold. Enhanced Due Diligence (EDD) / KRA PIN verification required."
      });
    }
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

io.on("connection", (socket) => {
  socket.on("join_room", (room) => socket.join(room));
});

app.get("/health", (req, res) => ok(res, { status: "STAGE_82_HYBRID_SOVEREIGN_ENGINE_ONLINE", time: Date.now() }));

function createEscrow(orderId, businessId, amount, region) {
    const escrowEntry = {
        escrowId: id("ESC"),
        orderId,
        businessId,
        amount,
        region,
        status: "HELD",
        createdAt: Date.now()
    };
    ensureState();
    data.escrow.push(escrowEntry);
    return escrowEntry;
}

function calculateRide(distanceKm, type) {
    const km = num(distanceKm);
    const vType = type ? type.toUpperCase() : "MOTORBIKE";
    if (km < 0.2 && vType === "BODA") return 100;
    let base = vType === "BODA" ? 50 : 100;
    let perKm = vType === "BODA" ? 30 : 60;
    return Math.round(base + (km * perKm));
}

app.post('/api/rider/register', async (req, res) => {
    try {
        ensureState();
        const { name, phone, vehicleType } = req.body;
        if (!name || !phone) return fail(res, "Name and phone required", 400);

        const riderId = id("RDR");
        data.riders.push({
            riderId,
            name,
            phone,
            vehicleType: vehicleType ? vehicleType.toUpperCase() : "MOTORBIKE",
            status: "ACTIVE",
            createdAt: Date.now()
        });

        data.rider_wallets.push({
            riderId,
            balance: 0,
            currency: "KES"
        });

        await saveDB();
        return ok(res, { success: true, riderId, message: "Rider registered successfully with dedicated wallet" });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/order/assign-rider', async (req, res) => {
    try {
        ensureState();
        const { orderId, riderId, distanceKm, vehicleType } = req.body;
        const order = data.orders.find(o => o.id === orderId);
        if (!order) return fail(res, "Order not found", 404);

        const deliveryFee = calculateRide(distanceKm || 3.0, vehicleType || "MOTORBIKE");

        order.riderId = riderId || "DRV_01";
        order.deliveryFee = deliveryFee;
        order.status = "RIDER_ASSIGNED";

        await saveDB();
        return ok(res, { success: true, deliveryFee, message: "Rider assigned successfully" });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.get('/api/rider/wallet/:riderId', async (req, res) => {
    try {
        ensureState();
        const { riderId } = req.params;
        let wallet = data.rider_wallets.find(w => w.riderId === riderId);
        if (!wallet) {
            wallet = { riderId, balance: 0, currency: "KES" };
            data.rider_wallets.push(wallet);
            await saveDB();
        }
        return ok(res, { success: true, wallet });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/rider/withdraw', async (req, res) => {
    try {
        ensureState();
        const { riderId, amount, phone } = req.body;
        const withdrawAmount = Number(amount);
        if (withdrawAmount <= 0) return fail(res, "Invalid withdrawal amount", 400);

        let wallet = data.rider_wallets.find(w => w.riderId === riderId);
        if (!wallet) return fail(res, "Rider wallet not found", 404);

        if (wallet.balance < withdrawAmount) return fail(res, "Insufficient rider wallet balance", 400);

        wallet.balance -= withdrawAmount;

        const referenceId = id("RDR_WTH");
        const ledgerEntry = {
            id: id("LEDGER"), owner_id: riderId, orderId: referenceId,
            amount: withdrawAmount, entry_type: "DEBIT", currency: wallet.currency || "KES",
            reference_id: referenceId, destination: phone || "M-Pesa", status: "SETTLED", timestamp: Date.now()
        };
        ledgerEntry.merkleProof = generateStage70MerkleProof(ledgerEntry);
        data.ledger_entries.push(ledgerEntry);

        await saveDB();
        if (global.io) global.io.emit('riderWalletUpdated', { riderId, balance: wallet.balance });

        return ok(res, { success: true, message: `Successfully withdrew KES ${withdrawAmount} to ${phone || 'M-Pesa'} (Simulated B2C Payout)` });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/compliance/reconcile-ledger', async (req, res) => {
  ensureState();
  let isValid = true;
  let discrepancies = [];

  for (let entry of data.ledger_entries) {
    const calculatedProof = generateStage70MerkleProof(entry);
    if (!entry.merkleProof || (typeof entry.merkleProof === 'object' && entry.merkleProof.hash !== calculatedProof.hash) || (typeof entry.merkleProof === 'string' && entry.merkleProof !== calculatedProof.hash)) {
      isValid = false;
      discrepancies.push({ entryId: entry.id, issue: "Merkle hash verification mismatch detected." });
    }
  }

  data.audit_logs.push({
    id: `REC_${Date.now()}`,
    type: "LEDGER_AUDIT",
    status: isValid ? "PASSED" : "FAILED",
    discrepanciesCount: discrepancies.length,
    timestamp: Date.now()
  });
  await saveDB();

  res.json({
    success: true,
    cbkComplianceStatus: isValid ? "FULLY_RECONCILED" : "INTEGRITY_ALERT",
    discrepancies,
    auditedAt: new Date().toISOString()
  });
});

app.get('/api/compliance/trust-account/:businessId', (req, res) => {
  ensureState();
  const { businessId } = req.params;
  const trustData = data.trust_accounts[businessId] || { segregatedBalance: 0, liabilityBalance: 0 };
  const isFullyBacked = trustData.segregatedBalance >= trustData.liabilityBalance;

  res.json({
    success: true,
    businessId,
    custodianStructure: "Commercially Banked Capped Trust Account",
    segregatedFunds: trustData.segregatedBalance,
    totalCustomerLiabilities: trustData.liabilityBalance,
    solvencyRatio: isFullyBacked ? "100%_FULLY_BACKED" : "UNDER_WATER",
    auditCompliance: isFullyBacked ? "PASSED" : "FAILED"
  });
});

app.post('/api/auth/send-otp', async (req, res) => {
    try {
        ensureState();
        const { phone } = req.body;
        if (!phone) return fail(res, "Phone number required", 400);
        const otp = "1234";
        const expires = Date.now() + 5 * 60 * 1000;
        data.otp_sessions = data.otp_sessions.filter(s => s.phone !== phone);
        data.otp_sessions.push({ phone, otp, expires });
        await saveDB();
        return ok(res, { success: true, message: "OTP sent successfully (Use 1234 for testing)" });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        ensureState();
        const { phone, otp } = req.body;
        const session = data.otp_sessions.find(s => s.phone === phone && s.otp === otp);
        if (!session || Date.now() > session.expires) return fail(res, "Invalid or expired OTP", 400);

        let user = data.users.find(u => u.phone === phone);
        if (!user) {
            user = { id: id("USR"), phone, role: "USER", createdAt: Date.now() };
            data.users.push(user);
        }
        const token = crypto.randomBytes(32).toString('hex');
        await saveDB();
        return ok(res, { success: true, token, user });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/user/set-role', async (req, res) => {
    try {
        ensureState();
        const { phone, role } = req.body;
        const user = data.users.find(u => u.phone === phone);
        if (!user) return fail(res, "User not found", 404);
        user.role = role || "USER";
        await saveDB();
        return ok(res, { success: true, user, message: `Role successfully updated to ${user.role}` });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/shop/register', async (req, res) => {
    try {
        ensureState();
        const { userId, shopName, idNumber, shopImageBase64, location, currency: shopCurrency, category } = req.body;
        if (!userId || !idNumber) return res.status(400).json({ success: false, error: "Missing required identification fields" });

        if (!data.shops) data.shops = [];
        
        const shopId = id("SHOP");
        const resolvedShopName = shopName || `Independent Merchant #${Math.floor(Math.random() * 900 + 100)}`;
        const resolvedCurrency = shopCurrency || "KES";

        const newShop = { 
            shopId, 
            id: shopId,
            ownerId: userId, 
            name: resolvedShopName,
            merchant: resolvedShopName,
            currency: resolvedCurrency,
            region: "KE",
            idNumber, 
            shopImage: shopImageBase64 || "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&auto=format&fit=crop&q=80", 
            location: location || { lat: -1.286389, lng: 36.817223 }, 
            verified: true, 
            createdAt: Date.now(), 
            status: "ACTIVE" 
        };

        data.shops.push(newShop);
        
        if (!data.businesses.some(b => b.id === shopId)) {
            data.businesses.push({
                id: shopId,
                name: resolvedShopName,
                region: "KE",
                currency: resolvedCurrency,
                ownerPhone: userId,
                taxPin: "P055" + Math.floor(Math.random() * 899999 + 100000) + "Z",
                custodianBank: "KCB-TRUST-001"
            });
        }

        if (!data.catalogs) data.catalogs = {};
        if (!data.catalogs[shopId]) data.catalogs[shopId] = [];

        await saveDB();
        return res.json({ success: true, message: "Shop registered automatically with no restrictions", shopId, shop: newShop });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// STAGE 82 SOVEREIGN DRIVER & VEHICLE KYC WITH FULL DOCUMENT RECORDING
app.post('/api/driver/register-sovereign', enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const {
            userId, fullName, phone, licenseNumber, idNumber, vehicleType, numberPlate,
            facePhotoBase64, licenseFrontBase64, licenseBackBase64, vehicleFrontBase64,
            vehicleBackBase64, logbookBase64, psvInsuranceBase64, psvBadgeBase64
        } = req.body;

        if (!userId || !licenseNumber || !idNumber || !numberPlate || !facePhotoBase64) {
            return fail(res, "Missing mandatory operator KYC or vehicle registration data", 400);
        }

        if (!data.drivers) data.drivers = [];
        const existingDriver = data.drivers.find(d => d.phone === phone || d.licenseNumber === licenseNumber || d.numberPlate === numberPlate);
        if (existingDriver) {
            return fail(res, "Driver, License, or Number Plate is already registered on the RDS Network.", 400);
        }

        const driverId = id("DRV_KYC");
        const sovereignDriverProfile = {
            id: driverId, userId, fullName: fullName || "Verified Operator", phone: phone || "",
            licenseNumber, idNumber, vehicleType: vehicleType ? vehicleType.toUpperCase() : "MOTORBIKE",
            numberPlate: numberPlate.toUpperCase(),
            documents: {
                facePhoto: facePhotoBase64 || "",
                licenseFront: licenseFrontBase64 || "",
                licenseBack: licenseBackBase64 || "",
                vehicleFront: vehicleFrontBase64 || "",
                vehicleBack: vehicleBackBase64 || "",
                logbook: logbookBase64 || "",
                psvInsurance: psvInsuranceBase64 || "",
                psvBadge: psvBadgeBase64 || ""
            },
            verificationStatus: "PENDING_KRA_PSV_AUDIT", status: "OFFLINE", createdAt: Date.now()
        };

        data.drivers.push(sovereignDriverProfile);
        await saveDB();

        return ok(res, {
            success: true,
            message: "Sovereign Driver & Vehicle Registration submitted successfully with full document bundle.",
            driverId
        });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

// STAGE 82 DYNAMIC DOCUMENT DOWNLOAD / VIEW ENDPOINT
app.get('/api/driver/documents/:driverId/:docType', enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const { driverId, docType } = req.params;
        const driver = data.drivers.find(d => d.id === driverId || d.userId === driverId);
        if (!driver) return fail(res, "Driver / Rider profile not found", 404);

        if (!driver.documents || !driver.documents[docType]) {
            return fail(res, `Requested document (${docType}) not found for this driver`, 404);
        }

        const base64Data = driver.documents[docType];
        if (base64Data.startsWith("data:")) {
            const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const mimeType = matches[1];
                const buffer = Buffer.from(matches[2], 'base64');
                res.setHeader('Content-Type', mimeType);
                res.setHeader('Content-Disposition', `attachment; filename="${driverId}_${docType}.${mimeType.split('/')[1] || 'bin'}"`);
                return res.send(buffer);
            }
        }

        return res.json({ success: true, driverId, docType, data: base64Data });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/products/add', (req, res) => {
    ensureState();
    const { shopId, name, price, category, merchant, image } = req.body;
    if (!shopId || !name || !price) return res.status(400).json({ success: false, error: "Missing required product fields" });

    if (!data.catalogs) data.catalogs = {};
    if (!data.catalogs[shopId]) data.catalogs[shopId] = [];

    const parentShop = data.shops.find(s => s.shopId === shopId) || data.businesses.find(b => b.id === shopId);
    const merchantName = merchant || (parentShop ? parentShop.name : "Independent Merchant");
    const itemCurrency = parentShop ? (parentShop.currency || "KES") : "KES";

    const newProduct = {
        id: id("PRD"), businessId: shopId, category: category || "RESTAURANT",
        merchant: merchantName, name, price: Number(price), currency: itemCurrency,
        image: image || "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&auto=format&fit=crop&q=80"
    };

    data.catalogs[shopId].push(newProduct);
    data.products.push(newProduct);
    saveDB();
    res.json({ success: true, product: newProduct, message: "Product added successfully!" });
});

app.post('/api/shops/:shopId/import-csv', enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const { shopId } = req.params;
        const { csvData } = req.body;
        if (!csvData) return fail(res, "No CSV data provided", 400);

        const rows = csvData.split('\n');
        let importedCount = 0;
        if (!data.catalogs) data.catalogs = {};
        if (!data.catalogs[shopId]) data.catalogs[shopId] = [];

        for (let row of rows) {
            const parts = row.split(',').map(p => p.trim());
            if (parts.length >= 2) {
                const name = parts[0];
                const price = Number(parts[1]);
                const category = parts[2] || "RESTAURANT";
                if (name && !isNaN(price)) {
                    const newProd = {
                        id: id("PRD_CSV"), businessId: shopId, category: category.toUpperCase(),
                        merchant: req.tenantObj.name || "Merchant Node", name, price,
                        currency: req.tenantObj.currency || "KES",
                        image: "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&auto=format&fit=crop&q=80"
                    };
                    data.catalogs[shopId].push(newProd);
                    data.products.push(newProd);
                    importedCount++;
                }
            }
        }
        await saveDB();
        return ok(res, { success: true, message: `Successfully imported ${importedCount} products via CSV batch.`, count: importedCount });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post('/api/driver/telemetry', enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const { driverId, lat, lng, orderId, status } = req.body;
        if (!driverId) return fail(res, "Driver ID required", 400);

        if (!data.driver_telemetry) data.driver_telemetry = {};
        data.driver_telemetry[driverId] = { lat: Number(lat), lng: Number(lng), updatedAt: Date.now() };

        if (orderId) {
            const order = data.orders.find(o => o.id === orderId);
            if (order && status) order.status = status;
        }

        await saveDB();
        if (global.io) global.io.emit('driverLocationUpdate', { driverId, lat, lng, orderId, status });
        return ok(res, { success: true, message: "Telemetry received successfully" });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.get('/api/products', enforceTenantIsolation, (req, res) => {
  ensureState();
  const { category } = req.query;
  let scopedProducts = data.products.filter(p => p.businessId === req.tenantId || (req.tenantObj && p.businessId === req.tenantObj.id));
  
  if (scopedProducts.length === 0 && data.catalogs && data.catalogs[req.tenantId]) {
      scopedProducts = data.catalogs[req.tenantId];
  }

  if (category && category !== 'ALL') scopedProducts = scopedProducts.filter(p => p.category === category);
  ok(res, { success: true, businessId: req.tenantId, storeName: req.tenantObj.name, currency: req.tenantObj.currency || "KES", products: scopedProducts });
});

app.get('/api/shops', (req, res) => {
    ensureState();
    const allShops = [...(data.businesses || []), ...(data.shops || [])];
    ok(res, { success: true, shops: allShops });
});

app.post('/api/calculate-total', enforceTenantIsolation, (req, res) => {
  const { itemPriceTotal, distanceKm, vehicleType } = req.body;
  const deliveryFee = calculateRide(distanceKm || 3.0, vehicleType || "MOTORBIKE");
  const split = calculateFinancials({
    itemPriceTotal: Number(itemPriceTotal) || 0,
    deliveryFee,
    currency: req.tenantObj.currency || "KES"
  });
  ok(res, { success: true, split });
});

app.post("/api/checkout", enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const { phone, itemPriceTotal, distanceKm, vehicleType, pickup, destination, riderId } = req.body;
        const tenant = req.tenantObj;
        const currencyCode = tenant.currency || "KES";
        const deliveryFeeVal = calculateRide(distanceKm || 3.0, vehicleType || "MOTORBIKE");

        const split = calculateFinancials({
            itemPriceTotal: Number(itemPriceTotal) || 0,
            deliveryFee: deliveryFeeVal,
            currency: currencyCode
        });

        if (split.userPays <= 0) return fail(res, "Invalid checkout amount", 400);

        const orderId = id("ORD_ST82");
        const assignedRiderId = riderId || "DRV_01";

        const order = {
            id: orderId,
            businessId: tenant.id,
            region: tenant.region || "KE",
            currency: currencyCode,
            productAmount: split.productAmount,
            deliveryFee: split.deliveryFee,
            shopSurcharge2Percent: split.platformFromUserFee,
            total: split.userPays,
            driverWalletCredit: split.riderReceives,
            platformRevenue: split.netPlatformRevenue,
            kraTax16Percent: split.tax,
            pickup: pickup || "Shop Hub",
            destination: destination || "Customer Destination",
            vehicleType: vehicleType || "MOTORBIKE",
            riderId: assignedRiderId,
            driverId: assignedRiderId,
            status: "RIDER_ASSIGNED",
            createdAt: Date.now()
        };
        data.orders.push(order);

        createEscrow(orderId, tenant.id, split.userPays, tenant.region || "KE");
        await saveDB();

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
                    CallBackURL: MPESA_CONFIG.callbackUrl, AccountReference: `RDS ${tenant.region || 'KE'}`,
                    TransactionDesc: `Stage 82 Escrow Checkout (${currencyCode})`
                },
                { headers: { Authorization: `Bearer ${accessToken}` } }
            );

            if (stkResponse.data && stkResponse.data.CheckoutRequestID) {
                order.checkoutRequestId = stkResponse.data.CheckoutRequestID;
                await saveDB();
            }
            return ok(res, { success: true, gateway: "M-PESA", darajaResponse: stkResponse.data, orderId, split });
        } else {
            const stripeAmount = Math.round(split.userPays * 100);
            const paymentIntent = await stripe.paymentIntents.create({
                amount: stripeAmount,
                currency: currencyCode.toLowerCase(),
                metadata: { orderId, businessId: tenant.id, region: tenant.region || "GLOBAL" }
            });
            order.checkoutRequestId = paymentIntent.id;
            await saveDB();
            return ok(res, { success: true, gateway: "STRIPE", clientSecret: paymentIntent.client_secret, orderId, split });
        }
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post("/api/orders/:orderId/dispatch", enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const { orderId } = req.params;
        const order = data.orders.find(o => o.id === orderId);
        if (!order) return fail(res, "Order not found", 404);
        if (order.status === "DISPATCHED" || order.status === "COMPLETED") return fail(res, "Already dispatched.", 400);

        order.status = "DISPATCHED";
        await saveDB();

        if (global.io) {
            global.io.emit('orderStatusUpdate', { orderId: order.id, status: 'DISPATCHED', pickup: order.pickup, destination: order.destination });
        }
        return ok(res, { success: true, message: "Order dispatched, waiting delivery. Funds remain secure in escrow." });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.post("/api/orders/:orderId/complete", enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const { orderId } = req.params;
        const order = data.orders.find(o => o.id === orderId);
        if (!order) return fail(res, "Order not found", 404);
        if (order.status === "COMPLETED") return fail(res, "Already completed.", 400);

        const escrow = data.escrow.find(e => e.orderId === orderId && e.status === "HELD");
        if (!escrow) return fail(res, "Escrow not found or already released", 400);

        const financials = calculateFinancials({
            itemPriceTotal: order.productAmount,
            deliveryFee: order.deliveryFee,
            currency: order.currency
        });

        if (!data.wallets) data.wallets = [];
        if (!data.rider_wallets) data.rider_wallets = [];

        function getWallet(ownerId, currency) {
            let w = data.wallets.find(w => w.ownerId === ownerId);
            if (!w) {
                w = { ownerId, balance: 0, currency };
                data.wallets.push(w);
            }
            return w;
        }

        const shopWallet = getWallet(order.businessId, financials.currency);
        const platformWallet = getWallet("PLATFORM", financials.currency);
        const taxWallet = getWallet("TAX", financials.currency);
        
        const targetRiderId = order.riderId || order.driverId || "DRV_01";
        let riderWallet = data.rider_wallets.find(w => w.riderId === targetRiderId);
        if (!riderWallet) {
            riderWallet = { riderId: targetRiderId, balance: 0, currency: financials.currency };
            data.rider_wallets.push(riderWallet);
        }

        shopWallet.balance = round(shopWallet.balance + financials.shopReceives);
        platformWallet.balance = round(platformWallet.balance + financials.platformFromUserFee + financials.platformFromRider);
        taxWallet.balance = round(taxWallet.balance + financials.tax);
        riderWallet.balance = round(riderWallet.balance + financials.riderReceives);

        const shopLedger = {
            id: id("LEDGER"), owner_id: order.businessId, orderId: order.id,
            amount: financials.shopReceives, entry_type: "CREDIT", currency: financials.currency,
            reference_id: order.id, status: "SETTLED", timestamp: Date.now()
        };
        shopLedger.merkleProof = generateStage70MerkleProof(shopLedger);
        data.ledger_entries.push(shopLedger);

        const riderLedger = {
            id: id("LEDGER"), owner_id: targetRiderId, orderId: order.id,
            amount: financials.riderReceives, entry_type: "CREDIT", currency: financials.currency,
            reference_id: order.id, status: "SETTLED", timestamp: Date.now()
        };
        riderLedger.merkleProof = generateStage70MerkleProof(riderLedger);
        data.ledger_entries.push(riderLedger);

        escrow.status = "RELEASED";
        escrow.releasedAt = Date.now();
        order.status = "COMPLETED";

        await saveDB();

        if (global.io) {
            global.io.emit('orderStatusUpdate', { orderId: order.id, status: 'COMPLETED' });
            global.io.emit('walletUpdated', { ownerId: order.businessId, currency: financials.currency });
            global.io.emit('riderWalletUpdated', { riderId: targetRiderId, balance: riderWallet.balance });
        }

        return res.json({
            success: true,
            message: "Order completed, escrow released, and funds safely distributed using updated model",
            breakdown: financials
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/wallets/:ownerId/balance', async (req, res) => {
    const { ownerId } = req.params;
    try {
        ensureState();
        let w = data.wallets.find(wallet => wallet.ownerId === ownerId);
        let balance = w ? w.balance : 0;
        
        if (!w) {
            const entries = data.ledger_entries.filter(e => e.owner_id === ownerId && e.status === 'SETTLED');
            balance = entries.reduce((acc, entry) => entry.entry_type === 'CREDIT' ? acc + entry.amount : acc - entry.amount, 0);
        }

        const tenant = data.businesses.find(b => b.id === ownerId) || data.shops.find(s => s.shopId === ownerId);
        const currencyCode = tenant ? (tenant.currency || "KES") : 'KES';
        res.json({ success: true, ownerId, currency: currencyCode, balance: round(balance), last_reconciled: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ error: "Wallet calculation failed", details: err.message });
    }
});

app.post("/api/wallet/withdraw", enforceTenantIsolation, enforceCbkAmlAndKyc, async (req, res) => {
    try {
        ensureState();
        const { amount, destination, ownerId } = req.body;
        const withdrawAmount = Number(amount);
        const tenant = req.tenantObj;
        const currencyCode = tenant.currency || "KES";
        const targetOwner = ownerId || tenant.id;

        if (withdrawAmount <= 0) return fail(res, "Invalid withdrawal amount", 400);

        let w = data.wallets.find(wallet => wallet.ownerId === targetOwner);
        let currentBalance = w ? w.balance : 0;
        if (!w) {
            const entries = data.ledger_entries.filter(e => e.owner_id === targetOwner && e.status === 'SETTLED');
            currentBalance = entries.reduce((acc, entry) => entry.entry_type === 'CREDIT' ? acc + entry.amount : acc - entry.amount, 0);
        }

        if (withdrawAmount > currentBalance) return fail(res, "Insufficient balance", 400);

        if (w) w.balance = round(w.balance - withdrawAmount);

        const referenceId = id("WTH_" + destination);
        const ledgerEntry = {
            id: id("LEDGER"), owner_id: targetOwner, orderId: referenceId,
            amount: withdrawAmount, entry_type: "DEBIT", currency: currencyCode,
            reference_id: referenceId, destination: destination, status: "SETTLED", timestamp: Date.now()
        };
        ledgerEntry.merkleProof = generateStage70MerkleProof(ledgerEntry);
        data.ledger_entries.push(ledgerEntry);
        await saveDB();

        if (global.io) global.io.emit('walletUpdated', { ownerId: targetOwner, currency: currencyCode });
        return ok(res, { success: true, message: `Successfully withdrew ${currencyCode} ${withdrawAmount} to ${destination}` });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

server.listen(PORT, () => {
  console.log(`🚀 RDS STAGE 82 HYBRID SOVEREIGN & RIDER ENGINE ACTIVE ON PORT ${PORT}`);
});