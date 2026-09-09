const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DB_FILE = "db.json";

/* ===================== */
/* DATABASE              */
/* ===================== */
let data = {
  businesses: [],
  products: [],
  orders: [],
  ledger: [],
  wallets: {},
  drivers: [],
  deliveries: []
};

if (fs.existsSync(DB_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    data = { ...data, ...parsed };
  } catch (e) {
    console.log("⚠️ DB corrupted, using fresh data");
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function uid(prefix) {
  return prefix + Date.now() + "_" + Math.floor(Math.random() * 1000);
}

/* ===================== */
/* ROOT                  */
/* ===================== */
app.get("/", (req, res) => {
  res.json({
    success: true,
    engine: "RDS PRO CORE ULTRA",
    status: "ACTIVE"
  });
});

/* ===================== */
/* BUSINESSES            */
/* ===================== */
app.post("/addBusiness", (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ success: false });

  const b = { id: uid("B_"), name };
  data.businesses.push(b);

  data.wallets[b.id] = { businessId: b.id, balance: 0, transactions: [] };

  saveDB();
  res.json({ success: true, business: b });
});

app.get("/businesses", (req, res) => {
  res.json({ success: true, businesses: data.businesses });
});

/* ===================== */
/* PRODUCTS              */
/* ===================== */
app.post("/addProduct", (req, res) => {
  const { name, price, businessId } = req.body;

  if (!name || !price || !businessId)
    return res.json({ success: false });

  const p = { id: uid("P_"), name, price, businessId };
  data.products.push(p);

  saveDB();
  res.json({ success: true, product: p });
});

app.get("/products", (req, res) => {
  res.json({ success: true, products: data.products });
});

/* ===================== */
/* DRIVER SYSTEM         */
/* ===================== */
app.post("/addDriver", (req, res) => {
  const { name, phone } = req.body;

  if (!name) return res.json({ success: false });

  const d = {
    id: uid("D_"),
    name,
    phone: phone || "",
    status: "AVAILABLE",
    earnings: 0
  };

  data.drivers.push(d);
  saveDB();

  res.json({ success: true, driver: d });
});

app.get("/drivers", (req, res) => {
  res.json({ success: true, drivers: data.drivers });
});

app.post("/driverStatus", (req, res) => {
  const { driverId, status } = req.body;

  const d = data.drivers.find(x => x.id === driverId);
  if (!d) return res.json({ success: false });

  d.status = status;
  saveDB();

  res.json({ success: true });
});

/* ===================== */
/* AUTO DISPATCH         */
/* ===================== */
function autoDispatch(order) {
  const driver = data.drivers.find(d => d.status === "AVAILABLE");
  if (!driver) return;

  const delivery = {
    id: uid("DL_"),
    orderId: order.id,
    driverId: driver.id,
    status: "ASSIGNED",
    createdAt: Date.now()
  };

  driver.status = "BUSY";
  data.deliveries.push(delivery);
}

/* ===================== */
/* CHECKOUT              */
/* ===================== */
app.post("/checkout", (req, res) => {
  const items = req.body.items;

  if (!items || !items.length)
    return res.json({ success: false, error: "No items" });

  let total = 0;
  let commission = 0;
  let walletMap = {};

  for (const i of items) {
    const p = data.products.find(x => x.id === i.productId);
    if (!p) continue;

    const sub = p.price * i.qty;
    const com = Math.floor(sub * 0.05);

    total += sub;
    commission += com;

    walletMap[p.businessId] =
      (walletMap[p.businessId] || 0) + (sub - com);
  }

  const order = {
    id: uid("O_"),
    items,
    total,
    commission,
    createdAt: Date.now()
  };

  data.orders.push(order);

  data.ledger.push({
    id: uid("L_"),
    orderId: order.id,
    total,
    commission
  });

  Object.keys(walletMap).forEach(b => {
    if (!data.wallets[b])
      data.wallets[b] = { businessId: b, balance: 0, transactions: [] };

    data.wallets[b].balance += walletMap[b];
  });

  /* AUTO DISPATCH */
  autoDispatch(order);

  saveDB();

  res.json({ success: true, order });
});

/* ===================== */
/* DRIVER JOBS           */
/* ===================== */
app.get("/driverJobs", (req, res) => {
  const { driverId } = req.query;

  const jobs = data.deliveries.filter(d => d.driverId === driverId);

  res.json({ success: true, jobs });
});

app.post("/completeDelivery", (req, res) => {
  const { deliveryId } = req.body;

  const d = data.deliveries.find(x => x.id === deliveryId);
  if (!d) return res.json({ success: false });

  d.status = "COMPLETED";

  const driver = data.drivers.find(x => x.id === d.driverId);
  if (driver) {
    driver.status = "AVAILABLE";
    driver.earnings += 50;
  }

  saveDB();
  res.json({ success: true });
});

/* ===================== */
/* READ ENDPOINTS        */
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

app.get("/deliveries", (req, res) => {
  res.json({ success: true, deliveries: data.deliveries });
});

/* ===================== */
/* START SERVER          */
/* ===================== */
app.listen(PORT, () => {
  console.log("🚀 RDS ULTRA CORE RUNNING ON PORT " + PORT);
});