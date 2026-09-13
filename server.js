const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fsPromises = require("fs").promises;
const cors = require("cors");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(cors());
app.set("trust proxy", 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-api-key"]
  }
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

function num(val) {
  const parsed = parseFloat(val);
  return isNaN(parsed) ? 0 : parsed;
}

const COMMISSION_RATE = 0.05; 
const TAX_RATE = 0.16;        
const BASE_FARE = 100;       
const RATE_PER_KM = 50;      

function calculateFare(distanceKm) {
  const km = num(distanceKm) > 0 ? num(distanceKm) : 10;
  return BASE_FARE + (km * RATE_PER_KM);
}

function processTrip(distanceKm, overrideAmount = null) {
  const fare = overrideAmount && num(overrideAmount) > 0 ? num(overrideAmount) : calculateFare(distanceKm);
  const commission = fare * COMMISSION_RATE;
  const tax = commission * TAX_RATE;
  const netRevenue = commission - tax;
  const driverAmount = fare - commission;

  return { fare, gross: fare, commission, tax, netRevenue, driverAmount };
}

const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY || "1gUiUGRcrNGP7GEplYsE62mNKqAnItctwfteNSPPklSop61w",
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || "wF4tdktQCUIATJr3DNqW9wtIjtImd7bNGGyYhYa5k3LNesW20xRG1ZAsEiqBqgRv",
  shortCode: "174379", 
  storeNumber: "1200280",
  passkey: "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919", 
  environment: "sandbox",
  callbackUrl: process.env.MPESA_CALLBACK_URL || "https://mydomain.co.ke/api/v1/webhook-listener"
};

const MPESA_BASE_URL = MPESA_CONFIG.environment === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

async function initDb() {
  try {
    await fsPromises.access(DB_FILE);
  } catch {
    const initialStructure = { trips: [], payments: [] };
    await fsPromises.writeFile(DB_FILE, JSON.stringify(initialStructure, null, 2), "utf8");
  }
}

async function readDb() {
  await initDb();
  const data = await fsPromises.readFile(DB_FILE, "utf8");
  return JSON.parse(data);
}

async function writeDb(data) {
  await fsPromises.writeFile(DB_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function getMpesaAccessToken() {
  try {
    const authString = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString("base64");
    const response = await axios.get(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${authString}` },
      timeout: 10000
    });
    return response.data.access_token;
  } catch (error) {
    console.error("Error generating M-Pesa access token:", error.response?.data || error.message);
    throw new Error("Failed to authenticate with M-Pesa API");
  }
}

function getMpesaTimestamp() {
  const date = new Date();
  return date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0') +
    String(date.getHours()).padStart(2, '0') +
    String(date.getMinutes()).padStart(2, '0') +
    String(date.getSeconds()).padStart(2, '0');
}

app.post("/api/mpesa/stkpush", async (req, res) => {
  const { phoneNumber, distanceKm, overrideAmount, accountReference } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ success: false, error: "Phone number is required" });
  }

  const financialBreakdown = processTrip(distanceKm, overrideAmount);
  let formattedPhone = phoneNumber.toString().replace("+", "").trim();
  if (formattedPhone.startsWith("0")) formattedPhone = "254" + formattedPhone.substring(1);

  try {
    const accessToken = await getMpesaAccessToken();
    const timestamp = getMpesaTimestamp();
    const password = Buffer.from(`${MPESA_CONFIG.shortCode}${MPESA_CONFIG.passkey}${timestamp}`).toString("base64");

    const requestBody = {
      BusinessShortCode: MPESA_CONFIG.shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(financialBreakdown.fare),
      PartyA: formattedPhone,
      PartyB: MPESA_CONFIG.shortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: MPESA_CONFIG.callbackUrl,
      AccountReference: accountReference || "TaxiTrip",
      TransactionDesc: `Fare payment for distance ${distanceKm || 10}km`
    };

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      requestBody,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000
      }
    );

    const db = await readDb();
    const pendingPayment = {
      checkoutRequestId: response.data.CheckoutRequestID,
      merchantRequestId: response.data.MerchantRequestID,
      phoneNumber: formattedPhone,
      status: "PENDING",
      financials: financialBreakdown,
      createdAt: new Date().toISOString()
    };
    db.payments.push(pendingPayment);
    await writeDb(db);

    res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    const errDetails = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    console.error("STK Push Error:", errDetails);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

app.post("/api/v1/webhook-listener", async (req, res) => {
  const { Body } = req.body;
  if (!Body || !Body.stkCallback) {
    return res.status(400).send("Invalid callback payload format");
  }

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = Body.stkCallback;
  const db = await readDb();
  
  const paymentIndex = db.payments.findIndex(p => p.checkoutRequestId === CheckoutRequestID);
  let updatedPaymentData = null;

  if (ResultCode === 0 && CallbackMetadata) {
    const items = CallbackMetadata.Item || [];
    const mpesaReceiptNumber = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
    const actualAmountPaid = items.find(i => i.Name === "Amount")?.Value;

    updatedPaymentData = {
      status: "COMPLETED",
      receipt: mpesaReceiptNumber,
      amountPaid: actualAmountPaid,
      completedAt: new Date().toISOString()
    };

    if (paymentIndex !== -1) {
      db.payments[paymentIndex] = { ...db.payments[paymentIndex], ...updatedPaymentData };
      
      const completedTrip = {
        tripId: `TRIP-${Date.now()}`,
        checkoutRequestId: CheckoutRequestID,
        receipt: mpesaReceiptNumber,
        ...db.payments[paymentIndex].financials,
        timestamp: new Date().toISOString()
      };
      db.trips.push(completedTrip);
    }

    io.emit("paymentStatus", { status: "SUCCESS", checkoutRequestId: CheckoutRequestID, receipt: mpesaReceiptNumber });
  } else {
    updatedPaymentData = {
      status: "FAILED",
      reason: ResultDesc,
      completedAt: new Date().toISOString()
    };

    if (paymentIndex !== -1) {
      db.payments[paymentIndex] = { ...db.payments[paymentIndex], ...updatedPaymentData };
    }

    io.emit("paymentStatus", { status: "FAILED", checkoutRequestId: CheckoutRequestID, reason: ResultDesc });
  }

  await writeDb(db);
  res.status(200).json({ ResultCode: 0, ResultDescription: "Success" });
});

app.get("/api/ledger", async (req, res) => {
  try {
    const db = await readDb();
    res.status(200).json(db);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Unified service securely active on port ${PORT}`);
  });
});