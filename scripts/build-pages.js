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
 *   public/juz/<n>/index.html      30 pages, each opening at its juz
 *   public/data/words/p<n>.json    the words behind each page's glyphs
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

/* Where this copy of the site lives. One file, so a move to another domain is
   an edit and a rebuild rather than a hunt through the markup. */
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.json'), 'utf8'));
const SITE = config.site.replace(/\/$/, '');
const AUDIO = (config.audio || '').replace(/\/$/, '');

const EOL = String.fromCharCode(10);

const rec = require('./recitations');
const surahText = require('./surah-text');
const pageWords = require('./page-words');
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

  /* The same two glyphs app.js writes, so the list does not restyle itself
     the moment the script runs. The codes are mushaf.js's surahGlyph(). */
  const surahWord = String.fromCharCode(0xE000);
  const surahGlyph = (n) =>
    String.fromCharCode(0xE000 + parseInt(String(n).padStart(3, '0'), 16));

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
          `<span class="surah-name-ar" role="img" aria-label="${esc(s.full)}">` +
            `<span class="sw">${surahWord}</span>` +
            `<span class="sn">${surahGlyph(s.id)}</span></span>` +
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
  const rec = recitationOf(s);
  // Worded as searchers type it: the bare name ranked on page one and drew no clicks
  const title = `${titleAr} مكتوبة ${rec ? 'مع التلاوة' : 'من مصحف المدينة'} · Surah ${s.en} | القرآن الكريم`;

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

  return headFor(shell, title, desc, url)
    /* Start the first page's font during html parse instead of after the
       scripts have run and worked out which one to ask for. These are ~125 KB
       each and the whole page stays blank until one lands, so the second saved
       here is the second the reader spends looking at nothing.
       s.from is always among the first pages drawn: one page mode opens on it,
       and a spread that starts a page earlier still shows it alongside. */
    .replace('</head>', preloadFont(s.from))
    /* The surah's name is what this page is about, so it is the h1 and the
       only one. The site's own name is still there and still looks the same;
       it is simply no longer claiming to be the heading of a page about
       something more particular than itself. */
    .replace(/<h1 id="brand-title">([\s\S]*?)<\/h1>/,
      '<p class="brand-title">$1</p>')
    .replace('</body>', wordsOf(s) + '</body>')
    /* and the schema says which chapter, rather than repeating the site. */
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/,
      schemaScript(schemaFor(shell, s)));
}

/* Built once: every surah page reads from it */
const SPELLINGS = surahText.spellings(surahs);

/* The glyphs the reader draws, as words: Uthmani as printed, and the spelling people type */
function wordsOf(s) {
  const t = SPELLINGS[s.id];
  const ar = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
  // Paragraphs in an article, since reading modes score <p> and pass over list items
  // The page's h1 lives here, so the loading screen shows only the site's name
  return `  <article class="sr-only" lang="ar" dir="rtl" aria-label="نص سورة ${esc(s.name)}">\n` +
    `    <h1>سورة ${esc(s.name)} · Surah ${esc(s.en)}</h1>\n` +
    `    <p>${esc(s.full)} — ${ayat(s.v)} · ${s.v} verses · ` +
    `الصفحات ${s.from}–${s.to} · pages ${s.from}–${s.to}</p>\n` +
    // Shown wherever this block is: reading modes, and screen readers
    `    <p><a href="/surah/${s.id}/text/">نص السورة كاملًا للقراءة والنسخ · the full text to read and copy</a></p>\n` +
    (t.basmala ? `    <p>${esc(t.basmala)}</p>\n` : '') +
    t.uthmani.map((u, i) =>
      `    <p>${esc(u)} ${ar(i + 1)}</p>\n`).join('') +
    '  </article>\n';
}

/** The head fields every generated page rewrites. */
function headFor(shell, title, desc, url) {
  return shell
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`);
}

/* Start the first page's font during html parse, not after the scripts pick it */
function preloadFont(page) {
  return `  <link rel="preload" as="font" type="font/woff2" crossorigin
` +
    `        href="/fonts/v2/p${page}.woff2" />
</head>`;
}

/* Stringified, not hand-written: one stray quote in an Arabic name would void the block */
function schemaScript(schema) {
  return [
    '<script type="application/ld+json">',
    JSON.stringify(schema, null, 2).split(EOL).map(l => '  ' + l).join(EOL),
    '  </script>',
  ].join(EOL);
}

// --- juz pages ---

const JUZ_ORDINALS = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع',
  'الثامن', 'التاسع', 'العاشر', 'الحادي عشر', 'الثاني عشر', 'الثالث عشر', 'الرابع عشر',
  'الخامس عشر', 'السادس عشر', 'السابع عشر', 'الثامن عشر', 'التاسع عشر', 'العشرون',
  'الحادي والعشرون', 'الثاني والعشرون', 'الثالث والعشرون', 'الرابع والعشرون',
  'الخامس والعشرون', 'السادس والعشرون', 'السابع والعشرون', 'الثامن والعشرون',
  'التاسع والعشرون', 'الثلاثون'];

// The last three are searched by their opening words, not their number
const JUZ_NAMES = { 28: 'جزء قد سمع', 29: 'جزء تبارك', 30: 'جزء عم' };

/** What each juz runs over, from where it and the next one start. */
function juzList() {
  const starts = JSON.parse(
    fs.readFileSync(path.join(PUBLIC, 'data', 'mushaf.json'), 'utf8')).juzPages;
  const on = (p) => surahs.filter((s) => s.from <= p && p <= s.to);
  return starts.map((from, i) => {
    const to = i + 1 < starts.length ? starts[i + 1] - 1 : 604;
    // A juz on a shared page opens with the surah that starts there (juz 26, Al-Ahqaf)
    const first = on(from).find((s) => s.from === from) || on(from)[0];
    return { id: i + 1, from, to, first, last: on(to).slice(-1)[0] };
  });
}

function juzPageFor(shell, j) {
  const nameAr = JUZ_NAMES[j.id] || `الجزء ${JUZ_ORDINALS[j.id - 1]} من القرآن`;
  const title = `${nameAr} مكتوب مع التلاوة · Juz ${j.id} | القرآن الكريم`;
  const one = j.first.id === j.last.id;
  const span = one ? `من سورة ${j.first.name}`
                   : `من سورة ${j.first.name} إلى سورة ${j.last.name}`;
  const spanEn = one ? `in Surah ${j.first.en}`
                     : `from Surah ${j.first.en} to Surah ${j.last.en}`;
  const desc = `اقرأ واستمع إلى ${nameAr}، ${span}، الصفحات ${j.from}–${j.to} من مصحف المدينة. ` +
    `Read and listen to Juz ${j.id} of the Quran, ${spanEn}, pages ${j.from}–${j.to} of the Madinah Mushaf.`;
  const url = `${SITE}/juz/${j.id}/`;

  return headFor(shell, title, desc, url)
    .replace('</head>', preloadFont(j.from))
    .replace(/<h1 id="brand-title">([\s\S]*?)<\/h1>/,
      '<p class="brand-title">$1</p>')
    .replace('</body>',
      `  <article class="sr-only" lang="ar" dir="rtl">\n` +
      `    <h1>${esc(nameAr)} · Juz ${j.id}</h1>\n` +
      `    <p>${esc(span)} · ${esc(spanEn)} · الصفحات ${j.from}–${j.to} · pages ${j.from}–${j.to}</p>\n` +
      '  </article>\n</body>')
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, schemaScript({
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      name: `${nameAr} · Juz ${j.id}`,
      url,
      position: j.id,
      inLanguage: 'ar',
      isPartOf: {
        '@type': 'Book',
        name: 'القرآن الكريم',
        alternateName: 'The Holy Quran',
        bookEdition: 'مصحف المدينة — Madinah Mushaf',
        numberOfPages: 604,
        url: `${SITE}/`,
      },
    }));
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

/* The Content-Security-Policy names the audio host twice, and a copy running on
   another domain with the wrong one there plays nothing. Same source as the
   pages; an empty audio host leaves it same-origin. */
function headers() {
  const f = path.join(ROOT, 'deploy', 'security-headers.conf');
  const was = fs.readFileSync(f, 'utf8');
  /* Only another origin is named. A path like /audio is already covered by
     'self', and is not a source expression a browser would accept anyway. */
  const other = /^https?:\/\//.test(AUDIO) ? AUDIO : '';
  const now = was
    .replace(/media-src 'self'[^;]*;/, `media-src 'self'${other ? ' ' + other : ''};`)
    .replace(/frame-src [^;]*;/, `frame-src ${other || "'self'"};`);
  if (now !== was) fs.writeFileSync(f, now);
  console.log('security-headers.conf  media-src names %s', other || "'self' only");
}

/* The head says where the site lives in four places. They are written here
   rather than typed, so site.json is the only place the domain appears. */
function named(html) {
  return html
    .replace(/(<meta name="quran-audio-base" content=")[^"]*(")/, `$1${AUDIO}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${SITE}/$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${SITE}/$2`)
    .replace(/("url": ")https?:\/\/[^"]*(")/, `$1${SITE}/$2`);
}

function main() {
  const indexPath = path.join(PUBLIC, 'index.html');
  let index = fs.readFileSync(indexPath, 'utf8');

  const open = index.indexOf(LIST_OPEN);
  if (open < 0) throw new Error('no <nav id="surah-list"> in index.html');
  const close = index.indexOf(LIST_CLOSE, open);

  index = index.slice(0, open + LIST_OPEN.length) + surahListHtml() + index.slice(close);
  index = named(index);
  fs.writeFileSync(indexPath, index);
  console.log('index.html    surah list filled in, %d surahs; head names %s', surahs.length, SITE);

  /* The surah pages are built from the index as it now stands, so they can
     never fall behind it. */
  const shell = index;
  surahs.forEach((s) => {
    const dir = path.join(PUBLIC, 'surah', String(s.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), pageFor(shell, s));
  });
  console.log('surah/*/      %d pages written', surahs.length);

  const juz = juzList();
  juz.forEach((j) => {
    const dir = path.join(PUBLIC, 'juz', String(j.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), juzPageFor(shell, j));
  });
  console.log('juz/*/        %d pages written', juz.length);

  const wordFiles = pageWords.build(surahs);
  console.log('data/words/   %d pages written', wordFiles.length);

  /* The words themselves, one page a surah: the reader's own pages are drawn
     from glyph codes and carry nothing a search engine can read. */
  const textUrls = surahText.build(surahs, SITE);
  console.log('surah/*/text/ %d pages written', textUrls.length);

  /* The privacy page is hand-written rather than generated, which is how it came
     to sit outside the sitemap: a page nothing lists is a page nothing finds. */
  const urls = [`${SITE}/`, `${SITE}/privacy/`]
    .concat(surahs.map((s) => `${SITE}/surah/${s.id}/`))
    .concat(juz.map((j) => `${SITE}/juz/${j.id}/`));
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
    /* The tools for whoever runs the site are not the site. They carry their
       own noindex; this keeps them out of a crawl as well. */
    'Disallow: /admin/\n' +
    '\n' +
    `Sitemap: ${SITE}/sitemap.xml\n`);
  console.log('robots.txt    sitemap declared');

  headers();
}

main();
