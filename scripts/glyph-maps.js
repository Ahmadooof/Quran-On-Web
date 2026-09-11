/**
 * What each page's codepoints are, in the only terms that cannot be argued
 * with: glyph numbers and advances.
 *
 *   node scripts/glyph-maps.js
 *
 * The reader had been drawing these pages as text, which means handing a string
 * to the system and trusting the whole apparatus behind it — the character map,
 * the Arabic shaper, joining and ligature rules, bidi, font fallback for
 * anything the face lacks. All of that exists to turn ordinary writing into
 * glyphs, and none of it is wanted here: this edition arrives with the work
 * already done, one finished word per codepoint, cut for one page.
 *
 * The apparatus is where the trouble was. The codepoints are U+FC41 upward —
 * Arabic presentation forms, not the private-use characters they were taken
 * for — so the system reads a script in them, and applies a script's rules to
 * glyphs that were never meant to receive any.
 *
 * So this reads the answer out of each face beforehand: the glyph number a
 * codepoint stands for, and how wide it is. On the phone that is drawn with
 * drawGlyphs, which asks for numbers and positions and consults nothing.
 *
 * One small file per page, beside the face it belongs to:
 *
 *   2500              units per em
 *   64577 3 4313      codepoint, glyph, advance
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FONTS = path.join(ROOT, 'android', 'app', 'src', 'main', 'fonts-ttf');

const READ = `
import sys, os, glob
from fontTools.ttLib import TTFont

d = sys.argv[1]
done = 0
for f in sorted(glob.glob(os.path.join(d, 'p*.ttf'))) + glob.glob(os.path.join(d, 'sura-names.ttf')):
    stem = os.path.splitext(os.path.basename(f))[0]
    out = os.path.join(d, 'g' + (stem[1:] if stem.startswith('p') else stem) + '.txt')
    if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(f):
        done += 1
        continue

    font = TTFont(f, lazy=True)
    order = font.getGlyphOrder()
    gid = {n: i for i, n in enumerate(order)}
    hm = font['hmtx']
    lines = [str(font['head'].unitsPerEm)]
    for cp, name in sorted(font.getBestCmap().items()):
        lines.append('%d %d %d' % (cp, gid[name], hm[name][0]))
    font.close()

    with open(out, 'w') as fh:
        fh.write(chr(10).join(lines) + chr(10))

    done += 1
    if done % 100 == 0:
        print('  ' + str(done) + ' pages', flush=True)

print('DONE ' + str(done))
`;

function main() {
  if (!fs.existsSync(FONTS)) {
    throw new Error('no fonts-ttf — run `npm run fonts:ttf` first');
  }
  const faces = fs.readdirSync(FONTS).filter((f) => /^p\d+\.ttf$/.test(f));
  if (faces.length < 604) {
    throw new Error('only ' + faces.length + ' of 604 faces are decoded');
  }

  execFileSync('python', ['-c', READ, FONTS], { stdio: 'inherit' });

  const maps = fs.readdirSync(FONTS).filter((f) => /^g.+\.txt$/.test(f));
  const bytes = maps.reduce((n, f) => n + fs.statSync(path.join(FONTS, f)).size, 0);
  console.log('  ' + maps.length + ' maps, ' + (bytes / 1048576).toFixed(1) + ' MB');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('\n  ' + e.message + '\n'); process.exit(1); }
}
