const express = require("express");
const router = express.Router();

// Central shared memory core
const store = require("../../core/store");

/* ================= HELPERS & VALIDATORS ================= */

function now() {
  return Date.now();
}

function num(v) {
  const parsed = Number(v);
  return isNaN(parsed) ? 0 : parsed;
}

function uid(prefix = "DRV") {
  return `${prefix}_${now()}_${Math.floor(Math.random() * 99999)}`;
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

function fail(res, message = "Error", statusCode = 400) {
  return res.status(statusCode).json({ success: false, error: message });
}

/* ================= ROUTE HANDLERS ================= */

/* GET ALL DRIVERS */
router.get("/", (req, res) => {
  try {
    store.sanitize();
    const { status } = req.query;
    let list = store.drivers;

    if (status) {
      list = list.filter(d => (d.status || "").toLowerCase() === status.toString().toLowerCase());
    }

    return ok(res, {
      count: list.length,
      data: list,
      drivers: list // Legacy support
    });
  } catch (err) {
    return fail(res, "Failed to retrieve drivers roster", 500);
  }
});

/* GET LIVE/ACTIVE DRIVERS ONLY */
router.get("/live", (req, res) => {
  try {
    store.sanitize();
    const currentTime = now();
    const active = store.drivers.filter(d =>
      d.location &&
      d.lastSeen &&
      (currentTime - d.lastSeen < 60000)
    );

    return ok(res, {
      count: active.length,
      drivers: active,
      data: active
    });
  } catch (err) {
    return fail(res, "Failed to retrieve live drivers", 500);
  }
});

/* GET SINGLE DRIVER BY ID */
router.get("/:id", (req, res) => {
  try {
    store.sanitize();
    const driver = store.drivers.find(d => d.id === req.params.id);
    if (!driver) {
      return fail(res, "Driver profile not found", 404);
    }
    return ok(res, { data: driver, driver });
  } catch (err) {
    return fail(res, "Failed to load driver profile", 500);
  }
});

/* ADD / REGISTER DRIVER */
const addDriverHandler = (req, res) => {
  try {
    store.sanitize();
    const name = (req.body.name || req.query.name || "").trim();
    const vehicle = (req.body.vehicle || req.query.vehicle || "Not assigned").trim();
    const phone = (req.body.phone || req.query.phone || "0700000000").trim();

    if (!name || name.length < 2) {
      return fail(res, "Driver name is required (minimum 2 characters)");
    }

    // Reactivate existing driver if profile exists
    let existing = store.drivers.find(d => d.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.status = "online";
      existing.lastSeen = now();
      if (vehicle !== "Not assigned") existing.vehicle = vehicle;
      return ok(res, {
        message: "Existing driver profile reactivated",
        data: existing,
        driver: existing
      });
    }

    const newDriver = {
      id: uid("DRV"),
      name,
      phone,
      vehicle,
      status: "offline",
      earnings: 0,
      location: null,
      lastSeen: now(),
      createdAt: now(),
      updatedAt: now()
    };

    store.drivers.push(newDriver);

    return ok(res, {
      message: "Driver registered successfully",
      data: newDriver,
      driver: newDriver
    });
  } catch (err) {
    return fail(res, "Failed to register driver", 500);
  }
};

router.post("/add", addDriverHandler);
router.post("/register", addDriverHandler);

/* UPDATE DRIVER STATUS */
const updateStatusHandler = (req, res) => {
  try {
    store.sanitize();
    const driverId = req.body.driverId || req.body.id || req.query.driverId;
    let status = (req.body.status || req.query.status || "").toString().toLowerCase();

    if (!driverId || !status) {
      return fail(res, "Missing required driverId or status payload");
    }

    if (["idle", "available", "online", "true"].includes(status)) status = "online";

    const driver = store.drivers.find(d => d.id === driverId);
    if (!driver) {
      return fail(res, "Driver not found", 404);
    }

    driver.status = status;
    driver.lastSeen = now();
    driver.updatedAt = now();

    return ok(res, {
      message: "Driver status updated",
      data: driver,
      driver
    });
  } catch (err) {
    return fail(res, "Status update failed", 500);
  }
};

router.post("/status", updateStatusHandler);

/* UPDATE DRIVER LOCATION (GPS TELEMETRY) */
const updateLocationHandler = (req, res) => {
  try {
    store.sanitize();
    const driverId = req.body.driverId || req.body.id || req.query.driverId;
    const payload = req.body.location || req.body;

    if (!driverId) {
      return fail(res, "Missing required driverId");
    }

    if (payload.lat == null || payload.lng == null) {
      return fail(res, "Missing valid latitude/longitude coordinates");
    }

    const latN = num(payload.lat);
    const lngN = num(payload.lng);

    if (isNaN(latN) || isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
      return fail(res, "Invalid geographical coordinate bounds");
    }

    const driver = store.drivers.find(d => d.id === driverId);
    if (!driver) {
      return fail(res, "Driver not found", 404);
    }

    driver.location = {
      lat: latN,
      lng: lngN,
      heading: num(payload.heading),
      speed: num(payload.speed)
    };
    driver.lastSeen = now();
    driver.updatedAt = now();

    // Auto mark online upon sending valid telemetry
    if (driver.status === "offline") {
      driver.status = "online";
    }

    return ok(res, {
      message: "Driver location updated",
      data: driver,
      location: driver.location
    });
  } catch (err) {
    return fail(res, "GPS telemetry processing failed", 500);
  }
};

router.post("/location", updateLocationHandler);

/* DELETE DRIVER PROFILE */
router.delete("/:id", (req, res) => {
  try {
    store.sanitize();
    const driverId = req.params.id;
    const initialLength = store.drivers.length;

    store.drivers = store.drivers.filter(d => d.id !== driverId);

    if (store.drivers.length === initialLength) {
      return fail(res, "Driver profile not found", 404);
    }

    return ok(res, { message: `Driver ${driverId} deleted successfully` });
  } catch (err) {
    return fail(res, "Delete operation failed", 500);
  }
});

module.exports = router;