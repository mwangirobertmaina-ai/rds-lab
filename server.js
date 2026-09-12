require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const fsPromises = require("fs").promises;
const cors = require("cors");
const path = require("path");
const axios = require("axios");

const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

const COMMISSION_RATE = 0.05;
const TAX_RATE = 0.16;
const BASE_FARE = 100;
const RATE_PER_KM = 50;

/* ---------------- UTIL ---------------- */

function log(type, msg) {
  console.log(`[${new Date().toISOString()}] [${type}] ${msg}`);
}

function num(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function id(prefix = "SYS") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 99999)}`;
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

function fail(res, msg = "Error", code = 400) {
  return res.status(code).json({ success: false, error: msg });
}

/* ---------------- DATABASE ---------------- */

function defaultDB() {
  return {
    orders: [],
    ledger: [],
    wallets: []
  };
}

let data = defaultDB();

if (fs.existsSync(DB_FILE)) {
  try {
    data = { ...defaultDB(), ...JSON.parse(fs.readFileSync(DB_FILE)) };
  } catch {
    data = defaultDB();
  }
}

async function saveDB() {
  await fsPromises.writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

/* ---------------- BUSINESS LOGIC ---------------- */

function calculateFare(distanceKm) {
  const km = num(distanceKm) > 0 ? num(distanceKm) : 10;
  return BASE_FARE + (km * RATE_PER_KM);
}

function processTrip(distanceKm, overrideAmount = null) {
  const fare = overrideAmount && num(overrideAmount) > 0
    ? num(overrideAmount)
    : calculateFare(distanceKm);

  const commission = fare * COMMISSION_RATE;
  const tax = commission * TAX_RATE;
  const netRevenue = commission - tax;
  const driverAmount = fare - commission;

  return { fare, commission, tax, netRevenue, driverAmount };
}

/* ---------------- MPESA CONFIG ---------------- */

const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY || "1gUiUGRcrNGP7GEplYsE62mNKqAnItctwfteNSPPklSop61w",
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || "wF4tdktQCUIATJr3DNqW9wtIjtImd7bNGGyYhYa5k3LNesW20xRG1ZAsEiqBqgRv",
  shortCode: process.env.MPESA_SHORTCODE || "174379",
  passkey: process.env.MPESA_PASSKEY || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
  environment: process.env.MPESA_ENV || "sandbox"
};

const MPESA_BASE_URL =
  MPESA_CONFIG.environment === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

/* ---------------- M-PESA AUTH ---------------- */

async function getMpesaAccessToken() {
  try {
    const auth = Buffer.from(
      `${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`
    ).toString("base64");

    const res = await axios.get(
      `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` }, timeout: 10000 }
    );

    return res.data.access_token;
  } catch (err) {
    const errDetails = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    log("MPESA_AUTH_ERROR", errDetails);
    throw new Error("Failed to authenticate with M-Pesa Daraja API: " + errDetails);
  }
}

/* ---------------- MIDDLEWARE ---------------- */

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  log("REQ", `${req.method} ${req.url}`);
  next();
});

/* ---------------- HEALTH ---------------- */

app.get("/health", (req, res) =>
  ok(res, { status: "OK", time: Date.now() })
);

/* ---------------- STK PUSH ---------------- */

app.post("/mpesa/stkpush", async (req, res) => {
  try {
    const { phone, amount, distanceKm } = req.body;

    if (!phone || (!amount && !distanceKm)) {
      return fail(res, "Missing phone or amount");
    }

    let formattedPhone = phone.replace("+", "").trim();
    if (formattedPhone.startsWith("0")) {
      formattedPhone = "254" + formattedPhone.substring(1);
    }

    const breakdown = processTrip(distanceKm, amount);
    const token = await getMpesaAccessToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    const password = Buffer.from(
      MPESA_CONFIG.shortCode + MPESA_CONFIG.passkey + timestamp
    ).toString("base64");

    const payload = {
      BusinessShortCode: MPESA_CONFIG.shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(breakdown.fare),
      PartyA: formattedPhone,
      PartyB: MPESA_CONFIG.shortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: process.env.CALLBACK_URL || "https://mydomain.com/mpesa/callback",
      AccountReference: "RDS",
      TransactionDesc: "RDS Payment"
    };

    let response;
    try {
      response = await axios.post(
        `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
        payload,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
    } catch (apiErr) {
      const errDetails = apiErr.response?.data ? JSON.stringify(apiErr.response.data) : apiErr.message;
      log("DARAJA_API_REJECTED", errDetails);
      return fail(res, `M-Pesa Daraja Rejected: ${errDetails}`, 502);
    }

    const order = {
      id: id("ORD"),
      phone: formattedPhone,
      amount: breakdown.fare,
      checkoutRequestId: response.data.CheckoutRequestID,
      status: "PENDING"
    };

    data.orders.push(order);
    await saveDB();

    ok(res, {
      message: "STK Sent",
      checkoutId: order.checkoutRequestId
    });
  } catch (err) {
    log("STK_ERROR", err.message);
    fail(res, err.message, 500);
  }
});

/* ---------------- CALLBACK ---------------- */

app.post("/mpesa/callback", async (req, res) => {
  try {
    const result = req.body?.Body?.stkCallback;

    if (!result) return res.json({ success: false });

    const order = data.orders.find(
      o => o.checkoutRequestId === result.CheckoutRequestID
    );

    if (!order) return res.json({ success: false });

    if (result.ResultCode === 0) {
      order.status = "PAID";

      const breakdown = processTrip(null, order.amount);

      data.ledger.push({
        id: id("LEDGER"),
        orderId: order.id,
        ...breakdown
      });

      let wallet = data.wallets.find(w => w.driverId === "driver_1");

      if (!wallet) {
        wallet = { driverId: "driver_1", balance: 0 };
        data.wallets.push(wallet);
      }

      wallet.balance += breakdown.driverAmount;
    } else {
      order.status = "FAILED";
    }

    await saveDB();
    res.json({ success: true });
  } catch (err) {
    log("CALLBACK_ERROR", err.message);
    res.json({ success: false });
  }
});

/* ---------------- FALLBACK ---------------- */

app.use((req, res) => ok(res, { autoHealed: true }));

/* ---------------- START ---------------- */

server.listen(PORT, () => {
  log("SYSTEM", `🚀 RDS BACKEND RUNNING ON PORT ${PORT}`);
});