const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

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
  data = JSON.parse(fs.readFileSync(DB_FILE));
}

/* SAVE FUNCTION */
const saveDB = () => {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

/* ===================== */
/* 🔧 HELPERS            */
/* ===================== */
const uid = (p) => p + Date.now() + "_" + Math.floor(Math.random() * 1000);

/* ===================== */
/* ROOT                  */
/* ===================== */
app.get("/", (req, res) => {
  res.json({ status: "OK DATABASE SYSTEM" });
});

/* ===================== */
/* 🏪 BUSINESSES         */
/* ===================== */
app.post("/addBusiness", (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.json({ success: false });
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

app.get("/businesses", (req, res) => {
  res.json({ success: true, businesses: data.businesses });
});

/* ===================== */
/* 📦 PRODUCTS           */
/* ===================== */
app.post("/addProduct", (req, res) => {
  const { name, price, businessId } = req.body;

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

app.get("/products", (req, res) => {
  res.json({ success: true, products: data.products });
});

/* ===================== */
/* 🛒 ORDER + LEDGER     */
/* ===================== */
app.post("/multiOrder", (req, res) => {
  const { items } = req.body;

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

    /* WALLET */
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
/* 🚀 START              */
/* ===================== */
app.listen(PORT, () => {
  console.log("🚀 DATABASE SYSTEM RUNNING ON PORT " + PORT);
});