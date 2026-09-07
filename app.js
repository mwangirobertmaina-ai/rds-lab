const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();

/* ===================== */
/* 🌍 CORS FIX (IMPORTANT) */
/* ===================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

/* ===================== */
/* 🚀 PORT FIX (RENDER)   */
/* ===================== */
const PORT = process.env.PORT || 3000;

/* ===================== */
/* 📁 FILE STORAGE       */
/* ===================== */
const DB_FILE = "db.json";

/* LOAD DATA */
let data = {
  businesses: [],
  products: [],
  orders: [],
  ledger: [],
  wallets: {}
};

if (fs.existsSync(DB_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE));
  } catch (e) {
    console.log("⚠️ DB corrupted, resetting...");
  }
}

/* SAVE FUNCTION */
const saveDB = () => {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

/* ===================== */
/* 🔧 HELPERS            */
/* ===================== */
const uid = (p) =>
  p + Date.now() + "_" + Math.floor(Math.random() * 1000);

/* ===================== */
/* ROOT HEALTH CHECK     */
/* ===================== */
app.get("/", (req, res) => {
  res.json({ status: "RDS ENGINE LIVE" });
});

/* ===================== */
/* 🏪 BUSINESSES         */
/* ===================== */

/* ADD BUSINESS */
app.post("/addBusiness", (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.json({ success: false, message: "Name required" });
  }

  const business = { id: uid("B_"), name };

  data.businesses.push(business);

  data.wallets[business.id] = {
    businessId: business.id,
    balance: 0,
    transactions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  saveDB();

  res.json({ success: true, business });
});

/* GET BUSINESSES */
app.get("/businesses", (req, res) => {
  res.json({ success: true, businesses: data.businesses });
});

/* DELETE BUSINESS */
app.post("/deleteBusiness", (req, res) => {
  const { id } = req.body;

  if (!id) return res.json({ success: false });

  data.businesses = data.businesses.filter(b => b.id !== id);
  data.products = data.products.filter(p => p.businessId !== id);

  delete data.wallets[id];

  saveDB();

  res.json({ success: true });
});

/* ===================== */
/* 📦 PRODUCTS           */
/* ===================== */

/* ADD PRODUCT */
app.post("/addProduct", (req, res) => {
  const { name, price, businessId } = req.body;

  if (!name || !price || !businessId) {
    return res.json({ success: false, message: "Missing fields" });
  }

  const product = {
    id: uid("P_"),
    name,
    price: parseInt(price),
    businessId,
  };

  data.products.push(product);

  saveDB();

  res.json({ success: true, product });
});

/* GET PRODUCTS */
app.get("/products", (req, res) => {
  res.json({ success: true, products: data.products });
});

/* DELETE PRODUCT */
app.post("/deleteProduct", (req, res) => {
  const { id } = req.body;

  if (!id) return res.json({ success: false });

  data.products = data.products.filter(p => p.id !== id);

  saveDB();

  res.json({ success: true });
});

/* ===================== */
/* 🛒 ORDER + LEDGER     */
/* ===================== */

app.post("/multiOrder", (req, res) => {
  const { items } = req.body;

  if (!items || !items.length) {
    return res.json({ success: false });
  }

  let total = 0;
  let businessMap = {};
  let detailed = [];

  for (let i of items) {
    const p = data.products.find(x => x.id === i.productId);
    if (!p) return res.json({ success: false });

    const qty = i.qty || 1;
    const itemTotal = p.price * qty;

    total += itemTotal;

    detailed.push({
      productId: p.id,
      price: p.price,
      qty,
      itemTotal,
      businessId: p.businessId
    });

    if (!businessMap[p.businessId]) {
      businessMap[p.businessId] = 0;
    }

    businessMap[p.businessId] += itemTotal;
  }

  const order = {
    id: uid("O_"),
    items: detailed,
    total,
    createdAt: Date.now()
  };

  data.orders.push(order);

  /* LEDGER */
  const RATE = 0.05;
  let entries = [];

  entries.push({ account: "CASH", debit: total, credit: 0 });

  Object.keys(businessMap).forEach(bId => {
    const bTotal = businessMap[bId];
    const commission = Math.floor(bTotal * RATE);
    const payable = bTotal - commission;

    entries.push({ account: "PLATFORM_REVENUE", debit: 0, credit: commission });

    entries.push({
      account: "BUSINESS_PAYABLE",
      businessId: bId,
      debit: 0,
      credit: payable
    });

    /* WALLET UPDATE */
    if (!data.wallets[bId]) {
      data.wallets[bId] = {
        businessId: bId,
        balance: 0,
        transactions: []
      };
    }

    data.wallets[bId].balance += payable;

    data.wallets[bId].transactions.push({
      id: uid("WT_"),
      type: "CREDIT",
      amount: payable,
      orderId: order.id,
      createdAt: Date.now()
    });
  });

  data.ledger.push({
    id: uid("L_"),
    entries,
    createdAt: Date.now()
  });

  saveDB();

  res.json({ success: true, order });
});

/* ===================== */
/* 💼 WALLETS            */
/* ===================== */

app.get("/wallets", (req, res) => {
  res.json({
    success: true,
    wallets: Object.values(data.wallets)
  });
});

/* ===================== */
/* 💸 WITHDRAW           */
/* ===================== */

app.post("/withdraw", (req, res) => {
  const { businessId, amount } = req.body;

  const w = data.wallets[businessId];
  const amt = parseInt(amount);

  if (!w || w.balance < amt) {
    return res.json({ success: false });
  }

  w.balance -= amt;

  w.transactions.push({
    id: uid("WT_"),
    type: "DEBIT",
    amount: amt,
    createdAt: Date.now()
  });

  data.ledger.push({
    id: uid("L_"),
    type: "WITHDRAW",
    entries: [
      { account: "BUSINESS_PAYABLE", debit: amt, credit: 0 },
      { account: "CASH_OUT", debit: 0, credit: amt }
    ],
    createdAt: Date.now()
  });

  saveDB();

  res.json({ success: true });
});

/* ===================== */
/* 🚀 START SERVER       */
/* ===================== */

app.listen(PORT, () => {
  console.log("🚀 RDS ENGINE RUNNING ON PORT " + PORT);
});