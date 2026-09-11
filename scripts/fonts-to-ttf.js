/**
 * The page fonts, in a format Android can load.
 *
 *   node scripts/fonts-to-ttf.js
 *
 * The web is served woff2: 604 faces, one per page, 95 MB, and every browser
 * reads them. Android reads TTF and OTF and nothing else — `Typeface` has no
 * woff2 decoder — so a native reader needs the same faces decompressed.
 *
 * woff2 is a TTF with the tables brotli-compressed and one transform applied to
 * the glyph outlines, so this is a decode rather than a conversion: the glyphs,
 * the metrics and the codepoints all come out exactly as they went in. fontTools
 * does it in one call; brotli does the unpacking underneath.
 *
 * Expect them to roughly double. That is the honest price of native rendering,
 * and it is why the web build keeps its woff2 — this writes somewhere else and
 * touches nothing the site serves.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FROM = path.join(ROOT, 'public', 'fonts', 'v2');
const TO = path.join(ROOT, 'android', 'app', 'src', 'main', 'fonts-ttf');

/* fontTools is a Python library and there is no Node equivalent worth the
   dependency; this hands it the whole directory in one process rather than
   paying Python's startup 604 times. */
const DECODE = `
import sys, os, glob
from fontTools.ttLib.woff2 import decompress

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)

done = 0
for f in sorted(glob.glob(os.path.join(src, '*.woff2'))):
    out = os.path.join(dst, os.path.splitext(os.path.basename(f))[0] + '.ttf')
    if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(f):
        done += 1
        continue
    decompress(f, out)
    done += 1
    if done % 100 == 0:
        print('  ' + str(done) + ' faces', flush=True)

names = sys.argv[3]
if os.path.exists(names):
    out = os.path.join(dst, 'sura-names.ttf')
    if not os.path.exists(out) or os.path.getmtime(out) < os.path.getmtime(names):
        decompress(names, out)

print('DONE ' + str(done))
`;

function main() {
  if (!fs.existsSync(FROM)) {
    throw new Error('no public/fonts/v2 — run `npm run fetch:fonts` first');
  }

  const before = fs.readdirSync(FROM).filter((f) => f.endsWith('.woff2'));
  if (before.length < 604) {
    throw new Error('only ' + before.length + ' of 604 page fonts are here');
  }

  /* The surah names are one face for the whole book, not one per page: the
     114 names and the word سورة, at private-use codepoints. It lives beside
     the page faces rather than among them. */
  const NAMES = path.join(ROOT, 'public', 'fonts', 'sura-names.woff2');

  execFileSync('python', ['-c', DECODE, FROM, TO, NAMES], { stdio: 'inherit' });

  const after = fs.readdirSync(TO).filter((f) => f.endsWith('.ttf'));
  const size = (dir, ext) =>
    fs.readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0) / 1048576;

  const was = size(FROM, '.woff2');
  const now = size(TO, '.ttf');

  console.log('  ' + after.length + ' faces');
  console.log('  woff2  ' + was.toFixed(0) + ' MB');
  console.log('  ttf    ' + now.toFixed(0) + ' MB  (' + (now / was).toFixed(2) + '×)');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('\n  ' + e.message + '\n'); process.exit(1); }
}
