const fs = require('fs');
const path = require('path');

// systemd's StateDirectory gives the data folder; locally it sits beside the service
const SERVER_DATA = '/var/lib/readquran-feedback';
const dataDir = process.env.STATE_DIRECTORY
    || (fs.existsSync(SERVER_DATA) ? SERVER_DATA : path.join(__dirname, '..', 'data'));

module.exports = {
    host: process.env.FEEDBACK_HOST || '127.0.0.1',
    port: Number(process.env.FEEDBACK_PORT || 8787),
    dbPath: process.env.FEEDBACK_DB || path.join(dataDir, 'feedback.db'),

    maxBody: '8kb',
    limits: {
        perHour: 5,
        perDay: 20,
        allPerDay: 500,
    },
    shown: 300,
    dev: process.argv.includes('--dev') || process.env.FEEDBACK_DEV === '1',
};
