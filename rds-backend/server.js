const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const fsPromises = require("fs").promises;
const cors = require("cors");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
  }
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

/* ========================================== */
/* DYNAMIC CORS & EXPRESS MIDDLEWARE          */
/* ========================================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static("."));

/* ================= STRUCTURED LOGGER ================= */
function log(type, msg) {
  console.log(`[${new Date().toISOString()}] [${type}] ${msg}`);
}

app.use((req, res, next) => {
  log("REQ", `${req.method} ${req.url}`);
  next();
});

/* ================= HEALTH CHECK ================= */
app.get("/health", (req, res) => {
  res.json({ status: "HEALTHY", uptime: process.uptime(), time: Date.now() });
});

app.get("/api/health", (req, res) => {
  res.json({ success: true, status: "OK", timestamp: Date.now() });
});

/* ================= WORKING FRONTEND ROUTES ================= */
app.get("/", (req, res) => {
  res.send(`<h1>RDS Welcome</h1><p>Try: <a href="/store">/store</a> | <a href="/driver">/driver</a> | <a href="/merchant">/merchant</a> | <a href="/admin">/admin</a> | <a href="/ads">/ads</a></p>`);
});

app.get("/store", (req, res) => {
  res.send(`<h1>Store Panel</h1><div id="app"></div><script>
    fetch('/api/store/products').then(r => r.json()).then(d => {
      document.getElementById('app').innerHTML = '<pre>' + JSON.stringify(d, null, 2) + '</pre>';
    }).catch(e => { document.getElementById('app').innerHTML = 'Network error: ' + e; });
  </script>`);
});

app.get("/driver", (req, res) => {
  res.send(`<h1>Driver Panel</h1><div id="app"></div><script>
    fetch('/api/driver/dispatches').then(r => r.json()).then(d => {
      document.getElementById('app').innerHTML = '<pre>' + JSON.stringify(d, null, 2) + '</pre>';
    }).catch(e => { document.getElementById('app').innerHTML = 'Network error: ' + e; });
  </script>`);
});

app.get("/merchant", (req, res) => {
  res.send(`<h1>Merchant Panel</h1><div id="app"></div><script>
    fetch('/api/merchant/inventory').then(r => r.json()).then(d => {
      document.getElementById('app').innerHTML = '<pre>' + JSON.stringify(d, null, 2) + '</pre>';
    }).catch(e => { document.getElementById('app').innerHTML = 'Network error: ' + e; });
  </script>`);
});

app.get("/admin", (req, res) => {
  res.send(`<h1>Admin Panel</h1><p>Access requires Bearer token</p>`);
});

app.get("/ads", (req, res) => {
  res.send(`<h1>Ads Panel</h1><div id="app"></div><script>
    fetch('/api/ads/list').then(r => r.json()).then(d => {
      document.getElementById('app').innerHTML = '<pre>' + JSON.stringify(d, null, 2) + '</pre>';
    }).catch(e => { document.getElementById('app').innerHTML = 'Network error: ' + e; });
  </script>`);
});

/* ================= WORKING API ENDPOINTS ================= */

// Store API
const storeRouter = express.Router();
storeRouter.get('/products', (req, res) => {
  res.json({
    success: true,
    products: [
      { id: "PROD_001", name: "Laptop", price: 50000, stock: 10, category: "Electronics" },
      { id: "PROD_002", name: "Phone", price: 30000, stock: 25, category: "Electronics" },
      { id: "PROD_003", name: "Headphones", price: 5000, stock: 100, category: "Accessories" }
    ]
  });
});
app.use('/api/store', storeRouter);

// Driver API
const driverRouter = express.Router();
driverRouter.get('/dispatches', (req, res) => {
  res.json({
    success: true,
    dispatches: [
      { id: "DISP_001", driver: "Kevin Kiprop", status: "ACTIVE", location: "Nairobi CBD", earnings: 5000 },
      { id: "DISP_002", driver: "Mercy Wanjiku", status: "ACTIVE", location: "Westlands", earnings: 3500 },
      { id: "DISP_003", driver: "Brian Omondi", status: "OFFLINE", location: "Karen", earnings: 4200 }
    ]
  });
});
app.use('/api/driver', driverRouter);

// Merchant API
const merchantRouter = express.Router();
merchantRouter.get('/inventory', (req, res) => {
  res.json({
    success: true,
    inventory: [
      { sku: "INV_001", item: "Rice (50kg)", quantity: 200, supplier: "Farmers Co-op" },
      { sku: "INV_002", item: "Cooking Oil (20L)", quantity: 150, supplier: "Oil Industries Ltd" },
      { sku: "INV_003", item: "Flour (25kg)", quantity: 300, supplier: "Grain Mills" }
    ]
  });
});
app.use('/api/merchant', merchantRouter);

// Ads API
const adsRouter = express.Router();
adsRouter.get('/list', (req, res) => {
  res.json({
    success: true,
    ads: [
      { id: "AD_001", title: "Buy Now - 50% Off", campaign: "Summer Sale", impressions: 15000 },
      { id: "AD_002", title: "Free Shipping", campaign: "Promo", impressions: 8500 },
      { id: "AD_003", title: "Loyalty Rewards", campaign: "VIP", impressions: 12000 }
    ]
  });
});
app.use('/api/ads', adsRouter);

// Admin API
const adminRouter = express.Router();
adminRouter.get('/status', (req, res) => {
  res.json({ success: true, status: 'Operational', systemHealth: 'HEALTHY' });
});
app.use('/api/admin', adminRouter);

// User API
const userRouter = express.Router();
userRouter.get('/profile', (req, res) => {
  res.json({ success: true, user: { id: "USR_001", name: "Demo User", email: "user@example.com" } });
});
app.use('/api/user', userRouter);

/* ================= DEFAULT ENTERPRISE SCHEMA ================= */
function defaultDB() {
  return {
    businesses: [],
    products: [],
    orders: [],
    drivers: [],
    deliveries: [],
    ledger: [],
    wallets: {
      SYSTEM_PLATFORM: { balance: 0, escrow: 0 }
    },
    system: { createdAt: Date.now(), lastCheck: Date.now() }
  };
}

let data = defaultDB();

/* ================= HELPERS & CALCULATORS ================= */
function id(prefix = "SYS") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 99999)}`;
}

function num(v) {
  const parsed = Number(v);
  return isNaN(parsed) ? 0 : parsed;
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

function fail(res, msg = "Error", statusCode = 400) {
  return res.status(statusCode).json({ success: false, error: msg });
}

function calculateDistanceKM(lat1, lon1, lat2, lon2) {
  const nLat1 = num(lat1);
  const nLon1 = num(lon1);
  const nLat2 = num(lat2);
  const nLon2 = num(lon2);

  if (!nLat1 && !nLon1 && !nLat2 && !nLon2) return Infinity;

  const R = 6371;
  const dLat = (nLat2 - nLat1) * Math.PI / 180;
  const dLon = (nLon2 - nLon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(nLat1 * Math.PI / 180) * Math.cos(nLat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* ================= SELF-HEALING STORE ENGINE ================= */
function sanitizeDataState() {
  if (!Array.isArray(data.businesses)) data.businesses = [];
  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.drivers)) data.drivers = [];
  if (!Array.isArray(data.deliveries)) data.deliveries = [];
  if (!Array.isArray(data.ledger)) data.ledger = [];
  if (!data.wallets || typeof data.wallets !== "object") {
    data.wallets = { SYSTEM_PLATFORM: { balance: 0, escrow: 0 } };
  }
  if (!data.system || typeof data.system !== "object") {
    data.system = { createdAt: Date.now(), lastCheck: Date.now() };
  }

  data.products.forEach(p => {
    if (p && typeof p === "object") {
      p.price = num(p.price);
      p.stock = p.stock !== undefined ? Math.max(0, Math.floor(num(p.stock))) : 50;
      p.businessId = p.businessId || "SYSTEM";
      p.name = (p.name || "Unnamed Product").trim();
      p.createdAt = p.createdAt || Date.now();
    }
  });

  const driverNameMap = new Map();
  data.drivers.forEach(d => {
    if (!d || (!d.id && !d.name)) return;
    const cleanName = (d.name || "Unknown Driver").trim();
    const nameKey = cleanName.toLowerCase();

    let status = (d.status || "").toString().toLowerCase();
    if (["idle", "available", "online", "true"].includes(status)) status = "online";
    if (!["online", "busy", "offline"].includes(status)) status = "offline";

    if (!driverNameMap.has(nameKey)) {
      const primaryDriver = {
        id: d.id || id("DRV"),
        name: cleanName,
        phone: d.phone || "0700000000",
        vehicle: d.vehicle || "Motorbike KAB 123X",
        status: status,
        earnings: num(d.earnings),
        location: d.location && !isNaN(num(d.location.lat)) && !isNaN(num(d.location.lng)) ? {
          lat: num(d.location.lat),
          lng: num(d.location.lng),
          heading: num(d.location.heading),
          speed: num(d.location.speed)
        } : { lat: -1.286389, lng: 36.817223 },
        lastSeen: num(d.lastSeen) || Date.now(),
        createdAt: num(d.createdAt) || Date.now()
      };
      driverNameMap.set(nameKey, primaryDriver);
    } else {
      const primary = driverNameMap.get(nameKey);
      primary.earnings = Math.max(primary.earnings, num(d.earnings));
      if (["online", "busy"].includes(status)) primary.status = status;
      if (d.location) primary.location = d.location;
      primary.lastSeen = Math.max(primary.lastSeen, num(d.lastSeen));
    }
  });
  data.drivers = Array.from(driverNameMap.values());

  if (!data.wallets["SYSTEM_PLATFORM"]) {
    data.wallets["SYSTEM_PLATFORM"] = { balance: 0, escrow: 0 };
  }
}

// Initial Boot Hydration
if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    data = { ...defaultDB(), ...parsed };
    sanitizeDataState();
    log("SYSTEM", "DB Hydrated & Self-Healed Successfully");
  } catch (err) {
    log("ERROR", "DB CORRUPTED — RESET TO FRESH SCHEMA");
    data = defaultDB();
    sanitizeDataState();
  }
} else {
  data = defaultDB();
  sanitizeDataState();
}

/* ================= ATOMIC NON-BLOCKING PERSISTENCE ================= */
let isWriting = false;
let pendingWrite = false;

const saveDB = async () => {
  if (isWriting) {
    pendingWrite = true;
    return;
  }
  isWriting = true;
  sanitizeDataState();
  data.system.lastCheck = Date.now();
  const tempFile = `${DB_FILE}.${Date.now()}_${Math.floor(Math.random() * 1000)}.tmp`;
  try {
    const serialized = JSON.stringify(data, null, 2);
    await fsPromises.writeFile(tempFile, serialized, "utf-8");
    await fsPromises.rename(tempFile, DB_FILE);
  } catch (err) {
    log("ERROR", "DB ATOMIC SAVE FAILED: " + err.message);
    try {
      if (fs.existsSync(tempFile)) await fsPromises.unlink(tempFile);
    } catch (_) {}
  } finally {
    isWriting = false;
    if (pendingWrite) {
      pendingWrite = false;
      saveDB();
    }
  }
};

/* ================= SOCKET.IO REAL-TIME STREAMING ENGINE ================= */
io.on("connection", (socket) => {
  log("SOCKET", `Client Connected: ${socket.id}`);

  socket.on("driver:location", (payload) => {
    sanitizeDataState();
    const driverId = payload.driverId || payload.id;
    if (!driverId) return;

    const latN = num(payload.lat);
    const lngN = num(payload.lng);
    const driver = data.drivers.find(d => d.id === driverId);

    if (driver) {
      driver.location = { lat: latN, lng: lngN, heading: num(payload.heading), speed: num(payload.speed) };
      driver.lastSeen = Date.now();
      saveDB();

      io.emit("telemetry:stream", {
        driverId: driver.id,
        driverName: driver.name,
        status: driver.status,
        location: driver.location
      });
    }
  });

  socket.on("disconnect", () => {
    log("SOCKET", `Client Disconnected: ${socket.id}`);
  });
});

/* ================= SYSTEM HEALTH & METRICS ================= */
app.get("/system/stats", (req, res) => {
  try {
    sanitizeDataState();
    const grossVolume = data.orders.reduce((sum, o) => sum + num(o.total || o.amount), 0);
    const totalCommission = data.ledger
      .filter(l => l.type === "COMMISSION" || l.type === "DELIVERY_PAYOUT")
      .reduce((sum, l) => sum + num(l.amount), 0);

    ok(res, {
      stats: {
        businesses: data.businesses.length,
        products: data.products.length,
        orders: data.orders.length,
        drivers: data.drivers.length,
        activeDrivers: data.drivers.filter(d => d.status === "online" || d.status === "busy").length,
        grossVolume,
        totalCommission
      }
    });
  } catch (err) {
    fail(res, "Failed to calculate stats", 500);
  }
});

/* ================= GLOBAL ERROR CATCH ================= */
app.use((err, req, res, next) => {
  log("CRITICAL_ERROR", err.stack || err.message);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

/* ================= SERVER START ================= */
server.listen(PORT, () => {
  log("SYSTEM", `RDS HYBRID CORE SERVER RUNNING ON PORT ${PORT} (SOCKET_ENABLED)`);
});
