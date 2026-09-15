const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openStore } = require('../src/store');
const { createApp } = require('../src/app');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
const store = openStore(path.join(dir, 'test.db'));
const app = createApp(store, {
    limits: { perHour: 5, perDay: 20, allPerDay: 500 },
    maxBody: '8kb',
    shown: 300,
});

let server;
let base;

before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// Reports from the app unless a test says otherwise
const post = (body, ip = '10.0.0.1', type = 'application/json') => fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-Real-IP': ip },
    body: typeof body === 'string' || Array.isArray(body) ? JSON.stringify(body)
        : JSON.stringify({ source: 'android', ...body }),
});

test('accepts a problem with severity and app details', async () => {
    const res = await post({
        kind: 'bug',
        severity: 'high',
        message: 'Audio stops on page 5',
        email: 'reader@example.com',
        app: {
            version: '0.1', android: '16', sdk: 36, device: 'samsung SM-S947B', language: 'ar', page: 5,
            theme: 'system', themeShown: 'dark', motion: 'turn', reciter: 'Maher Al-Muaiqly', screen: 'portrait 412x915',
        },
    });
    assert.equal(res.status, 201);
});

test('accepts a report from the website', async () => {
    const res = await post({
        source: 'web',
        kind: 'bug',
        message: 'Two-page view overlaps on a narrow window',
        app: { language: 'en', page: 12, theme: 'light', themeShown: 'light', screen: 'landscape 1280x720', browser: 'Chrome 138 on Windows' },
    });
    assert.equal(res.status, 201);
});

test('accepts a suggestion with nothing optional, and Arabic text', async () => {
    const res = await post({ kind: 'suggestion', message: 'أضيفوا مؤقت نوم للتلاوة' });
    assert.equal(res.status, 201);
});

test('rejects bad reports', async () => {
    const cases = [
        { kind: 'suggestion', severity: 'low', message: 'severity only for problems' },
        { kind: 'spam', message: 'unknown kind here' },
        { kind: 'bug', message: 'hi' },
        { kind: 'bug', message: 'bad email here', email: 'nope' },
        { kind: 'bug', message: 'page out of range', app: { page: 9999 } },
        { kind: 'bug', message: 'sdk not a number', app: { sdk: '36' } },
        ['not', 'an', 'object'],
        { source: 'ios', kind: 'bug', message: 'unknown source here' },
        { source: null, kind: 'bug', message: 'missing source here' },
        { kind: 'bug', message: 'unknown theme here', app: { theme: 'blue' } },
        { kind: 'bug', message: 'unknown motion here', app: { motion: 'spin' } },
    ];
    for (const body of cases) {
        const res = await post(body);
        assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await fetch(`${base}/api/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
    })).status, 400);
});

test('rejects the wrong content type and oversized bodies', async () => {
    assert.equal((await fetch(`${base}/api/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"source":"web","kind":"bug","message":"hello"}',
    })).status, 400);
    const big = { kind: 'bug', message: 'a'.repeat(9000) };
    assert.equal((await post(big)).status, 413);
});

test('limits reports per address', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++) {
        statuses.push((await post({ kind: 'other', message: 'burst test' }, '10.9.9.9')).status);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429]);
});

test('lists reports newest first, filtered, without addresses', async () => {
    const all = await (await fetch(`${base}/admin/reports`)).json();
    assert.ok(all.reports.length >= 3);
    assert.equal(all.counts.bug, 2);
    assert.ok(all.reports.every((r) => !('ip' in r)));
    assert.ok(all.reports[0].at >= all.reports[all.reports.length - 1].at);

    const high = await (await fetch(`${base}/admin/reports?kind=bug&severity=high`)).json();
    assert.equal(high.reports.length, 1);
    assert.equal(high.reports[0].message, 'Audio stops on page 5');

    const junk = await fetch(`${base}/admin/reports?kind=';drop table reports`);
    assert.equal(junk.status, 200);
});

test('filters by source and returns the new details', async () => {
    const web = await (await fetch(`${base}/admin/reports?source=web`)).json();
    assert.equal(web.reports.length, 1);
    assert.equal(web.reports[0].browser, 'Chrome 138 on Windows');
    assert.equal(web.sources.web, 1);
    assert.ok(web.sources.android >= 3);

    const android = await (await fetch(`${base}/admin/reports?source=android&kind=bug`)).json();
    assert.equal(android.reports.length, 1);
    assert.equal(android.reports[0].motion, 'turn');
    assert.equal(android.reports[0].themeShown, 'dark');
});

test('adds the new columns to a database from the first release', () => {
    const Database = require('better-sqlite3');
    const oldPath = path.join(dir, 'old.db');
    const old = new Database(oldPath);
    old.exec(`CREATE TABLE reports (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, ip TEXT NOT NULL, kind TEXT NOT NULL,
        severity TEXT, message TEXT NOT NULL, email TEXT, app_version TEXT, android TEXT, sdk INTEGER, device TEXT,
        language TEXT, page INTEGER)`);
    old.prepare("INSERT INTO reports (at, ip, kind, message) VALUES (1, '1.2.3.4', 'bug', 'from before')").run();
    old.close();

    const upgraded = openStore(oldPath);
    const [row] = upgraded.list({ source: 'android', limit: 10 });
    assert.equal(row.message, 'from before');
    assert.equal(row.source, 'android');
    assert.equal(row.browser, null);
    upgraded.close();
});

test('other paths are not found', async () => {
    assert.equal((await fetch(`${base}/whatever`)).status, 404);
});
