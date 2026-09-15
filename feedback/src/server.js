const config = require('./config');
const { openStore } = require('./store');
const { createApp } = require('./app');

const store = openStore(config.dbPath);
const app = createApp(store, config);

const server = app.listen(config.port, config.host, () => {
    console.log(`feedback listening on ${config.host}:${config.port}, data in ${config.dbPath}`);
});

// Slow or stuck clients should not hold connections open
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;

function shutdown() {
    server.close(() => {
        store.close();
        process.exit(0);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
