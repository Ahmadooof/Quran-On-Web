/**
 * Offline reading.
 *
 * The mushaf is drawn with one font per page — 604 of them, 96 MB in all — so
 * a reader on a plane or a bad connection loses the page rather than the
 * words: the markup arrives and the glyphs do not. That is what this is for.
 *
 * Two caches, and the split between them is the whole design:
 *
 *   Things that never change — a page's font, the mushaf data — are answered
 *   from the cache first and only fetched when they are missing. Page 42's
 *   font will not be revised; there is nothing to check for.
 *
 *   Everything else — the HTML, the stylesheet, the scripts, a surah's timing
 *   file — goes to the network first and falls back to the cache only when the
 *   network is not there. This matters more than it looks. None of those files
 *   carry a hash in their name: style.css is style.css forever. Answer them
 *   from the cache first and a fixed stylesheet reaches nobody who has been
 *   here before — the exact bug that makes people distrust offline support,
 *   and one that is invisible to whoever shipped the fix.
 *
 * So: a style bug is still fixed the moment anyone online reloads, and the
 * hundred megabytes that are genuinely immutable are the part kept.
 *
 * Bumping VERSION retires both caches on the next activation, which is the
 * escape hatch if one of them is ever poisoned.
 */

const VERSION = 'v1';

/* The mushaf is 604 pages, and that is the whole of what may be asked for. */
const PAGES = 604;
const SHELL = 'quran-shell-' + VERSION;    /* network-first, cache as fallback */
const ASSETS = 'quran-assets-' + VERSION;  /* cache-first, never revalidated */

/* Enough to open the reader with no network at all. Deliberately small: the
   weight is in the fonts, and those arrive as pages are read or when the
   reader asks for them outright. */
const SHELL_FILES = [
  '/',
  '/index.html',
  '/css/style.css',
  '/css/fonts.css',
  '/css/recite.css',
  '/js/app.js',
  '/js/mushaf.js',
  '/js/recite.js',
  '/data/surahs.json',
  '/data/recitations.json',
];

/** Immutable by nature: a page font, and the mushaf's own text. */
function isImmutable(url) {
  return url.pathname.startsWith('/fonts/')
      || url.pathname === '/data/mushaf.json';
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      /* One miss must not fail the install — a shell file that 404s should
         cost that file, not offline support altogether. */
      .then((c) => Promise.allSettled(SHELL_FILES.map((f) => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  /* The recordings live on another host and are gigabytes. They are the
     browser's business, not ours — and range requests through a cache are a
     good way to break seeking. */
  if (url.origin !== self.location.origin) return;

  if (isImmutable(url)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(ASSETS).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit
        /* An unvisited page with nothing cached: answer with the reader
           itself, which knows how to draw any surah once its font is in. */
        || (req.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});

/**
 * Take a list of pages and put their fonts in the cache.
 *
 * Asked for by the reader — a surah's worth, or the whole mushaf — and
 * answered with progress as it goes, because 96 MB with no sign of movement is
 * indistinguishable from nothing happening. Files already held are counted and
 * skipped, so asking twice is cheap and a cancelled run resumes.
 */
async function cachePages(asked, port) {
  /* Only page numbers, and only real ones.
   *
   * Nothing outside this origin can send us a message, so this is not a hole
   * anybody can reach — but the url below is built by joining strings, and a
   * value that was not a page number would join into some other same-origin
   * path and put it in the cache under a name the reader would later trust.
   * A list is also a loop: without a ceiling, one bad message runs forever.
   * Neither is a risk worth carrying to save four lines. */
  const seen = new Set();
  const pages = [];
  for (const p of Array.isArray(asked) ? asked : []) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > PAGES || seen.has(n)) continue;
    seen.add(n);
    pages.push(n);
  }

  const cache = await caches.open(ASSETS);
  let done = 0, added = 0, failed = 0;

  for (const page of pages) {
    const url = '/fonts/v2/p' + page + '.woff2';
    try {
      if (await cache.match(url)) { done++; }
      else {
        const res = await fetch(url);
        if (res.ok) { await cache.put(url, res); added++; done++; }
        else failed++;
      }
    } catch (err) { failed++; }

    if (port && (done + failed) % 5 === 0) {
      port.postMessage({ type: 'progress', done: done + failed, total: pages.length });
    }
  }

  if (port) port.postMessage({ type: 'done', cached: done, added, failed, total: pages.length });
}

self.addEventListener('message', (e) => {
  const msg = e.data || {};
  const port = e.ports && e.ports[0];

  if (msg.type === 'cache-pages') {
    e.waitUntil(cachePages(msg.pages || [], port));
  } else if (msg.type === 'clear') {
    e.waitUntil(caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => port && port.postMessage({ type: 'cleared' })));
  } else if (msg.type === 'usage') {
    /* Page fonts only. The reader asks this to decide whether the mushaf is
       already complete, and counting the odd data file alongside them would
       make 604 arrive early. */
    e.waitUntil(caches.open(ASSETS)
      .then((c) => c.keys())
      .then((keys) => {
        const fonts = keys.filter((r) => new URL(r.url).pathname.startsWith('/fonts/v2/'));
        if (port) port.postMessage({ type: 'usage', fonts: fonts.length, files: keys.length });
      }));
  }
});
