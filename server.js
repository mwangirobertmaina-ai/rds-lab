const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");

const app = express();

/* ========================================== */
/* EXPRESS MIDDLEWARE & CORS PROTOCOLS        */
/* ========================================== */
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "PUT", "OPTIONS"] }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

/* ========================================== */
/* IN-MEMORY SCHEMA HYDRATION                 */
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

// Synchronous initial load on boot
if (fs.existsSync(DB_FILE)) {
  try {
    const rawData = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(rawData);
    data = {
      businesses: Array.isArray(parsed.businesses) ? parsed.businesses : [],
      products: Array.isArray(parsed.products) ? parsed.products : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
      wallets: (parsed.wallets && typeof parsed.wallets === "object") ? parsed.wallets : {},
      drivers: Array.isArray(parsed.drivers) ? parsed.drivers : [],
      deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : []
    };
  } catch (e) {
    console.error("❌ CRITICAL: DB READ/PARSE FAILURE:", e.message);
  }
}

/* ========================================== */
/* NON-BLOCKING ASYNC ATOMIC PERSISTENCE     */
/* ========================================== */
let isWriting = false;
let pendingWrite = false;

const saveDB = async () => {
  if (isWriting) {
    pendingWrite = true;
    return;
  }

  isWriting = true;
  const tempFile = `${DB_FILE}.${Date.now()}_${Math.floor(Math.random() * 1000)}.tmp`;

  try {
    const serialized = JSON.stringify(data, null, 2);
    await fsPromises.writeFile(tempFile, serialized, "utf-8");
    await fsPromises.rename(tempFile, DB_FILE);
  } catch (err) {
    console.error("❌ DB ASYNC PERSISTENCE ERROR:", err.message);
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
/* HEALTH & TELEMETRY API                     */
/* ========================================== */
app.get("/", (req, res) => {
  res.json({
    success: true,
    engine: "RDS STAGE 10 ENTERPRISE CORE",
    status: "HEALTHY",
    uptime: `${Math.floor(process.uptime())}s`,
    timestamp: Date.now(),
    stats: {
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

  if (!data.wallets) data.wallets = {};
  data.wallets[business.id] = {
    businessId: business.id,
    balance: 0,
    transactions: []
  };

  saveDB();
  res.status(201).json({ success: true, business });
});

app.get("/businesses", (req, res) => {
  res.json({ success: true, businesses: data.businesses || [] });
});

app.post("/deleteBusiness", (req, res) => {
  const id = req.body.id || req.query.id;
  if (!id) {
    return res.status(400).json({ success: false, error: "Business ID required" });
  }

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

  const product = {
    id: uid("P_"),
    name,
    price,
    businessId,
    createdAt: Date.now()
  };

  data.products.push(product);
  saveDB();

  res.status(201).json({ success: true, product });
});

app.get("/products", (req, res) => {
  res.json({ success: true, products: data.products || [] });
});

app.post("/deleteProduct", (req, res) => {
  const id = req.body.id || req.query.id;
  if (!id) {
    return res.status(400).json({ success: false, error: "Product ID required" });
  }

  data.products = data.products.filter(p => p.id !== id);
  saveDB();
  res.json({ success: true, deletedId: id });
});

/* ========================================== */
/* FLEET & DRIVER ROUTER                      */
/* ========================================== */
app.post("/addDriver", (req, res) => {
  const name = (req.body.name || req.query.name || "").trim();
  const phone = (req.body.phone || req.query.phone || "").trim();

  if (!name) {
    return res.status(400).json({ success: false, error: "Driver name required" });
  }

  const driver = {
    id: uid("D_"),
    name,
    phone,
    status: "AVAILABLE", // AVAILABLE | BUSY | OFFLINE
    earnings: 0,
    createdAt: Date.now()
  };

  data.drivers.push(driver);
  saveDB();

  res.status(201).json({ success: true, driver });
});

app.get("/drivers", (req, res) => {
  res.json({ success: true, drivers: data.drivers || [] });
});

app.post("/updateDriverStatus", (req, res) => {
  const driverId = req.body.driverId || req.query.driverId;
  const status = (req.body.status || req.query.status || "").toUpperCase();

  if (!driverId || !["AVAILABLE", "BUSY", "OFFLINE"].includes(status)) {
    return res.status(400).json({ success: false, error: "Valid driverId and status required" });
  }

  const driver = data.drivers.find(d => d.id === driverId);
  if (!driver) {
    return res.status(404).json({ success: false, error: "Driver not found" });
  }

  driver.status = status;
  saveDB();

  res.json({ success: true, driver });
});

/* ========================================== */
/* FINANCIAL & TRANSACTION PROCESSING ENGINE  */
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
      throw new Error(`Product ID not found: ${item.productId}`);
    }

    const qty = parseInt(item.qty, 10) || 1;
    const subtotal = p.price * qty;
    const itemCommission = Math.floor(subtotal * 0.05); // 5% platform fee
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
/* CHECKOUT & AUTOMATED DISPATCH ROUTER       */
/* ========================================== */
app.post("/order", (req, res) => {
  const productId = req.body.productId || req.query.productId;
  const qty = parseInt(req.body.qty || req.query.qty, 10) || 1;

  if (!productId) {
    return res.status(400).json({ success: false, error: "Product ID required" });
  }

  req.body.items = [{ productId, qty }];
  return checkoutHandler(req, res);
});

app.post("/checkout", checkoutHandler);

function checkoutHandler(req, res) {
  try {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Cart payload must be a non-empty array" });
    }

    const { total, commission, walletMap, entries, enrichedItems } = processOrderItems(items);

    const order = {
      id: uid("O_"),
      items: enrichedItems,
      total,
      commission,
      createdAt: Date.now()
    };

    data.orders.push(order);

    /* JOURNAL LEDGER ENTRY */
    data.ledger.push({
      id: uid("L_"),
      orderId: order.id,
      entries,
      createdAt: Date.now()
    });

    /* WALLET ACCOUNTING */
    if (!data.wallets) data.wallets = {};

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

    /* AUTO DISPATCH DRIVER FLEET */
    const availableDriver = data.drivers.find(d => d.status === "AVAILABLE");
    let delivery = null;

    if (availableDriver) {
      availableDriver.status = "BUSY";

      delivery = {
        id: uid("DEL_"),
        orderId: order.id,
        driverId: availableDriver.id,
        status: "ASSIGNED", // ASSIGNED | PICKED_UP | IN_TRANSIT | DELIVERED | CANCELLED
        createdAt: Date.now()
      };

      data.deliveries.push(delivery);
    }

    saveDB();

    res.status(201).json({
      success: true,
      order,
      delivery: delivery || { status: "UNASSIGNED", note: "No drivers available" }
    });

  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
}

/* ========================================== */
/* DISPATCH & DELIVERY LIFECYCLE MANAGEMENT   */
/* ========================================== */
app.get("/deliveries", (req, res) => {
  res.json({ success: true, deliveries: data.deliveries || [] });
});

app.post("/updateDelivery", (req, res) => {
  const deliveryId = req.body.deliveryId || req.query.deliveryId;
  const status = (req.body.status || req.query.status || "").toUpperCase();

  if (!deliveryId || !["ASSIGNED", "PICKED_UP", "IN_TRANSIT", "DELIVERED", "CANCELLED"].includes(status)) {
    return res.status(400).json({ success: false, error: "Valid deliveryId and status required" });
  }

  const delivery = data.deliveries.find(d => d.id === deliveryId);
  if (!delivery) {
    return res.status(404).json({ success: false, error: "Delivery task not found" });
  }

  delivery.status = status;
  delivery.updatedAt = Date.now();

  if (status === "DELIVERED" || status === "CANCELLED") {
    const driver = data.drivers.find(dr => dr.id === delivery.driverId);
    if (driver) {
      driver.status = "AVAILABLE";
      if (status === "DELIVERED") {
        driver.earnings = (driver.earnings || 0) + 5; // Standard flat delivery bonus
      }
    }
  }

  saveDB();
  res.json({ success: true, delivery });
});

/* ========================================== */
/* MERCHANT & DRIVER PAYOUT ROUTER            */
/* ========================================== */
app.post("/payout", (req, res) => {
  const businessId = req.body.businessId || req.query.businessId;
  const amount = parseInt(req.body.amount || req.query.amount, 10);

  if (!businessId || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid business ID or withdrawal amount" });
  }

  if (!data.wallets || !data.wallets[businessId]) {
    return res.status(404).json({ success: false, error: "Wallet not found for business" });
  }

  const wallet = data.wallets[businessId];

  if (wallet.balance < amount) {
    return res.status(400).json({
      success: false,
      error: "Insufficient funds",
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
/* TRANSPARENCY READ APIs                     */
/* ========================================== */
app.get("/orders", (req, res) => {
  res.json({ success: true, orders: data.orders || [] });
});

app.get("/ledger", (req, res) => {
  res.json({ success: true, ledger: data.ledger || [] });
});

app.get("/wallets", (req, res) => {
  res.json({ success: true, wallets: Object.values(data.wallets || {}) });
});

/* ========================================== */
/* SERVER INITIALIZATION                     */
/* ========================================== */
app.listen(PORT, () => {
  console.log(`🚀 RDS STAGE 10 ENTERPRISE ENGINE ONLINE AT PORT ${PORT}`);
});