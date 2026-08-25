/**
 * Gives search engines something to find.
 *
 * The reader is one page of markup that draws the Quran with per-page fonts,
 * so a crawler sees no Arabic at all — the text is glyph codes in a private
 * use area, not words. Left alone the whole site is a single URL with nothing
 * on it to match a query against.
 *
 * This writes:
 *   public/surah/<id>/index.html   114 pages, each naming its own surah
 *   public/sitemap.xml             so they can be found without guessing
 *   public/robots.txt              pointing at the sitemap
 *   and fills the surah list inside public/index.html
 *
 * Every page is the whole app. A landing page that only described a surah and
 * linked onward would rank and then disappoint; this way the thing that was
 * searched for is the thing that opens.
 *
 *   npm run build:pages
 *
 * It is idempotent: run it twice and the second run changes nothing, which is
 * what lets CI check the committed files are current.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SITE = 'https://readqurantoday.com';

const surahs = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'surahs.json'), 'utf8'));

/* Markers rather than a separate template: index.html stays the one file to
   edit, and this fills a region of it. */
const LIST_OPEN = '<nav id="surah-list">';
const LIST_CLOSE = '</nav>';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;');

/* The same markup buildIndex() produces, so the list is real content for a
   crawler and is on screen before any script runs. app.js rebuilds it from the
   same data on load, which keeps this from drifting into a lie. */
function surahListHtml() {
  /* Which juz a surah opens in, from where it starts — the same derivation
     app.js does, off the same data, so the two cannot drift. */
  const starts = JSON.parse(
    fs.readFileSync(path.join(PUBLIC, 'data', 'mushaf.json'), 'utf8')).juzPages;
  const juzOfPage = (p) => {
    for (let j = starts.length - 1; j >= 0; j--) if (p >= starts[j]) return j + 1;
    return 1;
  };

  const groups = {};
  surahs.forEach((s) => {
    const j = juzOfPage(s.from);
    (groups[j] = groups[j] || []).push(s);
  });

  return Object.keys(groups).sort((a, b) => a - b).map((j) => {
    const items = groups[j].map((s) =>
      `<a class="surah-item" href="/surah/${s.id}/" data-id="${s.id}">` +
        `<span class="surah-num">${s.id}</span>` +
        '<span class="surah-names">' +
          `<span class="surah-name-ar">${esc(s.name)}</span>` +
          `<span class="surah-name-en">${esc(s.en)}</span>` +
        '</span>' +
        `<span class="surah-ayahs-count">${s.v}</span>` +
      '</a>').join('');

    return '<div class="juz-group">' +
      '<div class="juz-label">' +
        `<span class="lang-ar">الجزء ${j}</span>` +
        `<span class="lang-en">Juz ${j}</span>` +
      '</div>' +
      `<div class="juz-surahs">${items}</div>` +
    '</div>';
  }).join('');
}

/** The one page, with its head rewritten to name a surah. */
function pageFor(shell, s) {
  const titleAr = `سورة ${s.name}`;
  const title = `${titleAr} · Surah ${s.en} | القرآن الكريم`;
  const desc = `اقرأ ${titleAr} من المصحف كاملة، ${s.v} آية، الصفحات ${s.from}–${s.to} من مصحف المدينة. ` +
               `Read Surah ${s.en} in full — ${s.v} verses, pages ${s.from}–${s.to} of the Madinah Mushaf.`;
  const url = `${SITE}/surah/${s.id}/`;

  return shell
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    /* Start the first page's font during html parse instead of after the
       scripts have run and worked out which one to ask for. These are ~125 KB
       each and the whole page stays blank until one lands, so the second saved
       here is the second the reader spends looking at nothing.
       s.from is always among the first pages drawn: one page mode opens on it,
       and a spread that starts a page earlier still shows it alongside. */
    .replace('</head>',
      `  <link rel="preload" as="font" type="font/woff2" crossorigin
` +
      `        href="/fonts/v2/p${s.from}.woff2" />
</head>`)
    /* A heading and a sentence of real words. The mushaf itself is glyph
       codes, so without this the page has nothing a search engine can read. */
    .replace('<div class="welcome-card">',
      '<div class="welcome-card">\n' +
      `          <h1 class="seo-title">${esc(titleAr)} · Surah ${esc(s.en)}</h1>\n` +
      `          <p class="seo-note">${esc(s.full)} — ${s.v} آية · ${s.v} verses · ` +
      `الصفحات ${s.from}–${s.to} · pages ${s.from}–${s.to}</p>`);
}

function main() {
  const indexPath = path.join(PUBLIC, 'index.html');
  let index = fs.readFileSync(indexPath, 'utf8');

  const open = index.indexOf(LIST_OPEN);
  if (open < 0) throw new Error('no <nav id="surah-list"> in index.html');
  const close = index.indexOf(LIST_CLOSE, open);

  index = index.slice(0, open + LIST_OPEN.length) + surahListHtml() + index.slice(close);
  fs.writeFileSync(indexPath, index);
  console.log('index.html    surah list filled in, %d surahs', surahs.length);

  /* The surah pages are built from the index as it now stands, so they can
     never fall behind it. */
  const shell = index;
  surahs.forEach((s) => {
    const dir = path.join(PUBLIC, 'surah', String(s.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), pageFor(shell, s));
  });
  console.log('surah/*/      %d pages written', surahs.length);

  const urls = [`${SITE}/`].concat(surahs.map((s) => `${SITE}/surah/${s.id}/`));
  fs.writeFileSync(path.join(PUBLIC, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') +
    '\n</urlset>\n');
  console.log('sitemap.xml   %d urls', urls.length);

  /* Cloudflare serves a generated robots.txt when the origin has none. Ours
     replaces it, mainly to name the sitemap: the dashboard is kept out by its
     own X-Robots-Tag, not by asking politely here. */
  fs.writeFileSync(path.join(PUBLIC, 'robots.txt'),
    'User-agent: *\n' +
    'Allow: /\n' +
    '\n' +
    `Sitemap: ${SITE}/sitemap.xml\n`);
  console.log('robots.txt    sitemap declared');
}

main();
