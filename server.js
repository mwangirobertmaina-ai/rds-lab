const express = require("express");
const fs = require("fs");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

/* ================= ENV ================= */
const ENV = process.env.NODE_ENV || "development";

/* ================= BASIC SECURITY ================= */

// Simple API key system (upgrade later to JWT)
const API_KEYS = {
  ADMIN: "admin-secret",
  BUSINESS: "business-secret",
  DRIVER: "driver-secret"
};

function auth(role) {
  return (req, res, next) => {
    const key = req.headers["x-api-key"];
    if (!key || key !== API_KEYS[role]) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }
    next();
  };
}

/* ================= RATE LIMIT ================= */

const rateMap = {};

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();

  if (!rateMap[ip]) {
    rateMap[ip] = [];
  }

  rateMap[ip] = rateMap[ip].filter(t => now - t < 60000);

  if (rateMap[ip].length > 100) {
    return res.status(429).json({ success: false, error: "Too many requests" });
  }

  rateMap[ip].push(now);
  next();
}

app.use(rateLimit);

/* ================= LOGGER ================= */

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] [REQ] ${req.method} ${req.url}`);
  next();
});

/* ================= SAFE DB ================= */

function defaultDB() {
  return {
    businesses: [],
    products: [],
    orders: [],
    drivers: [],
    ledger: [],
    wallets: []
  };
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB(), null, 2));
      console.log("✅ DB CREATED");
      return defaultDB();
    }

    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));

    return {
      businesses: data.businesses || [],
      products: data.products || [],
      orders: data.orders || [],
      drivers: data.drivers || [],
      ledger: data.ledger || [],
      wallets: data.wallets || []
    };
  } catch (e) {
    console.error("DB ERROR:", e);
    return defaultDB();
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function id(prefix) {
  return prefix + "_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
}

function ok(res, data = {}) {
  return res.json({ success: true, ...data });
}

function fail(res, message) {
  return res.status(400).json({ success: false, error: message });
}

/* ================= HEALTH ================= */

app.get("/", (req, res) => {
  ok(res, {
    status: "RDS CORE FROZEN",
    env: ENV,
    time: Date.now()
  });
});

/* ================= BUSINESSES ================= */

app.get("/businesses", (req, res) => {
  const db = loadDB();
  ok(res, { businesses: db.businesses });
});

app.post("/addBusiness", auth("ADMIN"), (req, res) => {
  const { name, category } = req.body;
  if (!name) return fail(res, "Invalid name");

  const db = loadDB();

  const business = {
    id: id("biz"),
    name,
    category: category || "Retail",
    createdAt: Date.now()
  };

  db.businesses.push(business);

  db.wallets.push({
    id: id("wal"),
    businessId: business.id,
    balance: 0
  });

  saveDB(db);
  ok(res, { business });
});

app.post("/deleteBusiness", auth("ADMIN"), (req, res) => {
  const { id: bid } = req.body;

  const db = loadDB();
  db.businesses = db.businesses.filter(b => b.id !== bid);

  saveDB(db);
  ok(res);
});

/* ================= PRODUCTS ================= */

app.get("/products", (req, res) => {
  const { businessId } = req.query;
  const db = loadDB();

  const products = db.products.filter(p => p.businessId === businessId);
  ok(res, { products });
});

app.post("/addProduct", auth("BUSINESS"), (req, res) => {
  const { name, price, businessId } = req.body;

  const db = loadDB();

  const product = {
    id: id("prd"),
    name,
    price: Number(price),
    businessId
  };

  db.products.push(product);
  saveDB(db);

  ok(res, { product });
});

/* ================= ORDERS ================= */

app.post("/checkout", (req, res) => {
  const { businessId, items, total } = req.body;

  const db = loadDB();

  const order = {
    id: id("ord"),
    businessId,
    items,
    total,
    status: "PENDING",
    driverId: null
  };

  db.orders.push(order);

  db.ledger.push({
    id: id("tx"),
    type: "ORDER",
    amount: total,
    orderId: order.id
  });

  saveDB(db);

  ok(res, { order });
});

app.get("/orders", (req, res) => {
  const db = loadDB();
  ok(res, { orders: db.orders });
});

/* ================= DRIVERS ================= */

app.post("/registerDriver", (req, res) => {
  const { name } = req.body;
  const db = loadDB();

  const driver = {
    id: id("drv"),
    name,
    status: "offline",
    earnings: 0,
    location: null,
    lastSeen: null
  };

  db.drivers.push(driver);
  saveDB(db);

  ok(res, { driver });
});

app.post("/driverStatus", (req, res) => {
  const { driverId, status } = req.body;

  const db = loadDB();
  const d = db.drivers.find(x => x.id === driverId);

  if (!d) return fail(res, "Driver not found");

  d.status = status;
  d.lastSeen = Date.now();

  saveDB(db);
  ok(res);
});

/* ================= GPS ================= */

app.post("/driverLocation", (req, res) => {
  const { driverId, lat, lng } = req.body;

  const db = loadDB();
  const d = db.drivers.find(x => x.id === driverId);

  if (!d) return fail(res, "Driver not found");

  d.location = { lat, lng };
  d.lastSeen = Date.now();

  saveDB(db);
  ok(res);
});

app.get("/drivers/map", (req, res) => {
  const db = loadDB();
  const now = Date.now();

  const drivers = db.drivers
    .filter(d => d.location && now - d.lastSeen < 60000)
    .map(d => ({
      id: d.id,
      lat: d.location.lat,
      lng: d.location.lng,
      status: d.status
    }));

  ok(res, { drivers });
});

/* ================= DISPATCH ================= */

app.post("/assignDriver", (req, res) => {
  const { orderId } = req.body;

  const db = loadDB();
  const order = db.orders.find(o => o.id === orderId);

  if (!order) return fail(res, "Order not found");

  const drivers = db.drivers.filter(d => d.status === "online");

  if (!drivers.length) return fail(res, "No drivers");

  drivers.sort((a, b) => a.earnings - b.earnings);

  const driver = drivers[0];

  order.driverId = driver.id;
  order.status = "ASSIGNED";

  saveDB(db);

  ok(res, { driver });
});

/* ================= COMPLETE ================= */

app.post("/completeOrder", (req, res) => {
  const { orderId } = req.body;

  const db = loadDB();
  const order = db.orders.find(o => o.id === orderId);

  if (!order) return fail(res, "Order not found");

  order.status = "DELIVERED";

  const driver = db.drivers.find(d => d.id === order.driverId);

  if (driver) {
    const earn = order.total * 0.1;
    driver.earnings += earn;

    db.ledger.push({
      id: id("tx"),
      type: "DELIVERY",
      amount: earn,
      orderId
    });
  }

  saveDB(db);
  ok(res);
});

/* ================= LEDGER ================= */

app.get("/ledger", (req, res) => {
  const db = loadDB();
  ok(res, { ledger: db.ledger });
});

/* ================= START ================= */

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] [SYSTEM] RDS CORE FROZEN ON PORT ${PORT}`);
});