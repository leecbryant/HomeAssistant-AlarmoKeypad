const express = require('express');
const path = require('path');
const mqtt = require('mqtt');
const http = require('http');
const socketIo = require('socket.io');
const alarmRoutes = require('./api/alarm');
const sensorRoutes = require('./api/sensors');
const configRouter = require('./api/config');
const config = require('./config');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize MQTT client
const mqttClient = mqtt.connect(config.mqtt.broker, {
    username: config.mqtt.username,
    password: config.mqtt.password
});

// MQTT connection handling
mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker');
    
    // Subscribe to Alarmo state topic
    mqttClient.subscribe('alarmo/state');
    mqttClient.subscribe('alarmo/event');
});

mqttClient.on('error', (error) => {
    console.error('MQTT connection error:', error);
});

mqttClient.on('message', (topic, message) => {    
    // Process Alarmo state messages
    if (topic === 'alarmo/state' || topic.startsWith('alarmo/') && topic.endsWith('/state')) {
        const state = message.toString();
        // Store the state in app locals to share with routes
        app.locals.alarmState = state;
        
        // Emit this to WebSocket clients
        io.emit('alarmStateChanged', {
            topic: topic,
            state: state,
            timestamp: new Date().toISOString()
        });
    }
});

// WebSocket connection handling
io.on('connection', (socket) => {
    console.log('New client connected');
    
    // Send current alarm state to newly connected clients
    if (app.locals.alarmState) {
        socket.emit('alarmStateChanged', {
            topic: 'alarmo/state',
            state: app.locals.alarmState,
            timestamp: new Date().toISOString()
        });
    }
    
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Make MQTT client available to routes
app.locals.mqttClient = mqttClient;
app.locals.io = io; // Make WebSocket IO available to routes

// Routes
app.use('/api/alarm', alarmRoutes);
app.use('/api/sensors', sensorRoutes);
app.use('/api/config', configRouter);

// Start server
const PORT = config.server.port;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;