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

    // Columns added after the first release; existing rows keep them empty
    const have = new Set(db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name));
    for (const [name, type] of [
        ['source', 'TEXT'], ['theme', 'TEXT'], ['theme_shown', 'TEXT'], ['motion', 'TEXT'],
        ['reciter', 'TEXT'], ['screen', 'TEXT'], ['browser', 'TEXT'],
    ]) {
        if (!have.has(name)) db.exec(`ALTER TABLE reports ADD COLUMN ${name} ${type}`);
    }

    const insert = db.prepare(`
        INSERT INTO reports (at, ip, source, kind, severity, message, email, app_version, android, sdk, device, language, page,
                             theme, theme_shown, motion, reciter, screen, browser)
        VALUES (@at, @ip, @source, @kind, @severity, @message, @email, @appVersion, @android, @sdk, @device, @language, @page,
                @theme, @themeShown, @motion, @reciter, @screen, @browser)
    `);
    const byIpSince = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE ip = ? AND at > ?');
    const allSince = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE at > ?');
    const counts = db.prepare('SELECT kind, COUNT(*) AS n FROM reports GROUP BY kind');
    const sourceCounts = db.prepare("SELECT COALESCE(source, 'android') AS source, COUNT(*) AS n FROM reports GROUP BY 1");

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

        /** Newest first, optionally narrowed by source, kind and severity; the ip is never returned. */
        list({ source = null, kind = null, severity = null, limit }) {
            const where = [];
            const args = [];
            // Reports from before the source was recorded all came from the app
            if (source) { where.push("COALESCE(source, 'android') = ?"); args.push(source); }
            if (kind) { where.push('kind = ?'); args.push(kind); }
            if (severity) { where.push('severity = ?'); args.push(severity); }
            const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
            return db.prepare(`
                SELECT id, at, COALESCE(source, 'android') AS source, kind, severity, message, email,
                       app_version AS appVersion, android, sdk, device, language, page,
                       theme, theme_shown AS themeShown, motion, reciter, screen, browser
                FROM reports ${clause} ORDER BY at DESC LIMIT ?
            `).all(...args, limit);
        },

        counts() {
            return Object.fromEntries(counts.all().map((r) => [r.kind, r.n]));
        },

        sourceCounts() {
            return Object.fromEntries(sourceCounts.all().map((r) => [r.source, r.n]));
        },

        close() {
            db.close();
        },
    };
}

module.exports = { openStore };
