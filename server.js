// ============================================================================
// 🛡️ PERMANENT ARCHITECTURAL SAFEGUARD & ADDITIVE DEVELOPMENT MANDATE 🛡
// 1. IMMUTABLE CORE: Never delete, alter, or remove existing security middlewares 
//    (verifySovereignToken, requireAdminRole), audit vaults, or ledger equations.
// 2. ADDITIVE ONLY: All future modules must be appended strictly as new blocks.
// ============================================================================
// HARDENING NOTES (search "HARDENED:" for every change):
//  - Legacy verifySovereignToken/requireAdminRole are kept byte-for-byte but are
//    no longer mounted: they grant SOVEREIGN_ADMIN to anonymous callers and never
//    verify a signature. Strict HS256 versions are added and mounted instead.
//  - Business math (fees, splits, KRA tax, payouts) is unchanged.
//  - Env vars: NODE_ENV, JWT_SECRET, ALLOWED_ORIGINS, ALLOW_TEST_CREDENTIALS,
//    STRICT_ACTOR_AUTH, SOVEREIGN_ADMIN_PASSWORD_HASH (bcrypt) or
//    SOVEREIGN_ADMIN_PASSWORD, AUDIT_HMAC_KEY, DATA_DIR.
// ============================================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const fsPromises = require("fs").promises;
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs"); // ✅ Pure-JS bcryptjs configured for flawless CI/CD builds
const multer = require("multer");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by"); // HARDENED: don't advertise framework

// HARDENED: central configuration
const IS_PROD = process.env.NODE_ENV === "production";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const CORS_ORIGIN = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : "*"; // unset => old behaviour
// Demo credentials (OTP 1234 / merchant token 1234). Default ON outside production, OFF in production.
const ALLOW_TEST_CREDENTIALS = process.env.ALLOW_TEST_CREDENTIALS
    ? process.env.ALLOW_TEST_CREDENTIALS === "true"
    : !IS_PROD;
// When true, actor routes (merchant/driver/user) reject requests with no bearer token.
// Leave false until your front-ends send the token returned by login/verify-otp.
const STRICT_ACTOR_AUTH = process.env.STRICT_ACTOR_AUTH === "true";
const MAX_AMOUNT = 10000000; // KES sanity ceiling per transaction

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: CORS_ORIGIN,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-api-key", "x-business-id"]
    }
});

global.io = io;

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");
const DYNAMIC_JWT_SECRET = crypto.randomBytes(64).toString('hex');
const SOVEREIGN_OWNER_EMAIL = "mwangirobertmaina@gmail.com";

const ROLES = {
    SOVEREIGN_ADMIN: "SOVEREIGN_ADMIN",
    CENTRAL_BANK_AUDITOR: "CENTRAL_BANK_AUDITOR",
    COMMERCIAL_CASHIER: "COMMERCIAL_CASHIER",
    REGULAR_USER: "REGULAR_USER"
};

// HARDENED (additive): roles for non-staff actors
const ACTOR_ROLES = { MERCHANT: "MERCHANT", RIDER: "RIDER" };
// HARDENED: a stable secret is required for tokens to survive restarts
const JWT_SECRET = process.env.JWT_SECRET || DYNAMIC_JWT_SECRET;
if (!process.env.JWT_SECRET) {
    console.warn("⚠️  JWT_SECRET not set: using a random per-boot secret. All tokens die on restart. Set JWT_SECRET in production.");
}
if (ALLOW_TEST_CREDENTIALS) {
    console.warn("⚠️  TEST CREDENTIALS ENABLED (OTP/merchant token 1234). Set NODE_ENV=production and leave ALLOW_TEST_CREDENTIALS unset to disable.");
}

// ============================================================================
// HARDENED: security primitives (JWT, validation, rate limiting)
// ============================================================================
function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

function signJwt(payload, ttlSeconds = 3600) {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds })).toString("base64url");
    const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
    return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
    try {
        const parts = String(token).split(".");
        if (parts.length !== 3) return null;
        const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
        if (header.alg !== "HS256") return null; // blocks alg:none / algorithm confusion
        const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest("base64url");
        if (!safeEqual(parts[2], expected)) return null;
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch (e) {
        return null;
    }
}

const PROTO_KEYS = ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"];
function isSafeKey(v) {
    return typeof v === "string" && /^[A-Za-z0-9_.:+-]{1,80}$/.test(v) && !PROTO_KEYS.includes(v);
}
function pickKey(v, fallback) {
    const k = (v === undefined || v === null || v === "") ? fallback : v;
    return isSafeKey(k) ? String(k) : null;
}
function isPhone(v) { return typeof v === "string" && /^\+?[0-9 ()-]{7,20}$/.test(v); }
function isMoney(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT; }
function cleanText(v, max = 200) {
    if (v === undefined || v === null) return v;
    return String(v).replace(/[<>\u0000-\u001f]/g, "").trim().substring(0, max);
}
function cleanImage(v, fallback) {
    if (typeof v !== "string") return fallback;
    if (/^https?:\/\/[^\s"'<>]{1,500}$/i.test(v)) return v;
    if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 3 * 1024 * 1024) return v;
    return fallback;
}
function escapeHtml(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function bad(res, msg, code = 400) { return res.status(code).json({ success: false, error: msg }); }
function money2(n) { return Number(Number(n).toFixed(2)); }

function rateLimit({ windowMs, max }) {
    const hits = new Map();
    setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
    return (req, res, next) => {
        const now = Date.now();
        let e = hits.get(req.ip);
        if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; hits.set(req.ip, e); }
        e.count++;
        if (e.count > max) {
            res.set("Retry-After", String(Math.ceil((e.reset - now) / 1000)));
            return res.status(429).json({ success: false, error: "Too many requests. Slow down." });
        }
        next();
    };
}
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 600 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });   // logins / OTP
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }); // registrations

// HARDENED: security headers (no CSP: would break your inline-script front-ends)
app.use((req, res, next) => {
    res.set({
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "geolocation=(self), camera=(self), microphone=(self)"
    });
    if (IS_PROD) res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    next();
});

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));

// 🛡️ CRITICAL: Upgraded to 20mb payload limit for high-res biometric face snapshot payloads
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use("/api", apiLimiter);

// HARDENED: real LAN/API traffic log (dashboard previously showed one fake row)
app.use("/api", (req, res, next) => {
    res.on("finish", () => {
        lanTrafficLogs.push({
            timestamp: new Date().toLocaleTimeString(),
            clientIp: req.ip,
            method: req.method,
            endpoint: req.originalUrl.split("?")[0].substring(0, 200),
            status: `${res.statusCode} ${http.STATUS_CODES[res.statusCode] || ""}`.trim()
        });
        if (lanTrafficLogs.length > 1000) lanTrafficLogs.shift();
    });
    next();
});

// --- STAGE 190 STATIC DIRECTORY CONFIGURATION ---
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// HARDENED: express.static(__dirname) below would serve db.json, server.js, .env, keys,
// audit logs etc. to the internet. Block those before any static handler runs.
const BLOCKED_STATIC = /(^|\/)(\.[^/]*|node_modules|routes|db\.json|package(-lock)?\.json|server\.js|index\.js|audit-chain\.jsonl)(\/|$)|\.(env|pem|key|log|jsonl|bak|sqlite|db)$/i;
app.use((req, res, next) => {
    let p;
    try { p = decodeURIComponent(req.path); } catch (e) { return res.status(400).end(); }
    if (BLOCKED_STATIC.test(p) || p.includes("..")) return res.status(404).end();
    next();
});

// 🛡 CRITICAL STATIC SERVING FIX: Ensures browser can successfully load uploaded files and static assets
app.use('/uploads', express.static(uploadDir, { dotfiles: "deny", setHeaders: (r) => r.set("Content-Disposition", "inline") }));
app.use('/public', express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));
app.use(express.static(__dirname, { dotfiles: "deny" }));

// Configure Multer Storage for Local Video & Image Uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        // HARDENED: extension from a whitelist, never trust the client filename
        const ext = path.extname(file.originalname).toLowerCase();
        const safeExt = /^\.(mp4|webm|mov|jpg|jpeg|png|webp|gif|mp3|wav|ogg|m4a)$/.test(ext) ? ext : "";
        cb(null, uniqueSuffix + safeExt);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for video files
    fileFilter: (req, file, cb) => {
        // HARDENED: image/svg+xml startsWith('image/') => stored XSS; reject it
        if (file.mimetype === 'image/svg+xml') return cb(new Error('SVG uploads are not allowed!'), false);
        if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video, image, and audio files are allowed!'), false);
        }
    }
});

function stableStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

// --- SECURE JWT & RBAC PROTECTION MIDDLEWARES ---
// LEGACY (kept unmodified per mandate, no longer mounted on any route; see strict versions below)
function verifySovereignToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = { email: SOVEREIGN_OWNER_EMAIL, role: ROLES.SOVEREIGN_ADMIN };
        return next();
    }
    const token = authHeader.split(' ')[1];
    try {
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid token structure');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        req.user = payload;
        next();
    } catch (err) {
        req.user = { email: SOVEREIGN_OWNER_EMAIL, role: ROLES.SOVEREIGN_ADMIN };
        next();
    }
}

function requireAdminRole(req, res, next) {
    if (!req.user || (req.user.role !== ROLES.SOVEREIGN_ADMIN && req.user.role !== ROLES.CENTRAL_BANK_AUDITOR)) {
        req.user = { role: ROLES.SOVEREIGN_ADMIN };
    }
    next();
}

// HARDENED (additive): strict replacements that actually enforce identity and role
function verifySovereignTokenStrict(req, res, next) {
    const h = req.headers['authorization'];
    if (!h || !h.startsWith('Bearer ')) return bad(res, "Authentication required.", 401);
    const payload = verifyJwt(h.slice(7).trim());
    if (!payload) return bad(res, "Invalid or expired token.", 401);
    req.user = payload;
    next();
}
function requireRoles(...roles) {
    return (req, res, next) => {
        if (req.user && roles.includes(req.user.role)) return next();
        return bad(res, "Forbidden: insufficient role.", 403);
    };
}
const requireAdminRoleStrict = requireRoles(ROLES.SOVEREIGN_ADMIN, ROLES.CENTRAL_BANK_AUDITOR);
const requireSovereignAdminOnly = requireRoles(ROLES.SOVEREIGN_ADMIN);

// Actor auth for merchant/driver/user routes. A bearer token, when sent, must be valid and
// of the right role. With STRICT_ACTOR_AUTH=true a missing token is rejected too.
function softAuth(...roles) {
    return (req, res, next) => {
        const h = req.headers['authorization'];
        if (!h || !h.startsWith('Bearer ')) {
            if (STRICT_ACTOR_AUTH) return bad(res, "Authentication required.", 401);
            return next();
        }
        const p = verifyJwt(h.slice(7).trim());
        if (!p) return bad(res, "Invalid or expired token.", 401);
        if (roles.length && p.role !== ROLES.SOVEREIGN_ADMIN && !roles.includes(p.role)) return bad(res, "Forbidden: insufficient role.", 403);
        req.user = p;
        next();
    };
}
function ownsMerchant(req, merchantId) { return !req.user || req.user.role === ROLES.SOVEREIGN_ADMIN || req.user.merchantId === merchantId; }
function ownsDriver(req, driverId) { return !req.user || req.user.role === ROLES.SOVEREIGN_ADMIN || req.user.driverId === driverId; }

// HARDENED: OTP handling (expiry, attempt cap, random codes outside test mode)
function deliverOtp(phone, otp) {
    if (!ALLOW_TEST_CREDENTIALS) console.warn(`[OTP] No SMS gateway wired: cannot deliver code to ${phone}. Integrate a provider in deliverOtp().`);
}
function issueOtp(store, phone, extra) {
    const otp = ALLOW_TEST_CREDENTIALS ? "1234" : String(crypto.randomInt(100000, 1000000));
    store[phone] = { ...extra, otp, createdAt: Date.now(), attempts: 0 };
    deliverOtp(phone, otp);
    return otp;
}
function checkOtp(store, phone, otp) {
    if (ALLOW_TEST_CREDENTIALS && String(otp) === "1234") { delete store[phone]; return true; }
    const rec = store[phone];
    if (!rec) return false;
    if (Date.now() - rec.createdAt > 5 * 60 * 1000) { delete store[phone]; return false; }
    if (++rec.attempts > 5) { delete store[phone]; return false; }
    if (safeEqual(rec.otp, String(otp))) { delete store[phone]; return true; }
    return false;
}

// --- HEALTH CHECK ENDPOINT REQUIRED BY CI WORKFLOW ---
app.get('/health', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'OK', stage: 'STAGE_190', timestamp: Date.now() }));
});

// --- MULTI-PANEL FRONTEND ROUTES ---
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "ads.html")); });
app.get("/store", (req, res) => { res.sendFile(path.join(__dirname, "store.html")); });
app.get("/driver", (req, res) => { res.sendFile(path.join(__dirname, "driver.html")); });
app.get("/merchant", (req, res) => { res.sendFile(path.join(__dirname, "merchant.html")); });
app.get("/admin", (req, res) => { res.sendFile(path.join(__dirname, "admin.html")); });
app.get("/ads", (req, res) => { res.sendFile(path.join(__dirname, "ads.html")); });
app.get("/user", (req, res) => { res.sendFile(path.join(__dirname, "store.html")); });

// ============================================================================
// --- DOSECOLOR PRINT ROUTER & UI MOUNT (ADDITIVE BLOCK) ---
// ============================================================================
const printRouter = require('./routes/print');
app.use('/api', printRouter);

app.get('/print', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/print.html'));
});

// ============================================================================
// --- DOSECOLOR PRINT SPOOLER MIDDLEWARE INTERCEPTOR ENDPOINT (ADDITIVE BLOCK) ---
// ============================================================================
const { interceptAndProcessPrintJob } = require('./middleware/printInterceptor');

app.post('/api/middleware/intercept-print', (req, res) => {
    try {
        const { rawText, targetPrinter } = req.body;
        if (!rawText) {
            return res.status(400).json({ success: false, error: "No raw print text received." });
        }

        const result = interceptAndProcessPrintJob(rawText, targetPrinter || "Default_Thermal_Printer");
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================================
// --- GLOBAL STATE FOR MERCHANTS, DRIVERS & CATALOGS ---
// ============================================================================
let pendingMerchants = [];
let approvedMerchants = [];

const SEED_MERCHANT_TOKEN = ALLOW_TEST_CREDENTIALS ? "1234" : String(crypto.randomInt(100000, 1000000));
if (!ALLOW_TEST_CREDENTIALS) console.warn(`[SEED] Default merchant login token for this boot: ${SEED_MERCHANT_TOKEN}`);

let merchantCatalogs = {
    'MERCH_DEF_172': [
        { id: 'K_1', name: 'Sovereign Organic Milk (1L)', category: 'SUPERMARKET', price: 180, merchant: 'Sovereign Supermarket', image: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300' },
        { id: 'K_2', name: 'Premium Grade Rice (2kg)', category: 'SUPERMARKET', price: 320, merchant: 'Sovereign Supermarket', image: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=300' }
    ],
    'MERCH_SPARE_10': [
        { id: 'S_1', name: 'Heavy Duty Boda Brake Pads', category: 'SPARES', price: 650, merchant: 'Sovereign Auto Spare Parts', image: 'https://images.unsplash.com/photo-1486006920555-c77dce18193b?w=300' }
    ]
}; 

let merchantProfiles = {
    'MERCH_DEF_172': {
        merchantId: 'MERCH_DEF_172',
        shopName: "Sovereign Supermarket",
        businessType: "SUPERMARKET",
        phone: "+254712345678",
        gpsLat: -1.2863,
        gpsLon: 36.8172,
        banner: 'https://images.unsplash.com/photo-1578916171728-46686eac8d58?w=500',
        loginToken: SEED_MERCHANT_TOKEN
    },
    'MERCH_SPARE_10': {
        merchantId: 'MERCH_SPARE_10',
        shopName: "Sovereign Auto Spare Parts",
        businessType: "SPARES",
        phone: "+254722334455",
        gpsLat: -1.2789,
        gpsLon: 36.8123,
        banner: 'https://images.unsplash.com/photo-1486006920555-c77dce18193b?w=500',
        loginToken: SEED_MERCHANT_TOKEN
    }
};

function publicProfile(p) {
    if (!p) return p;
    const { loginToken, passportUrl, regNumber, ownerName, mpesaPhone, email, ...safe } = p;
    return safe;
}

function isTenantActive(id) {
    const has = global.merchantProfiles && Object.prototype.hasOwnProperty.call(global.merchantProfiles, id);
    const st = has ? global.merchantProfiles[id].status : undefined;
    return st !== 'SUSPENDED' && st !== 'REVOKED';
}

let merchantOrders = {
    'MERCH_DEF_172': [
        {
            orderId: 'ORD_' + crypto.randomInt(100000, 1000000),
            items: [{ name: "Sovereign Organic Milk (1L)", qty: 2, price: 180 }],
            totalAmount: 360,
            status: 'PENDING_VENDOR_ACCEPTANCE',
            createdAt: Date.now()
        }
    ]
}; 

if (!global.driverQueue) { global.driverQueue = []; }
if (!global.activeDispatches) { global.activeDispatches = {}; }
global.merchantCatalogs = merchantCatalogs;
global.merchantProfiles = merchantProfiles;
global.merchantOrders = merchantOrders;

// ============================================================================
// --- STORE API ROUTER ---
// ============================================================================
let storeProducts = [
    { id: "M_01", category: "SUPERMARKET", name: "Sovereign Organic Milk (1L)", price: 180, merchant: "Nakumatt Supermarket", image: "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300" },
    { id: "M_02", category: "SUPERMARKET", name: "Fresh Farm Bread (Loaf)", price: 110, merchant: "Naivas Supermarket", image: "https://images.unsplash.com/photo-1509440159596-0249088772ff?w=300" },
    { id: "H_01", category: "HOTELS", name: "Executive Suite (1 Night Stay)", price: 15000, merchant: "Serena Hotel", image: "https://images.unsplash.com/photo-1582719508461-905c673771fd?w=300" },
    { id: "H_02", category: "HOTELS", name: "Deluxe Double Room (Breakfast)", price: 9500, merchant: "Radisson Blu", image: "https://images.unsplash.com/photo-1590490360182-c33d57733427?w=300" },
    { id: "R_01", category: "RESTAURANT", name: "Sovereign Nyama Platter", price: 2500, merchant: "Carnivore Grill", image: "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=300" },
    { id: "R_02", category: "RESTAURANT", name: "Artisan Wood-Fired Pizza", price: 1400, merchant: "Artcaffe Bistro", image: "https://images.unsplash.com/photo-1513104890138-7c749659a591?w=300" }
];
let storeOrders = [];

const storeRouter = express.Router();

storeRouter.get('/products', (req, res) => {
    try {
        let dynamicProducts = [...storeProducts];
        const mCatalogs = global.merchantCatalogs || {};
        const mProfiles = global.merchantProfiles || {};

        Object.keys(mCatalogs).forEach(merchantId => {
            if (!isTenantActive(merchantId)) return;
            const profile = mProfiles[merchantId] || { shopName: "Independent Shop", businessType: "General Retail" };
            const catalogList = mCatalogs[merchantId] || [];

            catalogList.forEach(item => {
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

        const { category } = req.query;
        if (typeof category === 'string' && category !== 'ALL') {
            dynamicProducts = dynamicProducts.filter(p => p.category.toUpperCase() === category.toUpperCase());
        }

        res.json({ success: true, currency: 'KES', products: dynamicProducts });
    } catch (err) {
        res.json({ success: true, currency: 'KES', products: storeProducts });
    }
});

storeRouter.post('/checkout', softAuth(ROLES.REGULAR_USER), (req, res) => {
    const tenantId = pickKey(req.headers['x-business-id'] || req.body.merchantId, 'INST-CBK-RTGS');
    if (!tenantId) return bad(res, "Invalid business/merchant id.");
    const orderId = `ORD_${Date.now()}`;
    const escrowId = `ESC_${Date.now()}`;
    
    const { itemsTotal, distanceKm, pickupLocation, dropoffLocation, cartItems, merchantId, userId, phone } = req.body;

    if (itemsTotal !== undefined && !isMoney(itemsTotal)) return bad(res, "itemsTotal must be a non-negative number within limits.");
    if (distanceKm !== undefined && !(Number(distanceKm) >= 0 && Number(distanceKm) <= 500)) return bad(res, "distanceKm out of range.");
    if (cartItems !== undefined && (!Array.isArray(cartItems) || cartItems.length > 100)) return bad(res, "cartItems must be an array (max 100).");
    if (merchantId !== undefined && !isSafeKey(merchantId)) return bad(res, "Invalid merchantId.");
    if (phone !== undefined && !isPhone(phone)) return bad(res, "Invalid phone number.");
    if (!isTenantActive(pickKey(merchantId, 'MERCH_DEF_172'))) return bad(res, "This merchant is currently suspended and cannot take orders.", 403);
    
    const totalPrice = Number(itemsTotal) || 1500;
    const km = Number(distanceKm) || 6.5;
    
    const deliveryFee = Math.round((150 + (km * 35) + (18 * 4)) / 5) * 5;
    const merchantPayout = totalPrice;
    const sysFeeOnItems = totalPrice * 0.02;
    const driverPayout = deliveryFee * 0.95;
    const appDeliveryComm = deliveryFee * 0.05;
    const totalSysIncome = sysFeeOnItems + appDeliveryComm;
    const kraTax = totalSysIncome * 0.16;
    const netSysIncome = totalSysIncome - kraTax;
    const grossTotal = totalPrice + sysFeeOnItems + deliveryFee;

    const distributed = merchantPayout + driverPayout + appDeliveryComm + sysFeeOnItems;
    const ledgerBalanced = Math.abs(grossTotal - distributed) < 0.01;
    if (!ledgerBalanced) return bad(res, "Ledger imbalance detected; order rejected.", 500);

    const assignedDriver = { name: "Kiprono Driver (Bolt/Uber Pro)", phone: "+254 712 345678", payout: driverPayout };

    const newOrder = {
        orderId,
        escrowId,
        tenantId,
        userId: cleanText(userId, 80) || 'ANONYMOUS',
        phone: phone || '+254712345678',
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
        ledgerBalanced,
        status: "DISPATCHED_TO_RIDER",
        timestamp: Date.now(),
        delivery: {
            deliveryId: `DEL_${Date.now()}`,
            pickupLocation: cleanText(pickupLocation, 200) || "Nairobi CBD",
            dropoffLocation: cleanText(dropoffLocation, 200) || "Westlands",
            distanceKm: km,
            status: "DISPATCHED",
            assignedDriver
        }
    };

    storeOrders.push(newOrder);

    const targetMerchantId = pickKey(merchantId, 'MERCH_DEF_172');
    if (!global.merchantOrders) global.merchantOrders = {};
    if (!global.merchantOrders[targetMerchantId]) global.merchantOrders[targetMerchantId] = [];
    
    global.merchantOrders[targetMerchantId].push({
        orderId,
        items: cartItems || [{ name: "Store Item", qty: 1, price: totalPrice }],
        totalAmount: totalPrice,
        shopOwnerPayout: merchantPayout,
        assignedDriver,
        status: 'PENDING_VENDOR_ACCEPTANCE',
        createdAt: Date.now()
    });

    if (global.io) {
        global.io.to(targetMerchantId).emit('new_customer_order', { orderId, items: cartItems, totalAmount: totalPrice, shopOwnerPayout: merchantPayout, assignedDriver });
        global.io.emit('orderListUpdated', { orderId });
    }

    res.json({ success: true, message: "Order auto-dispatched, merchant paid, and escrow locked!", orderRecord: newOrder });
});

storeRouter.get('/orders/:tenantId', softAuth(), (req, res) => {
    const tenantId = req.params.tenantId;
    if (!isSafeKey(tenantId)) return bad(res, "Invalid tenant id.");
    const filtered = storeOrders.filter(o => o.tenantId === tenantId || !o.tenantId);
    res.json({ success: true, orders: filtered });
});

storeRouter.post('/logistics/rider-action', softAuth(ACTOR_ROLES.RIDER), (req, res) => {
    const { deliveryId, action } = req.body;
    const order = storeOrders.find(o => o.delivery && o.delivery.deliveryId === deliveryId);
    if (!order) return res.status(404).json({ success: false, error: "Active delivery session not found." });

    if (action === 'ARRIVED_AT_MERCHANT') {
        order.delivery.status = 'ARRIVED_AT_MERCHANT';
        return res.json({ success: true, message: "Rider arrival confirmed." });
    } else if (action === 'PICKED_COMMODITY') {
        order.delivery.status = 'COMMODITY_LOADED';
        return res.json({ success: true, message: "Commodity loaded." });
    }
    return res.status(400).json({ success: false, error: "Invalid action." });
});

storeRouter.post('/logistics/complete-trip', softAuth(ACTOR_ROLES.RIDER), (req, res) => {
    const { deliveryId } = req.body;
    const order = storeOrders.find(o => o.delivery && o.delivery.deliveryId === deliveryId);
    if (!order) return res.status(404).json({ success: false, error: "Active delivery session not found." });
    if (order.status === 'COMPLETED_SETTLED') return bad(res, "Trip already settled.", 409);
    order.delivery.status = 'COMPLETED';
    order.status = 'COMPLETED_SETTLED';
    res.json({ success: true, message: "Trip completed and escrow released!" });
});
app.use('/api/store', storeRouter);

// ============================================================================
// --- DRIVER API ROUTER ---
// ============================================================================
let otps = {};
let drivers = {};
let driverWallets = {};

const driverRouter = express.Router();

driverRouter.post('/register-and-send-otp', registerLimiter, authLimiter, (req, res) => {
    const { phone, email, name, vehicleType, plate, psvBadge, nationalId, passportSnap, vehicleSnap } = req.body;
    if (!phone || !name || !plate) {
        return res.status(400).json({ success: false, error: "Phone, name, and vehicle plate are required." });
    }
    if (!isPhone(phone)) return bad(res, "Invalid phone number.");

    const driverId = `DRV_${phone.replace(/[^0-9]/g, '')}`;
    drivers[driverId] = {
        id: driverId, name: cleanText(name, 100), phone, email: cleanText(email, 120) || 'driver@rds.com',
        vehicleType: cleanText(vehicleType, 20) || 'BODA', plate: cleanText(plate, 20), psvBadge: cleanText(psvBadge, 40) || 'N/A',
        nationalId: cleanText(nationalId, 30) || 'N/A', hasPassportSnap: !!passportSnap,
        hasVehicleSnap: !!vehicleSnap, verified: true, registeredAt: Date.now(),
        documentsReviewed: false, verificationStatus: 'AUTO_ACCEPTED_PENDING_MANUAL_REVIEW'
    };

    if (!driverWallets[driverId]) driverWallets[driverId] = 0;
    issueOtp(otps, phone, { email });

    res.json({ success: true, message: ALLOW_TEST_CREDENTIALS
        ? `Camera snaps & compliance docs verified! Verification OTP sent to ${phone} (Use 1234).`
        : `Registration received. A verification OTP was sent to ${phone}.` });
});

driverRouter.post('/verify-otp', authLimiter, (req, res) => {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ success: false, error: "Phone and OTP required." });
    if (!isPhone(phone)) return bad(res, "Invalid phone number.");
    if (!checkOtp(otps, phone, otp)) {
        return res.status(401).json({ success: false, error: "Invalid OTP code." });
    }
    const driverId = `DRV_${phone.replace(/[^0-9]/g, '')}`;
    const userProfile = drivers[driverId] || { id: driverId, phone, role: 'RIDER' };
    const token = signJwt({ sub: driverId, driverId, role: ACTOR_ROLES.RIDER }, 12 * 3600);
    res.json({ success: true, message: "Driver authenticated successfully!", user: userProfile, token });
});

driverRouter.get('/dispatches', softAuth(ACTOR_ROLES.RIDER), (req, res) => {
    const bizId = pickKey(req.headers['x-business-id'], 'MERCH_DEF_172');
    if (!bizId) return bad(res, "Invalid business id.");
    if (!global.activeDispatches[bizId]) {
        global.activeDispatches[bizId] = [
            { id: 'DISP_101', isDirectRide: true, vehicleType: 'BODA', pickup: 'Nairobi CBD', destination: 'Westlands', currency: 'KES', total: 450, status: 'PENDING_DRIVER_ACCEPTANCE' }
        ];
    }

    if (global.merchantOrders && global.merchantOrders[bizId]) {
        global.merchantOrders[bizId].forEach(mo => {
            const exists = global.activeDispatches[bizId].some(d => d.id === mo.orderId);
            if (!exists) {
                global.activeDispatches[bizId].push({
                    id: mo.orderId, isDirectRide: false, pickup: 'Merchant Hub / Store',
                    destination: 'Customer Dropoff Point', currency: 'KES', total: mo.totalAmount, status: 'PENDING_DRIVER_ACCEPTANCE'
                });
                if (global.io) {
                    global.io.emit('new_customer_order', { orderId: mo.orderId });
                }
            }
        });
    }

    res.json({ success: true, dispatches: global.activeDispatches[bizId] });
});

driverRouter.get('/queue', softAuth(ACTOR_ROLES.RIDER), (req, res) => {
    res.json({ success: true, queue: global.driverQueue || [] });
});

driverRouter.post('/accept-dispatch', softAuth(ACTOR_ROLES.RIDER), (req, res) => {
    const { dispatchId, driverId } = req.body;
    const bizId = pickKey(req.headers['x-business-id'], 'MERCH_DEF_172');
    if (!bizId) return bad(res, "Invalid business id.");
    if (driverId !== undefined && !isSafeKey(driverId)) return bad(res, "Invalid driverId.");
    const effectiveDriver = (req.user && req.user.driverId) || driverId || 'DRV_001';
    if (!ownsDriver(req, effectiveDriver)) return bad(res, "Forbidden.", 403);
    const dispatches = global.activeDispatches[bizId] || [];
    const dispatch = dispatches.find(d => d.id === dispatchId);
    if (!dispatch) return res.status(404).json({ success: false, error: "Dispatch not found." });
    if (dispatch.status !== 'PENDING_DRIVER_ACCEPTANCE') return bad(res, `Dispatch is ${dispatch.status}, cannot accept.`, 409);

    dispatch.status = 'ACCEPTED_BY_DRIVER';
    dispatch.driverId = effectiveDriver;
    if (global.io) global.io.emit('orderListUpdated', { dispatchId });

    res.json({ success: true, message: "Dispatch accepted successfully!" });
});

driverRouter.post('/complete-dispatch', softAuth(ACTOR_ROLES.RIDER), (req, res) => {
    const { dispatchId, driverId } = req.body;
    const bizId = pickKey(req.headers['x-business-id'], 'MERCH_DEF_172');
    if (!bizId) return bad(res, "Invalid business id.");
    if (driverId !== undefined && !isSafeKey(driverId)) return bad(res, "Invalid driverId.");
    const dispatches = global.activeDispatches[bizId] || [];
    const dispatch = dispatches.find(d => d.id === dispatchId);
    if (!dispatch) return res.status(404).json({ success: false, error: "Dispatch not found." });
    if (dispatch.status === 'COMPLETED') return bad(res, "Dispatch already completed.", 409);

    const drvKey = (req.user && req.user.driverId) || driverId || 'DRV_001';
    if (!ownsDriver(req, drvKey)) return bad(res, "Forbidden.", 403);
    if (dispatch.driverId && dispatch.driverId !== drvKey && (!req.user || req.user.role !== ROLES.SOVEREIGN_ADMIN)) {
        return bad(res, "This dispatch belongs to another driver.", 403);
    }

    dispatch.status = 'COMPLETED';
    if (!driverWallets[drvKey]) driverWallets[drvKey] = 0;
    driverWallets[drvKey] += Number(dispatch.total || dispatch.totalAmount || 500) * 0.85;

    if (global.io) global.io.emit('orderListUpdated', { dispatchId });
    res.json({ success: true, message: "Delivery completed and wallet credited!" });
});

driverRouter.get('/wallet', softAuth(ACTOR_ROLES.RIDER), (req, res) => {
    const ownerId = pickKey(req.query.ownerId, 'DRV_001');
    if (!ownerId) return bad(res, "Invalid ownerId.");
    if (!ownsDriver(req, ownerId)) return bad(res, "Forbidden.", 403);
    const balance = driverWallets[ownerId] || 0;
    res.json({ success: true, ownerId, balance });
});

driverRouter.post('/payout', authLimiter, softAuth(ACTOR_ROLES.RIDER), (req, res) => {
    const { ownerId, amount } = req.body;
    const drvKey = pickKey(ownerId, 'DRV_001');
    if (!drvKey) return bad(res, "Invalid ownerId.");
    if (!ownsDriver(req, drvKey)) return bad(res, "Forbidden.", 403);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_AMOUNT) return bad(res, "Amount must be a positive number.");
    if (!driverWallets[drvKey] || driverWallets[drvKey] < amt) {
        return res.status(400).json({ success: false, error: "Insufficient wallet balance for B2C payout." });
    }
    driverWallets[drvKey] -= amt;
    const payoutId = `MPESA_B2C_${crypto.randomInt(100000, 1000000)}`;
    res.json({ success: true, message: "M-Pesa B2C payout executed successfully!", payoutId, remainingBalance: driverWallets[drvKey], simulated: true });
});
app.use('/api/driver', driverRouter);

// ============================================================================
// --- MERCHANT API ROUTER ---
// ============================================================================
const merchantRouter = express.Router();

merchantRouter.param('merchantId', (req, res, next, val) => isSafeKey(val) ? next() : bad(res, "Invalid merchantId."));

function approvalSig(merchantId) {
    return crypto.createHmac("sha256", JWT_SECRET).update(`approve:${merchantId}`).digest("hex");
}

merchantRouter.get('/all-tenants', (req, res) => {
    try {
        const tenants = approvedMerchants.filter(m => isTenantActive(m.merchantId)).map(m => ({
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
        res.status(500).json({ success: false, error: IS_PROD ? "Internal error." : err.message });
    }
});

merchantRouter.post('/register', registerLimiter, (req, res) => {
    const { shopName, businessType, regNumber, ownerName, phone, mpesaPhone, email, gpsLat, gpsLon, passportImage, storePhoto } = req.body;
    if (!shopName || !ownerName || !phone) return bad(res, "shopName, ownerName and phone are required.");
    if (!isPhone(phone) || (mpesaPhone && !isPhone(mpesaPhone))) return bad(res, "Invalid phone number.");
    if (pendingMerchants.length >= 500) return bad(res, "Registration queue is full. Try again later.", 503);
    const lat = Number(gpsLat), lon = Number(gpsLon);
    if (gpsLat !== undefined && !(lat >= -90 && lat <= 90)) return bad(res, "Invalid gpsLat.");
    if (gpsLon !== undefined && !(lon >= -180 && lon <= 180)) return bad(res, "Invalid gpsLon.");

    const verticalKey = (businessType || 'GENERAL').toUpperCase().replace(/[^A-Z0-9]/g, '_').substring(0, 10);
    const merchantId = `MERCH_${verticalKey}_${Date.now()}`;
    
    const passportUrl = cleanImage(passportImage, 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300');
    const storePhotoUrl = cleanImage(storePhoto, 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300');

    const application = {
        merchantId, shopName: cleanText(shopName, 100), businessType: cleanText(businessType, 40) || 'General Retail',
        regNumber: cleanText(regNumber, 40), ownerName: cleanText(ownerName, 100), phone,
        mpesaPhone: mpesaPhone || phone, email: cleanText(email, 120) || SOVEREIGN_OWNER_EMAIL, gpsLat: gpsLat !== undefined ? lat : -1.2863, 
        gpsLon: gpsLon !== undefined ? lon : 36.8172, passportUrl, storePhotoUrl, status: 'PENDING_ADMIN_APPROVAL', createdAt: Date.now()
    };
    
    pendingMerchants.push(application);
    console.log(`[MERCHANT] Pending approval: ${application.shopName} -> /api/merchant/approve/${merchantId}?sig=${approvalSig(merchantId)}`);
    res.json({ success: true, message: `Registration submitted for ${application.shopName}! Awaiting admin review.` });
});

merchantRouter.get('/approve/:merchantId', (req, res) => {
    const { merchantId } = req.params;

    let authorised = false;
    const h = req.headers['authorization'];
    if (h && h.startsWith('Bearer ')) {
        const p = verifyJwt(h.slice(7).trim());
        authorised = !!p && p.role === ROLES.SOVEREIGN_ADMIN;
    }
    if (!authorised && typeof req.query.sig === 'string' && safeEqual(req.query.sig, approvalSig(merchantId))) authorised = true;
    if (!authorised) return res.status(401).send("<h3>Unauthorised approval link.</h3>");

    const index = pendingMerchants.findIndex(m => m.merchantId === merchantId);
    if (index === -1) return res.status(404).send("<h3>Merchant application not found or already processed.</h3>");

    const merchant = pendingMerchants.splice(index, 1)[0];
    merchant.status = 'APPROVED';
    merchant.loginToken = ALLOW_TEST_CREDENTIALS ? "1234" : String(crypto.randomInt(100000, 1000000));
    approvedMerchants.push(merchant);
    
    merchantProfiles[merchantId] = merchant;
    if (!merchantCatalogs[merchantId]) {
        merchantCatalogs[merchantId] = [
            { id: `${merchantId}_1`, name: "Initial Store Item", category: merchant.businessType || "General Retail", price: 500, stock: 20, image: "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300" }
        ];
    }
    if (!global.merchantOrders[merchantId]) global.merchantOrders[merchantId] = [];
    appendAudit('MERCHANT_APPROVED', { merchantId, shopName: merchant.shopName });

    res.send(`
        <div style="font-family: Arial; padding: 40px; background: #0b0f19; color: #fff; text-align: center;">
            <h1 style="color: #00ff88;">✅ Independent Shop Approved!</h1>
            <p>Shop Name: <strong>${escapeHtml(merchant.shopName)}</strong> (${escapeHtml(merchant.businessType)})</p>
            <p>Owner: <strong>${escapeHtml(merchant.ownerName)}</strong> | Phone: <strong>${escapeHtml(merchant.phone)}</strong></p>
            <p>Generated SMS Login Token: <strong style="color: #38bdf8; font-size: 28px;">${escapeHtml(merchant.loginToken)}</strong></p>
        </div>
    `);
});

merchantRouter.post('/login', authLimiter, (req, res) => {
    const { phone, token } = req.body;
    if (!isPhone(phone) || token === undefined) return bad(res, "Phone and token are required.");
    let merchant = approvedMerchants.find(m => m.phone === phone);
    if (!merchant && phone === '+254712345678') merchant = merchantProfiles['MERCH_DEF_172'];

    if (!merchant) return res.status(404).json({ success: false, error: "Phone number not registered or approved." });
    if (!isTenantActive(merchant.merchantId)) return bad(res, "This merchant account is suspended. Contact support.", 403);
    const tokenOk = (merchant.loginToken && safeEqual(merchant.loginToken, String(token))) || (ALLOW_TEST_CREDENTIALS && String(token) === "1234");
    if (!tokenOk) {
        return res.status(401).json({ success: false, error: ALLOW_TEST_CREDENTIALS ? "Invalid SMS login token. Use 1234 for test account." : "Invalid SMS login token." });
    }

    const jwt = signJwt({ sub: merchant.merchantId, merchantId: merchant.merchantId, role: ACTOR_ROLES.MERCHANT }, 12 * 3600);
    res.json({ success: true, message: "Login successful!", merchantId: merchant.merchantId, shopName: merchant.shopName, businessType: merchant.businessType, token: jwt });
});

merchantRouter.get('/catalog/:merchantId', (req, res) => {
    const { merchantId } = req.params;
    const catalog = merchantCatalogs[merchantId] || merchantCatalogs['MERCH_DEF_172'] || [];
    const profile = merchantProfiles[merchantId] || merchantProfiles['MERCH_DEF_172'] || { shopName: "Independent Shop" };
    res.json({ success: true, profile: publicProfile(profile), catalog });
});

merchantRouter.post('/catalog/update', softAuth(ACTOR_ROLES.MERCHANT), (req, res) => {
    const { merchantId, itemId, name, category, price, stock, image } = req.body;
    const targetId = pickKey(merchantId, 'MERCH_DEF_172');
    if (!targetId) return bad(res, "Invalid merchantId.");
    if (!ownsMerchant(req, targetId)) return bad(res, "You can only edit your own catalog.", 403);
    if (!isTenantActive(targetId)) return bad(res, "Merchant account suspended.", 403);
    if (price !== undefined && !isMoney(price)) return bad(res, "Invalid price.");
    if (stock !== undefined && !(Number.isFinite(Number(stock)) && Number(stock) >= 0 && Number(stock) <= 1000000)) return bad(res, "Invalid stock.");
    if (!merchantCatalogs[targetId]) merchantCatalogs[targetId] = [];
    if (merchantCatalogs[targetId].length >= 2000 && !itemId) return bad(res, "Catalog size limit reached.");

    let item = itemId ? merchantCatalogs[targetId].find(i => i.id === itemId) : null;
    if (item) {
        if (name) item.name = cleanText(name, 120);
        if (category) item.category = cleanText(category, 40);
        if (price !== undefined) item.price = Number(price);
        if (stock !== undefined) item.stock = Number(stock);
        if (image !== undefined) item.image = cleanImage(image, item.image);
    } else {
        merchantCatalogs[targetId].push({
            id: `ITEM_${Date.now()}_${crypto.randomInt(0, 1000)}`,
            name: cleanText(name, 120) || 'New Commodity',
            category: cleanText(category, 40) || 'General Retail',
            price: Number(price) || 500,
            stock: Number(stock) || 10,
            image: cleanImage(image, 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300')
        });
    }

    res.json({ success: true, message: "Tenant catalog updated successfully!", catalog: merchantCatalogs[targetId] });
});

merchantRouter.post('/catalog/delete', softAuth(ACTOR_ROLES.MERCHANT), (req, res) => {
    const { merchantId, itemId } = req.body;
    const targetId = pickKey(merchantId, 'MERCH_DEF_172');
    if (!targetId) return bad(res, "Invalid merchantId.");
    if (!ownsMerchant(req, targetId)) return bad(res, "You can only edit your own catalog.", 403);
    if (merchantCatalogs[targetId]) {
        merchantCatalogs[targetId] = merchantCatalogs[targetId].filter(i => i.id !== itemId);
    }
    res.json({ success: true, message: "Catalog item deleted successfully!", catalog: merchantCatalogs[targetId] || [] });
});

merchantRouter.get('/orders/:merchantId', softAuth(ACTOR_ROLES.MERCHANT), (req, res) => {
    const { merchantId } = req.params;
    if (!ownsMerchant(req, merchantId)) return bad(res, "Forbidden.", 403);
    const orders = global.merchantOrders[merchantId] || merchantOrders[merchantId] || [];
    res.json({ success: true, orders });
});

merchantRouter.post('/orders/accept', softAuth(ACTOR_ROLES.MERCHANT), (req, res) => {
    const { merchantId, orderId } = req.body;
    const targetId = pickKey(merchantId, 'MERCH_DEF_172');
    if (!targetId) return bad(res, "Invalid merchantId.");
    if (!ownsMerchant(req, targetId)) return bad(res, "Forbidden.", 403);
    if (!isTenantActive(targetId)) return bad(res, "Merchant account suspended.", 403);

    if (!global.merchantOrders[targetId]) global.merchantOrders[targetId] = [];
    const orderIndex = global.merchantOrders[targetId].findIndex(o => o.orderId === orderId);
    if (orderIndex === -1) return res.status(404).json({ success: false, error: "Order ID not found." });

    const order = global.merchantOrders[targetId][orderIndex];
    if (order.status !== 'PENDING_VENDOR_ACCEPTANCE') return bad(res, `Order is ${order.status}, cannot accept.`, 409);
    order.status = 'AWAITING_DRIVER_PICKUP';
    order.acceptedAt = Date.now();

    const dispatchPayload = {
        id: order.orderId, orderId: order.orderId, isDirectRide: false, merchantId: targetId,
        pickup: (merchantProfiles[targetId] && merchantProfiles[targetId].shopName) || 'Merchant Store',
        destination: 'Customer Dropoff Point', currency: 'KES', items: order.items, total: order.totalAmount,
        totalAmount: order.totalAmount, status: 'PENDING_DRIVER_ACCEPTANCE', dispatchedAt: Date.now()
    };

    global.driverQueue.push(dispatchPayload);
    if (global.io) {
        global.io.to(targetId).emit('merchant_order_update', order);
        global.io.emit('new_driver_dispatch', dispatchPayload);
        global.io.emit('orderListUpdated', dispatchPayload);
    }

    res.json({ success: true, message: `Order ${orderId} packed and dispatched to driver radar!`, order });
});

merchantRouter.post('/orders/complete-handover', softAuth(ACTOR_ROLES.MERCHANT), (req, res) => {
    const { merchantId, orderId } = req.body;
    const targetId = pickKey(merchantId, 'MERCH_DEF_172');
    if (!targetId) return bad(res, "Invalid merchantId.");
    if (!ownsMerchant(req, targetId)) return bad(res, "Forbidden.", 403);

    if (!global.merchantOrders[targetId]) global.merchantOrders[targetId] = [];
    const orderIndex = global.merchantOrders[targetId].findIndex(o => o.orderId === orderId);
    if (orderIndex === -1) return res.status(404).json({ success: false, error: "Order ID not found." });

    const order = global.merchantOrders[targetId][orderIndex];
    if (order.status === 'COMPLETED & PAID OUT') return bad(res, "Order already completed.", 409);
    order.status = 'COMPLETED & PAID OUT';
    order.completedAt = Date.now();

    if (global.io) {
        global.io.to(targetId).emit('merchant_order_update', order);
        global.io.emit('orderListUpdated', order);
    }

    res.json({ success: true, message: `Order ${orderId} successfully handed over and paid out!`, order });
});
app.use('/api/merchant', merchantRouter);

// ============================================================================
// --- USER & CHECKOUT API ROUTER ---
// ============================================================================
let userOtps = {};
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

function coordOk(c) {
    if (c === undefined || c === null) return true;
    if (typeof c !== 'object') return false;
    const lat = c.lat === undefined ? 0 : Number(c.lat), lng = c.lng === undefined ? 0 : Number(c.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

const userRouter = express.Router();

userRouter.post('/send-otp', authLimiter, (req, res) => {
    const { phone, email } = req.body;
    if (!phone) {
        return res.status(400).json({ success: false, error: "Phone number is required." });
    }
    if (!isPhone(phone)) return bad(res, "Invalid phone number.");
    issueOtp(userOtps, phone, { email });
    res.json({ success: true, message: ALLOW_TEST_CREDENTIALS
        ? `Verification OTP sent to ${phone} (Use 1234 for test).`
        : `Verification OTP sent to ${phone}.` });
});

userRouter.post('/verify-otp', authLimiter, (req, res) => {
    const { phone, otp, role, email } = req.body;
    if (!phone || !otp) {
        return res.status(400).json({ success: false, error: "Phone and OTP are required." });
    }
    if (!isPhone(phone)) return bad(res, "Invalid phone number.");
    if (!checkOtp(userOtps, phone, otp)) {
        return res.status(401).json({ success: false, error: "Invalid or expired OTP code." });
    }
    const userId = `USR_${phone.replace(/[^0-9]/g, '')}`;
    const safeRole = role === 'REGULAR_USER' ? 'REGULAR_USER' : 'USER';
    const userProfile = { id: userId, phone, email: cleanText(email, 120) || SOVEREIGN_OWNER_EMAIL, role: safeRole, verifiedAt: Date.now() };
    users[userId] = userProfile;
    const token = signJwt({ sub: userId, userId, role: ROLES.REGULAR_USER }, 12 * 3600);
    res.json({ success: true, message: "Authentication successful!", user: userProfile, token });
});

userRouter.get('/tenants', (req, res) => {
    try {
        const tenants = Object.keys(merchantProfiles).filter(isTenantActive).map(id => ({
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
        res.status(500).json({ success: false, error: IS_PROD ? "Internal error." : err.message });
    }
});

userRouter.get('/products', (req, res) => {
    const merchantId = pickKey(req.headers['x-business-id'] || req.query.merchantId, 'MERCH_DEF_172');
    if (!merchantId) return bad(res, "Invalid merchantId.");
    const currency = 'KES';
    let products = merchantCatalogs[merchantId] || merchantCatalogs['MERCH_DEF_172'] || [];
    if (!isTenantActive(merchantId)) products = [];
    const { category } = req.query;
    if (typeof category === 'string' && category !== 'ALL') {
        products = products.filter(p => String(p.category).toUpperCase() === category.toUpperCase());
    }
    res.json({ success: true, currency, products });
});

userRouter.post('/calculate-total', (req, res) => {
    const { itemPriceTotal, pickupCoords, destinationCoords, vehicleType } = req.body;
    if (itemPriceTotal !== undefined && !isMoney(itemPriceTotal)) return bad(res, "itemPriceTotal must be a non-negative number within limits.");
    if (!coordOk(pickupCoords) || !coordOk(destinationCoords)) return bad(res, "Invalid coordinates.");
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

userRouter.post('/checkout', softAuth(ROLES.REGULAR_USER), (req, res) => {
    const { phone, itemPriceTotal, pickupCoords, destinationCoords, vehicleType, pickup, destination, businessId, userId, items } = req.body;
    if (itemPriceTotal !== undefined && !isMoney(itemPriceTotal)) return bad(res, "itemPriceTotal must be a non-negative number within limits.");
    if (!coordOk(pickupCoords) || !coordOk(destinationCoords)) return bad(res, "Invalid coordinates.");
    if (phone !== undefined && !isPhone(phone)) return bad(res, "Invalid phone number.");
    if (items !== undefined && (!Array.isArray(items) || items.length > 100)) return bad(res, "items must be an array (max 100).");
    if (businessId !== undefined && !isSafeKey(businessId)) return bad(res, "Invalid businessId.");
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
    const orderId = `ORD_${crypto.randomInt(100000, 1000000)}`;

    const assignedDrivers = [
        { name: "John Kiprop", vehicle: "Honda Ace (KBX 420Y)", phone: "+254711223344", payout: riderShare },
        { name: "David Ochieng", vehicle: "Toyota Vitz (KDD 910Z)", phone: "+254722334455", payout: riderShare }
    ];
    const assignedDriver = assignedDrivers[Math.floor(Math.random() * assignedDrivers.length)];
    const resolvedItems = (items && items.length > 0) ? items : [{ name: `${isCar ? 'Cab' : 'Boda'} Ride`, qty: 1, price: total }];
    const isDirectRide = (businessId === 'DIRECT_RIDE' || commodityCost <= 0);

    const newOrder = {
        id: orderId,
        userId: cleanText(userId, 80) || 'ANONYMOUS',
        phone,
        pickup: cleanText(pickup, 200) || 'Nairobi CBD',
        destination: cleanText(destination, 200) || 'Kasarani',
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
        status: isDirectRide ? 'DISPATCHED_STRAIGHT_TO_DRIVER' : 'HELD_IN_ESCROW_PENDING_PACKAGING',
        createdAt: Date.now()
    };

    if (isDirectRide) {
        if (!global.driverQueue) global.driverQueue = [];
        const directDispatch = {
            id: orderId,
            orderId: orderId,
            isDirectRide: true,
            pickup: newOrder.pickup,
            destination: newOrder.destination,
            currency,
            total,
            totalAmount: total,
            assignedDriver,
            status: 'PENDING_DRIVER_ACCEPTANCE',
            dispatchedAt: Date.now()
        };
        global.driverQueue.push(directDispatch);

        if (!activeOrders['DIRECT_RIDES']) activeOrders['DIRECT_RIDES'] = [];
        activeOrders['DIRECT_RIDES'].push(newOrder);

        if (global.io) {
            global.io.emit('new_driver_dispatch', directDispatch);
            global.io.emit('orderListUpdated', directDispatch);
        }

        return res.json({ success: true, message: "Ride dispatched straight to driver radar with zero compromise.", orderId, total, assignedDriver });
    }

    const targetMerchant = pickKey(businessId, 'MERCH_DEF_172');
    if (!isTenantActive(targetMerchant)) return bad(res, "This merchant is currently suspended and cannot take orders.", 403);
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
        global.io.to(targetMerchant).emit('new_customer_order', { orderId, items: resolvedItems, totalAmount: total, shopOwnerPayout, assignedDriver });
        global.io.emit('orderListUpdated', { orderId });
    }

    res.json({ success: true, message: "Order sent to merchant store with instant ringer alarm.", orderId, total, assignedDriver });
});

userRouter.get('/orders/live', softAuth(), (req, res) => {
    const merchantId = pickKey(req.headers['x-business-id'], 'MERCH_DEF_172');
    if (!merchantId) return bad(res, "Invalid business id.");
    const orders = (activeOrders[merchantId] || []).concat(activeOrders['DIRECT_RIDES'] || []);
    res.json({ success: true, orders });
});

userRouter.post('/orders/dismiss', softAuth(), (req, res) => {
    const { orderId, businessId } = req.body;
    const bizKey = pickKey(businessId, 'MERCH_DEF_172');
    if (!bizKey) return bad(res, "Invalid businessId.");
    
    let found = false;
    for (let key in activeOrders) {
        const order = activeOrders[key].find(o => o.id === orderId);
        if (order) {
            order.status = 'ORDERLY_DISMISSED';
            found = true;
        }
    }
    if (!found && activeOrders[bizKey]) {
        const order = activeOrders[bizKey].find(o => o.id === orderId);
        if (order) {
            order.status = 'ORDERLY_DISMISSED';
            found = true;
        }
    }

    if (!found) return res.status(404).json({ success: false, error: "Order ID not found." });

    if (global.io) global.io.emit('orderListUpdated', { orderId });
    res.json({ success: true, message: `Order ${orderId} dismissed and escrow rolled back.` });
});

app.use('/api/user', userRouter);

// ============================================================================
// --- SOVEREIGN COMPLIANCE & ADMIN EXTENDED STATE STORES ---
// ============================================================================
let sovereignVerifications = [];
let sovereignTransactions = [];
let sovereignAuditStream = [];
let lanTrafficLogs = [
    { timestamp: new Date().toLocaleTimeString(), clientIp: "127.0.0.1", method: "GET", endpoint: "/api/admin/dashboard", status: "200 OK" }
];
let connectedPeripheralsList = [
    { peripheralId: "PERIPH_CAM_01", deviceType: "Biometric Face Camera", connectionMode: "Wired USB 3.0", docHashSnippet: "e3b0c442...98fc1c14", timestamp: Date.now() },
    { peripheralId: "PERIPH_POS_02", deviceType: "NFC Terminal Reader", connectionMode: "Bluetooth BLE", docHashSnippet: "8f434346...1a2b3c4d", timestamp: Date.now() }
];

const AUDIT_GENESIS = "0".repeat(64);
const AUDIT_FILE = path.join(process.env.DATA_DIR || __dirname, "audit-chain.jsonl");
const AUDIT_HMAC_KEY = process.env.AUDIT_HMAC_KEY || JWT_SECRET;

function auditBlockHash(prev, e) {
    return crypto.createHash("sha256").update(prev + stableStringify({
        index: e.index, auditId: e.auditId, timestamp: e.timestamp, actionType: e.actionType, payloadHash: e.payloadHash
    })).digest("hex");
}

function appendAudit(actionType, record) {
    const prev = sovereignAuditStream.length ? sovereignAuditStream[sovereignAuditStream.length - 1].currentHash : AUDIT_GENESIS;
    const entry = {
        index: sovereignAuditStream.length,
        auditId: `AUD_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
        timestamp: Date.now(),
        actionType,
        payloadHash: crypto.createHmac("sha256", AUDIT_HMAC_KEY).update(stableStringify(record)).digest("hex"),
        previousHash: prev
    };
    entry.currentHash = auditBlockHash(prev, entry);
    sovereignAuditStream.push(entry);
    fs.appendFile(AUDIT_FILE, JSON.stringify(entry) + "\n", (err) => {
        if (err) console.error("[AUDIT] Persist failed:", err.message);
    });
    return entry;
}

function verifyAuditChain(stream = sovereignAuditStream) {
    let prev = AUDIT_GENESIS;
    for (let i = 0; i < stream.length; i++) {
        const e = stream[i];
        if (e.index !== i || e.previousHash !== prev || e.currentHash !== auditBlockHash(prev, e)) {
            return { valid: false, length: stream.length, brokenAtIndex: i };
        }
        prev = e.currentHash;
    }
    return { valid: true, length: stream.length, headHash: prev };
}

(function loadAuditChain() {
    try {
        if (!fs.existsSync(AUDIT_FILE)) return;
        const lines = fs.readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean);
        sovereignAuditStream = lines.map(l => JSON.parse(l));
        const r = verifyAuditChain();
        if (!r.valid) console.error(`🚨 AUDIT CHAIN TAMPERING DETECTED at block ${r.brokenAtIndex} of ${r.length}`);
        else console.log(`🔐 Audit chain restored: ${r.length} blocks verified.`);
    } catch (e) {
        console.error("[AUDIT] Could not load chain:", e.message);
    }
})();

const corridorStatus = {};       
const corridorRequests = [];     
function tenantOf(req) { return pickKey(req.headers['x-business-id'], 'INST-CBK-RTGS'); }
function tenantBlocked(id) { return ['SUSPENDED', 'REVOKED'].includes(corridorStatus[id]); }

// ============================================================================
// --- ADMIN & COMPLIANCE API ROUTER ---
// ============================================================================
const adminRouter = express.Router();

adminRouter.get('/dashboard', verifySovereignTokenStrict, requireAdminRoleStrict, (req, res) => { 
    res.json({ success: true, message: "Admin active" }); 
});

adminRouter.get('/status', verifySovereignTokenStrict, requireAdminRoleStrict, (req, res) => { 
    res.json({ success: true, status: 'Operational', securityKernel: 'Active' }); 
});

adminRouter.get('/compliance-dashboard', verifySovereignTokenStrict, requireAdminRoleStrict, (req, res) => {
    const baseCorridors = [
        { id: "INST-CBK-RTGS", name: "Central Bank of Kenya", type: "CENTRAL_BANK", currency: "KES", status: "APPROVED_ACTIVE" },
        { id: "INST-MPESA", name: "M-Pesa Mobile Money Hub", type: "MOBILE_MONEY", currency: "KES", status: "APPROVED_ACTIVE" },
        { id: "INST-EQUITY", name: "Equity Bank Commercial Node", type: "COMMERCIAL_BANK", currency: "KES", status: "APPROVED_ACTIVE" }
    ];
    res.json({
        success: true,
        localIdVerificationsCount: sovereignVerifications.length,
        transactionsCount: sovereignTransactions.length,
        lanTrafficLogsCount: lanTrafficLogs.length,
        aiApprovedIntentsCount: 12,
        shadowTrapsCount: 2,
        makerCheckerCount: 4,
        sarQueueCount: 0,
        posWebhooksCount: 5,
        didPassesCount: 8,
        compliancePushCount: 3,
        placeholderMetrics: ["aiApprovedIntentsCount", "shadowTrapsCount", "makerCheckerCount", "sarQueueCount", "posWebhooksCount", "didPassesCount", "compliancePushCount"],
        vaultBlocksCount: sovereignAuditStream.length,
        auditChainValid: verifyAuditChain().valid,
        verifications: sovereignVerifications,
        transactions: sovereignTransactions,
        corridors: baseCorridors.map(c => ({ ...c, status: corridorStatus[c.id] || c.status }))
    });
});

adminRouter.get('/lan-traffic-logs', verifySovereignTokenStrict, requireAdminRoleStrict, (req, res) => {
    res.json({ success: true, lanTrafficLogs });
});

adminRouter.get('/sovereign-vault', verifySovereignTokenStrict, requireAdminRoleStrict, (req, res) => {
    res.json({ success: true, vaultBlocks: sovereignAuditStream });
});

adminRouter.post('/toggle-tenant-status', verifySovereignTokenStrict, requireSovereignAdminOnly, (req, res) => {
    const { tenantId, status } = req.body;
    const ALLOWED = ["APPROVED_ACTIVE", "SUSPENDED", "REVOKED"];
    if (!isSafeKey(tenantId) || !ALLOWED.includes(status)) return bad(res, `tenantId required; status must be one of ${ALLOWED.join(", ")}.`);
    corridorStatus[tenantId] = status;
    appendAudit('TENANT_STATUS_CHANGE', { tenantId, status, by: req.user.email || req.user.sub });
    res.json({ success: true, message: `Tenant ${tenantId} status successfully updated to ${status}.` });
});

adminRouter.post('/request-tenant-corridor', verifySovereignTokenStrict, (req, res) => {
    const { businessName } = req.body;
    if (!businessName || typeof businessName !== 'string') return bad(res, "businessName is required.");
    const reqRec = { requestId: `CORR_${Date.now()}`, businessName: cleanText(businessName, 120), requestedBy: req.user.email || req.user.sub, status: 'PENDING_OWNER_APPROVAL', createdAt: Date.now() };
    corridorRequests.push(reqRec);
    appendAudit('TENANT_CORRIDOR_REQUEST', reqRec);
    res.json({ success: true, message: `Tenant corridor request for "${reqRec.businessName}" submitted successfully for owner approval.` });
});

const adminModule = require('./routes/admin');
adminModule.init({
    verifyToken: verifySovereignTokenStrict,
    requireAdmin: requireAdminRoleStrict,
    requireSuperAdmin: requireSovereignAdminOnly,
    appendAudit,
    verifyAuditChain,
    corridorStatus,
    corridorRequests,
    state: () => ({
        verifications: sovereignVerifications,
        transactions: sovereignTransactions,
        lanTrafficLogs,
        auditStream: sovereignAuditStream
    })
});
app.use('/api/admin', adminModule);
app.use('/api/admin', adminRouter);

// ============================================================================
// --- COMPLIANCE & AUDIT STANDALONE ENDPOINTS ---
// ============================================================================
app.get('/api/compliance/generate-regulatory-package', verifySovereignTokenStrict, requireAdminRoleStrict, (req, res) => {
    const tenantId = pickKey(req.headers['x-business-id'], 'INST-CBK-RTGS');
    if (!tenantId) return bad(res, "Invalid business id.");
    const integrity = verifyAuditChain();
    const regulatoryPackage = {
        institution: tenantId,
        generatedAt: new Date().toISOString(),
        framework: "RDS Sovereign Financial OS v190.0 ULTIMATE",
        complianceStatus: integrity.valid ? "VERIFIED_COMPLIANT" : "AUDIT_INTEGRITY_FAILURE",
        metrics: {
            tierEcKYC: sovereignVerifications.length,
            cddEddLinked: true,
            auditTrailBlocks: sovereignAuditStream.length
        },
        auditChain: integrity,
        certificationNotice: "This document certifies that all transactions and tenant ledgers comply with mathematical audit standards and Central Bank regulatory frameworks."
    };
    res.json({ success: true, regulatoryPackage });
});

app.post('/api/kyc/verify-biometric-face', verifySovereignTokenStrict, requireRoles(ROLES.SOVEREIGN_ADMIN, ROLES.COMMERCIAL_CASHIER), (req, res) => {
    const { fullName, nationalIdNumber, countryCode, initialDeposit, selfieSha256 } = req.body;
    const tenantId = tenantOf(req);
    if (!tenantId) return bad(res, "Invalid business id.");
    if (tenantBlocked(tenantId)) return bad(res, `Corridor ${tenantId} is ${corridorStatus[tenantId]}: operations frozen.`, 403);
    if (!fullName || !nationalIdNumber) return bad(res, "fullName and nationalIdNumber are required.");
    if (selfieSha256 !== undefined && !/^[a-f0-9]{64}$/.test(selfieSha256)) return bad(res, "selfieSha256 must be a 64-char hex digest.");
    if (initialDeposit !== undefined && !isMoney(initialDeposit)) return bad(res, "Invalid initialDeposit.");
    const accountId = `ACC_${crypto.randomInt(100000, 1000000)}`;
    const newRecord = {
        accountId, tenantId, selfieSha256: selfieSha256 || null, fullName: cleanText(fullName, 100), nationalIdNumber: cleanText(nationalIdNumber, 30),
        registrySource: countryCode === 'KE' ? 'Kenya IPRS Bureau' : 'International Registry',
        initialDeposit: Number(initialDeposit) || 0,
        riskRating: 'LOW_RISK (99.8%)',
        simulated: true,
        status: 'VERIFIED_ACTIVE',
        timestamp: Date.now()
    };
    sovereignVerifications.push(newRecord);
    appendAudit('BIOMETRIC_KYC_VERIFICATION', newRecord);
    res.json({ success: true, message: `Account ${accountId} successfully opened with biometric liveness verification!`, simulated: true });
});

app.post('/api/cashier/process-transaction', verifySovereignTokenStrict, requireRoles(ROLES.SOVEREIGN_ADMIN, ROLES.COMMERCIAL_CASHIER), (req, res) => {
    const { customerName, amount, transactionType } = req.body;
    const tenantId = tenantOf(req);
    if (!tenantId) return bad(res, "Invalid business id.");
    if (tenantBlocked(tenantId)) return bad(res, `Corridor ${tenantId} is ${corridorStatus[tenantId]}: operations frozen.`, 403);
    if (amount === undefined || !isMoney(amount) || Number(amount) <= 0) return bad(res, "amount must be a positive number within limits.");
    const tx = {
        timestamp: Date.now(),
        tenantId,
        customerName: cleanText(customerName, 100) || 'Anonymous',
        amount: money2(amount),
        transactionType: cleanText(transactionType, 40) || 'Cash Deposit',
        riskLevel: 'LOW_RISK',
        cashierId: req.user.email || req.user.sub
    };
    sovereignTransactions.push(tx);
    appendAudit('CASHIER_TRANSACTION', tx);
    res.json({ success: true, riskScore: 2, simulated: true, message: "Transaction processed, enforced, and cryptographically anchored." });
});

app.get('/api/audit/search', verifySovereignTokenStrict, requireAdminRoleStrict, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().substring(0, 80) : '';
    const stream = q
        ? sovereignAuditStream.filter(b => b.actionType.toLowerCase().includes(q) || b.currentHash.includes(q) || b.payloadHash.includes(q) || String(b.index) === q)
        : sovereignAuditStream;
    res.json({ success: true, total: sovereignAuditStream.length, auditStream: stream.slice(-500) });
});

app.get('/api/hardware/peripherals', verifySovereignTokenStrict, requireAdminRoleStrict, (req, res) => {
    res.json({ success: true, connectedPeripherals: connectedPeripheralsList });
});

app.get('/api/ai/openapi.json', (req, res) => {
    res.json({
        openapi: "3.0.0",
        info: { title: "RDS Sovereign Financial OS API", version: "190.0" },
        paths: { "/api/admin/compliance-dashboard": { get: { summary: "Compliance Dashboard metrics" } } }
    });
});

app.post('/api/ai/intent-eval', verifySovereignTokenStrict, (req, res) => {
    res.json({
        success: true,
        simulated: true,
        intentResult: { intentId: `INTENT_${crypto.randomInt(1000, 10000)}`, status: "APPROVED", confidence: "99.8%" }
    });
});

// ============================================================================
// --- AUTH ISSUANCE + AUDIT INTEGRITY + MERCHANT REVIEW ---
// ============================================================================
const authRouter = express.Router();

authRouter.post('/admin-login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        const hash = process.env.SOVEREIGN_ADMIN_PASSWORD_HASH;
        const plain = process.env.SOVEREIGN_ADMIN_PASSWORD;
        if (!hash && !plain) return bad(res, "Admin login is not configured on this server.", 503);
        if (typeof email !== 'string' || typeof password !== 'string') return bad(res, "email and password required.");
        const emailOk = safeEqual(email.toLowerCase(), SOVEREIGN_OWNER_EMAIL.toLowerCase());
        const passOk = hash ? await bcrypt.compare(password, hash) : safeEqual(password, plain);
        if (!emailOk || !passOk) {
            appendAudit('ADMIN_LOGIN_FAILED', { email: cleanText(email, 120), ip: req.ip });
            return bad(res, "Invalid credentials.", 401);
        }
        appendAudit('ADMIN_LOGIN', { email: SOVEREIGN_OWNER_EMAIL, ip: req.ip });
        res.json({ success: true, token: signJwt({ sub: SOVEREIGN_OWNER_EMAIL, email: SOVEREIGN_OWNER_EMAIL, role: ROLES.SOVEREIGN_ADMIN }, 8 * 3600) });
    } catch (e) {
        bad(res, "Login failed.", 500);
    }
});
app.use('/api/auth', authRouter);

const adminExtras = express.Router();
adminExtras.use(verifySovereignTokenStrict);

adminExtras.post('/issue-token', requireSovereignAdminOnly, (req, res) => {
    const { email, role, ttlHours } = req.body;
    const allowed = [ROLES.CENTRAL_BANK_AUDITOR, ROLES.COMMERCIAL_CASHIER];
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, "Valid email required.");
    if (!allowed.includes(role)) return bad(res, `role must be one of ${allowed.join(", ")}.`);
    const hours = Math.min(Math.max(Number(ttlHours) || 8, 1), 24);
    appendAudit('TOKEN_ISSUED', { email, role, by: req.user.email });
    res.json({ success: true, token: signJwt({ sub: email, email, role }, hours * 3600), expiresInHours: hours });
});

adminExtras.get('/audit-integrity', requireAdminRoleStrict, (req, res) => {
    res.json({ success: true, integrity: verifyAuditChain() });
});

adminExtras.get('/pending-merchants', requireAdminRoleStrict, (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
        success: true,
        pending: pendingMerchants.map(m => ({
            merchantId: m.merchantId, shopName: m.shopName, businessType: m.businessType, ownerName: m.ownerName,
            phone: m.phone, createdAt: m.createdAt, approvalLink: `${base}/api/merchant/approve/${m.merchantId}?sig=${approvalSig(m.merchantId)}`
        }))
    });
});
app.use('/api/admin', adminExtras);

// ============================================================================
// --- SAFE MOUNT FOR ADS & REELS ROUTER ---
// ============================================================================
const adsRouter = require('./routes/ads');
if (adsRouter) {
    if (typeof adsRouter.setSocketIo === 'function') {
        adsRouter.setSocketIo(io);
    }
    if (typeof adsRouter === 'function') {
        app.use('/api/ads', adsRouter);
    } else if (typeof adsRouter.router === 'function') {
        app.use('/api/ads', adsRouter.router);
    } else {
        console.warn("⚠️ [SERVER] adsRouter module loaded, but is not a valid express middleware router function.");
    }
}

// HARDENED: unknown API paths return JSON 404
app.use('/api', (req, res) => res.status(404).json({ success: false, error: "Not found." }));

// --- FALLBACK ERROR HANDLER ---
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: "Malformed JSON body." });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, error: "Payload too large." });
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: "File too large." });
    if (err instanceof multer.MulterError) return res.status(400).json({ success: false, error: err.message });
    console.error("[ERROR]", req.method, req.originalUrl, err && err.stack ? err.stack : err);
    res.status(500).json({ success: false, error: IS_PROD ? "Internal server error." : err.message });
});

process.on('unhandledRejection', (r) => console.error('[UNHANDLED REJECTION]', r));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT EXCEPTION]', e));

server.keepAliveTimeout = 65000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 RDS Sovereign Enterprise Server Stage 190 Fully Active on port ${PORT}`);
});

['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => {
    console.log(`${sig} received: shutting down.`);
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
}));