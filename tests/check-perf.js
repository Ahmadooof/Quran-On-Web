/**
 * Checks what the reader actually has to download and build.
 *
 * Starts the real server on a spare port, asks it for the same things a
 * browser would, and holds the answers to a budget. The budgets are set a
 * little above where things currently sit, so this fails when something
 * regresses rather than drifting quietly.
 *
 * Run with: npm run test:perf
 */

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const net  = require('net');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

/* What the reader is allowed to cost. */
const BUDGET = {
  bootTransferKB : 150,   // everything needed before the first page can be read
  pageFontKB     : 320,   // the heaviest single page font
  medianFontKB   : 200,   // a typical page font
  wordsPerPage   : 260,   // spans built for one page
};

const results = [];
let failed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => results.push({ ok: true, name, detail: detail || '' }))
    .catch((err) => { failed++; results.push({ ok: false, name, detail: err.message }); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function main() {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), NO_OPEN: '1' },
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${port}`;
  const ready = async () => {
    for (let i = 0; i < 60; i++) {
      try { await fetch(base + '/data/surahs.json'); return true; }
      catch (e) { await new Promise((r) => setTimeout(r, 100)); }
    }
    return false;
  };

  try {
    assert(await ready(), `server did not come up on port ${port}`);

    const get = (p, headers = {}) => fetch(base + p, { headers });

    await check('the boot payload fits its budget', async () => {
      let total = 0;
      const parts = [];
      for (const p of ['/data/surahs.json', '/data/mushaf.json']) {
        const res = await get(p, { 'Accept-Encoding': 'gzip' });
        assert(res.ok, `${p} returned ${res.status}`);
        const bytes = (await res.arrayBuffer()).byteLength;
        /* fetch decompresses for us, so the transferred size is measured
           by compressing the body the same way the server does. */
        const wire = zlib.gzipSync(Buffer.from(await (await get(p)).arrayBuffer())).length;
        total += wire;
        parts.push(`${path.basename(p)} ${Math.round(wire / 1024)}KB of ${Math.round(bytes / 1024)}KB`);
      }
      const kb = Math.round(total / 1024);
      assert(kb <= BUDGET.bootTransferKB,
        `boot payload is ${kb} KB, budget is ${BUDGET.bootTransferKB} KB`);
      return `${kb} KB over the wire — ${parts.join(', ')}`;
    });

    await check('only the two files the reader needs are served', async () => {
      const files = fs.readdirSync(path.join(ROOT, 'public', 'data'))
        .filter((f) => f.endsWith('.json')).sort();
      assert(files.join(',') === 'mushaf.json,surahs.json',
        `public/data holds ${files.join(', ')} — the reader reads only two files`);
      return files.join(', ');
    });

    await check('text responses are compressed, fonts are not', async () => {
      for (const p of ['/data/mushaf.json', '/css/style.css', '/js/app.js']) {
        const res = await get(p, { 'Accept-Encoding': 'gzip' });
        assert(res.headers.get('content-encoding') === 'gzip', `${p} came back uncompressed`);
      }
      const font = await get('/fonts/v2/p77.woff2', { 'Accept-Encoding': 'gzip' });
      assert(!font.headers.get('content-encoding'),
        'woff2 is being compressed again — it is already compressed');
      return 'JSON, CSS and JS gzipped; woff2 served as-is';
    });

    await check('page fonts are cached hard', async () => {
      const res = await get('/fonts/v2/p77.woff2');
      const cc = res.headers.get('cache-control') || '';
      assert(/immutable/.test(cc) && /max-age=\d{7,}/.test(cc),
        `page fonts carry "${cc}" — they never change and should be immutable`);
      return cc;
    });

    await check('credentials are not served', async () => {
      const res = await get('/data/.env');
      assert(res.status === 404, `/data/.env returned ${res.status}`);
      return '/data/.env returns 404';
    });

  } finally {
    server.kill();
  }

  /* ---- what the browser then has to build, measured from the data ---- */

  const mushaf = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'mushaf.json'), 'utf8'));
  const surahs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'surahs.json'), 'utf8'));

  await check('no single page builds more spans than budgeted', async () => {
    let worst = { page: 0, words: 0 };
    for (let p = 1; p <= 604; p++) {
      const n = mushaf.pages[p].reduce(
        (m, l) => m + (l.t === 'ayah' ? l.v2.split('|').length : 0), 0);
      if (n > worst.words) worst = { page: p, words: n };
    }
    assert(worst.words <= BUDGET.wordsPerPage,
      `page ${worst.page} builds ${worst.words} spans, budget is ${BUDGET.wordsPerPage}`);
    return `heaviest page is ${worst.page} at ${worst.words} spans`;
  });

  await check('opening the longest surah stays cheap', async () => {
    /* Pages are built as they come into reach, so opening a surah costs its
       page shells plus the lines of the page being read — not every page. */
    const longest = surahs.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    const pages = longest.to - longest.from + 1;
    const allWords = Array.from({ length: pages }, (_, i) => longest.from + i)
      .reduce((n, p) => n + mushaf.pages[p].reduce(
        (m, l) => m + (l.t === 'ayah' ? l.v2.split('|').length : 0), 0), 0);
    const firstPage = mushaf.pages[longest.from].reduce(
      (m, l) => m + (l.t === 'ayah' ? l.v2.split('|').length : 0), 0);
    assert(firstPage <= BUDGET.wordsPerPage,
      `first page of surah ${longest.id} builds ${firstPage} spans`);
    return `surah ${longest.id} spans ${pages} pages and ${allWords} words; ` +
           `opening it builds ${pages} shells and ${firstPage} spans`;
  });

  await check('page fonts fit their budget', async () => {
    for (const ver of ['v1', 'v2']) {
      const sizes = [];
      for (let p = 1; p <= 604; p++) {
        sizes.push(fs.statSync(path.join(ROOT, 'public', 'fonts', ver, `p${p}.woff2`)).size);
      }
      sizes.sort((a, b) => a - b);
      const max = Math.round(sizes[sizes.length - 1] / 1024);
      const mid = Math.round(sizes[Math.floor(sizes.length / 2)] / 1024);
      if (ver === 'v2') {
        assert(max <= BUDGET.pageFontKB, `heaviest V2 page font is ${max} KB`);
        assert(mid <= BUDGET.medianFontKB, `median V2 page font is ${mid} KB`);
      }
      results.push({ ok: true, name: `  ${ver} page fonts`, detail: `median ${mid} KB, heaviest ${max} KB` });
    }
    return 'one page is fetched at a time, so this is the cost of turning a page';
  });

  console.log('\nSpeed\n');
  for (const r of results) {
    if (r.name.startsWith('  ')) { console.log(`        ${r.name.trim()}: ${r.detail}`); continue; }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (r.detail) console.log(`        ${r.detail}`);
  }
  const real = results.filter((r) => !r.name.startsWith('  '));
  console.log(`\n${real.length - failed}/${real.length} checks passed.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('\nERROR:', err.message); process.exit(1); });
