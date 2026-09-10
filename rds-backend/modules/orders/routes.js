const express = require("express");
const router = express.Router();

// Central shared memory core (Single Source of Truth)
const store = require("../../core/store");

/* ================= HELPERS & VALIDATORS ================= */

function now() {
  return Date.now();
}

function num(v) {
  const parsed = Number(v);
  return isNaN(parsed) ? 0 : parsed;
}

function uid(prefix = "ORD") {
  return `${prefix}_${now()}_${Math.floor(Math.random() * 99999)}`;
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

function fail(res, message = "Error", statusCode = 400) {
  return res.status(statusCode).json({ success: false, error: message });
}

/* ================= ROUTE HANDLERS ================= */

/* ================= GET ALL ORDERS ================= */
router.get("/", (req, res) => {
  try {
    store.sanitize();
    const { status, customerPhone, businessId } = req.query;

    let list = store.orders;

    if (status) {
      const targetStatus = status.toString().toLowerCase();
      list = list.filter(o => (o.status || "").toString().toLowerCase() === targetStatus);
    }

    if (customerPhone) {
      list = list.filter(o => o.customerPhone === customerPhone);
    }

    if (businessId) {
      list = list.filter(o => o.businessId === businessId);
    }

    return ok(res, {
      count: list.length,
      data: list,
      orders: list // Legacy compatibility
    });
  } catch (err) {
    return fail(res, "Failed to fetch orders feed", 500);
  }
});

/* GET SINGLE ORDER BY ID */
router.get("/:id", (req, res) => {
  try {
    store.sanitize();
    const order = store.orders.find(o => o.id === req.params.id);
    if (!order) {
      return fail(res, "Order profile not found", 404);
    }
    return ok(res, { data: order, order });
  } catch (err) {
    return fail(res, "Failed to load order record", 500);
  }
});

/* ================= CREATE ORDER ================= */
const createOrderHandler = (req, res) => {
  try {
    store.sanitize();
    const {
      customerName,
      customerPhone,
      businessId,
      items,
      pickup,
      dropoff,
      deliveryAddress,
      amount,
      total
    } = req.body;

    const finalName = (customerName || "Guest Customer").trim();
    const finalAmount = num(amount || total);

    const order = {
      id: uid("ORD"),
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
      createdAt: now(),
      updatedAt: now()
    };

    store.orders.push(order);

    // Journal Entry into Financial Ledger
    store.ledger.push({
      id: uid("TX"),
      type: "ORDER",
      amount: finalAmount,
      orderId: order.id,
      businessId: order.businessId,
      createdAt: now()
    });

    return ok(res, {
      message: "Order created successfully",
      data: order,
      order
    });
  } catch (err) {
    return fail(res, "Order creation failed", 500);
  }
};

router.post("/create", createOrderHandler);
router.post("/checkout", createOrderHandler); // Alias

/* ================= ASSIGN DRIVER ================= */
const assignDriverHandler = (req, res) => {
  try {
    store.sanitize();
    const orderId = req.body.orderId || req.body.id || req.query.orderId;
    const driverId = req.body.driverId || req.query.driverId;

    if (!orderId) return fail(res, "orderId is required");

    const order = store.orders.find(o => o.id === orderId);
    if (!order) return fail(res, "Order not found", 404);

    const currentStatus = (order.status || "").toString().toLowerCase();
    if (["completed", "delivered", "cancelled"].includes(currentStatus)) {
      return fail(res, `Order cannot be assigned from status '${order.status}'`);
    }

    if (driverId) {
      const driver = store.drivers.find(d => d.id === driverId);
      if (driver) {
        driver.status = "busy";
        driver.updatedAt = now();
      }
    }

    order.driverId = driverId || order.driverId;
    order.status = "assigned";
    order.updatedAt = now();

    return ok(res, {
      message: "Driver assigned successfully",
      data: order,
      order
    });
  } catch (err) {
    return fail(res, "Driver assignment failed", 500);
  }
};

router.post("/assign", assignDriverHandler);

/* ================= START DELIVERY ================= */
const startDeliveryHandler = (req, res) => {
  try {
    store.sanitize();
    const orderId = req.body.orderId || req.body.id || req.query.orderId;

    if (!orderId) return fail(res, "orderId is required");

    const order = store.orders.find(o => o.id === orderId);
    if (!order) return fail(res, "Order not found", 404);

    const currentStatus = (order.status || "").toString().toLowerCase();
    if (!["assigned", "pending"].includes(currentStatus)) {
      return fail(res, `Order cannot be started from status '${order.status}'`);
    }

    order.status = "in_progress";
    order.updatedAt = now();

    return ok(res, {
      message: "Delivery started successfully",
      data: order,
      order
    });
  } catch (err) {
    return fail(res, "Delivery start failed", 500);
  }
};

router.post("/start", startDeliveryHandler);

/* ================= COMPLETE ORDER ================= */
const completeOrderHandler = (req, res) => {
  try {
    store.sanitize();
    const orderId = req.body.orderId || req.body.deliveryId || req.body.id || req.query.orderId;

    if (!orderId) return fail(res, "orderId is required");

    const order = store.orders.find(o => o.id === orderId);
    if (!order) return fail(res, "Order not found", 404);

    order.status = "completed";
    order.completedAt = now();
    order.updatedAt = now();

    // Release driver status back to online & record payout
    if (order.driverId) {
      const driver = store.drivers.find(d => d.id === order.driverId);
      if (driver) {
        const earn = (order.total || order.amount || 0) * 0.10;
        driver.earnings += earn;
        driver.status = "online";
        driver.updatedAt = now();

        store.ledger.push({
          id: uid("TX"),
          type: "DELIVERY_PAYOUT",
          amount: earn,
          orderId: order.id,
          driverId: driver.id,
          createdAt: now()
        });
      }
    }

    return ok(res, {
      message: "Order completed successfully",
      data: order,
      order
    });
  } catch (err) {
    return fail(res, "Order completion failed", 500);
  }
};

router.post("/complete", completeOrderHandler);
router.post("/driver/complete", completeOrderHandler); // Alias

/* ================= DELETE ORDER ================= */
router.delete("/:id", (req, res) => {
  try {
    store.sanitize();
    const id = req.params.id;

    const initialLength = store.orders.length;
    store.orders = store.orders.filter(o => o.id !== id);

    if (store.orders.length === initialLength) {
      return fail(res, "Order not found", 404);
    }

    return ok(res, {
      message: `Order ${id} deleted successfully`
    });
  } catch (err) {
    return fail(res, "Delete operation failed", 500);
  }
});

/* ================= SAFE MODULE EXPORTS ================= */

// Export router as default module
module.exports = router;

// Bind dynamic store property getter to legacy module properties
Object.defineProperty(module.exports, "_orders", {
  get: () => store.orders,
  enumerable: true,
  configurable: true
});