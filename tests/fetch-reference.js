/**
 * Downloads independent copies of the Quran text to check our mushaf data
 * against. Everything lands in reference/, which is not in git.
 *
 *   tanzil-uthmani.txt  6236 verses, one per line, from tanzil.net — the
 *                       reference Uthmani text, from a different project than
 *                       the one our glyph codes come from
 *   alquran-cloud.json  6236 verses from api.alquran.cloud, a third source
 *   words.json          every word of the mushaf with its Uthmani spelling
 *                       beside its V1/V2 glyph codes and its printed position
 *
 * words.json is what makes the marks testable. Our pages hold glyph codes, not
 * letters — a QCF glyph is a whole word with its tashkeel, waqf sign and pause
 * marks already drawn in — so the only way to ask "is the Fatha there?" is to
 * line each glyph up against the spelling of the word it stands for.
 *
 * Run with: npm run fetch:reference
 */

const fs   = require('fs');
const path = require('path');

const REF   = path.join(__dirname, '..', 'reference');
const API   = 'https://api.quran.com/api/v4';
const PAGES = 604;
const PARALLEL = 6;

const SOURCES = [
  {
    file: 'tanzil-uthmani.txt',
    url : 'https://tanzil.net/pub/download/index.php?quranType=uthmani&outType=txt&agree=true',
  },
  {
    file: 'alquran-cloud.json',
    url : 'https://api.alquran.cloud/v1/quran/quran-uthmani',
  },
];

async function get(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i === tries) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

async function fetchWords() {
  const words = [];
  const seen  = new Set();
  const queue = Array.from({ length: PAGES }, (_, i) => i + 1);
  let done = 0;

  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (;;) {
      const page = queue.shift();
      if (!page) return;
      const body = JSON.parse(await get(
        `${API}/verses/by_page/${page}` +
        '?words=true&word_fields=code_v1,code_v2,line_number,page_number,char_type_name,text_uthmani' +
        '&fields=chapter_id&per_page=300'));

      for (const v of body.verses) {
        for (const w of v.words) {
          const key = `${v.chapter_id}:${v.verse_number}:${w.position}`;
          if (seen.has(key)) continue;
          seen.add(key);
          words.push({
            s: v.chapter_id, v: v.verse_number, pos: w.position,
            page: w.page_number, line: w.line_number,
            type: w.char_type_name,
            text: w.text_uthmani,
            v1: w.code_v1, v2: w.code_v2,
          });
        }
      }
      done++;
      if (done % 25 === 0 || done === PAGES) process.stdout.write(`  ${done}/${PAGES} pages\r`);
    }
  }));

  words.sort((a, b) => a.s - b.s || a.v - b.v || a.pos - b.pos);
  return words;
}

async function main() {
  fs.mkdirSync(REF, { recursive: true });

  for (const src of SOURCES) {
    const dest = path.join(REF, src.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) {
      console.log(`  ${src.file} — already present`);
      continue;
    }
    process.stdout.write(`  ${src.file} ...`);
    fs.writeFileSync(dest, await get(src.url));
    console.log(` ${Math.round(fs.statSync(dest).size / 1024)} KB`);
  }

  const wordsFile = path.join(REF, 'words.json');
  if (fs.existsSync(wordsFile) && fs.statSync(wordsFile).size > 10000) {
    console.log('  words.json — already present');
  } else {
    console.log('  words.json — reading every word of the mushaf...');
    const words = await fetchWords();
    process.stdout.write('\n');
    if (words.length < 70000) throw new Error(`only ${words.length} words collected`);
    fs.writeFileSync(wordsFile, JSON.stringify(words), 'utf8');
    console.log(`  words.json ${Math.round(fs.statSync(wordsFile).size / 1024)} KB, ${words.length} words`);
  }

  console.log('\nReference data ready in reference/');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
