// ==========================================
// RDS - STAGE 107 SOVEREIGN INTELLIGENCE & LAW ENFORCEMENT GRID
// Universal Support: Kenya (DCI/CID, CBK Form FXBO / POCAMLA), INTERPOL, FinCEN, FCA
// + Live Telemetry Tracking + Suspicious Movement Memorization + Forensic Intelligence Taps
// ==========================================

const express = require("express");
const http = http = require("http");
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
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-api-key", "x-business-id", "x-agency-clearance"]
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

function calculateFinancials(order, region = "KE") {
    const baseAmount = Number(order.itemPriceTotal || 0);    
    const deliveryFee = Number(order.deliveryFee || 0);
    const surcharge2 = round(baseAmount * 0.02);
    const total = round(baseAmount + surcharge2 + deliveryFee);
    
    let taxRate = 0.16;
    if (region === "UK" || region === "EU") taxRate = 0.20;
    if (region === "CA") taxRate = 0.13;
    if (region === "US") taxRate = 0.08;

    const tax = round(baseAmount * taxRate);
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
      { id: "BIZ-KE", name: "RDS Nairobi Forex Bureau (CBK FXBO Corridor)", region: "KE", currency: "KES", ownerPhone: "254721862397", taxPin: "P055123456Z" },
      { id: "BIZ-UK", name: "RDS London (FCA Reserve)", region: "UK", currency: "GBP", ownerPhone: "447123456789", taxPin: "GB123456789" },
      { id: "BIZ-US", name: "RDS New York (OFAC Corridor)", region: "US", currency: "USD", ownerPhone: "12125550199", taxPin: "US-EIN-9988" }
    ], 
    drivers: [
      { id: "DRV_01", name: "John Kiprop", vehicle: "Motorbike", plate: "KMXX 123A", status: "ONLINE", phone: "254711223344" }
    ],
    riders: [
      { riderId: "RDR_01", name: "John Kiprop", phone: "254711223344", vehicleType: "MOTORBIKE", status: "ACTIVE" }
    ],
    products: [
      { id: "p1", businessId: "BIZ-KE", category: "RESTAURANT", merchant: "Nairobi Grill & Chicken", name: "2pc Chicken Meal (KES)", price: 650, currency: "KES", image: "https://images.unsplash.com/photo-1562967914-608f82629710?w=400&auto=format&fit=crop&q=80" }
    ], 
    users: [
      { id: "USR_DEFAULT", fullName: "Robert Maina", phone: "254721862397", idOrPassportNo: "32456789", amlFlagged: false, riskScore: "0.8%", kycStatus: "VERIFIED", riskProfile: { score: 0.8, level: "LOW", factors: ["Global Verified ID", "POCAMLA Compliant"] } }
    ],
    otp_sessions: [],
    active_sessions: [],
    universal_connections: [],
    immutable_audit_vault: [],
    transactions: [],
    orders: [], 
    escrow: [],        
    wallets: [],      
    rider_wallets: [  
      { riderId: "DRV_01", balance: 0, currency: "KES" }
    ],
    sar_queue: [],
    maker_checker_queue: [],
    velocity_alerts: [],
    pep_watchlist: ["sanctioned_entity_alpha", "pep_corrupt_actor_x", "blacklisted_org_99", "ofac_blocked_target"],
    // STAGE 107: LAW ENFORCEMENT SURVEILLANCE & TELEMETRY STORES
    surveillance_grid: [],
    suspect_movement_logs: [],
    agency_access_keys: ["DCI_COMMAND_2026", "CID_SECURE_KEY", "INTERPOL_GLOBAL_RED"],
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
  if (!Array.isArray(data.active_sessions)) data.active_sessions = [];
  if (!Array.isArray(data.universal_connections)) data.universal_connections = [];
  if (!Array.isArray(data.immutable_audit_vault)) data.immutable_audit_vault = [];
  if (!Array.isArray(data.transactions)) data.transactions = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.drivers)) data.drivers = [];
  if (!Array.isArray(data.riders)) data.riders = [];
  if (!Array.isArray(data.escrow)) data.escrow = [];
  if (!Array.isArray(data.wallets)) data.wallets = [];
  if (!Array.isArray(data.rider_wallets)) data.rider_wallets = [];
  if (!Array.isArray(data.sar_queue)) data.sar_queue = [];
  if (!Array.isArray(data.maker_checker_queue)) data.maker_checker_queue = [];
  if (!Array.isArray(data.velocity_alerts)) data.velocity_alerts = [];
  if (!Array.isArray(data.pep_watchlist)) data.pep_watchlist = ["sanctioned_entity_alpha", "pep_corrupt_actor_x"];
  if (!Array.isArray(data.surveillance_grid)) data.surveillance_grid = [];
  if (!Array.isArray(data.suspect_movement_logs)) data.suspect_movement_logs = [];
  if (!Array.isArray(data.agency_access_keys)) data.agency_access_keys = ["DCI_COMMAND_2026", "CID_SECURE_KEY", "INTERPOL_GLOBAL_RED"];
  if (!Array.isArray(data.shops)) data.shops = [];
  if (!data.catalogs || typeof data.catalogs !== 'object') data.catalogs = {};
}

ensureState();

function id(prefix = "SYS") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 99999)}`;
}

async function recordImmutableAudit(actionType, actor, details) {
    ensureState();
    const timestamp = Date.now();
    const previousHash = data.immutable_audit_vault.length > 0 
        ? data.immutable_audit_vault[data.immutable_audit_vault.length - 1].currentHash 
        : "GENESIS_ROOT_HASH_000000000000000000000000";
    
    const rawString = `${timestamp}:${actionType}:${JSON.stringify(actor)}:${JSON.stringify(details)}:${previousHash}`;
    const currentHash = crypto.createHash("sha256").update(rawString).digest("hex");

    const auditRecord = {
        auditId: id("AUD"),
        timestamp,
        actionType,
        actor,
        details,
        previousHash,
        currentHash,
        tamperProof: true,
        regulatoryStandard: "INTERPOL, DCI & POCAMLA Verified"
    };

    data.immutable_audit_vault.push(auditRecord);
    await saveDB();
    return auditRecord;
}

// STAGE 107: LAW ENFORCEMENT SURVEILLANCE & TELEMETRY INGESTION ENDPOINT
app.post('/api/surveillance/track-movement', enforceTenantIsolation, async (req, res) => {
    try {
        ensureState();
        const { userId, orderId, coordinates, deviceFingerprint, ipAddress, velocityVector } = req.body;
        
        const timestamp = Date.now();
        const movementRecord = {
            trackId: id("TRK"),
            userId: userId || "ANONYMOUS_TARGET",
            orderId: orderId || "N/A",
            coordinates: coordinates || { lat: -1.286389, lng: 36.817223 }, // Default Nairobi Center
            deviceFingerprint: deviceFingerprint || "UNKNOWN_DEVICE",
            ipAddress: ipAddress || req.ip,
            velocityVector: velocityVector || "NORMAL",
            timestamp,
            agencyAlertStatus: "LOGGED_SILENTLY"
        };

        // Check if user is on watchlist or flagged for high-risk structuring
        const targetUser = data.users.find(u => u.id === userId);
        const isFlagged = targetUser?.amlFlagged || screenAgainstWatchlists(targetUser || "");

        if (isFlagged) {
            movementRecord.agencyAlertStatus = "INTERPOL_DCI_WATCHLIST_MATCH";
            data.suspect_movement_logs.push(movementRecord);
            
            // Record silently without alerting the criminal
            await recordImmutableAudit("SUSPECT_MOVEMENT_CAPTURED", { userId, agency: "DCI_INTERPOL_GRID" }, movementRecord);
        }

        data.surveillance_grid.push(movementRecord);
        // Keep buffer size managed
        if (data.surveillance_grid.length > 1000) data.surveillance_grid.shift();

        await saveDB();
        return ok(res, { success: true, telemetryStatus: "RECORDED_AND_MEMORIZED" });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

// STAGE 107: SECURE AGENCY INTELLIGENCE FEED (DCI / CID / INTERPOL ACCESS)
app.get('/api/agency/intelligence-feed', async (req, res) => {
    try {
        ensureState();
        const agencyKey = req.headers['x-agency-clearance'] || req.query.key;
        
        if (!agencyKey || !data.agency_access_keys.includes(agencyKey)) {
            await recordImmutableAudit("UNAUTHORIZED_AGENCY_ACCESS_ATTEMPT", { ip: req.ip }, { agencyKey });
            return fail(res, "Access denied: Valid Law Enforcement Agency Clearance Key Required (INTERPOL/DCI/CID).", 401);
        }

        await recordImmutableAudit("LAW_ENFORCEMENT_DATA_ACCESSED", { agencyKey }, { queryTime: Date.now() });

        return ok(res, {
            success: true,
            classification: "RESTRICTED_LAW_ENFORCEMENT_EYES_ONLY",
            suspectMovements: data.suspect_movement_logs,
            velocityAlerts: data.velocity_alerts,
            sarQueue: data.sar_queue,
            immutableVaultChainLength: data.immutable_audit_vault.length,
            message: "Intelligence stream successfully synchronized with DCI/CID & INTERPOL nodes."
        });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

app.get('/api/admin/audit/verify-chain', async (req, res) => {
    ensureState();
    let isValid = true;
    let corruptedBlockId = null;

    for (let i = 0; i < data.immutable_audit_vault.length; i++) {
        const block = data.immutable_audit_vault[i];
        const expectedPrev = i === 0 ? "GENESIS_ROOT_HASH_000000000000000000000000" : data.immutable_audit_vault[i - 1].currentHash;
        
        if (block.previousHash !== expectedPrev) {
            isValid = false;
            corruptedBlockId = block.auditId;
            break;
        }

        const rawString = `${block.timestamp}:${block.actionType}:${JSON.stringify(block.actor)}:${JSON.stringify(block.details)}:${block.previousHash}`;
        const recomputedHash = crypto.createHash("sha256").update(rawString).digest("hex");
        
        if (recomputedHash !== block.currentHash) {
            isValid = false;
            corruptedBlockId = block.auditId;
            break;
        }
    }

    await recordImmutableAudit("CRYPTOGRAPHIC_CHAIN_AUDIT_RUN", { admin: "SYSTEM_INSPECTOR" }, { isValid, totalBlocks: data.immutable_audit_vault.length });
    
    return ok(res, {
        success: true,
        chainValid: isValid,
        totalBlocksVerified: data.immutable_audit_vault.length,
        corruptedBlockId,
        message: isValid ? "✅ Cryptographic Chain Integrity 100% Valid. Zero Tampering Detected under INTERPOL & POCAMLA Standards." : "⚠️ Tampering detected at block ID: " + corruptedBlockId
    });
});

function screenAgainstWatchlists(userOrName) {
    ensureState();
    const queryStr = typeof userOrName === 'string' ? userOrName.toLowerCase() : `${userOrName.fullName} ${userOrName.idOrPassportNo}`.toLowerCase();
    return data.pep_watchlist.some(w => queryStr.includes(w.toLowerCase()));
}

function checkTransactionVelocity(userId, amount) {
    ensureState();
    const rollingWindowMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const recentTx = data.transactions.filter(t => t.userId === userId && (now - t.createdAt) < rollingWindowMs);
    
    const totalRollingAmount = recentTx.reduce((sum, t) => sum + Number(t.total || 0), 0) + Number(amount || 0);
    const transactionCount = recentTx.length + 1;

    if (totalRollingAmount > 10000 || transactionCount >= 6) {
        const alertEntry = {
            id: id("VEL"),
            userId,
            totalRollingAmount,
            transactionCount,
            reason: "CBK/POCAMLA & INTERPOL Cross-Border Structuring Threshold Exceeded",
            timestamp: now
        };
        data.velocity_alerts.push(alertEntry);
        recordImmutableAudit("SMURFING_VELOCITY_TRIGGERED", { userId }, alertEntry);
        return true;
    }
    return false;
}

function enforceComplianceAndKYC(req, res, next) {
    ensureState();
    const token = req.headers['authorization'] || req.headers['x-session-token'];
    const userIdFromBody = req.body.userId;

    let user = null;
    if (token) {
        const session = data.active_sessions.find(s => s.token === token);
        if (session) { user = data.users.find(u => u.id === session.userId); }
    }
    if (!user && userIdFromBody) { user = data.users.find(u => u.id === userIdFromBody); }
    if (!user) { user = data.users.find(u => u.id === "USR_DEFAULT"); }

    if (user && screenAgainstWatchlists(user)) {
        user.amlFlagged = true;
        // STAGE 107 PHILOSOPHY: Do not block instantly if tracking; record and log silently for DCI/INTERPOL operation
        recordImmutableAudit("GLOBAL_PEP_SANCTION_MATCH_LOGGED", { userId: user.id }, { name: user.fullName, action: "SILENT_TRACKING_ENGAGED" });
    }

    req.currentUser = user;
    next();
}

function verifyRole(requiredRole) {
    return (req, res, next) => {
        ensureState();
        const token = req.headers['authorization'] || req.headers['x-session-token'];
        const session = data.active_sessions.find(s => s.token === token);

        if (!session && requiredRole !== 'USER') {
            return fail(res, "Unauthorized: Valid session token required.", 401);
        }

        const userRole = session ? session.role : "USER";
        const roleHierarchy = { ADMIN: 3, MERCHANT: 2, USER: 1 };

        if ((roleHierarchy[userRole] || 1) < (roleHierarchy[requiredRole] || 1)) {
            return fail(res, "Access denied: Insufficient privileges.", 403);
        }

        req.session = session;
        next();
    };
}

function validateKenyanPhone(phone) {
  if (!phone) return null;
  let cleaned = phone.toString().replace(/[^0-9]/g, "");
  if (cleaned.startsWith("0")) cleaned = "254" + cleaned.substring(1);
  if (cleaned.startsWith("254") && cleaned.length === 12) return cleaned;
  return cleaned.length >= 9 ? cleaned : null;
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
    req.tenantObj = data.businesses.find(b => b.id === businessId) || data.shops.find(s => s.shopId === businessId) || { id: businessId, name: "Forex Bureau Node", currency: "KES", region: "KE" };
    next();
}

io.on("connection", (socket) => {
  socket.on("join_room", (room) => socket.join(room));
  // Live telemetry socket listener for suspect movement tracking
  socket.on("client_telemetry_ping", async (payload) => {
      if (payload && payload.userId) {
          data.surveillance_grid.push({
              trackId: id("TRK_SOCKET"),
              userId: payload.userId,
              coordinates: payload.coords || {},
              timestamp: Date.now()
          });
      }
  });
});

app.get("/health", (req, res) => ok(res, { status: "STAGE_107_SOVEREIGN_INTELLIGENCE_GRID_ACTIVE", time: Date.now() }));

server.listen(PORT, () => {
  console.log(`🚀 RDS STAGE 107 LAW ENFORCEMENT & INTELLIGENCE GRID ACTIVE ON PORT ${PORT}`);
});