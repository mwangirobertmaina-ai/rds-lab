const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

/* ===================== */
/* FILE STORAGE          */
/* ===================== */
const DB_FILE = "db.json";

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

const saveDB = () => {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

const uid = (p) => p + Date.now() + "_" + Math.floor(Math.random() * 1000);

/* ===================== */
/* ROOT                  */
/* ===================== */
app.get("/", (req, res) => {
  res.json({ status: "RDS ENGINE LIVE" });
});

/* ===================== */
/* BUSINESSES            */
/* ===================== */
app.post("/addBusiness", (req, res) => {
  const { name } = req.body;

  if (!name) return res.json({ success: false });

  const business = { id: uid("B_"), name };

  data.businesses.push(business);

  data.wallets[business.id] = {
    businessId: business.id,
    balance: 0,
    transactions: []
  };

  saveDB();

  res.json({ success: true, business });
});

app.get("/businesses", (req, res) => {
  res.json({ success: true, businesses: data.businesses });
});

app.post("/deleteBusiness", (req, res) => {
  const { id } = req.body;

  data.businesses = data.businesses.filter(b => b.id !== id);
  delete data.wallets[id];

  saveDB();
  res.json({ success: true });
});

/* ===================== */
/* PRODUCTS              */
/* ===================== */
app.post("/addProduct", (req, res) => {
  const { name, price, businessId } = req.body;

  if (!name || !price || !businessId) {
    return res.json({ success: false });
  }

  const product = {
    id: uid("P_"),
    name,
    price: parseInt(price),
    businessId
  };

  data.products.push(product);

  saveDB();

  res.json({ success: true, product });
});

app.get("/products", (req, res) => {
  res.json({ success: true, products: data.products });
});

app.post("/deleteProduct", (req, res) => {
  const { id } = req.body;

  data.products = data.products.filter(p => p.id !== id);

  saveDB();
  res.json({ success: true });
});

/* ===================== */
/* 🛒 ORDER ENGINE       */
/* ===================== */
app.post("/order", (req, res) => {
  const { productId, qty } = req.body;

  const p = data.products.find(x => x.id === productId);
  if (!p) return res.json({ success: false, message: "Product not found" });

  const quantity = qty || 1;
  const total = p.price * quantity;

  const order = {
    id: uid("O_"),
    productId,
    qty: quantity,
    total,
    businessId: p.businessId,
    createdAt: Date.now()
  };

  data.orders.push(order);

  /* ===== FINANCIAL LOGIC ===== */
  const commissionRate = 0.05;
  const commission = Math.floor(total * commissionRate);
  const payable = total - commission;

  /* ===== LEDGER ENTRY ===== */
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

  /* ===== WALLET UPDATE ===== */
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
    orderId: order.id,
    createdAt: Date.now()
  });

  saveDB();

  res.json({ success: true, order });
});

/* ===================== */
/* 🧾 LEDGER VIEW        */
/* ===================== */
app.get("/ledger", (req, res) => {
  res.json({
    success: true,
    ledger: data.ledger
  });
});

/* ===================== */
/* 💼 WALLET VIEW        */
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

  const wallet = data.wallets[businessId];
  const amt = parseInt(amount);

  if (!wallet || wallet.balance < amt) {
    return res.json({ success: false, message: "Insufficient funds" });
  }

  wallet.balance -= amt;

  wallet.transactions.push({
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
/* START                 */
/* ===================== */
app.listen(PORT, () => {
  console.log("🚀 RDS ENGINE RUNNING ON PORT " + PORT);
});