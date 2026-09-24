const express = require('express');
const router = express.Router();

router.get('/dispatches', (req, res) => {
    res.json({ success: true, dispatches: [] });
});

module.exports = router;