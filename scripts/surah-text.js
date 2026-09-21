/**
 * A plain page of each surah's words.
 *
 * The mushaf is drawn from glyph codes, one font per page, so a reader's page
 * carries no readable text at all: every surah page on the site is the same
 * navigation with a different heading, which is nothing for a search engine to
 * tell apart and nothing for anyone to copy from. These pages are the words
 * themselves — the same Tanzil text the search reads — one page a surah, in
 * ordinary HTML that can be read, searched, copied and printed.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Arabic figures, as the rest of the site sets them. */
const ar = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);

/** surah -> [verse text, ...], from the file the search already ships. */
function verses() {
  const file = path.join(PUBLIC, 'data', 'quran-simple.txt');
  const out = {};
  fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
    if (!line || line[0] === '#') return;
    const a = line.indexOf('|');
    const b = line.indexOf('|', a + 1);
    if (a <= 0 || b <= a) return;
    const s = +line.slice(0, a);
    const text = line.slice(b + 1).trim();
    if (!s || !text) return;
    (out[s] = out[s] || []).push(text);
  });
  return out;
}

function page(s, lines, site) {
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

  <ol class="verses">
${lines.map((t, i) => `    <li id="v${i + 1}"><span class="n">${ar(i + 1)}</span>${esc(t)}</li>`).join('\n')}
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
  const all = verses();
  const urls = [];

  surahs.forEach((s) => {
    const lines = all[s.id];
    if (!lines || !lines.length) return;
    const dir = path.join(PUBLIC, 'surah', String(s.id), 'text');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), page(s, lines, site));
    urls.push(`${site}/surah/${s.id}/text/`);
  });

  return urls;
}

module.exports = { build };
