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

const EOL = String.fromCharCode(10);

const rec = require('./recitations');
const DEFAULT_RECITATION = rec.defaultId();

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

/* Where the recordings are served from, taken from index.html rather than
   written here as well. The reader gets that value at runtime, and the schema
   below has to name the same file the reader will actually play — two copies
   of one url is two things to change and one to forget. */
function audioBase(shell) {
  const m = /<meta\s+name="quran-audio-base"\s+content="([^"]*)"/i.exec(shell);
  const base = ((m && m[1]) || '/surah').trim().replace(/\/$/, '') || '/surah';
  return /^https?:/i.test(base) ? base : SITE + base;
}

/**
 * What a surah's recitation is, if one has been prepared for it.
 *
 * The default one, of however many are shipped. A page describes a single
 * recording to a crawler and a reader who has chosen another still hears their
 * own — the choice is made in the browser, long after this markup is written,
 * and there is no honest way for one static page to name every possibility.
 */
function recitationOf(s) {
  const file = rec.timingFile(s.id, DEFAULT_RECITATION);
  if (!fs.existsSync(file)) return null;
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { reciter: t.reciter, reciterAr: t.reciterAr,
           seconds: Math.round(t.duration),
           /* The path the timing file states, so the schema names the file the
              reader will really fetch. */
           audioPath: t.audioPath || (s.id + '/' + rec.stem(s.id) + '.mp3') };
}

/* Arabic counts its nouns by how many there are: one is the bare singular, two
   has a dual, three to ten take the plural, and eleven upwards goes back to the
   singular. "4 آية" is simply wrong where "4 آيات" is right, and a description
   is the one place on the page a reader sees prose rather than the mushaf. */
function ayat(n) {
  if (n === 1) return 'آية واحدة';
  if (n === 2) return 'آيتان';
  return n + (n <= 10 ? ' آيات' : ' آية');
}

/* Each half of the description names the reciter in its own script. A Latin
   name dropped into the Arabic sentence reads as a database field; the Arabic
   name in the English one would be no better. */
function reciterName(rec, arabic) {
  if (!rec) return null;
  const n = (arabic && rec.reciterAr) || rec.reciter;
  return n ? String(n).replace(/\s*\([^)]*\)\s*$/, '') : null;
}

/* Schema.org wants a duration as an ISO 8601 period, not a count of seconds. */
function iso8601(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60;
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (sec % 60) + 'S';
}

/** The one page, with its head rewritten to name a surah. */
function pageFor(shell, s) {
  const titleAr = `سورة ${s.name}`;
  const title = `${titleAr} · Surah ${s.en} | القرآن الكريم`;
  const rec = recitationOf(s);

  /* A page that can be listened to says so. "Listen" is half of what anyone
     searching for a surah by name is after, and the description was promising
     only the reading. */
  const whoAr = reciterName(rec, true);
  const whoEn = reciterName(rec, false);
  const desc = rec
    ? `اقرأ واستمع إلى ${titleAr} كاملة${whoAr ? ` بصوت ${whoAr}` : ''}، ${ayat(s.v)}، ` +
      `مع تظليل الكلمات أثناء التلاوة. Read and listen to Surah ${s.en} — ${s.v} verses` +
      `${whoEn ? `, recited by ${whoEn}` : ''}, each word highlighted as it is read.`
    : `اقرأ ${titleAr} من المصحف كاملة، ${ayat(s.v)}، الصفحات ${s.from}–${s.to} من مصحف المدينة. ` +
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
      `          <p class="seo-note">${esc(s.full)} — ${ayat(s.v)} · ${s.v} verses · ` +
      `الصفحات ${s.from}–${s.to} · pages ${s.from}–${s.to}</p>`)
    /* The surah's name is what this page is about, so it is the h1 and the
       only one. The site's own name is still there and still looks the same;
       it is simply no longer claiming to be the heading of a page about
       something more particular than itself. */
    .replace(/<h1 id="brand-title">([\s\S]*?)<\/h1>/,
      '<p class="brand-title">$1</p>')
    /* and the schema says which chapter, rather than repeating the site.
       Built as an object and stringified rather than written out by hand: the
       names and the reciter are Arabic text inside JSON inside HTML, and one
       stray quote in any of them would make the whole block unreadable to a
       crawler without anything on the page looking wrong. */
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/,
      [
        '<script type="application/ld+json">',
        JSON.stringify(schemaFor(shell, s), null, 2).split(EOL).map(l => '  ' + l).join(EOL),
        '  </script>',
      ].join(EOL));
}

/**
 * What this page is, for a crawler.
 *
 * The recitation is declared as media belonging to the chapter rather than as
 * the page's main subject: the page is the surah, and the recording is one way
 * of taking it in. contentUrl names the file the reader will really fetch,
 * wherever it is being served from — a schema pointing at a url that 404s is
 * worse than no schema.
 */
function schemaFor(shell, s) {
  const rec = recitationOf(s);
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Chapter',
    name: `سورة ${s.name} · Surah ${s.en}`,
    url: `${SITE}/surah/${s.id}/`,
    position: s.id,
    inLanguage: 'ar',
    isPartOf: {
      '@type': 'Book',
      name: 'القرآن الكريم',
      alternateName: 'The Holy Quran',
      bookEdition: 'مصحف المدينة — Madinah Mushaf',
      numberOfPages: 604,
      url: `${SITE}/`,
    },
  };

  if (rec) {
    schema.associatedMedia = {
      '@type': 'AudioObject',
      name: `تلاوة سورة ${s.name} · Surah ${s.en} recited`,
      contentUrl: `${audioBase(shell)}/${rec.audioPath}`,
      encodingFormat: 'audio/mpeg',
      duration: iso8601(rec.seconds),
      inLanguage: 'ar',
    };
    if (rec.reciter) {
      schema.associatedMedia.creator = { '@type': 'Person', name: rec.reciter };
    }
  }
  return schema;
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
