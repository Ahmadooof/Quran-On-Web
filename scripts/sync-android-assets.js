/**
 * The data the Android reader needs, copied into the app.
 *
 *   node scripts/sync-android-assets.js
 *
 * This used to copy the whole website — the app was a WebView showing it. The
 * reader is native now and needs none of that: no html, no css, no scripts,
 * and not the woff2 faces either, because Android cannot read them and takes
 * the decoded ones from `npm run fonts:ttf` instead.
 *
 * What it does need is the part that is neither code nor presentation:
 *
 *   data/mushaf.json      every page of the book, line by line, as the glyphs
 *                         of the face that page is set in.
 *   data/surahs.json      the 114 surahs and the pages they run over.
 *   data/recitations.json which recordings there are.
 *   surah/…timing.json    where every word falls in each recitation.
 *
 * Five megabytes rather than ninety-nine, and all of it is data the reader
 * reads rather than a program it runs.
 *
 * Not committed: it is derived from public/, which already holds it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FROM = path.join(ROOT, 'public');
const TO = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');

/* Only these, at the top of public/. Everything else there belongs to the
   website: the markup, the stylesheets, the scripts, the woff2 faces, the
   service worker, the pre-rendered pages. */
const TAKE = new Set(['data', 'surah']);

/**
 * Whether a file or folder is one of the four things above.
 *
 * Plain string work rather than a pattern: the pattern this replaces had its
 * backslashes eaten on the way into the file, so it matched nothing on Windows
 * and quietly copied all 114 pre-rendered pages while looking correct.
 */
function wanted(from, name) {
  const here = path.join(from, name).split(path.sep).join('/');

  /* At the top level, only the two folders. */
  if (path.resolve(from) === path.resolve(FROM)) return TAKE.has(name);

  /* Inside surah/, the timings and the folders holding them — never the 114
     pre-rendered pages that sit beside them. */
  if (here.indexOf('/surah/') >= 0) {
    return fs.statSync(path.join(from, name)).isDirectory() || name.endsWith('.timing.json');
  }

  return true;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let files = 0, bytes = 0;

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    /* Nothing beginning with a dot. public/data/.env holds the API credentials
       when it exists, and the server is configured to refuse it — but an apk is
       a zip anyone can open, and a secret copied into one is published. There
       is nothing hidden that the reader needs. */
    if (entry.name.startsWith('.')) continue;
    if (!wanted(from, entry.name)) continue;

    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);

    if (entry.isDirectory()) {
      const r = copyDir(src, dst);
      files += r.files;
      bytes += r.bytes;
    } else {
      fs.copyFileSync(src, dst);
      files++;
      bytes += fs.statSync(src).size;
    }
  }

  return { files, bytes };
}

function main() {
  if (!fs.existsSync(path.join(FROM, 'index.html'))) {
    throw new Error('no public/index.html — run this from the repository root');
  }

  /* The faces the app actually loads are the decoded ones, and they are put
     in place by a different script. Say so plainly rather than letting the app
     build with no mushaf in it. */
  const faces = path.join(ROOT, 'android', 'app', 'src', 'main', 'fonts-ttf');
  if (!fs.existsSync(faces) || fs.readdirSync(faces).length < 604) {
    throw new Error('the page faces are not decoded yet — run `npm run fonts:ttf`');
  }

  fs.rmSync(TO, { recursive: true, force: true });
  const { files, bytes } = copyDir(FROM, TO);

  /* This is data, and data is small. Anything else that finds its way in —
     the recitations are 5.7 GB and the faces 95 MB — says so here rather than
     at the store's upload limit. */
  const mb = bytes / 1048576;
  if (mb > 30) {
    throw new Error('the copy came to ' + mb.toFixed(0) + ' MB, which is far more than the '
      + 'data for the reader — something joined it that belongs elsewhere');
  }

  console.log('  copied    ' + files + ' files, ' + mb.toFixed(1) + ' MB');
  console.log('  into      ' + path.relative(ROOT, TO));
  console.log('  taking    ' + Array.from(TAKE).join(', ') + ' only');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('\n  ' + e.message + '\n'); process.exit(1); }
}
