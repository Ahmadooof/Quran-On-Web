/**
 * Builds and pushes the three published tags.
 *
 *   node scripts/docker-release.js            # build all three, push none
 *   node scripts/docker-release.js --push     # and push them
 *   node scripts/docker-release.js --push latest slim
 *
 * They differ only in which recitations are in the build context, which
 * .dockerignore decides — so this rewrites that file per tag and puts it back,
 * rather than leaving anyone to remember which lines to comment out. Getting
 * that wrong is silent: the build succeeds and the image is just missing its
 * audio.
 *
 * Only a machine holding public/audio/ can build the two audio tags. That
 * folder is 5.5 GB and gitignored, so CI cannot do this and a clone cannot
 * reproduce them.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..');
const IGNORE = path.join(ROOT, '.dockerignore');
const AUDIO  = path.join(ROOT, 'public', 'audio');
const REPO   = 'ahmadooof/quran';

const TAGS = {
  // the default: the reader, and one voice to hear it in
  latest: { reciters: ['maher-al-muaiqly-qul'], audio: '/audio' },
  // the reader alone, for a copy whose audio comes from a host of its own
  slim:   { reciters: [], audio: '' },
  // every recitation there is
  full:   { reciters: 'all', audio: '/audio' },
};

const reciters = () => fs.existsSync(AUDIO)
  ? fs.readdirSync(AUDIO).filter((d) => fs.statSync(path.join(AUDIO, d)).isDirectory())
  : [];

/** The ignore file with exactly these reciters let through. */
function ignoreFor(wanted) {
  const was = fs.readFileSync(IGNORE, 'utf8');
  return was.split('\n').map((line) => {
    const m = /^#?\s*!public\/audio\/(.+)$/.exec(line.trim());
    if (!m) return line;
    return wanted.includes(m[1]) ? `!public/audio/${m[1]}` : `# !public/audio/${m[1]}`;
  }).join('\n');
}

function build(tag, push) {
  const spec = TAGS[tag];
  const here = reciters();
  const wanted = spec.reciters === 'all' ? here : spec.reciters;

  const missing = wanted.filter((r) => !here.includes(r));
  if (missing.length) {
    throw new Error(`${tag} wants ${missing.join(', ')}, which is not in public/audio/`);
  }

  const kept = fs.readFileSync(IGNORE, 'utf8');
  fs.writeFileSync(IGNORE, ignoreFor(wanted));
  try {
    console.log('\n%s  %s', tag, wanted.length ? wanted.join(', ') : 'no recitations');
    execFileSync('docker', [
      'build', '-t', `${REPO}:${tag}`, '--build-arg', `AUDIO=${spec.audio}`, '.',
    ], { cwd: ROOT, stdio: 'inherit' });
  } finally {
    fs.writeFileSync(IGNORE, kept);   // put it back even if the build failed
  }

  if (push) execFileSync('docker', ['push', `${REPO}:${tag}`], { stdio: 'inherit' });
}

function main() {
  const args = process.argv.slice(2);
  const push = args.includes('--push');
  const asked = args.filter((a) => !a.startsWith('--'));
  const tags = asked.length ? asked : Object.keys(TAGS);

  for (const tag of tags) {
    if (!TAGS[tag]) throw new Error(`no such tag: ${tag} (have ${Object.keys(TAGS).join(', ')})`);
  }
  for (const tag of tags) build(tag, push);

  console.log('\n%s %s', tags.join(', '), push ? 'built and pushed' : 'built');
}

main();
