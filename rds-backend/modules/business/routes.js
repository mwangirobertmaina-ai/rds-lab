const express = require("express");
const router = express.Router();

const { loadDB, saveDB } = require("../../config/db");
const { id } = require("../../core/id");
const { ok, fail } = require("../../core/response");

router.get("/", (req, res) => {
  const db = loadDB();
  return ok(res, { businesses: db.businesses });
});

router.post("/add", (req, res) => {
  if (!req.body.name) return fail(res, "Name required");

  const db = loadDB();

  const business = {
    id: id("biz"),
    name: req.body.name,
    category: req.body.category || "Retail",
    createdAt: Date.now()
  };

  db.businesses.push(business);
  saveDB(db);

  return ok(res, { business });
});

module.exports = router;