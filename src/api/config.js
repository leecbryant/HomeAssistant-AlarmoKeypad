const express = require('express');
const router = express.Router();
const config = require('../config');

// Get sensor configuration
router.get('/sensors', (req, res) => {
    try {
        // Return the sensors list from config
        res.json({
            sensors: config.sensors.list || []
        });
    } catch (error) {
        console.error('Error retrieving sensor configuration:', error);
        res.status(500).json({ error: 'Failed to retrieve sensor configuration' });
    }
});

module.exports = router;