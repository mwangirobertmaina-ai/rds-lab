const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

/* ===================== */
/* MIDDLEWARE & CORS     */
/* ===================== */
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

/* ===================== */
/* DATABASE INITIALIZATION */
/* ===================== */
let data = {
  businesses: [],
  products: [],
  orders: [],
  ledger: [],
  wallets: {}
};

// Safe Schema Hydration
if (fs.existsSync(DB_FILE)) {
  try {
    const rawData = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(rawData);
    data = {
      businesses: Array.isArray(parsed.businesses) ? parsed.businesses : [],
      products: Array.isArray(parsed.products) ? parsed.products : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
      wallets: (parsed.wallets && typeof parsed.wallets === "object") ? parsed.wallets : {}
    };
  } catch (e) {
    console.error("❌ DB READ/PARSE ERROR:", e.message);
  }
}

/* ===================== */
/* ATOMIC FILE STORAGE   */
/* ===================== */
let isSaving = false;
let savePending = false;

const saveDB = () => {
  if (isSaving) {
    savePending = true;
    return;
  }

  isSaving = true;
  const tempFile = `${DB_FILE}.tmp`;

  fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8", (err) => {
    if (err) {
      console.error("❌ DB WRITE TEMP ERROR:", err.message);
      isSaving = false;
      return;
    }

    fs.rename(tempFile, DB_FILE, (renameErr) => {
      isSaving = false;
      if (renameErr) {
        console.error("❌ DB ATOMIC RENAME ERROR:", renameErr.message);
      }
      if (savePending) {
        savePending = false;
        saveDB();
      }
    });
  });
};

const uid = (prefix) => `${prefix}${Date.now()}_${Math.floor(Math.random() * 10000)}`;

/* ===================== */
/* HEALTH & DIAGNOSTICS  */
/* ===================== */
app.get("/", (req, res) => {
  res.json({
    success: true,
    engine: "RDS PRO CORE ULTRA",
    status: "ACTIVE",
    uptime: `${Math.floor(process.uptime())}s`,
    timestamp: Date.now()
  });
});

/* ===================== */
/* BUSINESSES ROUTER     */
/* ===================== */
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

  if (data.wallets) {
    delete data.wallets[id];
  }

  saveDB();
  res.json({ success: true, deletedId: id });
});

/* ===================== */
/* PRODUCTS ROUTER       */
/* ===================== */
app.post("/addProduct", (req, res) => {
  const name = (req.body.name || req.query.name || "").trim();
  const price = parseInt(req.body.price || req.query.price, 10);
  const businessId = req.body.businessId || req.query.businessId;

  if (!name || isNaN(price) || price < 0 || !businessId) {
    return res.status(400).json({ success: false, error: "Invalid product fields or missing parameters" });
  }

  const bizExists = data.businesses.some(b => b.id === businessId);
  if (!bizExists) {
    return res.status(404).json({ success: false, error: "Associated business not found" });
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

/* ===================== */
/* ORDER PROCESSING LOGIC*/
/* ===================== */
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
    const itemCommission = Math.floor(subtotal * 0.05);
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

/* ===================== */
/* CHECKOUT & SINGLE ORDER*/
/* ===================== */

// Single Item Legacy Endpoint
app.post("/order", (req, res) => {
  try {
    const productId = req.body.productId || req.query.productId;
    const qty = parseInt(req.body.qty || req.query.qty, 10) || 1;

    if (!productId) {
      return res.status(400).json({ success: false, error: "Product ID required" });
    }

    const { total, commission, walletMap, entries, enrichedItems } = processOrderItems([{ productId, qty }]);

    const order = {
      id: uid("O_"),
      productId,
      qty,
      items: enrichedItems,
      total,
      commission,
      createdAt: Date.now()
    };

    data.orders.push(order);

    data.ledger.push({
      id: uid("L_"),
      orderId: order.id,
      entries,
      createdAt: Date.now()
    });

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

    saveDB();
    res.status(201).json({ success: true, order });

  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Atomic Batch Checkout
app.post("/checkout", (req, res) => {
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

    data.ledger.push({
      id: uid("L_"),
      orderId: order.id,
      entries,
      createdAt: Date.now()
    });

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

    saveDB();
    res.status(201).json({ success: true, order });

  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/* ===================== */
/* PAYOUT ENGINE         */
/* ===================== */
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
      error: "Insufficient wallet funds",
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

/* ===================== */
/* READ-ONLY API ENDPOINTS */
/* ===================== */
app.get("/orders", (req, res) => {
  res.json({ success: true, orders: data.orders || [] });
});

app.get("/ledger", (req, res) => {
  res.json({ success: true, ledger: data.ledger || [] });
});

app.get("/wallets", (req, res) => {
  res.json({ success: true, wallets: Object.values(data.wallets || {}) });
});

/* ===================== */
/* SERVER LISTENER       */
/* ===================== */
app.listen(PORT, () => {
  console.log(`🚀 RDS PRO ENGINE RUNNING ON PORT ${PORT}`);
});