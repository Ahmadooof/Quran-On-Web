/**
 * Builds public/data/mushaf.json — the line-by-line layout of the Madinah
 * Mushaf (604 pages) with the QCF V1 and V2 glyph codes for every word.
 *
 * The QCF page fonts encode one glyph per word, and a code only means anything
 * inside the font belonging to its own page, so the layout and the fonts have
 * to stay in step: page N's codes need public/fonts/v2/pN.woff2.
 *
 * Ornamental lines come out as { t: 'surah', s } and { t: 'basmalah' }. A
 * surah line carrying b:1 means its Basmalah has to be set inside the header
 * band, because the mushaf left only one line free above that surah.
 *
 * A line's words are joined by SEP rather than by a space, because a handful
 * of word codes contain a space of their own — a gap the typeface designs into
 * the middle of a word. Splitting on that space would tear the word in two and
 * let the justifier stretch the gap.
 *
 * Also writes public/data/surahs.json — the surah index the reader needs to
 * draw its sidebar and to know which pages a surah spans. It is about 10 KB,
 * and it is what the app loads instead of the 1.6 MB quran.json, whose verse
 * text the mushaf renderer has no use for.
 *
 * Source: api.quran.com v4 (public, no credentials needed).
 * Run with: npm run build:mushaf
 */

const fs   = require('fs');
const path = require('path');

const API      = 'https://api.quran.com/api/v4';
const OUT      = path.join(__dirname, '..', 'public', 'data', 'mushaf.json');
const OUT_INDEX = path.join(__dirname, '..', 'public', 'data', 'surahs.json');
const PAGES    = 604;
const PARALLEL = 6;
const SEP      = '|';   // never occurs inside a glyph code (all are U+E000 and up)

/**
 * How wide a line is drawn, in ems, for each version — the number the reader
 * divides the sheet's measure by to get its type size.
 *
 * These are properties of the typefaces, measured from the font files: every
 * page font of a version shares one design scale (the ayah marker is 1.245em
 * on all 604 V1 pages, 0.88em on all V2 pages), so one size is right for the
 * whole mushaf. Sizing each page to its own widest line — which is what the
 * reader used to do — made the type jump between pages, and made Al-Fatihah
 * come out nearly twice the size of everything else.
 *
 * The values are the 99.9th percentile of line width, not the maximum: V2
 * draws its lines to a near-constant width, so at 15.98em the median line
 * fills 97% of the measure. Taking the outright maximum would drop that to
 * 86% and leave every line loose for the sake of eight of them. Those eight
 * are set slightly smaller instead, line by line, by the reader.
 *
 * V1 does not justify within its glyphs, so its lines run from 12 to 21em and
 * a typical one fills about 72% — the remainder is word spacing, which is how
 * a V1 mushaf is set.
 *
 * Pages 1 and 2 — the framed opening spread — are drawn to the same scale as
 * the rest (their words average 1.82em against 1.65-1.79 elsewhere), so they
 * take the same size. Their lines are simply short, because the ornamental
 * frame leaves a narrow column, and short lines are centred rather than pulled
 * out to the margins.
 *
 * centreBelow is the fraction of the measure under which a line is centred
 * instead of justified. It differs by version because the versions intend
 * different word spacing: V2 draws its lines nearly full width, so anything
 * well short of the measure is a genuinely short line, while a V1 line filling
 * two thirds is ordinary and wants its gaps.
 */
const LINE_EM = {
  body       : { v1: 19.76, v2: 15.98 },
  centreBelow: { v1: 0.55,  v2: 0.92  },
};

/* Pages 1 and 2 are the framed opening spread and hold 8 lines; every other
   page of the Madinah Mushaf holds exactly 15. */
const linesOnPage = (p) => (p <= 2 ? 8 : 15);

/* Al-Fatihah carries its Basmalah as verse 1, and At-Tawbah has none at all,
   so neither of them gets a Basmalah of its own. */
const hasBasmalah = (surah) => surah !== 1 && surah !== 9;

async function getJSON(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (i === tries) throw err;
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

async function getPage(page) {
  const body = await getJSON(
    `${API}/verses/by_page/${page}` +
    '?words=true&word_fields=code_v1,code_v2,line_number,page_number,char_type_name' +
    '&fields=chapter_id&per_page=300');
  if (!body.verses || !body.verses.length) throw new Error(`page ${page}: no verses`);
  if (body.pagination && body.pagination.next_page) {
    throw new Error(`page ${page}: response was paginated — raise per_page`);
  }
  return body.verses;
}

/**
 * Collect every word of the mushaf, keyed by the page and line it is printed
 * on. This is deliberately not done page by page: a verse can straddle a page
 * break, and `by_page/N` reports the whole verse under whichever page it
 * starts on, so a per-page reading loses the words that spill over. Each word
 * carries its own page_number and line_number, and those are the truth.
 */
async function collectWords(warn, onProgress) {
  const all      = [];   // every word, later sorted into reading order
  const seen     = new Set();   // `${surah}:${verse}:${position}`
  const basmalah = [];   // the words of Al-Fatihah 1:1, minus its verse marker

  const queue = Array.from({ length: PAGES }, (_, i) => i + 1);
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (;;) {
      const page = queue.shift();
      if (!page) return;
      for (const v of await getPage(page)) {
        for (const w of v.words) {
          const key = `${v.chapter_id}:${v.verse_number}:${w.position}`;
          if (seen.has(key)) continue;
          if (!w.code_v1 || !w.code_v2) {
            warn(`${v.verse_key} word ${w.position} is missing a glyph code`);
            continue;
          }
          if (w.code_v1.includes(SEP) || w.code_v2.includes(SEP)) {
            warn(`${v.verse_key} word ${w.position} contains the separator`);
            continue;
          }
          seen.add(key);
          /* Al-Fatihah 1:1 is the Basmalah, so page 1's font already carries
             it — in both versions, in exactly the right face. Every other
             surah's Basmalah line is drawn from these glyphs. */
          if (v.chapter_id === 1 && v.verse_number === 1 && w.char_type_name === 'word') {
            basmalah.push({ pos: w.position, v1: w.code_v1, v2: w.code_v2 });
          }
          all.push({
            s: v.chapter_id, v: v.verse_number, pos: w.position,
            page: w.page_number, line: w.line_number,
            v1: w.code_v1, v2: w.code_v2,
          });
        }
      }
      onProgress();
    }
  }));

  /* Reading order is surah, then verse, then word position. */
  all.sort((a, b) => a.s - b.s || a.v - b.v || a.pos - b.pos);

  /* Reading order must never run backwards across the page: a word cannot be
     printed above the word before it. One word in the mushaf breaks this —
     the ayah marker closing 84:21 is reported a line above the verse it
     closes, which would set the verse number ahead of its own words. Pull any
     such word down onto the line of the word it follows. */
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1], cur = all[i];
    if (cur.page < prev.page || (cur.page === prev.page && cur.line < prev.line)) {
      warn(`${cur.s}:${cur.v} word ${cur.pos} is placed at p${cur.page} L${cur.line}, ` +
           `behind p${prev.page} L${prev.line} — moved onto p${prev.page} L${prev.line}`);
      cur.page = prev.page;
      cur.line = prev.line;
    }
  }

  const grid  = new Map();   // `${page}:${line}` -> [word]
  const spans = new Map();   // surah -> { from, to } in printed pages
  for (const w of all) {
    const cell = `${w.page}:${w.line}`;
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell).push(w);
    const sp = spans.get(w.s);
    if (!sp) spans.set(w.s, { from: w.page, to: w.page });
    else { if (w.page < sp.from) sp.from = w.page; if (w.page > sp.to) sp.to = w.page; }
  }

  basmalah.sort((a, b) => a.pos - b.pos);
  if (basmalah.length !== 4) {
    throw new Error(`expected 4 Basmalah words from 1:1, got ${basmalah.length}`);
  }
  return { grid, spans, total: seen.size, basmalah };
}

/** Cells where a surah's first word sits: `${page}:${line}` -> [surah]. */
function findOpenings(grid) {
  const opensAt = new Map();
  for (const [cell, ws] of grid) {
    for (const w of ws) {
      if (w.v === 1 && w.pos === 1) {
        if (!opensAt.has(cell)) opensAt.set(cell, []);
        opensAt.get(cell).push(w.s);
      }
    }
  }
  return opensAt;
}

/**
 * Cells holding the last word of a surah's last verse. Those lines stop short
 * of the margin, so they are centred rather than stretched edge to edge.
 */
function findClosings(grid, versesInSurah, warn) {
  const best = new Map();   // surah -> { page, line, pos, cell }
  for (const [cell, ws] of grid) {
    const [page, line] = cell.split(':').map(Number);
    for (const w of ws) {
      if (w.v !== versesInSurah[w.s]) continue;
      const cur = best.get(w.s);
      if (!cur || page > cur.page ||
          (page === cur.page && line > cur.line) ||
          (page === cur.page && line === cur.line && w.pos > cur.pos)) {
        best.set(w.s, { page, line, pos: w.pos, cell });
      }
    }
  }
  const closes = new Set();
  for (let s = 1; s <= 114; s++) {
    if (!best.has(s)) { warn(`surah ${s}: could not locate its closing line`); continue; }
    closes.add(best.get(s).cell);
  }
  return closes;
}

/**
 * Lay out one page. The ornamental lines are exactly the gaps in the line
 * grid: the mushaf sets a surah's header, and its Basmalah, into the run of
 * empty lines directly above its first word. Where only one line is free the
 * mushaf tightens up and puts the Basmalah inside the header band itself, so
 * the page still comes out at its fixed line count.
 */
function layoutPage(page, grid, opensAt, closes, warn) {
  const total = linesOnPage(page);
  const has   = (n) => grid.has(`${page}:${n}`);

  const opens = [];
  for (let n = 1; n <= total; n++) {
    for (const s of opensAt.get(`${page}:${n}`) || []) opens.push({ s, line: n });
  }
  opens.sort((a, b) => a.line - b.line || a.s - b.s);

  const ornament = new Map();
  const taken    = new Set();
  for (const { s, line } of opens) {
    const slot = [];
    for (let n = line - 1; n >= 1 && !has(n) && !taken.has(n); n--) slot.unshift(n);
    if (!slot.length) {
      warn(`page ${page}: surah ${s} opens on line ${line} with no free line above it`);
      continue;
    }
    const wants = hasBasmalah(s);
    if (wants && slot.length >= 2) {
      const [header, basmalah] = slot.slice(-2);
      ornament.set(header,   { t: 'surah', s });
      ornament.set(basmalah, { t: 'basmalah' });
      taken.add(header).add(basmalah);
    } else {
      const header = slot[slot.length - 1];
      ornament.set(header, wants ? { t: 'surah', s, b: 1 } : { t: 'surah', s });
      taken.add(header);
    }
  }

  const lines = [];
  for (let n = 1; n <= total; n++) {
    if (ornament.has(n)) { lines.push(ornament.get(n)); continue; }
    const ws = grid.get(`${page}:${n}`);
    if (!ws) { lines.push({ t: 'blank' }); continue; }
    const line = {
      t : 'ayah',
      v1: ws.map((w) => w.v1).join(SEP),
      v2: ws.map((w) => w.v2).join(SEP),
    };
    if (closes.has(`${page}:${n}`)) line.c = 1;
    lines.push(line);
  }

  for (let n = total + 1; n <= 20; n++) {
    if (has(n)) warn(`page ${page}: words on line ${n}, past the ${total}-line page`);
  }
  return lines;
}

async function main() {
  const warnings = [];
  const warn     = (m) => warnings.push(m);

  console.log('Fetching surah lengths...');
  const chapters = await getJSON(`${API}/chapters`);
  const versesInSurah = {};
  for (const c of chapters.chapters) versesInSurah[c.id] = c.verses_count;
  if (Object.keys(versesInSurah).length !== 114) {
    throw new Error('expected 114 surahs, got ' + Object.keys(versesInSurah).length);
  }

  const chapterInfo = chapters.chapters;

  console.log(`Downloading ${PAGES} mushaf pages...`);
  let done = 0;
  const { grid, spans, total, basmalah } = await collectWords(warn, () => {
    done++;
    if (done % 20 === 0 || done === PAGES) process.stdout.write(`  ${done}/${PAGES} pages\r`);
  });
  process.stdout.write('\n');

  /* A surah always runs over a contiguous run of pages, so its first and last
     are all the reader needs to lay one out. The range is taken from where the
     words are actually printed, not from the API's own chapter listing: a
     verse can spill past the page its surah is filed under — Surah 80 is filed
     on page 585 but ends on 586 — and reading from the listing would cut the
     last lines off. */
  /* api.quran.com spells the surah names bare; alquran.cloud vocalises them
     and includes the word "سورة", which is what a page's running head shows. */
  console.log('Fetching vocalised surah names...');
  const vocalised = {};
  for (const c of (await getJSON('https://api.alquran.cloud/v1/surah')).data) {
    vocalised[c.number] = c.name.trim();
  }

  const index = chapterInfo.map((c) => {
    const span = spans.get(c.id);
    if (!span) throw new Error(`surah ${c.id} has no words`);
    if (!vocalised[c.id]) throw new Error(`surah ${c.id} has no vocalised name`);
    return {
      id: c.id, name: c.name_arabic, full: vocalised[c.id],
      en: c.name_simple, v: c.verses_count,
      from: span.from, to: span.to,
    };
  });
  for (const s of index) {
    if (!(s.from >= 1 && s.to <= PAGES && s.to >= s.from)) {
      throw new Error(`surah ${s.id} has an impossible page range ${s.from}-${s.to}`);
    }
  }

  const opensAt = findOpenings(grid);
  const closes  = findClosings(grid, versesInSurah, warn);

  const mushaf = {};
  for (let page = 1; page <= PAGES; page++) {
    mushaf[page] = layoutPage(page, grid, opensAt, closes, warn);
  }

  /* Nothing is written unless every page and every word is accounted for. */
  const bad = [];
  for (let p = 1; p <= PAGES; p++) {
    if (!mushaf[p] || mushaf[p].length !== linesOnPage(p)) bad.push(p);
  }
  if (bad.length) throw new Error(`${bad.length} malformed page(s): ${bad.slice(0, 10).join(', ')}`);

  const placed = Object.values(mushaf).reduce((n, ls) =>
    n + ls.reduce((m, l) => m + (l.t === 'ayah' ? l.v1.split(SEP).length : 0), 0), 0);
  if (placed !== total) throw new Error(`placed ${placed} words but collected ${total}`);

  const headers = Object.values(mushaf).reduce((n, ls) =>
    n + ls.filter((l) => l.t === 'surah').length, 0);
  if (headers !== 114) throw new Error(`emitted ${headers} surah headers, expected 114`);

  /* The page each juz opens on. Not a clean 20 pages apart — juz 7 starts on
     121 and juz 11 on 201 — so it is read from the API, not calculated. */
  console.log('Fetching juz boundaries...');
  const juzPages = [];
  for (let j = 1; j <= 30; j++) {
    const b = await getJSON(`${API}/verses/by_juz/${j}?fields=page_number&per_page=1`);
    juzPages.push(b.verses[0].page_number);
  }
  if (juzPages.length !== 30 || juzPages[0] !== 1) {
    throw new Error('juz boundaries came back wrong: ' + juzPages.join(','));
  }

  const out = {
    fit: LINE_EM,
    juzPages,
    /* Rendered in page 1's own font, whichever version is selected. */
    basmalah: {
      page: 1,
      v1  : basmalah.map((w) => w.v1).join(SEP),
      v2  : basmalah.map((w) => w.v2).join(SEP),
    },
    pages: mushaf,
  };
  fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');
  fs.writeFileSync(OUT_INDEX, JSON.stringify(index), 'utf8');
  console.log(`Done. ${PAGES} pages, ${placed} words -> ${OUT} ` +
              `(${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
  console.log(`      114 surahs -> ${OUT_INDEX} ` +
              `(${Math.round(fs.statSync(OUT_INDEX).size / 1024)} KB)`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    warnings.slice(0, 25).forEach((w) => console.log('  ' + w));
  }
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  console.error('Output file was NOT changed.');
  process.exit(1);
});
