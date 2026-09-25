/**
 * A plain page of each surah's words.
 *
 * The mushaf is drawn from glyph codes, one font per page, so a reader's page
 * carries no readable text at all: every surah page on the site is the same
 * navigation with a different heading, which is nothing for a search engine to
 * tell apart and nothing for anyone to copy from. These pages are the words
 * themselves — the pointed Uthmani text, not the stripped copy the search
 * reads — one page a surah, in ordinary HTML that can be read, searched,
 * copied and printed.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

/* The pointed Uthmani text, one verse a line. A build input rather than
   something the site serves: the reader never asks for it, and the pages it
   makes are what ships. */
const TEXT = path.join(ROOT, 'data', 'quran-uthmani.txt');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Arabic figures, as the rest of the site sets them. */
const ar = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);

/** surah -> [verse text, ...], pointed, in the order the file gives them.
 *
 * Not the search's copy: that one has its diacritics stripped, because search
 * folds them away anyway — and a page of the Quran without them reads as
 * carelessness. This file carries no surah numbers, so the verses are dealt
 * out by the counts in surahs.json; the total is checked first, because a
 * disagreement would put every surah after it off by one silently.
 */
function verses(surahs) {
  const lines = fs.readFileSync(TEXT, 'utf8').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l[0] !== '#');

  const want = surahs.reduce((n, s) => n + s.v, 0);
  if (lines.length !== want) {
    throw new Error(`${path.basename(TEXT)} holds ${lines.length} verses and `
      + `surahs.json expects ${want}`);
  }

  const out = {};
  let at = 0;
  surahs.forEach((s) => { out[s.id] = lines.slice(at, at + s.v); at += s.v; });
  return out;
}

/* The text file carries the basmala at the head of each surah's first verse,
   and it is a verse only in al-Fatihah. Printed as part of verse 1 anywhere
   else it is simply wrong, so it is lifted out and set above the verses, which
   is where the mushaf puts it. At-Tawbah has none and gets none.

   The words are taken from al-Fatihah's first verse rather than written here:
   a literal has to match the file's diacritic order exactly, and this text
   writes the shadda before the fatha where I would have typed it after. It
   looks identical and compares false. */
function opensWithBasmala(s, lines, basmala) {
  return s.id !== 1 && lines.length > 0 && lines[0].startsWith(basmala + ' ');
}

/** The verses as they should be read: verse 1 without the basmala on its front. */
function said(s, lines, basmala) {
  if (!opensWithBasmala(s, lines, basmala)) return lines;
  return [lines[0].slice(basmala.length).trim()].concat(lines.slice(1));
}

function page(s, lines, site, basmala) {
  const url = `${site}/surah/${s.id}/text/`;
  const title = `نص سورة ${s.name} · Surah ${s.en} text`;
  const desc = `نص سورة ${s.name} كاملًا، ${s.v} آية، مكتوبًا للقراءة والنسخ. `
    + `The full text of Surah ${s.en}, ${s.v} verses, written out to read and copy.`;

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Chapter',
    name: title,
    url,
    position: s.id,
    inLanguage: 'ar',
    isPartOf: {
      '@type': 'Book',
      name: 'القرآن الكريم',
      alternateName: 'The Holy Quran',
      url: `${site}/`,
    },
  };

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<!-- Readable for the crawler, but the mushaf page is the one to rank -->
<meta name="robots" content="noindex, follow" />
<link rel="canonical" href="${url}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${url}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<link rel="stylesheet" href="/css/fonts.css" />
<link rel="stylesheet" href="/css/text.css" />
<script type="application/ld+json">
${JSON.stringify(schema, null, 2)}
</script>
</head>
<body>
<main class="text-page">
  <nav class="crumbs">
    <a href="/">القرآن الكريم</a> ·
    <a href="/surah/${s.id}/">اقرأ سورة ${esc(s.name)} في المصحف</a>
  </nav>

  <h1>نص سورة ${esc(s.name)}<span class="en">Surah ${esc(s.en)} — full text</span></h1>

  <p class="meta">${esc(s.full)} — ${s.v} آية · ${s.v} verses · الصفحات ${s.from}–${s.to} · pages ${s.from}–${s.to}</p>
${opensWithBasmala(s, lines, basmala) ? `
  <p class="basmala">${esc(basmala)}</p>` : ''}
  <ol class="verses">
${said(s, lines, basmala).map((t, i) => `    <li id="v${i + 1}"><span class="n">${ar(i + 1)}</span>${esc(t)}</li>`).join('\n')}
  </ol>

  <p class="foot">
    <a href="/surah/${s.id}/">اقرأ هذه السورة بمصحف المدينة مع التلاوة</a><br />
    <a href="/surah/${s.id}/">Read this surah in the Madinah Mushaf, with recitation</a>
  </p>
</main>
</body>
</html>
`;
}

/** Writes the pages and returns their urls, for the sitemap. */
function build(surahs, site) {
  const all = verses(surahs);
  // al-Fatihah opens with it, so its first verse is the words themselves
  const basmala = all[1][0];
  const urls = [];

  surahs.forEach((s) => {
    const lines = all[s.id];
    if (!lines || !lines.length) return;
    const dir = path.join(PUBLIC, 'surah', String(s.id), 'text');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), page(s, lines, site, basmala));
    urls.push(`${site}/surah/${s.id}/text/`);
  });

  return urls;
}

module.exports = { build };
