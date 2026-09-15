const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/** Reports kept in one SQLite file. Synchronous by design: one small write per report. */
function openStore(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS reports (
            id          INTEGER PRIMARY KEY,
            at          INTEGER NOT NULL,
            ip          TEXT    NOT NULL,
            kind        TEXT    NOT NULL,
            severity    TEXT,
            message     TEXT    NOT NULL,
            email       TEXT,
            app_version TEXT,
            android     TEXT,
            sdk         INTEGER,
            device      TEXT,
            language    TEXT,
            page        INTEGER
        );
        CREATE INDEX IF NOT EXISTS reports_ip_at ON reports (ip, at);
        CREATE INDEX IF NOT EXISTS reports_at    ON reports (at);
    `);

    const insert = db.prepare(`
        INSERT INTO reports (at, ip, kind, severity, message, email, app_version, android, sdk, device, language, page)
        VALUES (@at, @ip, @kind, @severity, @message, @email, @appVersion, @android, @sdk, @device, @language, @page)
    `);
    const byIpSince = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE ip = ? AND at > ?');
    const allSince = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE at > ?');
    const counts = db.prepare('SELECT kind, COUNT(*) AS n FROM reports GROUP BY kind');

    return {
        add(report, ip, at) {
            return insert.run({ ...report, ip, at }).lastInsertRowid;
        },

        countFrom(ip, since) {
            return byIpSince.get(ip, since).n;
        },

        countAll(since) {
            return allSince.get(since).n;
        },

        /** Newest first, optionally narrowed by kind and severity; the ip is never returned. */
        list({ kind = null, severity = null, limit }) {
            const where = [];
            const args = [];
            if (kind) { where.push('kind = ?'); args.push(kind); }
            if (severity) { where.push('severity = ?'); args.push(severity); }
            const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
            return db.prepare(`
                SELECT id, at, kind, severity, message, email, app_version AS appVersion,
                       android, sdk, device, language, page
                FROM reports ${clause} ORDER BY at DESC LIMIT ?
            `).all(...args, limit);
        },

        counts() {
            return Object.fromEntries(counts.all().map((r) => [r.kind, r.n]));
        },

        close() {
            db.close();
        },
    };
}

module.exports = { openStore };
