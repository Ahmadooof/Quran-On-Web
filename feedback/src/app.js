const path = require('path');
const express = require('express');
const { parseReport, Invalid, KINDS, SEVERITIES, SOURCES } = require('./validate');

const HOUR = 3600;
const DAY = 86400;
const MOST_AT_ONCE = 500;   // more than the page ever shows

/** The HTTP routes, given a store and settings, so tests can run it against a throwaway database. */
function createApp(store, { limits, maxBody, shown, dev = false, now = () => Math.floor(Date.now() / 1000) }) {
    const app = express();
    app.disable('x-powered-by');

    // nginx passes the visitor's address after restoring it from Cloudflare
    const clientIp = (req) => String(req.get('X-Real-IP') || req.socket.remoteAddress || '').slice(0, 45);

    app.post('/api/feedback', express.json({ limit: maxBody, strict: true }), (req, res) => {
        let report;
        try {
            report = parseReport(req.body);
        } catch (err) {
            if (err instanceof Invalid) return res.status(400).json({ error: 'invalid' });
            throw err;
        }

        const ip = clientIp(req);
        const at = now();
        if (store.countFrom(ip, at - HOUR) >= limits.perHour
            || store.countFrom(ip, at - DAY) >= limits.perDay
            || store.countAll(at - DAY) >= limits.allPerDay) {
            return res.status(429).json({ error: 'too_many' });
        }

        store.add(report, ip, at);
        res.status(201).json({ ok: true });
    });

    // Reached only through nginx, behind the password; the service itself listens on localhost
    const reports = (req, res) => {
        const source = SOURCES.includes(req.query.source) ? req.query.source : null;
        const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
        const severity = SEVERITIES.includes(req.query.severity) ? req.query.severity : null;
        res.set('Cache-Control', 'no-store');
        res.json({
            counts: store.counts(),
            sources: store.sourceCounts(),
            reports: store.list({ source, kind, severity, limit: shown }),
        });
    };
    app.get('/admin/reports', reports);

    // Deleting one. The page asks first; this does not ask twice.
    const remove = (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid' });
        res.set('Cache-Control', 'no-store');
        if (!store.remove(id)) return res.status(404).json({ error: 'not_found' });
        res.json({ ok: true });
    };
    app.delete('/admin/reports/:id', remove);

    /* Several at once. One request rather than one per report: the page is rate
       limited, and clearing a screenful would otherwise answer 429 halfway. */
    const removeMany = (req, res) => {
        const ids = req.body && req.body.ids;
        if (!Array.isArray(ids) || !ids.length || ids.length > MOST_AT_ONCE
            || !ids.every((id) => Number.isInteger(id) && id > 0)) {
            return res.status(400).json({ error: 'invalid' });
        }
        res.set('Cache-Control', 'no-store');
        res.json({ ok: true, deleted: store.removeMany(ids) });
    };
    app.delete('/admin/reports', express.json({ limit: '64kb', strict: true }), removeMany);

    // Locally there is no nginx, so serve the page at the same addresses it has in production
    if (dev) {
        app.get('/feedback/api/reports', reports);
        app.delete('/feedback/api/reports/:id', remove);
        app.delete('/feedback/api/reports', express.json({ limit: '64kb', strict: true }), removeMany);
        app.use('/feedback/reports', express.static(path.join(__dirname, '..', 'admin')));
    }

    app.use((req, res) => res.status(404).json({ error: 'not_found' }));

    // Body parser failures carry a status (413 too large, 400 bad JSON, 415 wrong type)
    app.use((err, req, res, next) => {
        const status = err.status && err.status < 500 ? err.status : 500;
        if (status === 500) console.error(err);
        res.status(status).json({ error: status === 500 ? 'server' : 'invalid' });
    });

    return app;
}

module.exports = { createApp };
