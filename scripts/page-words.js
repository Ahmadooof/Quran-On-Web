/**
 * The words behind each page's glyphs, one file a page.
 *
 * public/data/words/p<N>.json is an array with one entry for every glyph span
 * the reader draws on an ayah line of page N, in the same order: the Uthmani
 * word, or the ayah's number in Arabic figures for its closing mark. The
 * reader puts each on its span, so a word on screen has its text beside it.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'data', 'words');
const TEXT = path.join(ROOT, 'data', 'quran-uthmani.txt');

const ar = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);

// Two words the mushaf draws in one glyph slot (quran.com's words list agrees, space kept)
const JOINED = [['بَعْدَ', 'مَا'], ['إِلْ', 'يَاسِينَ']];

/** Glyph words per ayah, walked the way mushaf.js fillBox() numbers them. */
function glyphCounts(mushaf, version) {
  const out = {};
  let s = 0, v = 0;
  for (let p = 1; p <= 604; p++) {
    const marks = mushaf.marks[p] || '';
    for (const line of mushaf.pages[p]) {
      if (line.t === 'surah') { s = line.s; v = 1; }
      if (line.t !== 'ayah') continue;
      for (const word of line[version].split('|')) {
        if (marks.indexOf(word) >= 0) { v++; continue; }
        const k = s + ':' + v;
        out[k] = (out[k] || 0) + 1;
      }
    }
  }
  return out;
}

/** surah:ayah -> [word, ...], matched one to one with the glyphs or thrown. */
function ayahWords(surahs, counts) {
  const lines = fs.readFileSync(TEXT, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && l[0] !== '#');
  const out = {};
  let i = 0;
  surahs.forEach((su) => {
    for (let a = 1; a <= su.v; a++, i++) {
      const k = su.id + ':' + a;
      const want = counts[k];
      // Waqf marks stand alone in the text but are drawn inside a word's glyph
      let toks = lines[i].split(/\s+/).filter((t) => !/^[ۖ-ۭ]+$/.test(t));
      // The basmala is its own line in the mushaf; dropped by count, as 95 and 97 spell it with a shadda
      if (a === 1 && su.id !== 1 && toks.length === want + 4) toks = toks.slice(4);
      if (toks.length === want + 1) {
        for (const [x, y] of JOINED) {
          const at = toks.findIndex((t, j) => t === x && toks[j + 1] === y);
          if (at >= 0) { toks.splice(at, 2, x + ' ' + y); break; }
        }
      }
      if (toks.length !== want) {
        throw new Error(`${k}: ${toks.length} words in the text, ${want} glyphs in the mushaf`);
      }
      out[k] = toks;
    }
  });
  return out;
}

/** Writes the 604 files and returns their paths. */
function build(surahs) {
  const mushaf = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'mushaf.json'), 'utf8'));
  const words = ayahWords(surahs, glyphCounts(mushaf, 'v2'));
  fs.mkdirSync(OUT, { recursive: true });

  const files = [];
  let s = 0, v = 0, w = 0;
  for (let p = 1; p <= 604; p++) {
    const marks = mushaf.marks[p] || '';
    const page = [];
    for (const line of mushaf.pages[p]) {
      if (line.t === 'surah') { s = line.s; v = 1; w = 0; }
      if (line.t !== 'ayah') continue;
      for (const word of line.v2.split('|')) {
        if (marks.indexOf(word) >= 0) { page.push(ar(v)); v++; w = 0; continue; }
        page.push(words[s + ':' + v][w++]);
      }
    }
    const f = path.join(OUT, `p${p}.json`);
    fs.writeFileSync(f, JSON.stringify(page));
    files.push(f);
  }
  return files;
}

/** Glyph words per ayah as the reader draws them, keyed "s:v". */
function glyphSlots() {
  const mushaf = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'mushaf.json'), 'utf8'));
  return glyphCounts(mushaf, 'v2');
}

module.exports = { build, glyphSlots };
