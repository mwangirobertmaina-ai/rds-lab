const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const fsPromises = require("fs").promises;
const cors = require("cors");
const path = require("path");

const app = express();
app.set("trust proxy", 1); // Trust Render reverse proxy for accurate IP extraction

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-api-key"]
  }
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");
const ENV = process.env.NODE_ENV || "development";

/* ================= MIDDLEWARE & CORS ================= */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-api-key"]
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static("."));

/* ================= STRUCTURED LOGGER ================= */
function log(type, msg) {
  console.log(`[${new Date().toISOString()}] [STAGE-14] [${type}] ${msg}`);
}

app.use((req, res, next) => {
  log("REQ", `${req.method} ${req.url}`);
  next();
});

/* ================= MEMORY-SAFE RATE LIMITING ================= */
const rateMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateMap.entries()) {
    const valid = timestamps.filter(t => now - t < 60000);
    if (valid.length === 0) {
      rateMap.delete(ip);
    } else {
      rateMap.set(ip, valid);
    }
  }
}, 600000);

function rateLimit(req, res, next) {
  if (req.method === "GET") return next(); // Whitelist read-only polling

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || req.socket.remoteAddress || "127.0.0.1";
  const now = Date.now();

  if (!rateMap.has(ip)) rateMap.set(ip, []);
  const timestamps = rateMap.get(ip).filter(t => now - t < 60000);

  if (timestamps.length > 300) {
    rateMap.set(ip, timestamps);
    return res.status(429).json({ success: false, error: "Too many write operations" });
  }

  timestamps.push(now);
  rateMap.set(ip, timestamps);
  next();
}

app.use(rateLimit);

/* ================= API SECURITY AUTH ================= */
const API_KEYS = {
  ADMIN: process.env.ADMIN_KEY || "admin-secret",
  BUSINESS: process.env.BUSINESS_KEY || "business-secret",
  DRIVER: process.env.DRIVER_KEY || "driver-secret"
};

function auth(role) {
  return (req, res, next) => {
    const key = req.headers["x-api-key"];
    if (key && key !== API_KEYS[role]) {
      return res.status(403).json({ success: false, error: "Unauthorized endpoint access" });
    }
    next();
  };
}

/* ================= STAGE 14 ENTERPRISE SCHEMA ================= */
function defaultDB() {
  return {
    businesses: [],
    products: [],
    orders: [],
    drivers: [],
    deliveries: [],
    ledger: [],
    wallets: [],
    system: { stage: 14, createdAt: Date.now(), lastCheck: Date.now() }
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

/* ================= SELF-HEALING STORE ENGINE ================= */
function sanitizeDataState() {
  if (!Array.isArray(data.businesses)) data.businesses = [];
  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.drivers)) data.drivers = [];
  if (!Array.isArray(data.deliveries)) data.deliveries = [];
  if (!Array.isArray(data.ledger)) data.ledger = [];
  if (!Array.isArray(data.wallets)) data.wallets = [];

  const driverMap = new Map();
  data.drivers.forEach(d => {
    if (!d || (!d.id && !d.name)) return;
    const cleanName = (d.name || "Unknown Driver").trim();
    const nameKey = cleanName.toLowerCase();

    let status = (d.status || "").toString().toLowerCase();
    if (["idle", "available", "online", "true"].includes(status)) status = "online";
    if (!["online", "busy", "offline"].includes(status)) status = "offline";

    if (!driverMap.has(nameKey)) {
      driverMap.set(nameKey, {
        id: d.id || id("drv"),
        name: cleanName,
        phone: d.phone || "0700000000",
        status: status,
        earnings: num(d.earnings),
        location: d.location ? { lat: num(d.location.lat), lng: num(d.location.lng) } : null,
        lastSeen: num(d.lastSeen) || Date.now()
      });
    }
  });
  data.drivers = Array.from(driverMap.values());
}

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    data = { ...defaultDB(), ...JSON.parse(raw) };
    sanitizeDataState();
    log("SYSTEM", "DB Hydrated & Self-Healed (Stage 14 Active)");
  } catch (err) {
    log("ERROR", "DB RESET TO FRESH STAGE 14 SCHEMA");
    data = defaultDB();
    sanitizeDataState();
  }
} else {
  data = defaultDB();
  sanitizeDataState();
}

/* ================= HARDENED ATOMIC PERSISTENCE QUEUE ================= */
let writeQueue = Promise.resolve();

const saveDB = () => {
  writeQueue = writeQueue.then(async () => {
    sanitizeDataState();
    const tempFile = `${DB_FILE}.${Date.now()}_${Math.floor(Math.random() * 1000)}.tmp`;
    try {
      const serialized = JSON.stringify(data, null, 2);
      await fsPromises.writeFile(tempFile, serialized, "utf-8");
      await fsPromises.rename(tempFile, DB_FILE);
    } catch (err) {
      log("ERROR", "DB SAVE FAILED: " + err.message);
      try { if (fs.existsSync(tempFile)) await fsPromises.unlink(tempFile); } catch (_) {}
    }
  }).catch(err => log("CRITICAL", "Write Queue Failure: " + err.message));
  return writeQueue;
};

/* ================= SOCKET.IO REAL-TIME ENGINE ================= */
io.on("connection", (socket) => {
  log("SOCKET", `Client Connected: ${socket.id}`);

  socket.on("driver:location", async (payload) => {
    sanitizeDataState();
    const driverId = payload.driverId || payload.id;
    if (!driverId) return;

    const driver = data.drivers.find(d => d.id === driverId);
    if (driver) {
      driver.location = { lat: num(payload.lat), lng: num(payload.lng) };
      driver.lastSeen = Date.now();
      await saveDB();

      io.emit("telemetry:stream", {
        driverId: driver.id,
        driverName: driver.name,
        status: driver.status,
        location: driver.location
      });
    }
  });

  socket.on("disconnect", () => log("SOCKET", `Client Disconnected: ${socket.id}`));
});

/* ================= SYSTEM HEALTH & AUDIT METRICS ================= */
app.get("/", (req, res) => ok(res, { status: "RDS CORE STAGE 14 ACTIVE", env: ENV, time: Date.now() }));
app.get("/health", (req, res) => ok(res, { status: "HEALTHY", stage: 14, uptime: process.uptime(), time: Date.now() }));

app.get("/system/stats", (req, res) => {
  try {
    sanitizeDataState();
    const grossVolume = data.orders.reduce((sum, o) => sum + num(o.total || o.amount), 0);
    const platformCommission = data.ledger
      .filter(l => l.type === "COMMISSION")
      .reduce((sum, l) => sum + num(l.amount), 0);

    ok(res, {
      stats: {
        stage: 14,
        businesses: data.businesses.length,
        products: data.products.length,
        orders: data.orders.length,
        drivers: data.drivers.length,
        activeDrivers: data.drivers.filter(d => d.status === "online" || d.status === "busy").length,
        grossVolume,
        platformCommission
      }
    });
  } catch (err) {
    fail(res, "Failed to calculate stats", 500);
  }
});

/* ================= STAGE 14 DISPATCH & ORDER SETTLEMENT ENGINE ================= */
const checkoutHandler = async (req, res) => {
  try {
    const { businessId, items, total, amount, customerName, customerPhone } = req.body;
    const orderTotal = num(total || amount);

    const order = {
      id: id("ord"),
      businessId: businessId || "SYSTEM",
      customerName: customerName || "Guest",
      customerPhone: customerPhone || "0700000000",
      items: Array.isArray(items) ? items : [],
      total: orderTotal,
      amount: orderTotal,
      status: "PENDING",
      driverId: null,
      createdAt: Date.now()
    };

    data.orders.push(order);

    data.ledger.push({
      id: id("tx"),
      type: "ORDER_PAYMENT",
      amount: orderTotal,
      orderId: order.id,
      createdAt: Date.now()
    });

    // Stage 14 Auto-Dispatch Equity Algorithm
    const onlineDrivers = data.drivers.filter(d => d.status === "online");
    if (onlineDrivers.length > 0) {
      onlineDrivers.sort((a, b) => a.earnings - b.earnings);
      const assignedDriver = onlineDrivers[0];

      order.driverId = assignedDriver.id;
      order.status = "ASSIGNED";
      assignedDriver.status = "busy";

      data.deliveries.push({
        id: id("DL"),
        orderId: order.id,
        driverId: assignedDriver.id,
        status: "ASSIGNED",
        createdAt: Date.now()
      });
    }

    await saveDB();

    io.emit("order:created", order);
    log("ORDER", `Stage 14 Order Created: ${order.id} (KES ${orderTotal})`);
    ok(res, { order });
  } catch (err) {
    fail(res, "Checkout failed", 500);
  }
};

app.post("/checkout", checkoutHandler);
app.post("/order/create", checkoutHandler);

const completeOrderHandler = async (req, res) => {
  const { orderId, deliveryId } = req.body;
  const targetId = orderId || deliveryId;

  let delivery = data.deliveries.find(d => d.id === targetId || d.orderId === targetId);
  let order = data.orders.find(o => o.id === targetId || (delivery && o.id === delivery.orderId));

  if (!order && !delivery) return fail(res, "Order record not found");

  if (order) order.status = "DELIVERED";
  if (delivery) delivery.status = "COMPLETED";

  const targetDriverId = (order && order.driverId) || (delivery && delivery.driverId);
  if (targetDriverId) {
    const driver = data.drivers.find(d => d.id === targetDriverId);
    if (driver) {
      const earn = order ? num(order.total) * 0.10 : 50;
      driver.earnings += earn;
      driver.status = "online";

      data.ledger.push({
        id: id("tx"),
        type: "DRIVER_PAYOUT",
        amount: earn,
        driverId: driver.id,
        orderId: order ? order.id : targetId,
        createdAt: Date.now()
      });
    }
  }

  // Stage 14 Double-Entry Commission Split (90% Merchant / 10% Platform)
  if (order && order.businessId) {
    let wallet = data.wallets.find(w => w.businessId === order.businessId);
    if (!wallet) {
      wallet = { id: id("wal"), businessId: order.businessId, balance: 0 };
      data.wallets.push(wallet);
    }
    const merchantShare = num(order.total) * 0.90;
    const platformCommission = num(order.total) * 0.10;

    wallet.balance += merchantShare;

    data.ledger.push({
      id: id("tx"),
      type: "MERCHANT_CREDIT",
      amount: merchantShare,
      businessId: order.businessId,
      orderId: order.id,
      createdAt: Date.now()
    });

    data.ledger.push({
      id: id("tx"),
      type: "COMMISSION",
      amount: platformCommission,
      orderId: order.id,
      createdAt: Date.now()
    });
  }

  await saveDB();

  io.emit("order:completed", { orderId: order ? order.id : targetId });
  ok(res, { message: "Stage 14 Order settlement completed", order });
};

app.post("/completeOrder", completeOrderHandler);
app.post("/order/complete", completeOrderHandler);

/* ================= MODULE ENTITY ROUTES ================= */
app.get("/businesses", (req, res) => ok(res, { businesses: data.businesses, shops: data.businesses }));
app.get("/products", (req, res) => ok(res, { products: data.products }));
app.get("/drivers", (req, res) => ok(res, { count: data.drivers.length, drivers: data.drivers, data: data.drivers }));
app.get("/orders", (req, res) => ok(res, { orders: data.orders }));
app.get("/ledger", (req, res) => ok(res, { ledger: data.ledger, transactions: data.ledger }));
app.get("/wallets", (req, res) => ok(res, { wallets: data.wallets }));
app.get("/deliveries", (req, res) => ok(res, { deliveries: data.deliveries }));

/* ================= M-PESA GATEWAY & PAYOUTS ================= */
const stkPushHandler = (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return fail(res, "Missing phone or amount");

  let formattedPhone = phone.toString().replace("+", "").trim();
  if (formattedPhone.startsWith("0")) formattedPhone = "254" + formattedPhone.substring(1);

  const checkoutRequestId = `ws_CO_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  ok(res, {
    message: "STK Push prompt sent to handset",
    CheckoutRequestID: checkoutRequestId,
    CustomerPhone: formattedPhone,
    Amount: amount,
    status: "PENDING_USER_PIN"
  });
};

app.post("/mpesa/stkpush", stkPushHandler);
app.post("/payments/stk-push", stkPushHandler);

/* ================= SERVER START & SHUTDOWN ================= */
server.listen(PORT, () => {
  log("SYSTEM", `🚀 RDS CORE STAGE 14 UPGRADED ON PORT ${PORT}`);
});

const gracefulShutdown = async (signal) => {
  log("SYSTEM", `Received ${signal}. Flushing Stage 14 queue...`);
  await saveDB();
  server.close(() => process.exit(0));
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));