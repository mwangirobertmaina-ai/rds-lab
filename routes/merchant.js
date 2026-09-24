const express = require('express');
const router = express.Router();

router.get('/inventory', (req, res) => {
    res.json({ success: true, inventory: [] });
});

module.exports = router;