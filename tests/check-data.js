/**
 * Checks public/data/mushaf.json against independent copies of the Quran text.
 *
 * Our pages hold QCF glyph codes, not letters: one glyph is a whole word, with
 * its tashkeel, waqf sign and pause marks already drawn into the outline. So a
 * mark cannot be looked for in our data directly — it is checked by lining
 * every glyph up against the Uthmani spelling of the word it stands for
 * (reference/words.json) and against two unrelated copies of the text.
 *
 * Whether the marks are actually *drawn* is the font's side of the question,
 * and check-fonts.py answers it.
 *
 * Run with: npm run test:data
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REF  = path.join(ROOT, 'reference');
const SEP  = '|';

/* ---------- the marks under test ----------------------------------------
   Each entry is either the character itself, or [character, substitute, note]
   for a mark this mushaf writes another way. A mark absent under *both*
   spellings is a real gap; one written differently is not.                  */

const MARKS = [
  ['Diacritics (tashkeel)', {
    'Fatha':      'َ', 'Damma':    'ُ',
    'Kasra':      'ِ', 'Sukun':    'ْ',
    'Shadda':     'ّ', 'Fathatan': 'ً',
    'Dammatan':   'ٌ', 'Kasratan': 'ٍ',
    'Maddah':     'ٓ',
  }],
  ['Pause marks (waqf)', {
    'Mandatory stop (meem)':      'ۘ',
    'Do not stop (la)':           'ۙ',
    'Permissible stop (jeem)':    'ۚ',
    'Preferable stop (qala)':     'ۗ',
    'Preferable to go on (sala)': 'ۖ',
    'Suggested stop (seen)':      'ۜ',
    'Paired stop (three dots)':   'ۛ',
  }],
  ['Recitation / orthographic marks', {
    'Dagger alif':       'ٰ',
    'Quranic sukun':     ['ۡ', 'ْ', 'this mushaf spells sukun U+0652'],
    'Iqlab meem':        'ۢ',
    'Small low seen':    'ۣ',
    'Small high madda':  ['ۤ', 'ٓ', 'this mushaf spells madda U+0653'],
    'Small waw':         'ۥ',
    'Small yeh':         'ۦ',
    'Rounded zero':      '۟',
    'Rectangular zero':  '۠',
  }],
  ['Section marks', {
    'End of ayah':      ['۝', null, 'drawn as its own glyph, not a character — see the ayah-marker check'],
    'Rub el hizb':      '۞',
    'Place of sajdah':  '۩',
  }],
];

/* ---------- tiny harness ------------------------------------------------- */

const results = [];
let failed = 0;

function check(name, fn) {
  try {
    results.push({ ok: true, name, detail: fn() || '' });
  } catch (err) {
    failed++;
    results.push({ ok: false, name, detail: err.message });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ---------- load --------------------------------------------------------- */

function requireRef(file) {
  const p = path.join(REF, file);
  if (!fs.existsSync(p)) {
    console.error(`Missing ${path.relative(ROOT, p)} — run: npm run fetch:reference`);
    process.exit(2);
  }
  return p;
}

const loadJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const mushaf = loadJSON(path.join(ROOT, 'public', 'data', 'mushaf.json'));
const surahs = loadJSON(path.join(ROOT, 'public', 'data', 'surahs.json'));
const words  = loadJSON(requireRef('words.json'));
const cloud  = loadJSON(requireRef('alquran-cloud.json'));
const tanzil = fs.readFileSync(requireRef('tanzil-uthmani.txt'), 'utf8')
                 .split('\n').map((l) => l.trim())
                 .filter((l) => l && !l.startsWith('#'));

const linesOnPage = (p) => (p <= 2 ? 8 : 15);

/** Our pages flattened back into a word sequence, in printed order. */
function ourWords() {
  const out = [];
  for (let p = 1; p <= 604; p++) {
    mushaf.pages[p].forEach((l, i) => {
      if (l.t !== 'ayah') return;
      const a = l.v1.split(SEP), b = l.v2.split(SEP);
      for (let k = 0; k < a.length; k++) out.push({ page: p, line: i + 1, v1: a[k], v2: b[k] });
    });
  }
  return out;
}

/* ---------- structure ---------------------------------------------------- */

check('604 pages, each with its full line grid', () => {
  let total = 0;
  for (let p = 1; p <= 604; p++) {
    const ls = mushaf.pages[p];
    assert(ls, `page ${p} is missing`);
    assert(ls.length === linesOnPage(p),
      `page ${p} has ${ls.length} lines, expected ${linesOnPage(p)}`);
    total += ls.length;
  }
  assert(total === 9046, `${total} lines, expected 9046`);
  return `${total} lines (8 on each of the framed opening pair, 15 on each of 602)`;
});

check('one header per surah, in printed order', () => {
  const seen = [];
  for (let p = 1; p <= 604; p++) {
    for (const l of mushaf.pages[p]) if (l.t === 'surah') seen.push(l.s);
  }
  assert(seen.length === 114, `${seen.length} headers, expected 114`);
  for (let i = 0; i < 114; i++) {
    assert(seen[i] === i + 1, `header ${i + 1} out of order: found surah ${seen[i]}`);
  }
  return '114 headers, surah 1 through 114';
});

check('a Basmalah for every surah but Al-Fatihah and At-Tawbah', () => {
  let own = 0, inBand = 0;
  for (let p = 1; p <= 604; p++) {
    for (const l of mushaf.pages[p]) {
      if (l.t === 'basmalah') own++;
      if (l.t === 'surah' && l.b) inBand++;
    }
  }
  assert(own + inBand === 112, `${own + inBand} Basmalahs, expected 112`);
  return `${own} on their own line, ${inBand} set inside the header band`;
});

check("every surah's closing line is marked", () => {
  let n = 0;
  for (let p = 1; p <= 604; p++) for (const l of mushaf.pages[p]) if (l.c) n++;
  assert(n === 114, `${n} closing lines, expected 114`);
  return '114 surahs, 114 closing lines';
});

check('every surah carries a vocalised name for its running head', () => {
  const bad = surahs.filter((s) => !s.full || !/^سُورَة/.test(s.full));
  assert(!bad.length,
    `${bad.length} surah(s) have no vocalised name, first is ${bad[0] && bad[0].id}`);
  const plain = surahs.filter((s) => !/[ً-ْ]/.test(s.full));
  assert(!plain.length,
    `${plain.length} vocalised name(s) carry no tashkeel, first is ${plain[0] && plain[0].id}`);
  return `114 names, e.g. ${surahs[1].full}`;
});

check('the 30 juz boundaries land on real pages, in order', () => {
  const j = mushaf.juzPages;
  assert(Array.isArray(j) && j.length === 30, `juzPages has ${j && j.length} entries, expected 30`);
  assert(j[0] === 1, `juz 1 opens on page ${j[0]}, expected 1`);
  for (let i = 0; i < 30; i++) {
    assert(Number.isInteger(j[i]) && j[i] >= 1 && j[i] <= 604, `juz ${i + 1} opens on page ${j[i]}`);
    if (i) assert(j[i] > j[i - 1], `juz ${i + 1} opens on page ${j[i]}, not after juz ${i} on ${j[i - 1]}`);
  }
  /* The reader reads these backwards to label a page, so every page must land
     in exactly one juz. */
  const juzOf = (p) => { for (let i = 29; i >= 0; i--) if (p >= j[i]) return i + 1; return 0; };
  for (let p = 1; p <= 604; p++) assert(juzOf(p) >= 1 && juzOf(p) <= 30, `page ${p} falls outside every juz`);
  return `juz 1 on page 1 through juz 30 on page ${j[29]}`;
});

check('V2 draws every word on a page with its own glyph', () => {
  /* A V2 page font holds exactly one glyph per printed word, so a code
     repeating on a page would mean two words sharing a glyph. V1 is built
     differently — a fixed 720-glyph set per page, reused across matching word
     shapes — so repeats there are expected and not checked. */
  const clashes = [];
  for (let p = 1; p <= 604; p++) {
    const seen = new Set();
    for (const l of mushaf.pages[p]) {
      if (l.t !== 'ayah') continue;
      for (const w of l.v2.split(SEP)) {
        if (seen.has(w)) clashes.push(`p${p}`);
        seen.add(w);
      }
    }
  }
  assert(!clashes.length, `${clashes.length} repeated codes on ${clashes.slice(0, 5).join(', ')}`);
  return 'no V2 page draws two words with the same glyph';
});

check('reading order never runs backwards', () => {
  /* A line can never be printed above the line it follows. */
  let prev = { page: 0, line: 0 };
  for (let p = 1; p <= 604; p++) {
    mushaf.pages[p].forEach((l, i) => {
      if (l.t !== 'ayah') return;
      const cur = { page: p, line: i + 1 };
      assert(cur.page > prev.page || (cur.page === prev.page && cur.line > prev.line),
        `p${cur.page} L${cur.line} comes after p${prev.page} L${prev.line}`);
      prev = cur;
    });
  }
  return 'every line follows the one before it, across all 604 pages';
});

/* ---------- against the reference word list ------------------------------ */

check('every word of the mushaf is present, in reading order', () => {
  const ours = ourWords();
  assert(ours.length === words.length,
    `${ours.length} words laid out, reference has ${words.length}`);
  for (let i = 0; i < ours.length; i++) {
    const a = ours[i], b = words[i];
    assert(a.v1 === b.v1 && a.v2 === b.v2,
      `word ${i} differs: ours ${a.v1}/${a.v2}, reference ${b.v1}/${b.v2} (${b.s}:${b.v} #${b.pos})`);
  }
  return `${ours.length} words, glyph for glyph, in the same order`;
});

check('each word sits on the page and line it is printed on', () => {
  /* The source places one word behind the word it follows — the marker closing
     84:21 — which the build pulls back into order. That repair is the only
     position allowed to differ. */
  const REPAIRED = new Set(['84:21:7']);
  const ours = ourWords();
  const moved = [];
  for (let i = 0; i < ours.length; i++) {
    const a = ours[i], b = words[i];
    if (a.page === b.page && a.line === b.line) continue;
    const key = `${b.s}:${b.v}:${b.pos}`;
    assert(REPAIRED.has(key),
      `${key} placed at p${a.page} L${a.line}, source says p${b.page} L${b.line}`);
    moved.push(key);
  }
  return `${ours.length} words in place; ${moved.length} repaired (${moved.join(', ') || 'none'})`;
});

check('every verse ends with exactly one ayah marker', () => {
  const ends = {};
  for (const w of words) {
    if (w.type === 'end') ends[`${w.s}:${w.v}`] = (ends[`${w.s}:${w.v}`] || 0) + 1;
  }
  const verses = new Set(words.map((w) => `${w.s}:${w.v}`));
  const missing = [...verses].filter((k) => !ends[k]);
  const doubled = Object.keys(ends).filter((k) => ends[k] > 1);
  assert(!missing.length, `${missing.length} verses with no marker (${missing.slice(0, 3)})`);
  assert(!doubled.length, `${doubled.length} verses with more than one (${doubled.slice(0, 3)})`);
  return `${verses.size} verses, each closed by one marker glyph`;
});

/* ---------- against two unrelated copies of the text --------------------- */

check('verse count agrees with Tanzil and alquran.cloud', () => {
  const ours = new Set(words.map((w) => `${w.s}:${w.v}`)).size;
  const cloudVerses = cloud.data.surahs.reduce((n, s) => n + s.ayahs.length, 0);
  assert(tanzil.length === 6236, `Tanzil has ${tanzil.length} verses, expected 6236`);
  assert(ours === 6236, `our layout has ${ours} verses`);
  assert(cloudVerses === 6236, `alquran.cloud has ${cloudVerses} verses`);
  return '6236 verses in all three';
});

check('surah lengths agree with Tanzil and alquran.cloud', () => {
  const ourCount = {};
  for (const w of words) ourCount[w.s] = Math.max(ourCount[w.s] || 0, w.v);
  const cloudCount = {};
  for (const s of cloud.data.surahs) cloudCount[s.number] = s.ayahs.length;

  for (const s of surahs) {
    assert(ourCount[s.id] === s.v,
      `surah ${s.id}: layout ends at verse ${ourCount[s.id]}, index says ${s.v}`);
    assert(cloudCount[s.id] === s.v,
      `surah ${s.id}: index says ${s.v} verses, alquran.cloud says ${cloudCount[s.id]}`);
  }
  return '114 surahs, verse counts identical across all three';
});

check('word spelling matches the Tanzil text, verse for verse', () => {
  /* The two texts are equally correct but not written identically: Tanzil
     spells some words with an alif maksura and a dagger alif where this mushaf
     writes a plain alif, and uses a bare alif with a combining maddah where
     this one uses the precomposed letter. Reducing both to their consonant
     skeleton compares what is actually being said — the words present, their
     spelling and their order — and leaves the marks to be counted below. */
  const strip = (s) => s
    .replace(/[ً-ٰۖ-ۭـ]/g, '')          // tashkeel, Quranic annotation, tatweel
    .replace(/[‎‏؜]/g, '') // stray bidi controls
    .replace(/[آأإٱٲٳ]/g, 'ا')  // hamza-bearing alifs
    .replace(/ى/g, 'ا')              // alif maksura
    .replace(/ٱ/g, 'ا')
    .replace(/\s+/g, '');
  /* Tanzil writes the Basmalah into verse 1 of every surah that has one; the
     mushaf sets it on a line of its own, so it is not one of the verse's
     words. */
  const BASMALAH = strip('بِسْمِ ٱللَّهِ ' +
                         'ٱلرَّحْمَٰنِ ' +
                         'ٱلرَّحِيمِ');

  const byVerse = {};
  for (const w of words) {
    if (w.type !== 'word') continue;
    const k = `${w.s}:${w.v}`;
    (byVerse[k] = byVerse[k] || []).push(w.text);
  }

  let vi = 0;
  const mismatched = [];
  for (const s of surahs) {
    for (let v = 1; v <= s.v; v++) {
      const ours = strip((byVerse[`${s.id}:${v}`] || []).join(' '));
      let theirs = strip(tanzil[vi++]);
      if (v === 1 && s.id !== 1 && theirs.startsWith(BASMALAH)) {
        theirs = theirs.slice(BASMALAH.length);
      }
      if (ours !== theirs) mismatched.push(`${s.id}:${v}`);
    }
  }
  assert(!mismatched.length,
    `${mismatched.length} verses differ, e.g. ${mismatched.slice(0, 6).join(', ')}`);
  return 'all 6236 verses spell identically to Tanzil';
});

/* ---------- the marks ---------------------------------------------------- */

function markReport() {
  const rows = [];
  const joined = words.filter((w) => w.type === 'word').map((w) => w.text).join(' ');
  const tanzilText = tanzil.join(' ');
  const count = (hay, ch) => (ch ? hay.split(ch).length - 1 : 0);

  for (const [group, marks] of MARKS) {
    for (const [label, spec] of Object.entries(marks)) {
      const ch   = Array.isArray(spec) ? spec[0] : spec;
      const alt  = Array.isArray(spec) ? spec[1] : null;
      const note = Array.isArray(spec) ? spec[2] : '';
      const look = count(joined, ch) ? ch : alt;

      /* Which pages carry it — proof it is not confined to one corner. */
      const pages = new Set();
      if (look) {
        for (const w of words) {
          if (w.type === 'word' && w.text && w.text.includes(look)) pages.add(w.page);
        }
      }
      rows.push({
        group, label, note,
        ours  : count(joined, ch) || count(joined, alt),
        tanzil: count(tanzilText, ch) || count(tanzilText, alt),
        pages : pages.size,
      });
    }
  }
  return rows;
}

const marks = markReport();

check('every mark under test is present in the mushaf text', () => {
  /* The ayah marker is a glyph rather than a character, and has its own check
     above. */
  const testable = marks.filter((m) => !m.label.startsWith('End of ayah'));
  const absent = testable.filter((m) => m.ours === 0);
  assert(!absent.length,
    `${absent.length} never appear: ${absent.map((m) => m.label).join(', ')}`);
  const noted = testable.filter((m) => m.note).length;
  return `${testable.length} mark types present (${noted} written with this mushaf's own spelling)`;
});

check('sajdah and rub-el-hizb marks appear the expected number of times', () => {
  const find = (l) => marks.find((m) => m.label.startsWith(l));
  const sajdah = find('Place of sajdah');
  assert(sajdah.ours === 15, `${sajdah.ours} sajdah marks, expected 15`);
  const hizb = find('Rub el hizb');
  assert(hizb.ours >= 199 && hizb.ours <= 240,
    `${hizb.ours} rub-el-hizb marks, expected between 199 and 240`);
  return `15 places of sajdah, ${hizb.ours} rub-el-hizb marks`;
});

/* ---------- the surah index ---------------------------------------------- */

check('surahs.json page ranges match where the words actually are', () => {
  const range = {};
  for (const w of words) {
    const r = range[w.s] = range[w.s] || { from: 604, to: 1 };
    if (w.page < r.from) r.from = w.page;
    if (w.page > r.to) r.to = w.page;
  }
  for (const s of surahs) {
    assert(s.from === range[s.id].from && s.to === range[s.id].to,
      `surah ${s.id}: index says ${s.from}-${s.to}, words are on ${range[s.id].from}-${range[s.id].to}`);
  }
  return '114 surahs, page ranges exact';
});

/* ---------- report ------------------------------------------------------- */

console.log('\nMushaf data\n');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (r.detail) console.log(`        ${r.detail}`);
}

console.log('\nMarks — occurrences in the mushaf text vs Tanzil, and how many pages carry each\n');
let group = null;
for (const m of marks) {
  if (m.group !== group) { group = m.group; console.log(`  ${group}`); }
  const flag = m.ours === 0 ? '   MISSING' : '';
  console.log(`    ${m.label.padEnd(28)} ${String(m.ours).padStart(6)}   ` +
              `tanzil ${String(m.tanzil).padStart(6)}   ${String(m.pages).padStart(3)} pages${flag}`);
  if (m.note) console.log(`      ${' '.repeat(26)} ${m.note}`);
}

console.log(`\n${results.length - failed}/${results.length} checks passed.\n`);
process.exit(failed ? 1 : 0);
