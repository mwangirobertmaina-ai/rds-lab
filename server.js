const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();

// Advanced CORS configuration
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* ===================== */
/* DATABASE              */
/* ===================== */
const DB_FILE = "db.json";

let data = {
  businesses: [],
  products: [],
  orders: [],
  ledger: [],
  wallets: {}
};

// Safe Database Hydration
if (fs.existsSync(DB_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    data = {
      businesses: Array.isArray(parsed.businesses) ? parsed.businesses : [],
      products: Array.isArray(parsed.products) ? parsed.products : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
      wallets: (parsed.wallets && typeof parsed.wallets === "object") ? parsed.wallets : {}
    };
  } catch (e) {
    console.error("DB READ ERROR:", e.message);
  }
}

const saveDB = () => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("DB WRITE ERROR:", e.message);
  }
};

const uid = (p) => p + Date.now() + "_" + Math.floor(Math.random() * 1000);

/* ===================== */
/* ROOT                  */
/* ===================== */
app.get("/", (req, res) => {
  res.json({ status: "OK", engine: "RDS ADVANCED CORE" });
});

/* ===================== */
/* BUSINESSES            */
/* ===================== */
app.post("/addBusiness", (req, res) => {
  const name = req.body.name || req.query.name;
  if (!name) return res.status(400).json({ success: false, error: "Business name required" });

  const business = { id: uid("B_"), name };
  data.businesses.push(business);

  if (!data.wallets) data.wallets = {};
  data.wallets[business.id] = {
    businessId: business.id,
    balance: 0,
    transactions: []
  };

  saveDB();
  res.json({ success: true, business });
});

app.get("/businesses", (req, res) => {
  res.json({ success: true, businesses: data.businesses || [] });
});

app.post("/deleteBusiness", (req, res) => {
  const id = req.body.id || req.query.id;
  if (!id) return res.status(400).json({ success: false, error: "ID required" });

  data.businesses = data.businesses.filter(b => b.id !== id);
  if (data.wallets) delete data.wallets[id];

  saveDB();
  res.json({ success: true });
});

/* ===================== */
/* PRODUCTS              */
/* ===================== */
app.post("/addProduct", (req, res) => {
  const name = req.body.name || req.query.name;
  const price = parseInt(req.body.price || req.query.price, 10);
  const businessId = req.body.businessId || req.query.businessId;

  if (!name || isNaN(price) || !businessId) {
    return res.status(400).json({ success: false, error: "Invalid product parameters" });
  }

  const product = {
    id: uid("P_"),
    name,
    price,
    businessId
  };

  data.products.push(product);
  saveDB();

  res.json({ success: true, product });
});

app.get("/products", (req, res) => {
  res.json({ success: true, products: data.products || [] });
});

app.post("/deleteProduct", (req, res) => {
  const id = req.body.id || req.query.id;
  if (!id) return res.status(400).json({ success: false, error: "ID required" });

  data.products = data.products.filter(p => p.id !== id);
  saveDB();
  res.json({ success: true });
});

/* ===================== */
/* ORDERS & CHECKOUT     */
/* ===================== */

// Single Item Order Route (Backward Compatible)
app.post("/order", (req, res) => {
  const productId = req.body.productId || req.query.productId;
  const qty = parseInt(req.body.qty || req.query.qty, 10) || 1;

  const p = data.products.find(x => x.id === productId);
  if (!p) return res.status(404).json({ success: false, error: "Product not found" });

  const total = p.price * qty;
  const commission = Math.floor(total * 0.05);
  const payable = total - commission;

  const order = {
    id: uid("O_"),
    productId,
    qty,
    total,
    createdAt: Date.now()
  };

  data.orders.push(order);

  /* DOUBLE-ENTRY LEDGER */
  data.ledger.push({
    id: uid("L_"),
    orderId: order.id,
    entries: [
      { account: "CASH", debit: total, credit: 0 },
      { account: "PLATFORM_REVENUE", debit: 0, credit: commission },
      { account: "BUSINESS_PAYABLE", businessId: p.businessId, debit: 0, credit: payable }
    ],
    createdAt: Date.now()
  });

  /* WALLET CREDIT */
  if (!data.wallets) data.wallets = {};
  if (!data.wallets[p.businessId]) {
    data.wallets[p.businessId] = {
      businessId: p.businessId,
      balance: 0,
      transactions: []
    };
  }

  data.wallets[p.businessId].balance += payable;
  data.wallets[p.businessId].transactions.push({
    id: uid("WT_"),
    type: "CREDIT",
    amount: payable,
    orderId: order.id
  });

  saveDB();
  res.json({ success: true, order });
});

// Advanced Multi-Item Batch Checkout Route
app.post("/checkout", (req, res) => {
  const items = req.body.items;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: "Cart items must be a non-empty array" });
  }

  let grandTotal = 0;
  let grandCommission = 0;
  const orderItems = [];
  const walletMap = {};
  const ledgerEntries = [];

  for (const item of items) {
    const product = data.products.find(p => p.id === item.productId);
    if (!product) {
      return res.status(404).json({ success: false, error: `Product not found: ${item.productId}` });
    }

    const quantity = parseInt(item.qty, 10) || 1;
    const itemTotal = product.price * quantity;
    const itemCommission = Math.floor(itemTotal * 0.05);
    const itemPayable = itemTotal - itemCommission;

    grandTotal += itemTotal;
    grandCommission += itemCommission;

    orderItems.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      qty: quantity,
      subtotal: itemTotal
    });

    walletMap[product.businessId] = (walletMap[product.businessId] || 0) + itemPayable;

    ledgerEntries.push({
      account: "BUSINESS_PAYABLE",
      businessId: product.businessId,
      debit: 0,
      credit: itemPayable
    });
  }

  ledgerEntries.unshift({ account: "CASH", debit: grandTotal, credit: 0 });
  if (grandCommission > 0) {
    ledgerEntries.push({ account: "PLATFORM_REVENUE", debit: 0, credit: grandCommission });
  }

  const order = {
    id: uid("O_"),
    items: orderItems,
    total: grandTotal,
    commission: grandCommission,
    createdAt: Date.now()
  };

  data.orders.push(order);

  data.ledger.push({
    id: uid("L_"),
    orderId: order.id,
    entries: ledgerEntries,
    createdAt: Date.now()
  });

  if (!data.wallets) data.wallets = {};
  Object.keys(walletMap).forEach(bizId => {
    if (!data.wallets[bizId]) {
      data.wallets[bizId] = { businessId: bizId, balance: 0, transactions: [] };
    }
    const payableAmount = walletMap[bizId];
    data.wallets[bizId].balance += payableAmount;
    data.wallets[bizId].transactions.push({
      id: uid("WT_"),
      type: "CREDIT",
      amount: payableAmount,
      orderId: order.id
    });
  });

  saveDB();
  res.json({ success: true, order });
});

/* ===================== */
/* PAYOUT / WITHDRAW     */
/* ===================== */
app.post("/payout", (req, res) => {
  const businessId = req.body.businessId || req.query.businessId;
  const amount = parseInt(req.body.amount || req.query.amount, 10);

  if (!businessId || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid businessId or amount" });
  }

  if (!data.wallets || !data.wallets[businessId]) {
    return res.status(404).json({ success: false, error: "Wallet not found for this business" });
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

  /* DOUBLE-ENTRY LEDGER FOR PAYOUT */
  data.ledger.push({
    id: uid("L_"),
    payoutId,
    entries: [
      { account: "BUSINESS_PAYABLE", businessId, debit: amount, credit: 0 },
      { account: "CASH", debit: 0, credit: amount }
    ],
    createdAt: Date.now()
  });

  wallet.balance -= amount;
  wallet.transactions.push({
    id: uid("WT_"),
    type: "DEBIT",
    amount,
    payoutId
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
/* READ-ONLY ENDPOINTS   */
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
/* START SERVER          */
/* ===================== */
app.listen(PORT, () => {
  console.log("🚀 ADVANCED ENGINE RUNNING ON PORT " + PORT);
});