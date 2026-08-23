/**
 * Downloads the QCF mushaf fonts into public/fonts/.
 *
 * Both versions are page fonts: one file per mushaf page, holding one glyph
 * per printed word. They only make sense alongside the matching glyph codes in
 * public/data/mushaf.json, so run build-mushaf.js from the same source.
 *
 *   public/fonts/v1/p1.woff2 … p604.woff2   QCF V1  (~9 MB total)
 *   public/fonts/v2/p1.woff2 … p604.woff2   QCF V2  (~25 MB total)
 *   public/fonts/sura-names.woff2           ornamental surah headers + Basmalah
 *
 * Already-downloaded files are skipped, so an interrupted run just resumes.
 * Run with: npm run fetch:fonts
 */

const fs   = require('fs');
const path = require('path');

const CDN      = 'https://static.qurancdn.com/fonts/quran';
const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');
const PAGES    = 604;
const PARALLEL = 12;
const MIN_SIZE = 2000;   // a real page font is >2 KB; anything less is an error page

async function download(url, dest, tries = 4) {
  if (fs.existsSync(dest) && fs.statSync(dest).size >= MIN_SIZE) return 'skipped';
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_SIZE) throw new Error(`only ${buf.length} bytes`);
      if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a woff2 file');
      fs.writeFileSync(dest, buf);
      return 'downloaded';
    } catch (err) {
      if (i === tries) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

async function main() {
  fs.mkdirSync(FONT_DIR, { recursive: true });

  const jobs = [];
  for (const version of ['v1', 'v2']) {
    fs.mkdirSync(path.join(FONT_DIR, version), { recursive: true });
    for (let p = 1; p <= PAGES; p++) {
      jobs.push({
        url : `${CDN}/hafs/${version}/woff2/p${p}.woff2`,
        dest: path.join(FONT_DIR, version, `p${p}.woff2`),
      });
    }
  }
  jobs.push({
    url : `${CDN}/surah-names/v1/sura_names.woff2`,
    dest: path.join(FONT_DIR, 'sura-names.woff2'),
  });

  console.log(`Fetching ${jobs.length} font files into public/fonts/ ...`);
  let done = 0, got = 0, skipped = 0;
  const queue = jobs.slice();

  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const how = await download(job.url, job.dest);
      if (how === 'skipped') skipped++; else got++;
      done++;
      if (done % 25 === 0 || done === jobs.length) {
        process.stdout.write(`  ${done}/${jobs.length}\r`);
      }
    }
  }));
  process.stdout.write('\n');

  /* Every page of both versions has to be present, or some page of the mushaf
     would silently render as empty boxes. */
  const missing = [];
  for (const job of jobs) {
    if (!fs.existsSync(job.dest) || fs.statSync(job.dest).size < MIN_SIZE) {
      missing.push(path.relative(FONT_DIR, job.dest));
    }
  }
  if (missing.length) {
    throw new Error(`${missing.length} font file(s) missing: ${missing.slice(0, 8).join(', ')}`);
  }

  const bytes = jobs.reduce((n, j) => n + fs.statSync(j.dest).size, 0);
  console.log(`Done. ${got} downloaded, ${skipped} already present, ` +
              `${Math.round(bytes / 1024 / 1024)} MB total.`);
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
