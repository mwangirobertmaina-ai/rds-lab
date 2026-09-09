const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");

const app = express();

/* ========================================== */
/* CORS & EXPRESS MIDDLEWARE SETUP            */
/* ========================================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

/* ========================================== */
/* IN-MEMORY SCHEMA & SELF-HEALING ENGINE     */
/* ========================================== */
let data = {
  businesses: [],
  products: [],
  orders: [],
  ledger: [],
  wallets: {},
  drivers: [],
  deliveries: []
};

// Self-healing function to scrub corrupted memory states
function sanitizeDataState() {
  if (!Array.isArray(data.businesses)) data.businesses = [];
  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.ledger)) data.ledger = [];
  if (!data.wallets || typeof data.wallets !== "object") data.wallets = {};
  if (!Array.isArray(data.drivers)) data.drivers = [];
  if (!Array.isArray(data.deliveries)) data.deliveries = [];

  // Deduplicate drivers by ID and normalize status
  const driverMap = new Map();
  data.drivers.forEach(d => {
    if (!d || !d.id) return;
    let status = (d.status || "AVAILABLE").toUpperCase();
    if (status === "IDLE") status = "AVAILABLE";
    driverMap.set(d.id, {
      id: d.id,
      name: (d.name || "Unknown Driver").trim(),
      phone: d.phone || "0700000000",
      status: status,
      available: status === "AVAILABLE",
      earnings: typeof d.earnings === "number" ? d.earnings : 0,
      location: d.location || { lat: 0, lng: 0, heading: 0, speed: 0, lastPing: null },
      createdAt: d.createdAt || Date.now()
    });
  });
  data.drivers = Array.from(driverMap.values());

  // Deduplicate deliveries by ID
  const deliveryMap = new Map();
  data.deliveries.forEach(del => {
    if (!del || !del.id) return;
    let status = (del.status || "ASSIGNED").toUpperCase();
    if (status === "DELIVERED") status = "COMPLETED";
    deliveryMap.set(del.id, {
      id: del.id,
      orderId: del.orderId,
      driverId: del.driverId,
      status: status,
      createdAt: del.createdAt || Date.now(),
      updatedAt: del.updatedAt || Date.now()
    });
  });
  data.deliveries = Array.from(deliveryMap.values());

  // Ensure wallets exist for all active businesses
  data.businesses.forEach(b => {
    if (b && b.id && !data.wallets[b.id]) {
      data.wallets[b.id] = { businessId: b.id, balance: 0, transactions: [] };
    }
  });
}

// Initial Boot Hydration
if (fs.existsSync(DB_FILE)) {
  try {
    const rawData = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(rawData);
    data = { ...data, ...parsed };
    sanitizeDataState();
    console.log("✅ DB Hydrated & Self-Healed Successfully");
  } catch (e) {
    console.error("⚠️ DB Read Error. Initializing fresh schema:", e.message);
    sanitizeDataState();
  }
}

/* ========================================== */
/* ATOMIC NON-BLOCKING PERSISTENCE ENGINE     */
/* ========================================== */
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
    console.error("❌ DB ATOMIC SAVE ERROR:", err.message);
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

const uid = (prefix) => `${prefix}${Date.now()}_${Math.floor(Math.random() * 100000)}`;

/* ========================================== */
/* ENUM LIFECYCLE STATE MACHINES              */
/* ========================================== */
const ORDER_LIFECYCLE = ["CREATED", "PAID", "DISPATCHED", "COMPLETED", "CANCELLED"];
const DELIVERY_LIFECYCLE = ["ASSIGNED", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "COMPLETED", "FAILED"];

/* ========================================== */
/* HEALTH & TELEMETRY ROUTE                   */
/* ========================================== */
app.get("/", (req, res) => {
  res.json({
    success: true,
    engine: "RDS STAGE 12 ENTERPRISE DISPATCH CORE",
    status: "ACTIVE",
    environment: process.env.NODE_ENV || (process.env.RENDER ? "production" : "development"),
    uptime: `${Math.floor(process.uptime())}s`,
    timestamp: Date.now(),
    telemetry: {
      businesses: data.businesses.length,
      products: data.products.length,
      orders: data.orders.length,
      drivers: data.drivers.length,
      deliveries: data.deliveries.length
    }
  });
});

/* ========================================== */
/* BUSINESS & MERCHANT ROUTER                 */
/* ========================================== */
app.post("/addBusiness", (req, res) => {
  const name = (req.body.name || req.query.name || "").trim();
  if (!name) {
    return res.status(400).json({ success: false, error: "Business name required" });
  }
  const business = { id: uid("B_"), name, createdAt: Date.now() };
  data.businesses.push(business);
  if (!data.wallets[business.id]) {
    data.wallets[business.id] = { businessId: business.id, balance: 0, transactions: [] };
  }
  saveDB();
  res.status(201).json({ success: true, business });
});

app.get("/businesses", (req, res) => {
  res.json({ success: true, businesses: data.businesses || [] });
});

app.post("/deleteBusiness", (req, res) => {
  const id = req.body.id || req.query.id;
  if (!id) return res.status(400).json({ success: false, error: "Business ID required" });
  data.businesses = data.businesses.filter(b => b.id !== id);
  data.products = data.products.filter(p => p.businessId !== id);
  if (data.wallets) delete data.wallets[id];
  saveDB();
  res.json({ success: true, deletedId: id });
});

/* ========================================== */
/* PRODUCT CATALOG ROUTER                     */
/* ========================================== */
app.post("/addProduct", (req, res) => {
  const name = (req.body.name || req.query.name || "").trim();
  const price = parseInt(req.body.price || req.query.price, 10);
  const businessId = req.body.businessId || req.query.businessId;
  if (!name || isNaN(price) || price < 0 || !businessId) {
    return res.status(400).json({ success: false, error: "Invalid product parameters" });
  }
  const bizExists = data.businesses.some(b => b.id === businessId);
  if (!bizExists) {
    return res.status(404).json({ success: false, error: "Merchant business not found" });
  }
  const product = { id: uid("P_"), name, price, businessId, createdAt: Date.now() };
  data.products.push(product);
  saveDB();
  res.status(201).json({ success: true, product });
});

app.get("/products", (req, res) => {
  res.json({ success: true, products: data.products || [] });
});

app.post("/deleteProduct", (req, res) => {
  const id = req.body.id || req.query.id;
  if (!id) return res.status(400).json({ success: false, error: "Product ID required" });
  data.products = data.products.filter(p => p.id !== id);
  saveDB();
  res.json({ success: true, deletedId: id });
});

/* ========================================== */
/* DRIVER FLEET ROUTER (MULTI-ALIAS)          */
/* ========================================== */
const addDriverHandler = (req, res) => {
  const name = (req.body.name || req.query.name || "").trim();
  const phone = (req.body.phone || req.query.phone || "0700000000").trim();
  if (!name) return res.status(400).json({ success: false, error: "Driver name required" });

  let existing = data.drivers.find(d => d.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return res.status(200).json({ success: true, driver: existing, note: "Existing profile recovered" });
  }
  const driver = {
    id: uid("D_"),
    name,
    phone,
    available: true,
    status: "AVAILABLE",
    location: { lat: 0.0, lng: 0.0, heading: 0, speed: 0, lastPing: null },
    earnings: 0,
    createdAt: Date.now()
  };
  data.drivers.push(driver);
  saveDB();
  res.status(201).json({ success: true, driver });
};

app.post("/driver/add", addDriverHandler);
app.post("/addDriver", addDriverHandler);

app.get("/drivers", (req, res) => {
  sanitizeDataState();
  res.json({ success: true, drivers: data.drivers || [] });
});

const updateDriverStatusHandler = (req, res) => {
  const driverId = req.body.driverId || req.query.driverId;
  let status = (req.body.status || req.query.status || "").toUpperCase();
  if (status === "IDLE") status = "AVAILABLE";
  if (!driverId || !["AVAILABLE", "BUSY", "OFFLINE"].includes(status)) {
    return res.status(400).json({ success: false, error: "Valid status required: AVAILABLE | BUSY | OFFLINE" });
  }
  const driver = data.drivers.find(d => d.id === driverId);
  if (!driver) return res.status(404).json({ success: false, error: "Driver profile not found" });
  driver.status = status;
  driver.available = (status === "AVAILABLE");
  saveDB();
  res.json({ success: true, driver });
};

app.post("/updateDriverStatus", updateDriverStatusHandler);
app.post("/driverStatus", updateDriverStatusHandler);

/* GPS Telemetry Route */
app.post("/driver/location", (req, res) => {
  const driverId = req.body.driverId || req.query.driverId;
  const { lat, lng, heading, speed } = req.body;
  const driver = data.drivers.find(d => d.id === driverId);
  if (!driver) return res.status(404).json({ success: false, error: "Driver not found" });
  driver.location = {
    lat: parseFloat(lat) || 0,
    lng: parseFloat(lng) || 0,
    heading: parseFloat(heading) || 0,
    speed: parseFloat(speed) || 0,
    lastPing: Date.now()
  };
  saveDB();
  res.json({ success: true, location: driver.location });
});

/* ========================================== */
/* FINANCIAL TRANSACTION ENGINE               */
/* ========================================== */
function processOrderItems(items) {
  let total = 0;
  let commission = 0;
  const walletMap = {};
  const entries = [];
  const enrichedItems = [];

  items.forEach(item => {
    const p = data.products.find(x => x.id === item.productId);
    if (!p) {
      throw new Error(`Product not found: ${item.productId}`);
    }
    const qty = parseInt(item.qty, 10) || 1;
    const subtotal = p.price * qty;
    const itemCommission = Math.floor(subtotal * 0.05); // 5% fee
    const itemPayable = subtotal - itemCommission;

    total += subtotal;
    commission += itemCommission;

    enrichedItems.push({
      productId: p.id,
      name: p.name,
      price: p.price,
      qty,
      subtotal
    });

    walletMap[p.businessId] = (walletMap[p.businessId] || 0) + itemPayable;

    entries.push({
      account: "BUSINESS_PAYABLE",
      businessId: p.businessId,
      debit: 0,
      credit: itemPayable
    });
  });

  entries.unshift({ account: "CASH", debit: total, credit: 0 });
  if (commission > 0) {
    entries.push({ account: "PLATFORM_REVENUE", debit: 0, credit: commission });
  }
  return { total, commission, walletMap, entries, enrichedItems };
}

/* ========================================== */
/* CHECKOUT & AUTO DISPATCH ENGINE            */
/* ========================================== */
app.post("/order", (req, res) => {
  const productId = req.body.productId || req.query.productId;
  const qty = parseInt(req.body.qty || req.query.qty, 10) || 1;
  if (!productId) return res.status(400).json({ success: false, error: "Product ID required" });
  req.body.items = [{ productId, qty }];
  return checkoutHandler(req, res);
});

app.post("/checkout", checkoutHandler);

function checkoutHandler(req, res) {
  try {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Cart payload cannot be empty" });
    }
    const { total, commission, walletMap, entries, enrichedItems } = processOrderItems(items);

    const order = {
      id: uid("O_"),
      items: enrichedItems,
      total,
      commission,
      status: "PAID",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    data.orders.push(order);

    // Ledger Record
    data.ledger.push({
      id: uid("L_"),
      orderId: order.id,
      entries,
      total,
      commission,
      createdAt: Date.now()
    });

    // Credit Merchant Wallets
    Object.keys(walletMap).forEach(bizId => {
      if (!data.wallets[bizId]) {
        data.wallets[bizId] = { businessId: bizId, balance: 0, transactions: [] };
      }

      data.wallets[bizId].balance += walletMap[bizId];
      data.wallets[bizId].transactions.push({
        id: uid("WT_"),
        type: "CREDIT",
        amount: walletMap[bizId],
        orderId: order.id,
        createdAt: Date.now()
      });
    });

    // Auto Dispatch to Available Driver
    let delivery = null;
    const driver = data.drivers.find(d => d.available === true || d.status === "AVAILABLE");

    if (driver) {
      driver.available = false;
      driver.status = "BUSY";

      delivery = {
        id: uid("DL_"),
        orderId: order.id,
        driverId: driver.id,
        status: "ASSIGNED",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      data.deliveries.push(delivery);
      order.status = "DISPATCHED";
    }

    saveDB();

    res.status(201).json({
      success: true,
      order,
      delivery: delivery || { status: "UNASSIGNED", note: "Pending driver dispatch" }
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
}

/* ========================================== */
/* ORDER STATUS STATE MACHINE                 */
/* ========================================== */
app.post("/order/status", (req, res) => {
  const orderId = req.body.orderId || req.query.orderId;
  const status = (req.body.status || req.query.status || "").toUpperCase();
  if (!orderId || !ORDER_LIFECYCLE.includes(status)) {
    return res.status(400).json({
      success: false,
      error: `Invalid status. Valid lifecycle states: ${ORDER_LIFECYCLE.join(" → ")}`
    });
  }
  const order = data.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ success: false, error: "Order not found" });
  order.status = status;
  order.updatedAt = Date.now();
  saveDB();
  res.json({ success: true, order });
});

/* ========================================== */
/* MANUAL DISPATCH CONTROL                    */
/* ========================================== */
app.post("/dispatch", (req, res) => {
  const orderId = req.body.orderId || req.query.orderId;
  const targetDriverId = req.body.driverId || req.query.driverId;
  const order = data.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ success: false, error: "Order not found" });
  let driver;
  if (targetDriverId) {
    driver = data.drivers.find(d => d.id === targetDriverId && (d.available || d.status === "AVAILABLE"));
  } else {
    driver = data.drivers.find(d => d.available || d.status === "AVAILABLE");
  }
  if (!driver) {
    return res.status(400).json({ success: false, error: "No available driver found for dispatch" });
  }
  driver.available = false;
  driver.status = "BUSY";
  const delivery = {
    id: uid("DL_"),
    orderId,
    driverId: driver.id,
    status: "ASSIGNED",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  data.deliveries.push(delivery);
  order.status = "DISPATCHED";
  saveDB();
  res.json({ success: true, delivery, order });
});

/* ========================================== */
/* DELIVERY ENGINE & DRIVER JOBS ALIASES      */
/* ========================================== */
const updateDeliveryHandler = (req, res) => {
  req.body.deliveryId = req.body.deliveryId || req.body.id;
  const deliveryId = req.body.deliveryId;
  let status = (req.body.status || req.query.status || "").toUpperCase();
  if (status === "ACCEPTED") status = "ASSIGNED";
  const delivery = data.deliveries.find(d => d.id === deliveryId);
  if (!delivery) return res.status(404).json({ success: false, error: "Delivery task not found" });
  if (!DELIVERY_LIFECYCLE.includes(status)) {
    return res.status(400).json({ success: false, error: `Invalid delivery status state: ${status}` });
  }
  delivery.status = status;
  delivery.updatedAt = Date.now();
  const order = data.orders.find(o => o.id === delivery.orderId);
  const driver = data.drivers.find(d => d.id === delivery.driverId);
  if (status === "COMPLETED" || status === "DELIVERED") {
    delivery.status = "COMPLETED";
    if (order) order.status = "COMPLETED";
    if (driver) {
      driver.available = true;
      driver.status = "AVAILABLE";
      driver.earnings = (driver.earnings || 0) + 50; // $50 flat payout credit
    }
  } else if (status === "FAILED") {
    if (order) order.status = "PAID";
    if (driver) {
      driver.available = true;
      driver.status = "AVAILABLE";
    }
  }
  saveDB();
  res.json({ success: true, delivery, orderStatus: order ? order.status : null });
};

app.post("/updateDelivery", updateDeliveryHandler);
app.post("/delivery/updateStatus", updateDeliveryHandler);
app.post("/completeDelivery", (req, res) => {
  req.body.status = "COMPLETED";
  return updateDeliveryHandler(req, res);
});

app.get("/deliveries", (req, res) => {
  sanitizeDataState();
  res.json({ success: true, deliveries: data.deliveries || [] });
});

const getDriverJobsHandler = (req, res) => {
  const driverId = req.params.driverId || req.query.driverId || req.body.driverId;
  if (!driverId) return res.status(400).json({ success: false, error: "driverId is required" });
  sanitizeDataState();
  const jobs = data.deliveries.filter(d => d.driverId === driverId);
  res.json({ success: true, jobs, deliveries: jobs });
};

app.get("/driverJobs", getDriverJobsHandler);
app.get("/driver/:driverId/deliveries", getDriverJobsHandler);

app.get("/delivery/track/:orderId", (req, res) => {
  const orderId = req.params.orderId;
  const delivery = data.deliveries.find(d => d.orderId === orderId);
  const order = data.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ success: false, error: "Order not found" });
  let driver = null;
  if (delivery) {
    const rawDriver = data.drivers.find(d => d.id === delivery.driverId);
    if (rawDriver) {
      driver = {
        id: rawDriver.id,
        name: rawDriver.name,
        phone: rawDriver.phone,
        location: rawDriver.location
      };
    }
  }
  res.json({
    success: true,
    orderStatus: order.status,
    delivery: delivery || null,
    driverLocation: driver ? driver.location : null,
    driverInfo: driver
  });
});

/* ========================================== */
/* MERCHANT & DRIVER PAYOUT ENGINE            */
/* ========================================== */
app.post("/payout", (req, res) => {
  const businessId = req.body.businessId || req.query.businessId;
  const amount = parseInt(req.body.amount || req.query.amount, 10);
  if (!businessId || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid business ID or withdrawal amount" });
  }
  if (!data.wallets[businessId]) {
    return res.status(404).json({ success: false, error: "Wallet not found for business" });
  }
  const wallet = data.wallets[businessId];
  if (wallet.balance < amount) {
    return res.status(400).json({
      success: false,
      error: "Insufficient wallet balance",
      currentBalance: wallet.balance
    });
  }
  const payoutId = uid("PO_");
  wallet.balance -= amount;
  wallet.transactions.push({
    id: uid("WT_"),
    type: "DEBIT",
    amount,
    payoutId,
    createdAt: Date.now()
  });
  data.ledger.push({
    id: uid("L_"),
    payoutId,
    entries: [
      { account: "BUSINESS_PAYABLE", businessId, debit: amount, credit: 0 },
      { account: "CASH", debit: 0, credit: amount }
    ],
    createdAt: Date.now()
  });
  saveDB();
  res.json({
    success: true,
    payoutId,
    amountDeducted: amount,
    remainingBalance: wallet.balance
  });
});

/* ========================================== */
/* READ-ONLY AUDIT & FINANCIAL ENDPOINTS      */
/* ========================================== */
app.get("/orders", (req, res) => res.json({ success: true, orders: data.orders || [] }));
app.get("/ledger", (req, res) => res.json({ success: true, ledger: data.ledger || [] }));
app.get("/wallets", (req, res) => res.json({ success: true, wallets: Object.values(data.wallets || {}) }));

/* ========================================== */
/* GLOBAL ERROR CATCH-ALL & UNHANDLED ROUTE   */
/* ========================================== */
app.use((err, req, res, next) => {
  console.error("❌ Global Server Exception Catch:", err.stack);
  res.status(500).json({ success: false, error: "Internal Server Exception caught & recovered" });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.originalUrl} not found` });
});

/* ========================================== */
/* SERVER INITIALIZATION                      */
/* ========================================== */
app.listen(PORT, () => {
  console.log(`🚀 RDS STAGE 12 ENTERPRISE ENGINE ACTIVE ON PORT ${PORT}`);
});