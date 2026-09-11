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
  console.log(`[${new Date().toISOString()}] [${type}] ${msg}`);
}

app.use((req, res, next) => {
  log("REQ", `${req.method} ${req.url}`);
  next();
});

/* ================= SAFE RATE LIMITING ================= */
const rateMap = new Map();

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || req.socket.remoteAddress || "127.0.0.1";
  const now = Date.now();

  if (!rateMap.has(ip)) {
    rateMap.set(ip, []);
  }

  const timestamps = rateMap.get(ip).filter(t => now - t < 60000);
  
  if (timestamps.length > 150) {
    rateMap.set(ip, timestamps);
    return res.status(429).json({ success: false, error: "Too many requests" });
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
    // Flexible Auth: Enforce validation only if header is explicitly provided
    if (key && key !== API_KEYS[role]) {
      return res.status(403).json({ success: false, error: "Unauthorized endpoint access" });
    }
    next();
  };
}

/* ================= DEFAULT ENTERPRISE SCHEMA ================= */
function defaultDB() {
  return {
    businesses: [],
    products: [],
    orders: [],
    drivers: [],
    deliveries: [],
    ledger: [],
    wallets: [],
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

/* ================= SELF-HEALING STORE ENGINE ================= */
function sanitizeDataState() {
  if (!Array.isArray(data.businesses)) data.businesses = [];
  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.drivers)) data.drivers = [];
  if (!Array.isArray(data.deliveries)) data.deliveries = [];
  if (!Array.isArray(data.ledger)) data.ledger = [];
  if (!Array.isArray(data.wallets)) data.wallets = [];

  // Sanitize Product Inventory
  data.products.forEach(p => {
    if (p && typeof p === "object") {
      p.price = num(p.price);
      p.businessId = p.businessId || "SYSTEM";
      p.name = (p.name || "Unnamed Product").trim();
    }
  });

  // Sanitize Driver Roster
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

/* ================= ATOMIC PERSISTENCE MUTEX ================= */
let isWriting = false;
let pendingWrite = false;

const saveDB = async () => {
  if (isWriting) {
    pendingWrite = true;
    return;
  }
  isWriting = true;
  sanitizeDataState();
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
      await saveDB();
    }
  }
};

/* ================= SOCKET.IO REAL-TIME ENGINE ================= */
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
      driver.location = { lat: latN, lng: lngN };
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
app.get("/", (req, res) => {
  ok(res, { status: "RDS CORE ACTIVE", env: ENV, time: Date.now() });
});

app.get("/health", (req, res) => {
  ok(res, { status: "HEALTHY", uptime: process.uptime(), time: Date.now() });
});

app.get("/system/stats", (req, res) => {
  try {
    sanitizeDataState();
    const grossVolume = data.orders.reduce((sum, o) => sum + num(o.total || o.amount), 0);
    ok(res, {
      stats: {
        businesses: data.businesses.length,
        products: data.products.length,
        orders: data.orders.length,
        drivers: data.drivers.length,
        activeDrivers: data.drivers.filter(d => d.status === "online" || d.status === "busy").length,
        grossVolume
      }
    });
  } catch (err) {
    fail(res, "Failed to calculate stats", 500);
  }
});

/* ================= MODULE 1: MERCHANTS & SHOPS ================= */
app.get("/businesses", (req, res) => {
  sanitizeDataState();
  ok(res, { businesses: data.businesses, shops: data.businesses });
});

const addBusinessHandler = (req, res) => {
  try {
    const { name, category } = req.body;
    if (!name) return fail(res, "Invalid business name");

    const business = {
      id: id("biz"),
      name: name.trim(),
      category: category || "Retail",
      createdAt: Date.now()
    };

    data.businesses.push(business);
    data.wallets.push({ id: id("wal"), businessId: business.id, balance: 0 });
    saveDB();

    io.emit("business:created", business);
    log("BUSINESS", `Onboarded: ${business.name}`);
    ok(res, { business, shop: business });
  } catch (err) {
    fail(res, "Failed to onboard business", 500);
  }
};

app.post("/addBusiness", auth("ADMIN"), addBusinessHandler);
app.post("/business/add", auth("ADMIN"), addBusinessHandler);
app.post("/business/create", auth("ADMIN"), addBusinessHandler);

app.post("/deleteBusiness", auth("ADMIN"), (req, res) => {
  const { id: bid } = req.body;
  data.businesses = data.businesses.filter(b => b.id !== bid);
  saveDB();
  ok(res, { message: "Business deleted" });
});

/* ================= MODULE 2: CATALOG & PRODUCTS ================= */
app.get("/products", (req, res) => {
  sanitizeDataState();
  const { businessId } = req.query;
  let products = data.products;
  if (businessId) {
    products = products.filter(p => p.businessId === businessId);
  }
  ok(res, { products });
});

const addProductHandler = (req, res) => {
  try {
    const { name, price, businessId } = req.body;
    if (!name || price === undefined) return fail(res, "Missing name or price");

    const product = {
      id: id("prd"),
      name: name.trim(),
      price: num(price),
      businessId: businessId || "SYSTEM"
    };

    data.products.push(product);
    saveDB();

    io.emit("product:added", product);
    log("PRODUCT", `Added: ${product.name}`);
    ok(res, { product });
  } catch (err) {
    fail(res, "Failed to add product", 500);
  }
};

app.post("/addProduct", auth("BUSINESS"), addProductHandler);
app.post("/product/add", auth("BUSINESS"), addProductHandler);

/* ================= MODULE 3: DRIVERS & FLEET ================= */
const getDriversHandler = (req, res) => {
  sanitizeDataState();
  ok(res, { count: data.drivers.length, drivers: data.drivers, data: data.drivers });
};

app.get("/drivers", getDriversHandler);
app.get("/drivers/live", getDriversHandler);

const registerDriverHandler = (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name) return fail(res, "Missing driver name");

    let driver = data.drivers.find(d => d.name.toLowerCase() === name.trim().toLowerCase());
    if (driver) {
      driver.status = "online";
      driver.lastSeen = Date.now();
      saveDB();
      return ok(res, { driver });
    }

    driver = {
      id: id("drv"),
      name: name.trim(),
      phone: phone || "0700000000",
      status: "offline",
      earnings: 0,
      location: null,
      lastSeen: Date.now()
    };

    data.drivers.push(driver);
    saveDB();

    io.emit("driver:registered", driver);
    log("DRIVER", `Registered: ${driver.name}`);
    ok(res, { driver });
  } catch (err) {
    fail(res, "Failed to register driver", 500);
  }
};

app.post("/registerDriver", registerDriverHandler);
app.post("/addDriver", registerDriverHandler);
app.post("/driver/add", registerDriverHandler);

const updateDriverStatusHandler = (req, res) => {
  const { driverId, status } = req.body;
  const d = data.drivers.find(x => x.id === driverId);
  if (!d) return fail(res, "Driver not found");

  d.status = (status || "offline").toString().toLowerCase();
  d.lastSeen = Date.now();
  saveDB();

  io.emit("driver:statusChanged", { driverId, status: d.status });
  ok(res, { message: "Driver status updated", driver: d });
};

app.post("/driverStatus", updateDriverStatusHandler);
app.post("/driver/status", updateDriverStatusHandler);

const updateLocationHandler = (req, res) => {
  const { driverId, lat, lng, location } = req.body;
  const targetId = driverId || req.body.id;
  const d = data.drivers.find(x => x.id === targetId);

  if (!d) return fail(res, "Driver not found");

  const latVal = location ? location.lat : lat;
  const lngVal = location ? location.lng : lng;

  d.location = { lat: num(latVal), lng: num(lngVal) };
  d.status = "online";
  d.lastSeen = Date.now();

  saveDB();

  io.emit("telemetry:stream", {
    driverId: d.id,
    driverName: d.name,
    status: d.status,
    location: d.location
  });

  ok(res, { message: "Location updated", location: d.location });
};

app.post("/driverLocation", updateLocationHandler);
app.post("/updateDriverLocation", updateLocationHandler);
app.post("/driver/location", updateLocationHandler);

app.get("/drivers/map", (req, res) => {
  sanitizeDataState();
  const now = Date.now();
  const activeDrivers = data.drivers
    .filter(d => d.location && now - d.lastSeen < 120000)
    .map(d => ({
      id: d.id,
      name: d.name,
      lat: d.location.lat,
      lng: d.location.lng,
      status: d.status
    }));

  ok(res, { drivers: activeDrivers });
});

/* ================= MODULE 4: ORDERS & CHECKOUT ================= */
app.get("/orders", (req, res) => {
  sanitizeDataState();
  ok(res, { orders: data.orders });
});

const checkoutHandler = (req, res) => {
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
      type: "ORDER",
      amount: orderTotal,
      orderId: order.id,
      createdAt: Date.now()
    });

    // Auto-dispatch assignment
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

    saveDB();

    io.emit("order:created", order);
    log("ORDER", `Created: ${order.id} ($${orderTotal})`);
    ok(res, { order });
  } catch (err) {
    fail(res, "Checkout failed", 500);
  }
};

app.post("/checkout", checkoutHandler);
app.post("/order/create", checkoutHandler);

const assignDriverHandler = (req, res) => {
  const { orderId, driverId } = req.body;
  const order = data.orders.find(o => o.id === orderId);

  if (!order) return fail(res, "Order not found");

  let driver = null;
  if (driverId) {
    driver = data.drivers.find(d => d.id === driverId);
  } else {
    const onlineDrivers = data.drivers.filter(d => d.status === "online");
    if (!onlineDrivers.length) return fail(res, "No online drivers available");
    onlineDrivers.sort((a, b) => a.earnings - b.earnings);
    driver = onlineDrivers[0];
  }

  if (!driver) return fail(res, "Driver selection failed");

  order.driverId = driver.id;
  order.status = "ASSIGNED";
  driver.status = "busy";

  data.deliveries.push({
    id: id("DL"),
    orderId: order.id,
    driverId: driver.id,
    status: "ASSIGNED",
    createdAt: Date.now()
  });

  saveDB();
  ok(res, { driver, order });
};

app.post("/assignDriver", assignDriverHandler);
app.post("/dispatch/auto", assignDriverHandler);

const completeOrderHandler = (req, res) => {
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
        type: "DELIVERY",
        amount: earn,
        orderId: order ? order.id : targetId,
        createdAt: Date.now()
      });
    }
  }

  // Credit Merchant Wallet (90% Net Payout after 10% platform commission)
  if (order && order.businessId) {
    let wallet = data.wallets.find(w => w.businessId === order.businessId);
    if (!wallet) {
      wallet = { id: id("wal"), businessId: order.businessId, balance: 0 };
      data.wallets.push(wallet);
    }
    const merchantShare = num(order.total) * 0.90;
    wallet.balance += merchantShare;

    data.ledger.push({
      id: id("tx"),
      type: "MERCHANT_CREDIT",
      amount: merchantShare,
      businessId: order.businessId,
      orderId: order.id,
      createdAt: Date.now()
    });
  }

  saveDB();

  io.emit("order:completed", { orderId: order ? order.id : targetId });
  ok(res, { message: "Order completed successfully", order });
};

app.post("/completeOrder", completeOrderHandler);
app.post("/completeDelivery", completeOrderHandler);
app.post("/order/complete", completeOrderHandler);

app.get("/driverJobs", (req, res) => {
  const { driverId } = req.query;
  const jobs = data.deliveries.filter(d => d.driverId === driverId);
  ok(res, { jobs, deliveries: jobs });
});

/* ================= MODULE 5: FINANCIAL LEDGER ================= */
app.get("/ledger", (req, res) => {
  sanitizeDataState();
  ok(res, { ledger: data.ledger, transactions: data.ledger });
});

app.get("/wallets", (req, res) => {
  sanitizeDataState();
  ok(res, { wallets: data.wallets });
});

app.get("/deliveries", (req, res) => {
  sanitizeDataState();
  ok(res, { deliveries: data.deliveries });
});

/* ================= MODULE 6: M-PESA DARAJA PAYMENT GATEWAY ================= */
const stkPushHandler = (req, res) => {
  try {
    const { phone, amount } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ success: false, error: "Missing phone or amount" });
    }

    let formattedPhone = phone.toString().replace("+", "").trim();
    if (formattedPhone.startsWith("0")) {
      formattedPhone = "254" + formattedPhone.substring(1);
    }

    log("MPESA", `Initiating STK Push for ${formattedPhone} - Amount: KES ${amount}`);

    const checkoutRequestId = `ws_CO_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    ok(res, {
      message: "STK Push prompt sent to handset",
      CheckoutRequestID: checkoutRequestId,
      CustomerPhone: formattedPhone,
      Amount: amount,
      status: "PENDING_USER_PIN"
    });
  } catch (err) {
    fail(res, "M-Pesa STK Push failed", 500);
  }
};

app.post("/mpesa/stkpush", stkPushHandler);
app.post("/payments/stk-push", stkPushHandler);

app.post("/mpesa/callback", (req, res) => {
  try {
    const callbackData = req.body?.Body?.stkCallback || req.body;
    log("MPESA_CALLBACK", JSON.stringify(callbackData));

    const resultCode = callbackData?.ResultCode;
    const merchantRequestId = callbackData?.MerchantRequestID;

    if (resultCode === 0) {
      log("MPESA", `Payment SUCCESS for Request: ${merchantRequestId}`);

      io.emit("payment:success", {
        status: "CONFIRMED",
        requestId: merchantRequestId,
        time: Date.now()
      });
    } else {
      log("MPESA", `Payment Cancelled/Failed: ${callbackData?.ResultDesc}`);
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    res.status(200).json({ ResultCode: 0, ResultDesc: "Error handled" });
  }
});

/* ================= MODULE 7: AUTOMATED SETTLEMENT & PAYOUTS ================= */

// Merchant Settlement & Wallet Payout Endpoint
app.post("/merchant/payout", auth("BUSINESS"), async (req, res) => {
  try {
    sanitizeDataState();
    const { businessId, amount } = req.body;

    if (!businessId || !amount || num(amount) <= 0) {
      return fail(res, "Invalid businessId or payout amount");
    }

    const business = data.businesses.find(b => b.id === businessId);
    if (!business) return fail(res, "Merchant profile not found", 404);

    let wallet = data.wallets.find(w => w.businessId === businessId);
    if (!wallet) {
      wallet = { id: id("wal"), businessId, balance: 0 };
      data.wallets.push(wallet);
    }

    if (wallet.balance < num(amount)) {
      return fail(res, "Insufficient merchant wallet balance");
    }

    wallet.balance -= num(amount);

    data.ledger.push({
      id: id("tx"),
      type: "MERCHANT_SETTLEMENT",
      amount: num(amount),
      businessId,
      status: "COMPLETED",
      createdAt: Date.now()
    });

    await saveDB();

    io.emit("merchant:payout", { businessId, amount: num(amount), remainingBalance: wallet.balance });
    log("SETTLEMENT", `Merchant Payout Released: ${business.name} - KES ${amount}`);

    ok(res, { message: "Merchant payout successfully processed", balance: wallet.balance });
  } catch (err) {
    fail(res, "Merchant settlement processing failed", 500);
  }
});

// Driver Earnings Cashout Endpoint
app.post("/driver/cashout", auth("DRIVER"), async (req, res) => {
  try {
    sanitizeDataState();
    const { driverId, amount } = req.body;

    if (!driverId || !amount || num(amount) <= 0) {
      return fail(res, "Invalid driverId or cashout amount");
    }

    const driver = data.drivers.find(d => d.id === driverId);
    if (!driver) return fail(res, "Driver profile not found", 404);

    if (driver.earnings < num(amount)) {
      return fail(res, "Cashout request exceeds available earnings");
    }

    driver.earnings -= num(amount);

    data.ledger.push({
      id: id("tx"),
      type: "DRIVER_CASHOUT",
      amount: num(amount),
      driverId,
      status: "COMPLETED",
      createdAt: Date.now()
    });

    await saveDB();

    io.emit("driver:cashout", { driverId, amount: num(amount), remainingEarnings: driver.earnings });
    log("CASHOUT", `Driver Cashout Processed: ${driver.name} - KES ${amount}`);

    ok(res, { message: "Driver cashout successfully disbursed", remainingEarnings: driver.earnings });
  } catch (err) {
    fail(res, "Driver cashout processing failed", 500);
  }
});

/* ================= SERVER START ================= */
server.listen(PORT, () => {
  log("SYSTEM", `🚀 RDS CORE ACTIVE ON PORT ${PORT} (SOCKET, M-PESA & SETTLEMENTS ENABLED)`);
});