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

// Load database and guarantee required keys exist
if (fs.existsSync(DB_FILE)) {
  try {
    const parsedData = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    data = {
      businesses: parsedData.businesses || [],
      products: parsedData.products || [],
      orders: parsedData.orders || [],
      ledger: parsedData.ledger || [],
      wallets: parsedData.wallets || {}
    };
  } catch (err) {
    console.error("Error reading db.json, using default schema:", err.message);
  }
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
  if (!name) return res.json({ success: false, error: "Name is required" });

  const business = { id: uid("B_"), name };
  data.businesses.push(business);

  // Safely initialize wallets map if it doesn't exist
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
  res.json({ success: true, businesses: data.businesses });
});

app.post("/deleteBusiness", (req, res) => {
  const { id } = req.body;
  data.businesses = data.businesses.filter(b => b.id !== id);
  if (data.wallets) {
    delete data.wallets[id];
  }
  saveDB();
  res.json({ success: true });
});

/* ===================== */
/* PRODUCTS              */
/* ===================== */
app.post("/addProduct", (req, res) => {
  const { name, price, businessId } = req.body;

  const product = {
    id: uid("P_"),
    name,
    price: parseInt(price, 10),
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
/* ORDER + LEDGER        */
/* ===================== */
app.post("/order", (req, res) => {
  const { productId, qty } = req.body;

  const p = data.products.find(x => x.id === productId);
  if (!p) return res.json({ success: false, error: "Product not found" });

  const quantity = qty || 1;
  const total = p.price * quantity;

  const commission = Math.floor(total * 0.05);
  const payable = total - commission;

  const order = {
    id: uid("O_"),
    productId,
    qty: quantity,
    total,
    createdAt: Date.now()
  };

  data.orders.push(order);

  /* LEDGER ENTRY */
  data.ledger.push({
    id: uid("L_"),
    entries: [
      { account: "CASH", debit: total, credit: 0 },
      { account: "PLATFORM_REVENUE", debit: 0, credit: commission },
      { account: "BUSINESS_PAYABLE", businessId: p.businessId, debit: 0, credit: payable }
    ],
    createdAt: Date.now()
  });

  /* WALLET UPDATE */
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
    amount: payable
  });

  saveDB();

  res.json({ success: true, order });
});

/* ===================== */
/* PAYOUT / WITHDRAW     */
/* ===================== */
app.post("/payout", (req, res) => {
  const { businessId, amount } = req.body;

  const withdrawAmount = parseInt(amount, 10);
  if (!businessId || isNaN(withdrawAmount) || withdrawAmount <= 0) {
    return res.json({ success: false, error: "Invalid businessId or amount" });
  }

  // 1. Verify business and wallet existence
  if (!data.wallets || !data.wallets[businessId]) {
    return res.json({ success: false, error: "Wallet not found for this business" });
  }

  const wallet = data.wallets[businessId];

  // 2. Check sufficient funds
  if (wallet.balance < withdrawAmount) {
    return res.json({
      success: false,
      error: "Insufficient funds",
      currentBalance: wallet.balance
    });
  }

  const payoutId = uid("PO_");

  /* 3. LEDGER ENTRY (Debits Payable, Credits Cash) */
  data.ledger.push({
    id: uid("L_"),
    entries: [
      { account: "BUSINESS_PAYABLE", businessId, debit: withdrawAmount, credit: 0 },
      { account: "CASH", debit: 0, credit: withdrawAmount }
    ],
    createdAt: Date.now()
  });

  /* 4. WALLET DEDUCTION */
  wallet.balance -= withdrawAmount;
  wallet.transactions.push({
    id: uid("WT_"),
    type: "DEBIT",
    amount: withdrawAmount,
    payoutId
  });

  saveDB();

  res.json({
    success: true,
    payoutId,
    amountDeducted: withdrawAmount,
    remainingBalance: wallet.balance
  });
});

/* ===================== */
/* LEDGER + WALLETS      */
/* ===================== */
app.get("/ledger", (req, res) => {
  res.json({ success: true, ledger: data.ledger });
});

app.get("/wallets", (req, res) => {
  res.json({
    success: true,
    wallets: Object.values(data.wallets || {})
  });
});

/* ===================== */
/* START                 */
/* ===================== */
app.listen(PORT, () => {
  console.log("🚀 RDS ENGINE RUNNING ON PORT " + PORT);
});