/**
 * Checks the generated pages are what the generator would write today.
 *
 * public/index.html is the shell every surah page is stamped from, so editing
 * its head leaves 114 pages, the sitemap and robots.txt describing the page
 * before. Nothing says so: they are valid html, just stale. CI catches it, but
 * only after a push — this catches it here.
 *
 * It does what CI does, without needing git: hash everything the generator
 * owns, run the generator, hash again. A file that moved was out of date.
 *
 * Run with: npm run test:pages
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const ROOT   = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

/** Every file `npm run build:pages` writes. */
function generated() {
  const out = ['index.html', 'sitemap.xml', 'robots.txt']
    .map((f) => path.join(PUBLIC, f));

  // not a page, but written from the same site.json and just as easy to leave behind
  out.push(path.join(ROOT, 'deploy', 'security-headers.conf'));

  const surah = path.join(PUBLIC, 'surah');
  for (const dir of fs.readdirSync(surah)) {
    out.push(path.join(surah, dir, 'index.html'));
    const text = path.join(surah, dir, 'text', 'index.html');
    if (fs.existsSync(text)) out.push(text);
  }
  return out.filter((f) => fs.existsSync(f));
}

const hashes = (files) => new Map(files.map((f) =>
  [f, crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')]));

function main() {
  const before = hashes(generated());

  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-pages.js')],
    { stdio: 'pipe' });

  const after = hashes(generated());
  const moved = [...after.keys()]
    .filter((f) => before.get(f) !== after.get(f))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));

  console.log('\nGenerated pages\n');
  if (moved.length) {
    console.log('  FAIL  the committed pages are not what the generator writes');
    console.log(`        ${moved.length} file${moved.length > 1 ? 's' : ''} changed just now:`);
    for (const f of moved.slice(0, 8)) console.log(`          ${f}`);
    if (moved.length > 8) console.log(`          … and ${moved.length - 8} more`);
    console.log('        They are correct on disk now — commit them.');
    console.log('\n0/1 checks passed.\n');
    process.exit(1);
  }

  console.log('  PASS  every generated page is current');
  console.log(`        ${after.size} files, rebuilt and unchanged`);
  console.log('\n1/1 checks passed.\n');
}

main();
