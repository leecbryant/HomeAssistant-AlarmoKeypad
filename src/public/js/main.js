/**
 * Alarm Control Panel - Main JavaScript
 * 
 * This module handles WebSocket connections, UI updates, and alarm system interactions.
 * It provides real-time feedback through audio, visual, and haptic responses,
 * manages PIN entry for security operations, and displays system status information.
 * 
 * @author [Your Name]
 * @version 1.0.0
 */

//==============================================================================
// INITIALIZATION AND GLOBALS
//==============================================================================

// Initialize WebSocket connection
const socket = io();

// PIN entry state
let currentCode = '';
let pinLength = 0;
let pendingArmMode = null; // Store the arm mode that's pending code entry

// Track initialization to prevent sounds on initial state load and reconnections
let initialStateLoaded = false;
let currentAlarmState = null; // Track current state to prevent redundant updates
let lastButtonState = null; // Track button visibility state to prevent unnecessary changes

// Audio elements for various system sounds - Optimized for Android/FullyKiosk
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const soundBuffers = {};
const soundSources = {}; // Cache active sources for quick reuse
const sounds = ['keypress', 'action', 'error', 'armed', 'disarmed'];

// Preload and optimize audio buffers
sounds.forEach(sound => {
    fetch(`/sounds/${sound}.mp3`)
        .then(response => response.arrayBuffer())
        .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer))
        .then(audioBuffer => {
            soundBuffers[sound] = audioBuffer;
            console.log(`Sound ${sound} loaded and optimized`);
        })
        .catch(error => console.error(`Error loading sound ${sound}:`, error));
});

// Pre-warm audio context for Android
if (audioContext.state === 'suspended') {
    // Create a silent buffer to initialize audio system
    const buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(0);
}

// Store the refresh timer ID to avoid multiple refreshes
let sensorRefreshTimer = null;

// Track arm button state for double-press functionality
let armButtonPressed = {
    'arm_home': false,
    'arm_away': false
};

let armButtonTimer = {
    'arm_home': null,
    'arm_away': null
};

//==============================================================================
// WEBSOCKET EVENT HANDLERS
//==============================================================================

/**
 * WebSocket connection established
 */
socket.on('connect', () => {
    console.log('Connected to server');
});

/**
 * WebSocket connection lost
 */
socket.on('disconnect', () => {
    console.log('Disconnected from server');
    updateAlarmState('Unknown');
    // Don't reset currentAlarmState here - keep it so we can detect actual changes on reconnect
});

/**
 * Handle alarm state changes received from server
 */
socket.on('alarmStateChanged', (data) => {
    console.log('Alarm state changed:', data);
    
    // Check if this is actually a state change or just a reconnection update
    const isActualStateChange = currentAlarmState !== data.state;
    
    // Only play sound if this is an actual state change and not initial load
    if (initialStateLoaded && isActualStateChange) {
        // Play appropriate sound based on the state change
        playAlarmStateSound(data.state);
        console.log(`State changed from ${currentAlarmState} to ${data.state} - playing sound`);
    } else if (!initialStateLoaded) {
        // First state update after page load, mark initialization complete
        initialStateLoaded = true;
        console.log('Initial state loaded without playing sounds');
    } else {
        console.log(`State update ignored - no change from ${currentAlarmState}`);
    }
    
    // Update the current state tracker before UI update
    currentAlarmState = data.state;
    
    // Update the UI (but buttons will only change if state actually changed)
    updateAlarmState(data.state);
});

/**
 * Handle alarm update errors received from server
 */
socket.on('alarmUpdateError', (data) => {
    console.error('Alarm update error:', data);
    
    // Show toast notification with error message
    const message = data.message || getErrorMessageForEvent(data.event);
    showNotification(message, 'error');
    
    // Play error feedback
    playHapticFeedback('error');
    playSound('error');
    
    // Reset pending arm mode
    pendingArmMode = null;
});

/**
 * Handle alarm update timeouts received from server
 */
socket.on('alarmUpdateTimeout', (data) => {
    console.warn('Alarm update timeout for mode:', data.mode);
    
    // Show toast notification
    showNotification('The alarm system did not respond. Please try again.', 'warning');
    
    // Play error feedback
    playHapticFeedback('error');
    playSound('error');
    
    // Reset pending arm mode
    pendingArmMode = null;
});

//==============================================================================
// FEEDBACK AND UI FUNCTIONS
//==============================================================================

/**
 * Plays the appropriate sound based on the new alarm state
 * 
 * @param {string} state - The new alarm state
 */
function playAlarmStateSound(state) {
    switch(state.toLowerCase()) {
        case 'armed_away':
        case 'armed_home':
        case 'armed_night':
        case 'armed_vacation':
            playSound('armed');
            break;
        case 'disarmed':
            playSound('disarmed');
            break;
        case 'triggered':
            playSound('triggered');
            break;
        default:
            // No sound for other states
            break;
    }
}

/**
 * Provides haptic feedback if available on the device
 * 
 * @param {string} style - The haptic style ('light', 'medium', 'heavy', 'success', 'error')
 */
function playHapticFeedback(style = 'medium') {
    // Check if the browser supports the Vibration API
    if ('vibrate' in navigator) {
        switch(style) {
            case 'light':
                navigator.vibrate(15);
                break;
            case 'medium':
                navigator.vibrate(30);
                break;
            case 'heavy':
                navigator.vibrate(50);
                break;
            case 'success':
                navigator.vibrate([25, 50, 25]);
                break;
            case 'error':
                navigator.vibrate([50, 25, 50, 25, 50]);
                break;
            default:
                navigator.vibrate(30);
        }
    }
}

/**
 * Plays sound feedback for button presses and system events
 * Optimized for low latency on Android/FullyKiosk
 * 
 * @param {string} type - Type of sound ('keypad', 'action', 'error', 'armed', 'disarmed', 'triggered')
 */
function playSound(type = 'keypad') {
    try {
        // Quick resume for Android
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }
        
        // Map the type to the buffer name
        let soundName;
        switch(type) {
            case 'keypad': soundName = 'keypress'; break;
            case 'action': soundName = 'action'; break;
            case 'error': soundName = 'error'; break;
            case 'armed': soundName = 'armed'; break;
            case 'disarmed': soundName = 'disarmed'; break;
            case 'triggered': soundName = 'action'; break;
            default: soundName = 'keypress';
        }
        
        // If buffer is loaded, play it immediately
        if (soundBuffers[soundName]) {
            // Stop any existing sound of this type for immediate response
            if (soundSources[soundName]) {
                try {
                    soundSources[soundName].stop();
                } catch (e) {}
            }
            
            const source = audioContext.createBufferSource();
            source.buffer = soundBuffers[soundName];
            source.connect(audioContext.destination);
            source.start(0);
            
            // Cache for potential early stopping
            soundSources[soundName] = source;
            
            // Clean up reference when done
            source.onended = () => {
                if (soundSources[soundName] === source) {
                    soundSources[soundName] = null;
                }
            };
        }
    } catch (e) {
        console.error('Error playing sound:', e);
    }
}

/**
 * Updates the UI based on the current alarm state
 * Changes status icons, text, and button visibility
 * 
 * @param {string} state - The current alarm state
 */
function updateAlarmState(state) {
    console.log('Updating alarm state to:', state);
    
    // Get the system status element and alarm state text element
    const systemStatus = document.getElementById('system-status');
    const alarmState = document.getElementById('alarm-state');
    const statusDetail = document.getElementById('status-detail');
    
    // Update the status icon and text based on state
    if (systemStatus && alarmState) {
        // Remove existing state classes
        systemStatus.classList.remove(
            'status-disarmed', 
            'status-armed_home', 
            'status-armed_away', 
            'status-pending', 
            'status-triggered',
            'status-arming'
        );
        
        // Update the status text based on the current state
        switch (state) {
            case 'disarmed':
                alarmState.textContent = 'Disarmed';
                systemStatus.classList.add('status-disarmed');
                
                if (statusDetail) {
                    statusDetail.textContent = 'System Ready';
                }
                break;
                
            case 'armed_home':
                alarmState.textContent = 'Armed Home';
                systemStatus.classList.add('status-armed_home');
                
                if (statusDetail) {
                    statusDetail.textContent = 'Home Perimeter Protected';
                }
                break;
                
            case 'armed_away':
                alarmState.textContent = 'Armed Away';
                systemStatus.classList.add('status-armed_away');
                
                if (statusDetail) {
                    statusDetail.textContent = 'Full Protection Active';
                }
                break;
                
            case 'pending':
                alarmState.textContent = 'Exit Delay';
                systemStatus.classList.add('status-pending');
                
                if (statusDetail) {
                    statusDetail.textContent = 'Please Exit Now';
                }
                break;
                
            case 'arming':
                alarmState.textContent = 'Arming';
                systemStatus.classList.add('status-arming');
                
                if (statusDetail) {
                    statusDetail.textContent = 'Exit Now';
                }
                break;
                
            case 'triggered':
                alarmState.textContent = 'ALARM!';
                systemStatus.classList.add('status-triggered');
                
                if (statusDetail) {
                    statusDetail.textContent = 'Security Alert!';
                }
                break;
                
            default:
                alarmState.textContent = state || 'Unknown';
                if (statusDetail) {
                    statusDetail.textContent = 'System Status Unknown';
                }
        }
    }
    
    // Update arm buttons based on state
    updateArmButtonsState(state);
}

/**
 * Updates arm button states based on current alarm state
 * Shows/hides buttons depending on system state
 * 
 * @param {string} state - The current alarm state
 */
function updateArmButtonsState(state) {
    const armHomeBtn = document.getElementById('arm-home');
    const armAwayBtn = document.getElementById('arm-away');
    
    if (armHomeBtn && armAwayBtn) {
        // Determine what the button state should be
        const shouldShowButtons = (state === 'disarmed');
        
        // Only update if the button state actually needs to change
        if (lastButtonState !== shouldShowButtons) {
            console.log(`Button visibility changing: ${lastButtonState} -> ${shouldShowButtons}`);
            
            if (shouldShowButtons) {
                armHomeBtn.style.display = 'flex';
                armAwayBtn.style.display = 'flex';
            } else {
                armHomeBtn.style.display = 'none';
                armAwayBtn.style.display = 'none';
            }
            
            // Update the tracked state
            lastButtonState = shouldShowButtons;
        } else {
            console.log(`Button visibility unchanged: ${shouldShowButtons}`);
        }
    }
    
    // Reset any pending arm mode if we're not disarmed
    if (state !== 'disarmed') {
        pendingArmMode = null;
    }
}

/**
 * Updates the PIN dots display to reflect the current code length
 * Fills or empties the visual dots based on PIN digits entered
 */
function updatePinDisplay() {
    const pinDots = document.querySelectorAll('#pin-dots .pin-dot');
    if (pinDots.length > 0) {
        // Reset all dots to empty
        pinDots.forEach(dot => dot.classList.add('empty'));
        
        // Fill in dots based on current code length
        for (let i = 0; i < pinLength && i < pinDots.length; i++) {
            pinDots[i].classList.remove('empty');
        }
    }
}

/**
 * Displays a toast notification to the user
 * 
 * Creates a notification element that appears at the top center of the screen
 * and automatically fades out after the specified duration.
 * 
 * @param {string} message - The message text to display in the notification
 * @param {string} type - Notification type: 'success', 'error', 'warning', or 'info'
 * @param {number} duration - How long to display the notification in milliseconds
 */
function showNotification(message, type = 'info', duration = 3000) {
    // Check if notification container exists, create if not
    let container = document.getElementById('notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notification-container';
        container.style.position = 'fixed';
        container.style.top = '10px';
        container.style.left = '50%';
        container.style.transform = 'translateX(-50%)';
        container.style.zIndex = '1000';
        document.body.appendChild(container);
    }
    
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    // Set background color based on notification type
    switch (type) {
        case 'error':
            notification.style.backgroundColor = '#ff5252';
            break;
        case 'warning':
            notification.style.backgroundColor = '#ffb142';
            break;
        case 'success':
            notification.style.backgroundColor = '#69c779';
            break;
        default: // info
            notification.style.backgroundColor = '#3498db';
    }
    
    // Apply common styles
    notification.style.color = 'white';
    notification.style.padding = '12px 20px';
    notification.style.borderRadius = '4px';
    notification.style.margin = '10px 0';
    notification.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
    notification.style.opacity = '0';
    notification.style.transition = 'opacity 0.3s ease';
    
    // Add to container
    container.appendChild(notification);
    
    // Animate in - small delay ensures transition works
    setTimeout(() => {
        notification.style.opacity = '1';
    }, 10);
    
    // Set timeout to remove notification
    setTimeout(() => {
        // Fade out
        notification.style.opacity = '0';
        
        // Remove from DOM after fade completes
        setTimeout(() => {
            if (container.contains(notification)) {
                container.removeChild(notification);
            }
        }, 300); // Match the transition duration (300ms)
    }, duration);
}

/**
 * Maps error events to user-friendly messages
 * 
 * @param {string} event - The error event from the backend
 * @returns {string} User-friendly error message
 */
function getErrorMessageForEvent(event) {
    switch(event) {
        case 'FAILED_TO_ARM':
            return 'Failed to arm system. Check that all sensors are closed.';
        case 'INVALID_CODE_PROVIDED':
            return 'The security code you entered is incorrect.';
        case 'NO_CODE_PROVIDED':
            return 'Security code is required.';
        case 'COMMAND_NOT_ALLOWED':
            return 'This operation is not allowed right now.';
        default:
            return 'There was a problem updating the alarm system.';
    }
}

/**
 * Update arm button styling based on open sensor status
 * Adds warning indicators when sensors are open
 * 
 * @param {boolean} openSensorsPresent - Whether there are any open sensors
 */
function updateArmButtonsForOpenSensors(openSensorsPresent) {
    const armHomeBtn = document.getElementById('arm-home');
    const armAwayBtn = document.getElementById('arm-away');
    
    if (armHomeBtn && armAwayBtn) {
        if (openSensorsPresent) {
            // Add warning styling to buttons when sensors are open
            armHomeBtn.classList.add('arm-button-warning');
            armAwayBtn.classList.add('arm-button-warning');
        } else {
            // Remove warning styling when all sensors are closed
            armHomeBtn.classList.remove('arm-button-warning');
            armAwayBtn.classList.remove('arm-button-warning');
            
            // Reset any pending arm button states
            armButtonPressed.arm_home = false;
            armButtonPressed.arm_away = false;
            if (armButtonTimer.arm_home) clearTimeout(armButtonTimer.arm_home);
            if (armButtonTimer.arm_away) clearTimeout(armButtonTimer.arm_away);
        }
    }
}

//==============================================================================
// PIN ENTRY AND ALARM CONTROL
//==============================================================================

/**
 * Handles keypad button clicks for code entry
 * Processes button presses and updates PIN display
 * 
 * @param {string} key - The key that was pressed
 */
function handleKeyPress(key) {
    // Play feedback for all key presses
    playSound('keypad');
    playHapticFeedback('light');
    
    if (key === 'clear') {
        // Clear the code
        currentCode = '';
        pinLength = 0;
        updatePinDisplay();
    } else if (key === 'enter') {
        // Play different feedback for enter key
        playHapticFeedback('medium');
        
        if (currentCode) {
            if (pendingArmMode) {
                // We have a pending arm operation
                armSystem(pendingArmMode, currentCode);
                pendingArmMode = null; // Reset pending mode
            } else {
                // Default is to disarm with the code
                disarmWithCode(currentCode);
            }
        }
        
        currentCode = '';
        pinLength = 0;
        updatePinDisplay();
    } else {
        // Add digit to current code (limit to 4 digits for PIN)
        if (pinLength < 4) {
            currentCode += key;
            pinLength++;
            updatePinDisplay();
        } else {
            // Play error sound if trying to add more than 4 digits
            playSound('error');
            playHapticFeedback('error');
        }
    }
}

/**
 * Sends a disarm request with the provided code
 * 
 * @param {string} code - The disarm code
 */
function disarmWithCode(code) {
    // Show visual feedback that request is processing
    const statusDetailElement = document.getElementById('status-detail');
    if (statusDetailElement) {
        statusDetailElement.textContent = 'Processing Disarm Request...';
    }
    
    fetch('/api/alarm/updateAlarmState', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ mode: 'disarm', code: code })
    })
    .then(response => {
        if (!response.ok) {
            return response.json().then(data => {
                throw new Error(data.message || 'Failed to disarm system');
            });
        }
        return response.json();
    })
    .then(data => {
        console.log('Disarm attempt:', data);
        if (data.success) {
            playHapticFeedback('success');            
            // Visual feedback only (state update comes via WebSocket)
            showNotification('System successfully disarmed', 'success');
        } else {
            // Fallback error handling
            playHapticFeedback('error');
            playSound('error');
            showNotification(data.message || 'Failed to disarm system', 'error');
        }
    })
    .catch(error => {
        console.error('Error disarming system:', error);
        playHapticFeedback('error');
        playSound('error');
        showNotification(error.message || 'Failed to disarm system', 'error');
        
        // Reset status detail
        if (statusDetailElement) {
            statusDetailElement.textContent = 'System Ready';
        }
    });
}

/**
 * Sends an arm request with the specified mode
 * 
 * @param {string} mode - The arming mode (e.g., arm_away, arm_home)
 * @param {string} code - The security code
 */
function armSystem(mode, code) {
    // Show visual feedback that request is processing
    const statusDetailElement = document.getElementById('status-detail');
    if (statusDetailElement) {
        statusDetailElement.textContent = `Processing ${mode === 'arm_home' ? 'Home' : 'Away'} Request...`;
    }
    
    // Play feedback before sending request
    playHapticFeedback('medium');
    
    fetch('/api/alarm/updateAlarmState', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
            mode: mode,
            code: code
        })
    })
    .then(response => {
        if (!response.ok) {
            return response.json().then(data => {
                throw new Error(data.message || 'Failed to update alarm system');
            });
        }
        return response.json();
    })
    .then(data => {
        console.log(`Arm ${mode} response:`, data);
        if (data.success) {
            playHapticFeedback('success');            
            // Since we may receive state update via WebSocket, we'll only show feedback here
            showNotification(
                `System successfully ${mode === 'disarm' ? 'disarmed' : 'armed in ' + mode.replace('arm_', '') + ' mode'}`, 
                'success'
            );
        } else {
            // This is a fallback since errors should be handled by WebSocket events
            playHapticFeedback('error');
            playSound('error');
            showNotification(data.message || 'Failed to update alarm system', 'error');
        }
    })
    .catch(error => {
        console.error('Error updating system:', error);
        playHapticFeedback('error');
        playSound('error');
        showNotification(error.message || 'Failed to communicate with alarm system', 'error');
        
        // Reset status detail to show we're ready again
        if (statusDetailElement) {
            statusDetailElement.textContent = 'System Ready';
        }
    });
}

/**
 * Request PIN for arming or directly arm if code is already available
 * Implements double-press requirement for open sensors as a safety feature
 * 
 * @param {string} mode - The arming mode to prepare for ('arm_home' or 'arm_away')
 * @param {string} [code] - Optional security code if already available
 */
function requestArmWithMode(mode, code = null) {
    console.log(`Handling arm request for ${mode}`);
    
    // Store the provided code to preserve it through the double-press flow
    const providedCode = code;
    
    // Check if there are open sensors
    const openSensorsContainer = document.getElementById('entities-container');
    const hasOpenSensors = openSensorsContainer && 
                           openSensorsContainer.style.display !== 'none' && 
                           openSensorsContainer.children.length > 0;
    
    // If open sensors are present, require double-press for confirmation
    if (hasOpenSensors) {
        // If this is the first press, show warning and set timer
        if (!armButtonPressed[mode]) {
            armButtonPressed[mode] = true;
            
            // Show warning notification
            showNotification(
                'Warning: Sensors are open. Press again to override and arm anyway.', 
                'warning', 
                5000
            );
            
            // Add visual indication to the button
            const buttonId = mode === 'arm_home' ? 'arm-home' : 'arm-away';
            const button = document.getElementById(buttonId);
            if (button) {
                button.classList.add('override-pending');
                button.style.animation = 'pulse 1.5s infinite';
            }
            
            // Clear after 5 seconds if not pressed again
            armButtonTimer[mode] = setTimeout(() => {
                armButtonPressed[mode] = false;
                const btn = document.getElementById(mode === 'arm_home' ? 'arm-home' : 'arm-away');
                if (btn) {
                    btn.classList.remove('override-pending');
                    btn.style.animation = '';
                }
            }, 5000);
            
            // IMPORTANT: Don't clear the code, preserve it for the second press!
            return;
        } else {
            // This is the second press, clear the timer and continue with arming
            clearTimeout(armButtonTimer[mode]);
            armButtonPressed[mode] = false;
            
            // Remove the visual indication
            const buttonId = mode === 'arm_home' ? 'arm-home' : 'arm-away';
            const button = document.getElementById(buttonId);
            if (button) {
                button.classList.remove('override-pending');
                button.style.animation = '';
            }
            
            // Continue with arming, but add a notice that we're overriding
            showNotification('Arming with open sensors (override)', 'info');
            
            // Use the original provided code or the current code in the input
            code = providedCode || (currentCode.length >= 4 ? currentCode : null);
        }
    }
    
    // Always require a code to arm - if no code provided, request one
    if (!code) {
        // Request a code
        playSound('keypad');
        playHapticFeedback('light');
        
        // Set the pending arm mode
        pendingArmMode = mode;
        
        // Clear any existing code only if we're not in the override flow
        if (!hasOpenSensors || !armButtonPressed[mode]) {
            currentCode = '';
            pinLength = 0;
            updatePinDisplay();
        }
        
        // Update the status detail to show we're waiting for code
        const statusDetailElement = document.getElementById('status-detail');
        if (statusDetailElement) {
            statusDetailElement.textContent = `Enter Code to Arm ${mode === 'arm_home' ? 'Home' : 'Away'}`;
        }
                
        return;
    }
    
    // Proceed with arming using the provided code
    armSystem(mode, code);
}

//==============================================================================
// SENSOR MANAGEMENT
//==============================================================================

/**
 * Fetches multiple entity states from Home Assistant and displays open sensors in status bar
 * 
 * @param {Array<string>} entityIds - Array of entity IDs to fetch
 * @returns {Promise<void>} - Resolves when entities are fetched and displayed
 */
async function getAndDisplayEntities(entityIds) {
    try {
        // Get the system status bar where we'll show the sensors
        const systemStatus = document.getElementById('system-status');
        
        // Create or get sensor container within the system status
        let container = document.getElementById('entities-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'entities-container';
            container.classList.add('status-sensors');
            
            // Add container to the system status bar
            systemStatus.appendChild(container);
            
            // Add some styling for the container
            const style = document.createElement('style');
            document.head.appendChild(style);
        } else {
            // Clear existing content
            container.innerHTML = '';
        }
        
        // Use our backend API to fetch entity states
        const response = await fetch('/api/sensors/getStates', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ entityIds: entityIds })
        });
        
        if (!response.ok) {
            throw new Error(`API call failed: ${response.statusText}`);
        }
        
        const results = await response.json();
        
        // Track if there are open sensors for the arm button warning
        let openSensorsPresent = false;
        
        // Process and display each entity
        if (results && results.entities) {
            // Only show triggered sensors
            const openSensors = results.entities.filter(entity => entity.state === 'on');
            openSensorsPresent = openSensors.length > 0;
            
            if (openSensors.length > 0) {
                // Sort sensors by type - doors first, then other types
                openSensors.sort((a, b) => {
                    const typeA = a.attributes.device_class || '';
                    const typeB = b.attributes.device_class || '';
                    
                    // Doors and windows first
                    if ((typeA === 'door' || typeA === 'window') && 
                        !(typeB === 'door' || typeB === 'window')) {
                        return -1;
                    }
                    if ((typeB === 'door' || typeB === 'window') && 
                        !(typeA === 'door' || typeA === 'window')) {
                        return 1;
                    }
                    
                    // Then sort by name
                    const nameA = a.attributes.friendly_name || a.entity_id;
                    const nameB = b.attributes.friendly_name || b.entity_id;
                    return nameA.localeCompare(nameB);
                });
                
                // Add count badge for multiple sensors
                if (openSensors.length > 1) {
                    const countBadge = document.createElement('div');
                    countBadge.classList.add('sensor-badge');
                    countBadge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>${openSensors.length} Open`;
                    container.appendChild(countBadge);
                }
                
                // Apply scrolling if many sensors
                if (openSensors.length > 3) {
                    container.classList.add('many-sensors');
                } else {
                    container.classList.remove('many-sensors');
                }
                
                // Add each sensor badge
                openSensors.forEach(entity => {
                    const badge = document.createElement('div');
                    badge.classList.add('sensor-badge', 'open');
                    
                    // Get friendly name or fallback to entity ID
                    const name = entity.attributes.friendly_name || 
                        entity.entity_id.split('.').pop().replace(/_/g, ' ');
                    
                    // Determine icon based on entity type
                    let iconClass = 'fa-solid fa-sensor';
                    
                    if (entity.entity_id.startsWith('binary_sensor.')) {
                        if (entity.attributes.device_class === 'door' || 
                            entity.attributes.device_class === 'window') {
                            iconClass = 'fa-solid fa-door-open';
                        } else if (entity.attributes.device_class === 'motion') {
                            iconClass = 'fa-solid fa-person-running';
                        } else if (entity.attributes.device_class === 'smoke') {
                            iconClass = 'fa-solid fa-smoke';
                        } else if (entity.attributes.device_class === 'moisture') {
                            iconClass = 'fa-solid fa-droplet';
                        } else {
                            iconClass = 'fa-solid fa-triangle-exclamation';
                        }
                    }
                    
                    badge.innerHTML = `<i class="${iconClass}"></i>${name}`;
                    container.appendChild(badge);
                });
                
                // Make container visible
                container.style.display = 'flex';
            } else {
                // If no open sensors, don't show anything to keep UI clean
                container.style.display = 'none';
            }
            
            // Update arm buttons with warning if open sensors
            updateArmButtonsForOpenSensors(openSensorsPresent);
            
            // Set up auto-refresh
            startSensorAutoRefresh(entityIds);
            
        } else {
            throw new Error("Invalid response format from API");
        }
        
    } catch (error) {
        console.error('Error fetching entity states:', error);
        
        const container = document.getElementById('entities-container');
        if (container) {
            container.innerHTML = `
                <div class="sensor-badge">
                    <i class="fas fa-exclamation-triangle"></i> Sensor Error
                </div>
            `;
            container.style.display = 'flex';
        }
    }
}

/**
 * Starts auto-refresh for sensors
 * Sets up periodic polling of sensor states
 * 
 * @param {Array<string>} entityIds - Array of entity IDs to refresh
 */
function startSensorAutoRefresh(entityIds) {
    // Clear any existing timer
    if (sensorRefreshTimer) {
        clearInterval(sensorRefreshTimer);
    }
    
    // Refresh every 30 seconds
    sensorRefreshTimer = setInterval(() => {
        console.log('Auto-refreshing sensors...');
        getAndDisplayEntities(entityIds);
    }, 30000); // 30 seconds
}

/**
 * Fetches sensor configuration from server and displays them
 */
function loadAndDisplaySensors() {
    // Fetch the sensor list from the server
    fetch('/api/config/sensors')
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to load sensor configuration');
            }
            return response.json();
        })
        .then(config => {
            if (config && config.sensors && Array.isArray(config.sensors)) {
                console.log('Loaded sensor configuration:', config.sensors);
                getAndDisplayEntities(config.sensors);
            } else {
                throw new Error('Invalid sensor configuration format');
            }
        })
        .catch(error => {
            console.error('Error loading sensors:', error);
            showNotification('Failed to load sensor configuration', 'error');
        });
}

//==============================================================================
// INITIALIZATION AND EVENT LISTENERS
//==============================================================================

/**
 * Initialize all event listeners when the DOM is fully loaded
 */
document.addEventListener('DOMContentLoaded', () => {
    // Preload sounds to prevent delay on first interaction
    try {
        keypadSound.load();
        actionSound.load();
        errorSound.load();
        armedSound.load();
        disarmedSound.load();
        triggeredSound.load();
    } catch (e) {
        console.warn('Sound preloading not supported:', e);
    }
    
    // iOS specific: Resume audio context on visibility change (app comes to foreground)
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') {
            if (audioContext && audioContext.state === 'suspended') {
                console.log('Resuming audio context after visibility change');
                audioContext.resume().then(() => {
                    console.log('Audio context successfully resumed');
                });
            }
        }
    });
    
    // iOS specific: Resume audio context on any user interaction
    document.addEventListener('touchstart', function() {
        if (audioContext && audioContext.state === 'suspended') {
            console.log('Resuming audio context after user interaction');
            audioContext.resume();
        }
    }, true);
    
    // Periodically check and try to resume audio context
    setInterval(() => {
        if (audioContext && audioContext.state === 'suspended') {
            console.log('Attempting to resume suspended audio context');
            audioContext.resume();
        }
    }, 30000); // Check every 30 seconds

    // Add custom styling to arm buttons but preserve their content
    const armHomeBtn = document.getElementById('arm-home');
    const armAwayBtn = document.getElementById('arm-away');
    
    if (armHomeBtn) {
        armHomeBtn.classList.add('large-button');
    }
    
    if (armAwayBtn) {
        armAwayBtn.classList.add('large-button');
    }
    
    // Event listeners for keypad - Optimized for fast touch response
    document.querySelectorAll('.key').forEach(button => {
        // Use touchstart for immediate response on Android
        button.addEventListener('touchstart', function(e) {
            e.preventDefault(); // Prevent mouse events
            this.classList.add('active');
            
            // Immediate key processing for faster response
            const key = this.dataset.key;
            handleKeyPress(key);
        }, { passive: false });
        
        // Clean up active state on touchend
        button.addEventListener('touchend', function(e) {
            e.preventDefault();
            this.classList.remove('active');
        }, { passive: false });
        
        // Keep click handler as fallback for non-touch devices
        button.addEventListener('click', function(e) {
            // Only process if no touch events fired
            if (e.detail === 0) return; // Skip if triggered by touch
            const key = this.dataset.key;
            handleKeyPress(key);
        });
        
        // Prevent context menu on long press
        button.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });
    });
    
/**
 * Handles arm button press logic (shared between touch and click events)
 * @param {string} mode - 'arm_home' or 'arm_away'
 */
function handleArmButtonPress(mode) {
    console.log(`${mode} button pressed`);
    
    // Process arm request
    const openSensorsContainer = document.getElementById('entities-container');
    const hasOpenSensors = openSensorsContainer && 
                        openSensorsContainer.style.display !== 'none' && 
                        openSensorsContainer.children.length > 0;
                        
    if (hasOpenSensors && !armButtonPressed[mode]) {
        requestArmWithMode(mode, currentCode.length >= 4 ? currentCode : null);
    } else {
        if (currentCode && pinLength >= 4) {
            const codeToUse = currentCode;
            currentCode = '';
            pinLength = 0;
            updatePinDisplay();
            requestArmWithMode(mode, codeToUse);
        } else {
            requestArmWithMode(mode);
        }
    }
}

    // Action button event listeners - Optimized for Android touch response
    if (armHomeBtn) {
        // Use touchstart for immediate response on touch devices
        armHomeBtn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            this.classList.add('active');
            handleArmButtonPress('arm_home');
        }, { passive: false });
        
        // Clean up on touch end
        armHomeBtn.addEventListener('touchend', function(e) {
            e.preventDefault();
            this.classList.remove('active');
        }, { passive: false });
        
        // Click fallback for non-touch devices or when touch fails
        armHomeBtn.addEventListener('click', function(e) {
            // Only process if not triggered by touch event
            if (e.detail !== 0) {
                handleArmButtonPress('arm_home');
            }
        });
        
        // Prevent context menu
        armHomeBtn.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });
    }

    if (armAwayBtn) {
        // Use touchstart for immediate response on touch devices
        armAwayBtn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            this.classList.add('active');
            handleArmButtonPress('arm_away');
        }, { passive: false });
        
        // Clean up on touch end
        armAwayBtn.addEventListener('touchend', function(e) {
            e.preventDefault();
            this.classList.remove('active');
        }, { passive: false });
        
        // Click fallback for non-touch devices or when touch fails
        armAwayBtn.addEventListener('click', function(e) {
            // Only process if not triggered by touch event
            if (e.detail !== 0) {
                handleArmButtonPress('arm_away');
            }
        });
        
        // Prevent context menu
        armAwayBtn.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });
    }
    
    // Remove or hide the disarm button since we're using enter for disarm
    const disarmBtn = document.getElementById('disarm'); 
    if (disarmBtn) {
        disarmBtn.style.display = 'none'; // Hide it instead of removing to preserve layout
    }
    
    // Initial state update
    updateArmButtonsState('disarmed');
    
    // Load sensors from config instead of hardcoding
    loadAndDisplaySensors();

    // Debugging: log out a message to confirm initialization completed
    console.log('Event listeners initialized');
});