/**
 * RDS ENTERPRISE CORE - CENTRAL IN-MEMORY DATA STORE
 * Provides synchronized, self-healing shared memory across all Express routes.
 */

/* ================= UTILITY HELPERS ================= */

function now() {
  return Date.now();
}

function num(v) {
  const parsed = Number(v);
  return isNaN(parsed) ? 0 : parsed;
}

function uid(prefix = "SYS") {
  return `${prefix}_${now()}_${Math.floor(Math.random() * 99999)}`;
}

/* ================= CENTRAL STORE SCHEMA ================= */

const store = {
  businesses: [],
  products: [],
  orders: [],
  drivers: [],
  deliveries: [],
  ledger: [],
  wallets: {
    SYSTEM_PLATFORM: { balance: 0, escrow: 0 }
  },
  system: {
    createdAt: now(),
    lastCheck: now()
  },

  /* ================= SELF-HEALING ENGINE ================= */

  /**
   * Validates and repairs store collections to prevent null/undefined runtime crashes.
   */
  sanitize() {
    if (!Array.isArray(this.businesses)) this.businesses = [];
    if (!Array.isArray(this.products)) this.products = [];
    if (!Array.isArray(this.orders)) this.orders = [];
    if (!Array.isArray(this.drivers)) this.drivers = [];
    if (!Array.isArray(this.deliveries)) this.deliveries = [];
    if (!Array.isArray(this.ledger)) this.ledger = [];
    if (!this.wallets || typeof this.wallets !== "object") {
      this.wallets = { SYSTEM_PLATFORM: { balance: 0, escrow: 0 } };
    }

    // 1. Sanitize Products Catalog
    this.products.forEach(p => {
      if (p && typeof p === "object") {
        p.price = num(p.price);
        p.stock = p.stock !== undefined ? Math.max(0, Math.floor(num(p.stock))) : 50;
        p.businessId = p.businessId || "SYSTEM";
        p.name = (p.name || "Unnamed Product").trim();
        p.createdAt = p.createdAt || now();
      }
    });

    // 2. Sanitize and Deduplicate Driver Roster
    const driverNameMap = new Map();
    this.drivers.forEach(d => {
      if (!d || (!d.id && !d.name)) return;
      const cleanName = (d.name || "Unknown Driver").trim();
      const nameKey = cleanName.toLowerCase();

      let status = (d.status || "").toString().toLowerCase();
      if (["idle", "available", "online", "true"].includes(status)) status = "online";
      if (!["online", "busy", "offline"].includes(status)) status = "offline";

      if (!driverNameMap.has(nameKey)) {
        const primaryDriver = {
          id: d.id || uid("DRV"),
          name: cleanName,
          phone: d.phone || "0700000000",
          status: status,
          earnings: num(d.earnings),
          location: d.location && !isNaN(num(d.location.lat)) && !isNaN(num(d.location.lng)) ? {
            lat: num(d.location.lat),
            lng: num(d.location.lng),
            heading: num(d.location.heading),
            speed: num(d.location.speed)
          } : null,
          lastSeen: num(d.lastSeen) || now(),
          createdAt: num(d.createdAt) || now()
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
    this.drivers = Array.from(driverNameMap.values());

    this.system.lastCheck = now();
    return this;
  },

  /* ================= SAFE ACCESSORS & MUTATORS ================= */

  /**
   * Safe item push with duplicate prevention by ID
   */
  add(collectionName, item) {
    this.sanitize();
    if (!this[collectionName] || !Array.isArray(this[collectionName])) {
      this[collectionName] = [];
    }
    
    if (!item.id) {
      item.id = uid(collectionName.substring(0, 3).toUpperCase());
    }
    item.createdAt = item.createdAt || now();
    item.updatedAt = now();

    const existingIndex = this[collectionName].findIndex(x => x.id === item.id);
    if (existingIndex !== -1) {
      this[collectionName][existingIndex] = { ...this[collectionName][existingIndex], ...item };
    } else {
      this[collectionName].push(item);
    }

    return item;
  },

  /**
   * Find entity by ID safely
   */
  findById(collectionName, entityId) {
    this.sanitize();
    if (!this[collectionName] || !Array.isArray(this[collectionName])) return null;
    return this[collectionName].find(x => x && x.id === entityId) || null;
  },

  /**
   * Filter collection safely
   */
  where(collectionName, predicate) {
    this.sanitize();
    if (!this[collectionName] || !Array.isArray(this[collectionName])) return [];
    return this[collectionName].filter(predicate);
  },

  /**
   * Delete item by ID
   */
  remove(collectionName, entityId) {
    this.sanitize();
    if (!this[collectionName] || !Array.isArray(this[collectionName])) return false;
    const initialLength = this[collectionName].length;
    this[collectionName] = this[collectionName].filter(x => x && x.id !== entityId);
    return this[collectionName].length < initialLength;
  },

  /**
   * Hydrate bulk data into store safely
   */
  hydrate(payload = {}) {
    if (Array.isArray(payload.businesses)) this.businesses = payload.businesses;
    if (Array.isArray(payload.products)) this.products = payload.products;
    if (Array.isArray(payload.orders)) this.orders = payload.orders;
    if (Array.isArray(payload.drivers)) this.drivers = payload.drivers;
    if (Array.isArray(payload.deliveries)) this.deliveries = payload.deliveries;
    if (Array.isArray(payload.ledger)) this.ledger = payload.ledger;
    if (payload.wallets && typeof payload.wallets === "object") this.wallets = payload.wallets;
    this.sanitize();
  }
};

// Auto-sanitize store on module import
store.sanitize();

module.exports = store;