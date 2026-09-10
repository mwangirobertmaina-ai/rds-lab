const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const fsPromises = require("fs").promises;
const cors = require("cors");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
  }
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

/* ========================================== */
/* DYNAMIC CORS & EXPRESS MIDDLEWARE          */
/* ========================================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static("."));

/* ================= STRUCTURED LOGGER ================= */
function log(type, msg) {
  console.log(`[${new Date().toISOString()}] [${type}] ${msg}`);
}

app.use((req, res, next) => {
  log("REQ", `${req.method} ${req.url}`);
  next();
});

/* ================= DEFAULT ENTERPRISE SCHEMA ================= */
function defaultDB() {
  return {
    businesses: [],
    products: [],
    orders: [],
    drivers: [],
    deliveries: [],
    ledger: [],
    wallets: {
      SYSTEM_PLATFORM: { balance: 0, escrow: 0 }
    },
    system: { createdAt: Date.now(), lastCheck: Date.now() }
  };
}

let data = defaultDB();

/* ================= HELPERS & CALCULATORS ================= */
function id(prefix = "SYS") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 99999)}`;
}

function num(v) {
  const parsed = Number(v);
  return isNaN(parsed) ? 0 : parsed;
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

function fail(res, msg = "Error", statusCode = 400) {
  return res.status(statusCode).json({ success: false, error: msg });
}

function calculateDistanceKM(lat1, lon1, lat2, lon2) {
  const nLat1 = num(lat1);
  const nLon1 = num(lon1);
  const nLat2 = num(lat2);
  const nLon2 = num(lon2);

  if (!nLat1 && !nLon1 && !nLat2 && !nLon2) return Infinity;

  const R = 6371;
  const dLat = (nLat2 - nLat1) * Math.PI / 180;
  const dLon = (nLon2 - nLon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(nLat1 * Math.PI / 180) * Math.cos(nLat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* ================= SELF-HEALING STORE ENGINE ================= */
function sanitizeDataState() {
  if (!Array.isArray(data.businesses)) data.businesses = [];
  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  if (!Array.isArray(data.drivers)) data.drivers = [];
  if (!Array.isArray(data.deliveries)) data.deliveries = [];
  if (!Array.isArray(data.ledger)) data.ledger = [];
  if (!data.wallets || typeof data.wallets !== "object") {
    data.wallets = { SYSTEM_PLATFORM: { balance: 0, escrow: 0 } };
  }
  if (!data.system || typeof data.system !== "object") {
    data.system = { createdAt: Date.now(), lastCheck: Date.now() };
  }

  // 1. Sanitize Products Catalog
  data.products.forEach(p => {
    if (p && typeof p === "object") {
      p.price = num(p.price);
      p.stock = p.stock !== undefined ? Math.max(0, Math.floor(num(p.stock))) : 50;
      p.businessId = p.businessId || "SYSTEM";
      p.name = (p.name || "Unnamed Product").trim();
      p.createdAt = p.createdAt || Date.now();
    }
  });

  // 2. Sanitize and Deduplicate Driver Roster
  const driverNameMap = new Map();
  data.drivers.forEach(d => {
    if (!d || (!d.id && !d.name)) return;
    const cleanName = (d.name || "Unknown Driver").trim();
    const nameKey = cleanName.toLowerCase();

    let status = (d.status || "").toString().toLowerCase();
    if (["idle", "available", "online", "true"].includes(status)) status = "online";
    if (!["online", "busy", "offline"].includes(status)) status = "offline";

    if (!driverNameMap.has(nameKey)) {
      const primaryDriver = {
        id: d.id || id("DRV"),
        name: cleanName,
        phone: d.phone || "0700000000",
        vehicle: d.vehicle || "Motorbike KAB 123X",
        status: status,
        earnings: num(d.earnings),
        location: d.location && !isNaN(num(d.location.lat)) && !isNaN(num(d.location.lng)) ? {
          lat: num(d.location.lat),
          lng: num(d.location.lng),
          heading: num(d.location.heading),
          speed: num(d.location.speed)
        } : { lat: -1.286389, lng: 36.817223 },
        lastSeen: num(d.lastSeen) || Date.now(),
        createdAt: num(d.createdAt) || Date.now()
      };
      driverNameMap.set(nameKey, primaryDriver);
    } else {
      const primary = driverNameMap.get(nameKey);
      primary.earnings = Math.max(primary.earnings, num(d.earnings));
      if (["online", "busy"].includes(status)) primary.status = status;
      if (d.location) primary.location = d.location;
      primary.lastSeen = Math.max(primary.lastSeen, num(d.lastSeen));
    }
  });
  data.drivers = Array.from(driverNameMap.values());

  if (!data.wallets["SYSTEM_PLATFORM"]) {
    data.wallets["SYSTEM_PLATFORM"] = { balance: 0, escrow: 0 };
  }
}

// Initial Boot Hydration
if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    data = { ...defaultDB(), ...parsed };
    sanitizeDataState();
    log("SYSTEM", "DB Hydrated & Self-Healed Successfully");
  } catch (err) {
    log("ERROR", "DB CORRUPTED — RESET TO FRESH SCHEMA");
    data = defaultDB();
    sanitizeDataState();
  }
} else {
  data = defaultDB();
  sanitizeDataState();
}

/* ================= ATOMIC NON-BLOCKING PERSISTENCE ================= */
let isWriting = false;
let pendingWrite = false;

const saveDB = async () => {
  if (isWriting) {
    pendingWrite = true;
    return;
  }
  isWriting = true;
  sanitizeDataState();
  data.system.lastCheck = Date.now();
  const tempFile = `${DB_FILE}.${Date.now()}_${Math.floor(Math.random() * 1000)}.tmp`;
  try {
    const serialized = JSON.stringify(data, null, 2);
    await fsPromises.writeFile(tempFile, serialized, "utf-8");
    await fsPromises.rename(tempFile, DB_FILE);
  } catch (err) {
    log("ERROR", "DB ATOMIC SAVE FAILED: " + err.message);
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

/* ================= SOCKET.IO REAL-TIME STREAMING ENGINE ================= */
io.on("connection", (socket) => {
  log("SOCKET", `Client Connected: ${socket.id}`);

  // Driver GPS Telemetry Stream
  socket.on("driver:location", (payload) => {
    sanitizeDataState();
    const driverId = payload.driverId || payload.id;
    if (!driverId) return;

    const latN = num(payload.lat);
    const lngN = num(payload.lng);
    const driver = data.drivers.find(d => d.id === driverId);

    if (driver) {
      driver.location = { lat: latN, lng: lngN, heading: num(payload.heading), speed: num(payload.speed) };
      driver.lastSeen = Date.now();
      saveDB();

      io.emit("telemetry:stream", {
        driverId: driver.id,
        driverName: driver.name,
        status: driver.status,
        location: driver.location
      });
    }
  });

  socket.on("disconnect", () => {
    log("SOCKET", `Client Disconnected: ${socket.id}`);
  });
});

/* ================= SYSTEM HEALTH & METRICS ================= */
app.get("/", (req, res) => {
  ok(res, { status: "RDS HYBRID CORE RUNNING", mode: "SOCKET_ENABLED", time: Date.now() });
});

app.get("/health", (req, res) => {
  ok(res, { status: "HEALTHY", mode: "SOCKET_ENABLED", uptime: process.uptime(), time: Date.now() });
});

app.get("/system/stats", (req, res) => {
  try {
    sanitizeDataState();
    const grossVolume = data.orders.reduce((sum, o) => sum + num(o.total || o.amount), 0);
    const totalCommission = data.ledger
      .filter(l => l.type === "COMMISSION" || l.type === "DELIVERY_PAYOUT")
      .reduce((sum, l) => sum + num(l.amount), 0);

    ok(res, {
      stats: {
        businesses: data.businesses.length,
        products: data.products.length,
        orders: data.orders.length,
        drivers: data.drivers.length,
        activeDrivers: data.drivers.filter(d => d.status === "online" || d.status === "busy").length,
        grossVolume,
        totalCommission
      }
    });
  } catch (err) {
    fail(res, "Failed to calculate stats", 500);
  }
});

/* ================= MODULE 1: MERCHANTS & SHOPS ================= */
const getBusinessesHandler = (req, res) => {
  try {
    sanitizeDataState();
    ok(res, { businesses: data.businesses, shops: data.businesses });
  } catch (err) {
    fail(res, "Failed to load businesses", 500);
  }
};

app.get("/businesses", getBusinessesHandler);
app.get("/shops", getBusinessesHandler);

const addBusinessHandler = (req, res) => {
  try {
    const name = (req.body.name || req.query.name || "").trim();
    const category = (req.body.category || req.query.category || "Retail").trim();

    if (!name || name.length < 2) return fail(res, "Business name is required");

    const b = {
      id: id("B"),
      name,
      category,
      balance: 0,
      createdAt: Date.now()
    };

    data.businesses.push(b);
    data.wallets[b.id] = { balance: 0, escrow: 0 };
    saveDB();

    io.emit("business:created", b);
    log("BUSINESS", `Onboarded: ${b.name} (${b.id})`);
    ok(res, { business: b, shop: b });
  } catch (err) {
    fail(res, "Failed to create business", 500);
  }
};

app.post("/business/add", addBusinessHandler);
app.post("/business/create", addBusinessHandler);

const deleteBusinessHandler = (req, res) => {
  try {
    const bizId = req.params.id || req.body.id || req.query.id;
    const initialLen = data.businesses.length;

    data.businesses = data.businesses.filter(b => b.id !== bizId);

    if (initialLen === data.businesses.length) {
      return fail(res, "Business not found", 404);
    }

    delete data.wallets[bizId];
    saveDB();

    io.emit("business:deleted", { businessId: bizId });
    log("BUSINESS", `Deleted: ${bizId}`);
    ok(res, { message: `Business ${bizId} deleted` });
  } catch (err) {
    fail(res, "Delete failed", 500);
  }
};

app.delete("/business/delete/:id", deleteBusinessHandler);
app.delete("/business/:id", deleteBusinessHandler);

/* ================= MODULE 2: CATALOG & PRODUCTS ================= */
app.get("/products", (req, res) => {
  try {
    sanitizeDataState();
    const { businessId } = req.query;
    let products = data.products;

    if (businessId) {
      products = products.filter(p => p.businessId === businessId);
    }

    ok(res, { products });
  } catch (err) {
    fail(res, "Failed to load products", 500);
  }
});

app.post("/product/add", (req, res) => {
  try {
    const { businessId, name, price, stock, category } = req.body;

    if (!businessId || !name || price === undefined) {
      return fail(res, "Missing required product parameters: businessId, name, price");
    }

    const product = {
      id: id("P"),
      businessId,
      name: name.trim(),
      price: num(price),
      stock: stock !== undefined ? Math.max(0, Math.floor(num(stock))) : 50,
      category: category || "General",
      createdAt: Date.now()
    };

    data.products.push(product);
    saveDB();

    io.emit("product:added", product);
    log("PRODUCT", `Added: ${product.name}`);
    ok(res, { product });
  } catch (err) {
    fail(res, "Failed to add product", 500);
  }
});

/* ================= MODULE 3: DRIVERS & FLEET ================= */
const getDriversHandler = (req, res) => {
  try {
    sanitizeDataState();
    const { status } = req.query;
    let list = data.drivers;

    if (status) {
      list = list.filter(d => (d.status || "").toLowerCase() === status.toString().toLowerCase());
    }

    ok(res, { count: list.length, data: list, drivers: list });
  } catch (err) {
    fail(res, "Failed to fetch driver roster", 500);
  }
};

app.get("/drivers", getDriversHandler);
app.get("/drivers/live", getDriversHandler);
app.get("/drivers/map", getDriversHandler);

const registerDriverHandler = (req, res) => {
  try {
    sanitizeDataState();
    const name = (req.body.name || req.query.name || "").trim();
    const vehicle = (req.body.vehicle || req.query.vehicle || "Motorbike KAB 123X").trim();
    const phone = (req.body.phone || req.query.phone || "0700000000").trim();

    if (!name || name.length < 2) return fail(res, "Driver name is required");

    let driver = data.drivers.find(d => d.name.toLowerCase() === name.toLowerCase());

    if (driver) {
      driver.status = "online";
      driver.lastSeen = Date.now();
      if (vehicle !== "N/A") driver.vehicle = vehicle;
      saveDB();
      io.emit("driver:updated", driver);
      return ok(res, { message: "Existing driver reactivated", driver, data: driver });
    }

    driver = {
      id: id("DRV"),
      name,
      phone,
      vehicle,
      status: "offline",
      earnings: 0,
      location: { lat: -1.286389, lng: 36.817223 },
      lastSeen: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    data.drivers.push(driver);
    saveDB();

    io.emit("driver:registered", driver);
    log("DRIVER", `Registered: ${driver.name} (${driver.id})`);
    ok(res, { message: "Driver registered successfully", driver, data: driver });
  } catch (err) {
    fail(res, "Registration failed", 500);
  }
};

app.post("/driver/register", registerDriverHandler);
app.post("/driver/add", registerDriverHandler);
app.post("/addDriver", registerDriverHandler);

const updateDriverStatusHandler = (req, res) => {
  try {
    sanitizeDataState();
    const driverId = req.body.driverId || req.body.id || req.query.driverId;
    let status = (req.body.status || req.query.status || "").toString().toLowerCase();

    if (!driverId || !status) return fail(res, "Missing driverId or status payload");

    if (["idle", "available", "online", "true"].includes(status)) status = "online";

    const driver = data.drivers.find(d => d.id === driverId);
    if (!driver) return fail(res, "Driver not found", 404);

    driver.status = status;
    driver.lastSeen = Date.now();
    driver.updatedAt = Date.now();

    saveDB();
    io.emit("driver:statusChanged", { driverId, status });
    ok(res, { message: "Driver status updated", driver, data: driver });
  } catch (err) {
    fail(res, "Status update failed", 500);
  }
};

app.post("/driver/status", updateDriverStatusHandler);
app.post("/driverStatus", updateDriverStatusHandler);

const updateLocationHandler = (req, res) => {
  try {
    sanitizeDataState();
    const driverId = req.body.driverId || req.body.id || req.query.driverId;
    const payload = req.body.location || req.body;

    if (!driverId) return fail(res, "Missing required driverId");
    if (payload.lat == null || payload.lng == null) return fail(res, "Missing GPS coordinates");

    const latN = num(payload.lat);
    const lngN = num(payload.lng);

    if (isNaN(latN) || isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
      return fail(res, "Invalid geographical coordinate bounds");
    }

    const driver = data.drivers.find(d => d.id === driverId);
    if (!driver) return fail(res, "Driver not found", 404);

    driver.location = { lat: latN, lng: lngN, heading: num(payload.heading), speed: num(payload.speed) };
    driver.status = "online";
    driver.lastSeen = Date.now();
    driver.updatedAt = Date.now();

    saveDB();

    io.emit("telemetry:stream", {
      driverId: driver.id,
      driverName: driver.name,
      status: driver.status,
      location: driver.location
    });

    ok(res, { message: "Location updated", driver, location: driver.location });
  } catch (err) {
    fail(res, "GPS telemetry update failed", 500);
  }
};

app.post("/driver/location", updateLocationHandler);
app.post("/updateDriverLocation", updateLocationHandler);

/* ================= MODULE 4: ORDERS & CHECKOUT ================= */
app.get("/orders", (req, res) => {
  try {
    sanitizeDataState();
    const { status, customerPhone, businessId } = req.query;

    let list = data.orders;

    if (status) {
      const targetStatus = status.toString().toLowerCase();
      list = list.filter(o => (o.status || "").toString().toLowerCase() === targetStatus);
    }

    if (customerPhone) list = list.filter(o => o.customerPhone === customerPhone);
    if (businessId) list = list.filter(o => o.businessId === businessId);

    ok(res, { count: list.length, data: list, orders: list });
  } catch (err) {
    fail(res, "Failed to load orders", 500);
  }
});

const createOrderHandler = (req, res) => {
  try {
    sanitizeDataState();
    const { customerName, customerPhone, businessId, items, pickup, dropoff, deliveryAddress, amount, total } = req.body;

    const finalName = (customerName || "Guest Customer").trim();
    const finalAmount = num(amount || total);

    const order = {
      id: id("ORD"),
      businessId: businessId || "SYSTEM",
      customerName: finalName,
      customerPhone: customerPhone || "0700000000",
      deliveryAddress: deliveryAddress || dropoff || "Nairobi CBD",
      pickup: pickup || { lat: -1.286389, lng: 36.817223 },
      dropoff: dropoff || { lat: -1.286389, lng: 36.817223 },
      items: Array.isArray(items) ? items : [],
      amount: finalAmount,
      total: finalAmount,
      status: "pending",
      driverId: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    data.orders.push(order);

    data.ledger.push({
      id: id("TX"),
      type: "ORDER",
      amount: finalAmount,
      orderId: order.id,
      businessId: order.businessId,
      createdAt: Date.now()
    });

    saveDB();

    io.emit("order:created", order);
    log("ORDER", `Created: ${order.id} ($${finalAmount})`);
    ok(res, { message: "Order created successfully", data: order, order });
  } catch (err) {
    fail(res, "Order creation failed", 500);
  }
};

app.post("/order/create", createOrderHandler);
app.post("/orders/create", createOrderHandler);
app.post("/checkout", createOrderHandler);

const completeOrderHandler = (req, res) => {
  try {
    sanitizeDataState();
    const orderId = req.body.orderId || req.body.deliveryId || req.body.id || req.query.orderId;

    if (!orderId) return fail(res, "orderId is required");

    const order = data.orders.find(o => o.id === orderId);
    if (!order) return fail(res, "Order not found", 404);

    order.status = "completed";
    order.completedAt = Date.now();
    order.updatedAt = Date.now();

    let payout = 0;
    if (order.driverId) {
      const driver = data.drivers.find(d => d.id === order.driverId);
      if (driver) {
        payout = (order.total || order.amount || 0) * 0.90;
        driver.earnings += payout;
        driver.status = "online";
        driver.updatedAt = Date.now();

        data.ledger.push({
          id: id("TX"),
          type: "DELIVERY_PAYOUT",
          amount: payout,
          orderId: order.id,
          driverId: driver.id,
          createdAt: Date.now()
        });
      }
    }

    saveDB();

    io.emit("order:completed", { orderId: order.id, driverId: order.driverId, payout });
    log("FULFILLMENT", `Completed: ${order.id}`);
    ok(res, { message: "Order completed successfully", data: order, order });
  } catch (err) {
    fail(res, "Order completion failed", 500);
  }
};

app.post("/order/complete", completeOrderHandler);
app.post("/orders/complete", completeOrderHandler);
app.post("/driver/complete", completeOrderHandler);

/* ================= MODULE 5: DISPATCH ENGINE ================= */
const autoDispatchHandler = (req, res) => {
  try {
    sanitizeDataState();
    const orderId = req.body.orderId || req.body.id || req.query.orderId;

    const availableDrivers = data.drivers.filter(d => 
      ["ONLINE", "AVAILABLE", "IDLE"].includes((d.status || "").toString().toUpperCase())
    );

    if (availableDrivers.length === 0) {
      return fail(res, "No online drivers available for dispatch", 404);
    }

    if (!orderId) {
      const pendingOrders = data.orders.filter(o => 
        ["PENDING", "PLACED", "UNASSIGNED"].includes((o.status || "").toString().toUpperCase())
      );

      if (pendingOrders.length === 0) return fail(res, "No pending orders in dispatch queue");

      const assignments = [];

      for (const order of pendingOrders) {
        let nearestDriver = null;
        let minDistance = Infinity;

        const pLat = order.pickup?.lat || -1.286389;
        const pLng = order.pickup?.lng || 36.817223;

        for (const driver of availableDrivers) {
          if (driver.status === "busy") continue;

          const dist = driver.location ? calculateDistanceKM(pLat, pLng, driver.location.lat, driver.location.lng) : Infinity;

          if (dist < minDistance) {
            minDistance = dist;
            nearestDriver = driver;
          }
        }

        if (!nearestDriver && availableDrivers.length > 0) {
          availableDrivers.sort((a, b) => (a.earnings || 0) - (b.earnings || 0));
          nearestDriver = availableDrivers[0];
        }

        if (nearestDriver) {
          order.status = "assigned";
          order.driverId = nearestDriver.id;
          order.updatedAt = Date.now();

          nearestDriver.status = "busy";
          nearestDriver.currentOrder = order.id;
          nearestDriver.updatedAt = Date.now();

          assignments.push({
            orderId: order.id,
            driverId: nearestDriver.id,
            driverName: nearestDriver.name
          });

          io.emit("order:dispatched", { orderId: order.id, driverId: nearestDriver.id });
        }
      }

      saveDB();
      return ok(res, { message: `Auto dispatch completed (${assignments.length} assigned)`, assignments });
    }

    const order = data.orders.find(o => o.id === orderId);
    if (!order) return fail(res, "Order not found", 404);

    const driverId = req.body.driverId || req.query.driverId;
    let selectedDriver = null;

    if (driverId) {
      selectedDriver = availableDrivers.find(d => d.id === driverId);
    }

    if (!selectedDriver) {
      const pLat = order.pickup?.lat || -1.286389;
      const pLng = order.pickup?.lng || 36.817223;

      availableDrivers.sort((a, b) => {
        if (a.location && b.location) {
          return calculateDistanceKM(pLat, pLng, a.location.lat, a.location.lng) - calculateDistanceKM(pLat, pLng, b.location.lat, b.location.lng);
        }
        return (a.earnings || 0) - (b.earnings || 0);
      });

      selectedDriver = availableDrivers[0];
    }

    order.driverId = selectedDriver.id;
    order.status = "assigned";
    order.updatedAt = Date.now();

    selectedDriver.status = "busy";
    selectedDriver.currentOrder = order.id;
    selectedDriver.updatedAt = Date.now();

    saveDB();

    io.emit("order:dispatched", { orderId: order.id, driverId: selectedDriver.id });
    ok(res, { message: "Order auto-dispatched successfully", order, driver: selectedDriver });
  } catch (err) {
    fail(res, "Dispatch processing failed", 500);
  }
};

app.post("/dispatch/auto", autoDispatchHandler);
app.post("/dispatch/assign", autoDispatchHandler);
app.post("/order/assign", autoDispatchHandler);

/* ================= MODULE 6: FINANCIAL LEDGER ================= */
const getLedgerHandler = (req, res) => {
  try {
    sanitizeDataState();
    ok(res, { ledger: data.ledger, transactions: data.ledger });
  } catch (err) {
    fail(res, "Failed to load ledger transactions", 500);
  }
};

app.get("/ledger", getLedgerHandler);
app.get("/transactions", getLedgerHandler);

app.get("/wallets", (req, res) => {
  try {
    sanitizeDataState();
    const walletList = Object.keys(data.wallets).map(bId => ({
      businessId: bId,
      balance: data.wallets[bId].balance || 0,
      escrow: data.wallets[bId].escrow || 0
    }));
    ok(res, { wallets: walletList });
  } catch (err) {
    fail(res, "Failed to load wallets", 500);
  }
});

/* ================= GLOBAL ERROR CATCH ================= */
app.use((err, req, res, next) => {
  log("CRITICAL_ERROR", err.stack || err.message);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

/* ================= SERVER START ================= */
server.listen(PORT, () => {
  log("SYSTEM", `RDS HYBRID CORE SERVER RUNNING ON PORT ${PORT} (SOCKET_ENABLED)`);
});