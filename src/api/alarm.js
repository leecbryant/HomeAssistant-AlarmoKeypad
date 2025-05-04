const express = require('express');
const router = express.Router();

// Get alarm state
router.get('/state', (req, res) => {
    // Return the latest state received via MQTT
    res.json({ state: req.app.locals.alarmState || 'unknown' });
});

// Arm the alarm
router.post('/updateAlarmState', (req, res) => {
    const { mode, code } = req.body;

    console.log(`Updating alarm state with mode: ${mode}, code: ${code}`);
    
    // Check if code is provided
    if (!code) {
        return res.status(400).json({ success: false, message: 'Security code is required' });
    }
    
    // Get MQTT client from app locals
    const mqttClient = req.app.locals.mqttClient;
    const io = req.app.locals.io;
    
    // Track if we've responded yet
    let hasResponded = false;
    
    // Set up a response timeout (5 seconds)
    const responseTimeout = setTimeout(() => {
        if (!hasResponded) {
            hasResponded = true;
            // Remove the event listener to prevent memory leaks
            mqttClient.removeListener('message', responseHandler);
            // Emit timeout event via Socket.IO
            if (io) {
                io.emit('alarmUpdateTimeout', { mode });
            }
            // Return timeout error
            res.status(504).json({ 
                success: false, 
                message: 'Timeout waiting for alarm system response',
                event: 'TIMEOUT'
            });
        }
    }, 5000);
    
    // Set up a one-time listener for the response
    const responseHandler = (topic, message) => {
        console.log(`Received message on topic ${topic}: ${message.toString()}`);
        if (topic === 'alarmo/event') {
            try {
                console.log(`Response received on ${topic}: ${message.toString()}`);
                const response = JSON.parse(message.toString());

                // Only process if we haven't responded yet
                if (!hasResponded) {
                    switch (response.event) {
                        case 'ARM_AWAY':
                        case 'ARM_HOME':
                        case 'ARM_NIGHT':
                        case 'ARM_VACATION':
                        case 'ARM_CUSTOM_BYPASS':
                            hasResponded = true;
                            clearTimeout(responseTimeout);
                            mqttClient.removeListener('message', responseHandler);
                            res.status(200).json({ 
                                success: true, 
                                event: response.event,
                                state: mapEventToState(response.event)
                            });
                            break;
                            
                        case 'TRIGGER':
                            hasResponded = true;
                            clearTimeout(responseTimeout);
                            mqttClient.removeListener('message', responseHandler);
                            res.status(200).json({ 
                                success: true, 
                                event: response.event,
                                state: 'triggered' 
                            });
                            break;
                            
                        case 'FAILED_TO_ARM':
                        case 'COMMAND_NOT_ALLOWED':
                        case 'INVALID_CODE_PROVIDED':
                        case 'NO_CODE_PROVIDED':
                            hasResponded = true;
                            clearTimeout(responseTimeout);
                            mqttClient.removeListener('message', responseHandler);
                            res.status(400).json({ 
                                success: false, 
                                message: getErrorMessage(response.event), 
                                event: response.event 
                            });
                            break;
                            
                        default:
                            // Only handle unrecognized events if we haven't responded yet
                            if (!hasResponded) {
                                hasResponded = true;
                                clearTimeout(responseTimeout);
                                mqttClient.removeListener('message', responseHandler);
                                res.status(400).json({ 
                                    success: false, 
                                    message: 'Unrecognized alarm event received', 
                                    event: response.event 
                                });
                            }
                    }
                }
            } catch (e) {
                console.error('Error parsing MQTT response:', e);
                
                // Only respond with error if we haven't already responded
                if (!hasResponded) {
                    hasResponded = true;
                    clearTimeout(responseTimeout);
                    mqttClient.removeListener('message', responseHandler);
                    
                    // Emit error via socket.io
                    if (io) {
                        io.emit('alarmUpdateError', { 
                            error: 'PARSE_ERROR',
                            message: 'Failed to parse alarm system response'
                        });
                    }
                    
                    res.status(500).json({ 
                        success: false, 
                        message: 'Failed to parse alarm system response' 
                    });
                }
            }
        }

        if (topic === 'alarmo/state') {
            // handle disarmed state
            const state = message.toString();
            if (state === 'disarmed') {
                hasResponded = true;
                clearTimeout(responseTimeout);
                mqttClient.removeListener('message', responseHandler);
                res.status(200).json({ 
                    success: true, 
                    event: 'DISARMED',
                    state: 'disarmed' 
                });
            }
        }
    };
    
    // Listen for the response
    mqttClient.on('message', responseHandler);
    
    // Send command to update the alarm using Alarmo's MQTT API
    try {
        mqttClient.publish('alarmo/command', JSON.stringify({
            command: mode,
            code: code
        }));
    } catch (error) {
        console.error('Error sending MQTT command:', error);
        
        // Clean up the listener since we're responding with an error
        clearTimeout(responseTimeout);
        mqttClient.removeListener('message', responseHandler);
        hasResponded = true;
        
        // Emit error via socket.io
        if (io) {
            io.emit('alarmUpdateError', {
                error: 'MQTT_PUBLISH_ERROR',
                message: 'Failed to send command to alarm system'
            });
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'Failed to send command to alarm system' 
        });
    }
});

/**
 * Helper function to map alarm events to states
 * @param {string} event - The event from alarmo
 * @returns {string} The corresponding state
 */
function mapEventToState(event) {
    switch(event) {
        case 'ARM_AWAY': return 'armed_away';
        case 'ARM_HOME': return 'armed_home';
        case 'ARM_NIGHT': return 'armed_night';
        case 'ARM_VACATION': return 'armed_vacation';
        case 'ARM_CUSTOM_BYPASS': return 'armed_custom_bypass';
        case 'TRIGGER': return 'triggered';
        default: return 'unknown';
    }
}

/**
 * Helper function to get user-friendly error messages
 * @param {string} event - The error event from alarmo
 * @returns {string} User-friendly error message
 */
function getErrorMessage(event) {
    switch(event) {
        case 'FAILED_TO_ARM': return 'Failed to arm the system. Please check if all sensors are closed.';
        case 'COMMAND_NOT_ALLOWED': return 'Command not allowed in the current state.';
        case 'INVALID_CODE_PROVIDED': return 'Invalid security code provided.';
        case 'NO_CODE_PROVIDED': return 'Security code is required for this operation.';
        default: return 'Failed to change the state of the alarm.';
    }
}

module.exports = router;