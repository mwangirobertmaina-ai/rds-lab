const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "../db.json");

function defaultDB() {
  return {
    businesses: [],
    orders: [],
    drivers: [],
    ledger: []
  };
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB(), null, 2));
      return defaultDB();
    }

    const raw = fs.readFileSync(DB_FILE, "utf-8");
    const data = JSON.parse(raw);

    return {
      businesses: data.businesses || [],
      orders: data.orders || [],
      drivers: data.drivers || [],
      ledger: data.ledger || []
    };
  } catch (err) {
    console.error("DB LOAD ERROR:", err);
    return defaultDB();
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error("DB SAVE ERROR:", err);
  }
}

module.exports = { loadDB, saveDB };