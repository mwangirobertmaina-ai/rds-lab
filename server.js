const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");

const app = express();

/* ========================================== */
/* DYNAMIC CROSS-ENVIRONMENT CORS SETUP       */
/* ========================================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
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

// Advanced self-healing function to scrub and repair memory states
function sanitizeDataState() {
  if (!Array.isArray(data.businesses)) data.businesses = [];
  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.ledger)) data.ledger = [];
  if (!data.wallets || typeof data.wallets !== "object") data.wallets = {};
  if (!Array.isArray(data.drivers)) data.drivers = [];
  if (!Array.isArray(data.deliveries)) data.deliveries = [];

  // Deduplicate and merge duplicate driver profiles by case-insensitive name
  const driverNameMap = new Map();
  const driverIdRedirectMap = new Map();

  data.drivers.forEach(d => {
    if (!d || (!d.id && !d.name)) return;
    const cleanName = (d.name || "Unknown Driver").trim();
    const nameKey = cleanName.toLowerCase();
    
    // Auto-normalize statuses (handles 'online', 'idle', true, etc.)
    let status = (d.status || "").toString().toUpperCase();
    if (status === "IDLE" || status === "ONLINE" || status === "TRUE") status = "AVAILABLE";
    if (!["AVAILABLE", "BUSY", "OFFLINE"].includes(status)) status = "AVAILABLE";

    if (!driverNameMap.has(nameKey)) {
      const primaryDriver = {
        id: d.id || `D_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        name: cleanName,
        phone: d.phone || "0700000000",
        status: status,
        available: status === "AVAILABLE",
        earnings: typeof d.earnings === "number" ? d.earnings : 0,
        location: d.location || { lat: 0, lng: 0, heading: 0, speed: 0, lastPing: null },
        createdAt: d.createdAt || Date.now()
      };
      driverNameMap.set(nameKey, primaryDriver);
      if (d.id) driverIdRedirectMap.set(d.id, primaryDriver.id);
    } else {
      const primary = driverNameMap.get(nameKey);
      if (d.id) driverIdRedirectMap.set(d.id, primary.id);
      primary.earnings = Math.max(primary.earnings, typeof d.earnings === "number" ? d.earnings : 0);
      if (status === "AVAILABLE" || status === "BUSY") {
        primary.status = status;
        primary.available = (status === "AVAILABLE");
      }
    }
  });
  data.drivers = Array.from(driverNameMap.values());

  // Re-map deliveries assigned to merged duplicate driver IDs
  const deliveryMap = new Map();
  data.deliveries.forEach(del => {
    if (!del || !del.id) return;
    let status = (del.status || "ASSIGNED").toUpperCase();
    if (status === "DELIVERED") status = "COMPLETED";
    
    const remappedDriverId = driverIdRedirectMap.get(del.driverId) || del.driverId;

    deliveryMap.set(del.id, {
      id: del.id,
      orderId: del.orderId,
      driverId: remappedDriverId,
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
/* AUTONOMOUS REAL-TIME DISPATCH ENGINE       */
/* ========================================== */
function autoDispatch(order) {
  if (!order) return null;

  console.log("🚀 Dispatch triggered for order:", order.id);

  // Skip if delivery already assigned
  const existingDelivery = data.deliveries.find(
    d => d.orderId === order.id && d.status !== "FAILED" && d.status !== "CANCELLED"
  );
  if (existingDelivery) {
    console.log("ℹ️ Order already dispatched:", existingDelivery.id);
    return existingDelivery;
  }

  // Broad driver availability check (status OR boolean flag)
  const availableDrivers = data.drivers.filter(d => {
    const st = (d.status || "").toString().toUpperCase();
    return st === "AVAILABLE" || d.available === true || st === "ONLINE" || st === "IDLE";
  });

  console.log("👀 Available drivers found:", availableDrivers.length);

  if (availableDrivers.length === 0) {
    console.log("❌ No available drivers found for order:", order.id);
    return null;
  }

  const driver = availableDrivers[0];

  const delivery = {
    id: uid("DL_"),
    orderId: order.id,
    driverId: driver.id,
    status: "ASSIGNED",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  driver.status = "BUSY";
  driver.available = false;

  order.status = "DISPATCHED";
  order.updatedAt = Date.now();

  data.deliveries.push(delivery);

  console.log("✅ Delivery created:", delivery.id, "Assigned to driver:", driver.name, `(${driver.id})`);
  return delivery;
}

// Background Dispatch Daemon (Sweeps queue every 3 seconds)
setInterval(() => {
  const pendingOrders = data.orders.filter(o => {
    const st = (o.status || "").toUpperCase();
    return st === "PAID" || st === "CREATED";
  });

  let changed = false;
  pendingOrders.forEach(order => {
    const hasDelivery = data.deliveries.some(d => d.orderId === order.id && d.status !== "FAILED");
    if (!hasDelivery) {
      const delivery = autoDispatch(order);
      if (delivery) changed = true;
    }
  });

  if (changed) saveDB();
}, 3000);

/* ========================================== */
/* HEALTH & TELEMETRY ROUTE                   */
/* ========================================== */
const healthHandler = (req, res) => {
  const host = req.get("host") || "";
  const isCloud = process.env.RENDER || host.includes("onrender.com") || host.includes("railway.app");

  res.json({
    success: true,
    engine: "RDS STAGE 12 ENTERPRISE DISPATCH CORE",
    status: "ACTIVE",
    mode: isCloud ? "CLOUD" : "LOCAL",
    host: host,
    environment: process.env.NODE_ENV || (isCloud ? "production" : "development"),
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
};

app.get("/", healthHandler);
app.get("/health", healthHandler);

/* ========================================== */
/* BUSINESS & MERCHANT ROUTER                 */
/* ========================================== */
app.post("/addBusiness", (req, res) => {
  const name = (req.body.name || req.query.name || "").trim();
  if (!name) return res.status(400).json({ success: false, error: "Business name required" });

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
    existing.status = "AVAILABLE";
    existing.available = true;

    // Scan for pending orders on driver reactivation
    const pendingOrder = data.orders.find(o => o.status === "PAID" || o.status === "CREATED");
    if (pendingOrder) autoDispatch(pendingOrder);

    saveDB();
    return res.status(200).json({ success: true, driver: existing, note: "Existing profile reactivated" });
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

  // Scan for pending orders on new driver registration
  const pendingOrder = data.orders.find(o => o.status === "PAID" || o.status === "CREATED");
  if (pendingOrder) autoDispatch(pendingOrder);

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
  let status = (req.body.status || req.query.status || "").toString().toUpperCase();

  if (status === "IDLE" || status === "ONLINE" || status === "TRUE") status = "AVAILABLE";

  const driver = data.drivers.find(d => d.id === driverId);
  if (!driver) return res.status(404).json({ success: false, error: "Driver profile not found" });

  driver.status = status;
  driver.available = (status === "AVAILABLE");

  // Instantly attempt dispatch when a driver turns available
  if (driver.available) {
    const pendingOrder = data.orders.find(o => o.status === "PAID" || o.status === "CREATED");
    if (pendingOrder) autoDispatch(pendingOrder);
  }

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
    if (!p) throw new Error(`Product not found: ${item.productId}`);

    const qty = parseInt(item.qty, 10) || 1;
    const subtotal = p.price * qty;
    const itemCommission = Math.floor(subtotal * 0.05);
    const itemPayable = subtotal - itemCommission;

    total += subtotal;
    commission += itemCommission;

    enrichedItems.push({ productId: p.id, name: p.name, price: p.price, qty, subtotal });
    walletMap[p.businessId] = (walletMap[p.businessId] || 0) + itemPayable;

    entries.push({ account: "BUSINESS_PAYABLE", businessId: p.businessId, debit: 0, credit: itemPayable });
  });

  entries.unshift({ account: "CASH", debit: total, credit: 0 });
  if (commission > 0) entries.push({ account: "PLATFORM_REVENUE", debit: 0, credit: commission });

  return { total, commission, walletMap, entries, enrichedItems };
}

/* ========================================== */
/* CHECKOUT ROUTE                             */
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

    data.ledger.push({
      id: uid("L_"),
      orderId: order.id,
      entries,
      total,
      commission,
      createdAt: Date.now()
    });

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

    // Execute Immediate Dispatch Trigger
    const delivery = autoDispatch(order);

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
/* MANUAL DISPATCH CONTROL                    */
/* ========================================== */
app.post("/dispatch", (req, res) => {
  const orderId = req.body.orderId || req.query.orderId;
  const targetDriverId = req.body.driverId || req.query.driverId;
  const order = data.orders.find(o => o.id === orderId);

  if (!order) return res.status(404).json({ success: false, error: "Order not found" });

  let delivery;
  if (targetDriverId) {
    const driver = data.drivers.find(d => d.id === targetDriverId && (d.available || d.status === "AVAILABLE"));
    if (!driver) return res.status(400).json({ success: false, error: "Specified driver is not available" });

    driver.available = false;
    driver.status = "BUSY";

    delivery = {
      id: uid("DL_"),
      orderId,
      driverId: driver.id,
      status: "ASSIGNED",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    data.deliveries.push(delivery);
    order.status = "DISPATCHED";
  } else {
    delivery = autoDispatch(order);
  }

  if (!delivery) return res.status(400).json({ success: false, error: "No available driver found for dispatch" });

  saveDB();
  res.json({ success: true, delivery, order });
});

/* ========================================== */
/* DELIVERY ENGINE & DRIVER JOBS ALIASES      */
/* ========================================== */
const updateDeliveryHandler = (req, res) => {
  req.body.deliveryId = req.body.deliveryId || req.body.id;
  const deliveryId = req.body.deliveryId;
  let status = (req.body.status || req.query.status || "").toString().toUpperCase();

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
      driver.earnings = (driver.earnings || 0) + 50;
    }
  } else if (status === "FAILED") {
    if (order) order.status = "PAID";
    if (driver) {
      driver.available = true;
      driver.status = "AVAILABLE";
    }
  }

  // Trigger dispatch check after completing an existing delivery task
  const pendingOrder = data.orders.find(o => o.status === "PAID" || o.status === "CREATED");
  if (pendingOrder) autoDispatch(pendingOrder);

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

/* ========================================== */
/* READ-ONLY AUDIT ENDPOINTS                  */
/* ========================================== */
app.get("/orders", (req, res) => res.json({ success: true, orders: data.orders || [] }));
app.get("/ledger", (req, res) => res.json({ success: true, ledger: data.ledger || [] }));
app.get("/wallets", (req, res) => res.json({ success: true, wallets: Object.values(data.wallets || {}) }));

/* ========================================== */
/* GLOBAL ERROR HANDLER                       */
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