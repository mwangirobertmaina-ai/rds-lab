const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   CONFIG
========================= */
const PORT = 3000;
const TAX_RATE = 0.16;
const COMMISSION_RATE = 0.03;
const REFUND_TIMEOUT = 60000;

/* =========================
   LEDGER ENGINE
========================= */
class Ledger {
  constructor() {
    this.chain = [];
    this.init();
  }

  hash(data) {
    return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
  }

  init() {
    const genesis = {
      index: 0,
      prev: "GENESIS",
      data: "GENESIS_BLOCK",
      time: Date.now()
    };
    genesis.hash = this.hash(genesis);
    this.chain.push(genesis);
  }

  add(event) {
    const prev = this.chain[this.chain.length - 1];
    const block = {
      index: prev.index + 1,
      prev: prev.hash,
      data: event,
      time: Date.now()
    };
    block.hash = this.hash(block);
    this.chain.push(block);
  }
}

const ledger = new Ledger();

/* =========================
   STORAGE (IN-MEMORY)
========================= */
let businesses = [];
let products = [];
let orders = [];

let drivers = [
  { id: "D_1", name: "Driver John", available: true },
  { id: "D_2", name: "Driver Mary", available: true }
];

let wallets = {
  platform: { balance: 0 },
  businesses: {}
};

/* =========================
   HELPERS
========================= */
function breakdown(price) {
  const tax = Math.round(price * TAX_RATE);
  const commission = Math.round(price * COMMISSION_RATE);
  const merchant = price - tax - commission;
  return { tax, commission, merchant };
}

function findOrder(orderId) {
  return orders.find(o => o.id === orderId);
}

function assignDriver() {
  return drivers.find(d => d.available);
}

function fail(res, msg = "Invalid request") {
  return res.json({ success: false, error: msg });
}

/* =========================
   HEALTH
========================= */
app.get("/", (req, res) => {
  res.json({ status: "RDS ENGINE LIVE" });
});

/* =========================
   BUSINESS
========================= */
app.post("/addBusiness", (req, res) => {
  const { name } = req.body || {};
  if (!name) return fail(res, "Name required");

  const business = {
    id: "B_" + Date.now(),
    name: name.toLowerCase()
  };

  businesses.push(business);
  wallets.businesses[business.id] = { balance: 0 };

  ledger.add({ type: "BUSINESS_CREATED", business });

  res.json({ success: true, business });
});

app.get("/businesses", (req, res) => {
  res.json({ success: true, businesses });
});

/* =========================
   PRODUCTS
========================= */
app.post("/addProduct", (req, res) => {
  const { name, price, businessId } = req.body || {};
  if (!name || !price || !businessId)
    return fail(res, "Missing fields");

  const business = businesses.find(b => b.id === businessId);
  if (!business) return fail(res, "Invalid businessId");

  const product = {
    id: "P_" + Date.now(),
    name,
    price: parseInt(price),
    businessId
  };

  products.push(product);
  ledger.add({ type: "PRODUCT_ADDED", product });

  res.json({ success: true, product });
});

app.get("/products", (req, res) => {
  res.json({ success: true, products });
});

/* =========================
   ORDER FLOW (STATE MACHINE)
========================= */

// BUY → HOLD MONEY
app.post("/buy", (req, res) => {
  const { productId } = req.body || {};
  const product = products.find(p => p.id === productId);

  if (!product) return fail(res, "Product not found");

  const order = {
    id: "O_" + Date.now(),
    productId,
    name: product.name,
    price: product.price,
    businessId: product.businessId,
    status: "PAID_HOLD",
    createdAt: Date.now()
  };

  orders.push(order);
  ledger.add({ type: "ORDER_CREATED", order });

  res.json({ success: true, order });
});

// ASSIGN DRIVER
app.post("/assignDriver", (req, res) => {
  const { orderId } = req.body || {};
  const order = findOrder(orderId);

  if (!order || order.status !== "PAID_HOLD")
    return fail(res, "Invalid state");

  const driver = assignDriver();
  if (!driver) return fail(res, "No drivers available");

  driver.available = false;
  order.driverId = driver.id;
  order.status = "ASSIGNED_DRIVER";

  ledger.add({ type: "DRIVER_ASSIGNED", orderId, driver });

  res.json({ success: true, order });
});

// DISPATCH
app.post("/dispatch", (req, res) => {
  const { orderId } = req.body || {};
  const order = findOrder(orderId);

  if (!order || order.status !== "ASSIGNED_DRIVER")
    return fail(res, "Invalid state");

  order.status = "DISPATCHED";
  ledger.add({ type: "DISPATCHED", orderId });

  res.json({ success: true, status: order.status });
});

// ARRIVED
app.post("/arrived", (req, res) => {
  const { orderId } = req.body || {};
  const order = findOrder(orderId);

  if (!order || order.status !== "DISPATCHED")
    return fail(res, "Invalid state");

  order.status = "ARRIVED";
  ledger.add({ type: "ARRIVED", orderId });

  res.json({ success: true, status: order.status });
});

// CONFIRM → RELEASE MONEY
app.post("/confirm", (req, res) => {
  const { orderId } = req.body || {};
  const order = findOrder(orderId);

  if (!order || order.status !== "ARRIVED")
    return fail(res, "Invalid state");

  const { tax, commission, merchant } = breakdown(order.price);

  order.status = "COMPLETED";
  order.tax = tax;
  order.commission = commission;
  order.merchant = merchant;

  wallets.platform.balance += tax + commission;
  wallets.businesses[order.businessId].balance += merchant;

  // release driver
  const driver = drivers.find(d => d.id === order.driverId);
  if (driver) driver.available = true;

  ledger.add({ type: "ORDER_COMPLETED", order });

  res.json({ success: true, order });
});

/* =========================
   AUTO REFUND ENGINE
========================= */
setInterval(() => {
  const now = Date.now();

  orders.forEach(order => {
    if (
      order.status === "PAID_HOLD" &&
      now - order.createdAt > REFUND_TIMEOUT
    ) {
      order.status = "REFUNDED";
      ledger.add({ type: "AUTO_REFUND", orderId: order.id });
      console.log("⏱ Refunded:", order.id);
    }
  });
}, 10000);

/* =========================
   READ APIs
========================= */
app.get("/orders", (req, res) => {
  res.json({ success: true, orders });
});

app.get("/wallets", (req, res) => {
  res.json({ success: true, wallets });
});

app.get("/drivers", (req, res) => {
  res.json({ success: true, drivers });
});

app.get("/ledger", (req, res) => {
  res.json({ success: true, chain: ledger.chain });
});

/* ========================= */

app.listen(PORT, () => {
  console.log(`🚀 RDS ESCROW ENGINE running on http://localhost:${PORT}`);
});