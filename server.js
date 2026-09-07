const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

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

if (fs.existsSync(DB_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE));
    data = {
      businesses: parsed.businesses || [],
      products: parsed.products || [],
      orders: parsed.orders || [],
      ledger: parsed.ledger || [],
      wallets: parsed.wallets || {}
    };
  } catch (e) {
    console.log("DB ERROR:", e.message);
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
  res.json({ status: "OK" });
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
/* ORDER + LEDGER        */
/* ===================== */
app.post("/order", (req, res) => {
  const { productId, qty } = req.body;

  const p = data.products.find(x => x.id === productId);
  if (!p) return res.json({ success: false });

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

  /* LEDGER */
  data.ledger.push({
    id: uid("L_"),
    entries: [
      { account: "CASH", debit: total, credit: 0 },
      { account: "PLATFORM_REVENUE", debit: 0, credit: commission },
      { account: "BUSINESS_PAYABLE", businessId: p.businessId, debit: 0, credit: payable }
    ],
    createdAt: Date.now()
  });

  /* WALLET */
  if (!data.wallets[p.businessId]) {
    data.wallets[p.businessId] = {
      businessId: p.businessId,
      balance: 0,
      transactions: []
    };
  }

  data.wallets[p.businessId].balance += payable;

  saveDB();
  res.json({ success: true, order });
});

/* ===================== */
/* EXTRA ROUTES          */
/* ===================== */
app.get("/orders", (req, res) => {
  res.json({ success: true, orders: data.orders });
});

app.get("/ledger", (req, res) => {
  res.json({ success: true, ledger: data.ledger });
});

app.get("/wallets", (req, res) => {
  res.json({ success: true, wallets: Object.values(data.wallets) });
});

/* ===================== */
/* START                 */
/* ===================== */
app.listen(PORT, () => {
  console.log("🚀 SERVER RUNNING ON PORT " + PORT);
});