require('dotenv').config();

const config = {
    homeAssistant: {
        apiUrl: process.env.API_URL || 'http://localhost:8123/api',
        apiKey: process.env.LONG_LIVED_ACCESS_TOKEN || 'your_default_token'
    },
    server: {
        port: process.env.PORT || 3000
    },
    mqtt: {
        broker: process.env.MQTT_BROKER || 'mqtt://homeassistant.local',
        username: process.env.MQTT_USER || 'your_mqtt_username',
        password: process.env.MQTT_PASSWORD || 'your_mqtt_password',
        clientId: process.env.MQTT_CLIENT_ID || 'alarm_panel_' + Math.random().toString(16).substring(2, 8)
    },
    alarm: {
        entityId: process.env.ALARM_ENTITY_ID || 'alarm_control_panel.alarmo',
        bypassSensorsTimeout: 10000
    },
    sensors: {
        list: JSON.parse(process.env.SENSOR_LIST ?? '[]'),
        refreshInterval: 5000
    }
};

module.exports = config;