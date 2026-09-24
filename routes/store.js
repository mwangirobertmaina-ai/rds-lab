const express = require('express');
const router = express.Router();

router.get('/products', (req, res) => {
  res.json({ success: true, products: [] });
});

module.exports = router;