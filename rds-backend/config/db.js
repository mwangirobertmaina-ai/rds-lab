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

    return JSON.parse(fs.readFileSync(DB_FILE));
  } catch {
    return defaultDB();
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

module.exports = { loadDB, saveDB };