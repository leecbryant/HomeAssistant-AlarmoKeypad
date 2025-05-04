const express = require('express');
const axios = require('axios');
const config = require('../config');
const router = express.Router();

// Get all binary sensors
router.get('/', async (req, res) => {
    try {
        const response = await axios.get(`${config.homeAssistant.apiUrl}/states`, {
            headers: {
                'Authorization': `Bearer ${config.homeAssistant.apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        // Filter only binary sensors
        const sensors = response.data.filter(entity => 
            entity.entity_id.startsWith(config.sensors.sensorFilter)
        );

        // Sort sensors by friendly name if available
        sensors.sort((a, b) => {
            const nameA = a.attributes.friendly_name || a.entity_id;
            const nameB = b.attributes.friendly_name || b.entity_id;
            return nameA.localeCompare(nameB);
        });

        res.json(sensors);
    } catch (error) {
        console.error('Error fetching Konnected sensors:', error);
        res.status(500).json({ error: 'Failed to fetch Konnected sensors' });
    }
});

/**
 * Get states for specific entities
 * Accepts array of entity IDs and returns their current states
 */
router.post('/getStates', async (req, res) => {
    try {
        // Get the entity IDs from the request
        const { entityIds } = req.body;
        
        if (!entityIds || !Array.isArray(entityIds)) {
            return res.status(400).json({ 
                error: 'Invalid request. Expected entityIds array in request body.' 
            });
        }
        
        // Initialize results array
        let entities = [];
        
        // If the array is empty, return empty results
        if (entityIds.length === 0) {
            return res.json({ entities });
        }
        
        // Get all states from Home Assistant
        const response = await axios.get(`${config.homeAssistant.apiUrl}/states`, {
            headers: {
                'Authorization': `Bearer ${config.homeAssistant.apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        
        // Filter to only the requested entities
        entities = response.data.filter(entity => 
            entityIds.includes(entity.entity_id)
        );
        
        // If some entities weren't found, log them
        const foundIds = entities.map(e => e.entity_id);
        const missingIds = entityIds.filter(id => !foundIds.includes(id));
        
        if (missingIds.length > 0) {
            console.warn(`Some requested entities were not found: ${missingIds.join(', ')}`);
        }
        
        res.json({ entities });
    } catch (error) {
        console.error('Error fetching entity states:', error);
        res.status(500).json({ 
            error: 'Failed to fetch entity states',
            message: error.message
        });
    }
});

module.exports = router;