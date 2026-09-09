const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

/* ========================================== */
/* DYNAMIC CORS & MIDDLEWARE                  */
/* ========================================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(".")); // Serve static frontend assets (Admin, Merchant, Driver, Market)

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

function sanitizeDataState() {
  if (!Array.isArray(data.businesses)) data.businesses = [];
  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.ledger)) data.ledger = [];
  if (!data.wallets || typeof data.wallets !== "object") data.wallets = {};
  if (!Array.isArray(data.drivers)) data.drivers = [];
  if (!Array.isArray(data.deliveries)) data.deliveries = [];

  // 1. Sanitize Products & Ensure Stock/Price Integrity
  data.products.forEach(p => {
    if (p) {
      p.price = parseFloat(p.price) || 0;
      p.stock = typeof p.stock === "number" ? p.stock : (parseInt(p.stock) || 0);
      p.businessId = p.businessId || "SYSTEM";
      p.name = p.name || "Unnamed Product";
    }
  });

  // 2. Deduplicate & normalize Drivers
  const driverNameMap = new Map();
  const driverIdRedirectMap = new Map();

  data.drivers.forEach(d => {
    if (!d || (!d.id && !d.name)) return;
    const cleanName = (d.name || "Unknown Driver").trim();
    const nameKey = cleanName.toLowerCase();

    let status = (d.status || "").toString().toUpperCase();
    if (["IDLE", "ONLINE", "TRUE"].includes(status)) status = "AVAILABLE";
    if (!["AVAILABLE", "BUSY", "OFFLINE"].includes(status)) status = "OFFLINE";

    if (!driverNameMap.has(nameKey)) {
      const primaryDriver = {
        id: d.id || `D_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        name: cleanName,
        phone: d.phone || "0700000000",
        status: status,
        available: status === "AVAILABLE",
        earnings: typeof d.earnings === "number" ? d.earnings : 0,
        location: d.location || { lat: -1.286389, lng: 36.817223, heading: 0, speed: 0, lastPing: null },
        createdAt: d.createdAt || Date.now()
      };
      driverNameMap.set(nameKey, primaryDriver);
      if (d.id) driverIdRedirectMap.set(d.id, primaryDriver.id);
    } else {
      const primary = driverNameMap.get(nameKey);
      if (d.id) driverIdRedirectMap.set(d.id, primary.id);
      primary.earnings = Math.max(primary.earnings, typeof d.earnings === "number" ? d.earnings : 0);
      if (["AVAILABLE", "BUSY"].includes(status)) {
        primary.status = status;
        primary.available = (status === "AVAILABLE");
      }
    }
  });
  data.drivers = Array.from(driverNameMap.values());

  // 3. Normalize Deliveries & map remapped Drivers
  const deliveryMap = new Map();
  data.deliveries.forEach(del => {
    if (!del || !del.id) return;
    let status = (del.status || "ASSIGNED").toUpperCase();
    if (["DONE", "DELIVERED"].includes(status)) status = "COMPLETED";

    const remappedDriverId = driverIdRedirectMap.get(del.driverId) || del.driverId;

    deliveryMap.set(del.id, {
      id: del.id,
      orderId: del.orderId || `ORD_${Date.now()}`,
      driverId: remappedDriverId,
      status: status,
      createdAt: del.createdAt || Date.now(),
      updatedAt: del.updatedAt || Date.now()
    });
  });
  data.deliveries = Array.from(deliveryMap.values());

  // 4. System Wallets Integrity Safeguard
  if (!data.wallets["SYSTEM_PLATFORM"]) {
    data.wallets["SYSTEM_PLATFORM"] = { balance: 0, escrow: 0 };
  }
}

// Initial Boot Data Hydration
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
/* ATOMIC PERSISTENCE ENGINE                  */
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
/* HAVERSINE AUTO-DISPATCH CALCULATOR         */
/* ========================================== */
function calculateDistanceKM(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* ========================================== */
/* 1. SYSTEM HEALTH & TELEMETRY ROUTER        */
/* ========================================== */
const healthHandler = (req, res) => {
  sanitizeDataState();
  res.json({
    success: true,
    engine: "RDS END-TO-END ENTERPRISE DISPATCH CORE",
    status: "ACTIVE",
    uptime: `${Math.floor(process.uptime())}s`,
    timestamp: Date.now(),
    metrics: {
      businesses: data.businesses.length,
      products: data.products.length,
      orders: data.orders.length,
      drivers: data.drivers.length,
      activeDeliveries: data.deliveries.filter(d => d.status !== "COMPLETED").length,
      totalLedgerEntries: data.ledger.length
    }
  });
};

app.get("/", healthHandler);
app.get("/health", healthHandler);

/* ========================================== */
/* 2. ADMIN CONTROL CENTER ROUTER             */
/* ========================================== */
app.get("/admin/overview", (req, res) => {
  sanitizeDataState();
  
  const totalSystemVolume = data.orders.reduce((acc, o) => acc + (o.total || 0), 0);
  const platformRevenue = data.ledger
    .filter(l => l.type === "COMMISSION")
    .reduce((acc, l) => acc + (l.amount || 0), 0);

  res.json({
    success: true,
    stats: {
      totalVolume: totalSystemVolume,
      platformRevenue: platformRevenue,
      businessesCount: data.businesses.length,
      productsCount: data.products.length,
      ordersCount: data.orders.length,
      driversCount: data.drivers.length,
      availableDrivers: data.drivers.filter(d => d.status === "AVAILABLE").length,
      pendingDeliveries: data.deliveries.filter(d => d.status !== "COMPLETED").length
    },
    drivers: data.drivers,
    recentOrders: data.orders.slice(-20).reverse(),
    recentLedger: data.ledger.slice(-20).reverse()
  });
});

app.get("/driverLocations", (req, res) => {
  sanitizeDataState();
  const drivers = data.drivers.map(d => ({
    id: d.id,
    name: d.name,
    phone: d.phone,
    status: d.status,
    lat: d.location?.lat || 0,
    lng: d.location?.lng || 0,
    heading: d.location?.heading || 0,
    speed: d.location?.speed || 0,
    lastPing: d.location?.lastPing || null
  }));
  res.json({ success: true, drivers });
});

/* ========================================== */
/* 3. BUSINESS & MERCHANT API                 */
/* ========================================== */
const getBusinessesHandler = (req, res) => {
  sanitizeDataState();
  res.json({ success: true, businesses: data.businesses, shops: data.businesses });
};

app.get("/businesses", getBusinessesHandler);
app.get("/shops", getBusinessesHandler);

const addBusinessHandler = (req, res) => {
  const { name, category, address, phone } = req.body;
  if (!name) return res.status(400).json({ success: false, error: "Business name required" });

  const business = {
    id: uid("BIZ_"),
    name: name.trim(),
    category: category || "Retail",
    address: address || "Nairobi, Kenya",
    phone: phone || "0700000000",
    balance: 0,
    createdAt: Date.now()
  };

  data.businesses.push(business);
  data.wallets[business.id] = { balance: 0, escrow: 0 };
  saveDB();

  res.status(201).json({ success: true, business, shop: business });
};

app.post("/business/add", addBusinessHandler);
app.post("/business/create", addBusinessHandler);

const deleteBusinessHandler = (req, res) => {
  const businessId = req.params.id || req.body.id || req.query.id;
  const index = data.businesses.findIndex(b => b.id === businessId);

  if (index === -1) {
    return res.status(404).json({ success: false, error: "Business not found" });
  }

  const removed = data.businesses.splice(index, 1);
  delete data.wallets[businessId];

  saveDB();
  res.json({ success: true, deleted: removed[0] });
};

app.delete("/business/delete/:id", deleteBusinessHandler);
app.delete("/business/:id", deleteBusinessHandler);

app.get("/products", (req, res) => {
  sanitizeDataState();
  const { businessId } = req.query;
  let products = data.products;
  if (businessId) {
    products = products.filter(p => p.businessId === businessId);
  }
  res.json({ success: true, products });
});

app.post("/product/add", (req, res) => {
  const { businessId, name, price, stock, category } = req.body;
  if (!businessId || !name || price === undefined) {
    return res.status(400).json({ success: false, error: "Missing required product fields" });
  }

  const product = {
    id: uid("PROD_"),
    businessId,
    name: name.trim(),
    price: parseFloat(price) || 0,
    stock: parseInt(stock) !== undefined && !isNaN(parseInt(stock)) ? parseInt(stock) : 50,
    category: category || "General",
    createdAt: Date.now()
  };

  data.products.push(product);
  saveDB();
  res.status(201).json({ success: true, product });
});

/* ========================================== */
/* 4. MARKET, ORDERS & CHECKOUT ENGINE        */
/* ========================================== */
const createOrderInternal = (orderData) => {
  const { customerName, customerPhone, items, deliveryAddress, targetLat, targetLng } = orderData;

  let totalAmount = 0;
  const verifiedItems = [];

  items.forEach(item => {
    const prod = data.products.find(p => p.id === (item.productId || item.id));
    const itemPrice = prod ? prod.price : (parseFloat(item.price) || 0);
    const qty = parseInt(item.quantity || item.qty) || 1;
    const itemSubtotal = itemPrice * qty;
    totalAmount += itemSubtotal;

    const bizId = prod ? prod.businessId : (item.businessId || "SYSTEM");

    verifiedItems.push({
      productId: (prod ? prod.id : item.productId) || "CUSTOM",
      businessId: bizId,
      name: prod ? prod.name : (item.name || "Item"),
      price: itemPrice,
      quantity: qty,
      subtotal: itemSubtotal
    });

    if (prod) {
      prod.stock = Math.max(0, (prod.stock || 0) - qty);
    }
  });

  const orderId = uid("ORD_");
  const order = {
    id: orderId,
    customerName: customerName || "Guest Customer",
    customerPhone: customerPhone || "0700000000",
    deliveryAddress: deliveryAddress || "Nairobi CBD",
    targetLocation: {
      lat: parseFloat(targetLat) || -1.286389,
      lng: parseFloat(targetLng) || 36.817223
    },
    items: verifiedItems,
    total: totalAmount,
    status: "PLACED",
    createdAt: Date.now()
  };

  data.orders.push(order);

  // Financial Double-Entry Journal Logging
  const ledgerEntries = [];
  const merchantTotals = {};

  verifiedItems.forEach(item => {
    merchantTotals[item.businessId] = (merchantTotals[item.businessId] || 0) + item.subtotal;
  });

  Object.keys(merchantTotals).forEach(bId => {
    const gross = merchantTotals[bId];
    const platformFee = gross * 0.10; // 10% Commission
    const merchantNet = gross - platformFee;

    ledgerEntries.push(
      { account: "ACCOUNTS_RECEIVABLE", businessId: bId, debit: gross, credit: 0 },
      { account: "MERCHANT_EARNINGS", businessId: bId, debit: 0, credit: merchantNet },
      { account: "PLATFORM_COMMISSION", businessId: "SYSTEM_PLATFORM", debit: 0, credit: platformFee }
    );

    const biz = data.businesses.find(b => b.id === bId);
    if (biz) {
      biz.balance = (biz.balance || 0) + merchantNet;
    }
    if (!data.wallets[bId]) data.wallets[bId] = { balance: 0, escrow: 0 };
    data.wallets[bId].balance = (data.wallets[bId].balance || 0) + merchantNet;
  });

  data.ledger.push({
    id: uid("TX_"),
    orderId: order.id,
    type: "ORDER_PAYMENT",
    amount: totalAmount,
    entries: ledgerEntries,
    createdAt: Date.now(),
    timestamp: Date.now()
  });

  // AUTO-DISPATCH ENGINE: Assign nearest available driver
  const availableDrivers = data.drivers.filter(d => d.status === "AVAILABLE");
  let assignedDriver = null;

  if (availableDrivers.length > 0) {
    let minDistance = Infinity;

    availableDrivers.forEach(d => {
      const dLat = d.location?.lat || 0;
      const dLng = d.location?.lng || 0;
      if (dLat !== 0 && dLng !== 0) {
        const dist = calculateDistanceKM(
          order.targetLocation.lat,
          order.targetLocation.lng,
          dLat,
          dLng
        );
        if (dist < minDistance) {
          minDistance = dist;
          assignedDriver = d;
        }
      }
    });

    if (!assignedDriver) assignedDriver = availableDrivers[0];
  }

  let delivery = null;
  if (assignedDriver) {
    assignedDriver.status = "BUSY";
    assignedDriver.available = false;

    delivery = {
      id: uid("DEL_"),
      orderId: order.id,
      driverId: assignedDriver.id,
      status: "ASSIGNED",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    data.deliveries.push(delivery);
    order.status = "DISPATCHED";
  }

  saveDB();
  return { order, delivery, assignedDriver };
};

// Batch Checkout Endpoint (Supported by Marketplace Frontends)
app.post("/checkout", (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: "Cart payload empty" });
  }

  const result = createOrderInternal({ items });
  res.status(201).json({
    success: true,
    order: result.order,
    delivery: result.delivery,
    assignedDriver: result.assignedDriver ? result.assignedDriver.name : "Unassigned"
  });
});

// Single Item Order Creation Endpoints
const orderCreateHandler = (req, res) => {
  let items = req.body.items;
  if (!items && (req.body.productId || req.body.id)) {
    items = [{
      productId: req.body.productId || req.body.id,
      qty: req.body.qty || req.body.quantity || 1
    }];
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: "Order items list cannot be empty" });
  }

  const result = createOrderInternal({
    customerName: req.body.customerName,
    customerPhone: req.body.customerPhone,
    deliveryAddress: req.body.deliveryAddress,
    targetLat: req.body.targetLat,
    targetLng: req.body.targetLng,
    items
  });

  res.status(201).json({
    success: true,
    order: result.order,
    delivery: result.delivery,
    assignedDriver: result.assignedDriver ? result.assignedDriver.name : "Unassigned"
  });
};

app.post("/order/create", orderCreateHandler);
app.post("/order", orderCreateHandler);

app.get("/orders", (req, res) => {
  sanitizeDataState();
  res.json({ success: true, orders: data.orders });
});

/* ========================================== */
/* 5. LEDGER, WALLETS & JOURNAL ENDPOINTS     */
/* ========================================== */
const getLedgerHandler = (req, res) => {
  sanitizeDataState();
  res.json({
    success: true,
    ledger: data.ledger,
    transactions: data.ledger
  });
};

app.get("/ledger", getLedgerHandler);
app.get("/transactions", getLedgerHandler);

app.get("/wallets", (req, res) => {
  sanitizeDataState();
  const walletList = Object.keys(data.wallets).map(bizId => ({
    businessId: bizId,
    balance: data.wallets[bizId].balance || 0,
    escrow: data.wallets[bizId].escrow || 0
  }));
  res.json({ success: true, wallets: walletList });
});

/* ========================================== */
/* 6. DRIVER FLEET TERMINAL ROUTER            */
/* ========================================== */
app.get("/drivers", (req, res) => {
  sanitizeDataState();
  res.json({ success: true, drivers: data.drivers || [] });
});

const addDriverHandler = (req, res) => {
  const name = (req.body.name || req.query.name || "").trim();
  const phone = (req.body.phone || req.query.phone || "0700000000").trim();
  if (!name) return res.status(400).json({ success: false, error: "Driver name required" });

  let existing = data.drivers.find(d => d.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.status = "AVAILABLE";
    existing.available = true;
    saveDB();
    return res.status(200).json({ success: true, driver: existing, note: "Existing driver profile reactivated" });
  }

  const driver = {
    id: uid("D_"),
    name,
    phone,
    available: true,
    status: "AVAILABLE",
    location: { lat: -1.286389, lng: 36.817223, heading: 0, speed: 0, lastPing: Date.now() },
    earnings: 0,
    createdAt: Date.now()
  };

  data.drivers.push(driver);
  saveDB();
  res.status(201).json({ success: true, driver });
};

app.post("/addDriver", addDriverHandler);
app.post("/driver/add", addDriverHandler);

const updateDriverStatusHandler = (req, res) => {
  const driverId = req.body.driverId || req.query.driverId;
  let status = (req.body.status || req.query.status || "").toString().toUpperCase();

  if (["IDLE", "ONLINE", "TRUE"].includes(status)) status = "AVAILABLE";

  const driver = data.drivers.find(d => d.id === driverId);
  if (!driver) return res.status(404).json({ success: false, error: "Driver not found" });

  driver.status = status;
  driver.available = (status === "AVAILABLE");

  saveDB();
  res.json({ success: true, driver });
};

app.post("/driverStatus", updateDriverStatusHandler);
app.post("/updateDriverStatus", updateDriverStatusHandler);

const updateLocationHandler = (req, res) => {
  const driverId = req.body.driverId || req.query.driverId;
  const locPayload = req.body.location || req.body;

  const lat = parseFloat(locPayload.lat) || 0;
  const lng = parseFloat(locPayload.lng) || 0;
  const heading = parseFloat(locPayload.heading) || 0;
  const speed = parseFloat(locPayload.speed) || 0;

  const driver = data.drivers.find(d => d.id === driverId);
  if (!driver) return res.status(404).json({ success: false, error: "Driver not found" });

  driver.location = {
    lat,
    lng,
    heading,
    speed,
    lastPing: Date.now()
  };

  saveDB();
  res.json({ success: true, location: driver.location });
};

app.post("/updateDriverLocation", updateLocationHandler);
app.post("/driver/location", updateLocationHandler);

/* ========================================== */
/* 7. JOBS & FULFILLMENT PIPELINE            */
/* ========================================== */
const getDriverJobsHandler = (req, res) => {
  const driverId = req.query.driverId || req.params.driverId || req.body.driverId;
  if (!driverId) return res.status(400).json({ success: false, error: "driverId is required" });

  sanitizeDataState();
  const jobs = data.deliveries.filter(d => d.driverId === driverId && d.status !== "COMPLETED");
  res.json({ success: true, jobs, deliveries: jobs });
};

app.get("/driverJobs", getDriverJobsHandler);
app.get("/driver/:driverId/deliveries", getDriverJobsHandler);

const completeDeliveryHandler = (req, res) => {
  const deliveryId = req.body.deliveryId || req.body.id || req.query.deliveryId;
  const delivery = data.deliveries.find(d => d.id === deliveryId);

  if (!delivery) return res.status(404).json({ success: false, error: "Delivery not found" });

  delivery.status = "COMPLETED";
  delivery.updatedAt = Date.now();

  // Update Order Status
  const order = data.orders.find(o => o.id === delivery.orderId);
  if (order) {
    order.status = "DELIVERED";
  }

  // Driver Payout & Status Reset
  const driver = data.drivers.find(d => d.id === delivery.driverId);
  if (driver) {
    driver.status = "AVAILABLE";
    driver.available = true;
    driver.earnings = (driver.earnings || 0) + 50;

    data.ledger.push({
      id: uid("TX_"),
      orderId: delivery.orderId,
      type: "DRIVER_PAYOUT",
      driverId: driver.id,
      amount: 50,
      createdAt: Date.now(),
      timestamp: Date.now()
    });
  }

  saveDB();
  res.json({ success: true, delivery, driverEarnings: driver ? driver.earnings : 0 });
};

app.post("/completeDelivery", completeDeliveryHandler);
app.post("/updateDelivery", completeDeliveryHandler);

app.post("/createDelivery", (req, res) => {
  const driverId = req.body.driverId || req.query.driverId;
  const delivery = {
    id: uid("DEL_"),
    orderId: uid("ORD_"),
    driverId,
    status: "ASSIGNED",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const driver = data.drivers.find(d => d.id === driverId);
  if (driver) {
    driver.status = "BUSY";
    driver.available = false;
  }

  data.deliveries.push(delivery);
  saveDB();
  res.status(201).json({ success: true, delivery });
});

/* ========================================== */
/* SERVER INITIALIZATION                      */
/* ========================================== */
app.listen(PORT, () => {
  console.log(`🚀 RDS MULTI-TENANT ENTERPRISE CORE ACTIVE ON PORT ${PORT}`);
});