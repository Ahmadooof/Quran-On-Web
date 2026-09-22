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

/** The recitations that exist, which is what the site offers — not what happens
    to be on this disk. `full` claiming otherwise is how it ended up missing one. */
const offered = () => JSON.parse(
  fs.readFileSync(path.join(ROOT, 'public', 'data', 'recitations.json'), 'utf8'))
  .recitations.map((r) => r.id);

const here = () => fs.existsSync(AUDIO)
  ? fs.readdirSync(AUDIO).filter((d) => fs.statSync(path.join(AUDIO, d)).isDirectory())
  : [];

/** The ignore file with exactly these reciters let through.
 *
 * The lines are written from what is on disk rather than toggled in place.
 * Toggling only ever reached the reciters already named in the file, so a
 * newly fetched one stayed excluded and the build succeeded without it —
 * which is how :full first shipped four of the five. */
function ignoreFor(wanted) {
  const lines = fs.readFileSync(IGNORE, 'utf8').split('\n')
    .filter((l) => !/^#?\s*!public\/audio\//.test(l.trim()));

  const at = lines.findIndex((l) => l.trim() === 'public/audio');
  if (at < 0) throw new Error('.dockerignore no longer excludes public/audio');

  const rules = here().sort()
    .map((id) => (wanted.includes(id) ? '' : '# ') + `!public/audio/${id}`);

  lines.splice(at + 1, 0, ...rules);
  return lines.join('\n');
}

function build(tag, push) {
  const spec = TAGS[tag];
  const have = here();
  const wanted = spec.reciters === 'all' ? offered() : spec.reciters;

  const missing = wanted.filter((r) => !have.includes(r));
  if (missing.length) {
    throw new Error(`${tag} needs ${missing.join(', ')}, which recitations.json offers `
      + 'but public/audio/ does not hold. Fetch them, or the image ships a reciter '
      + 'the reader lists and cannot play.');
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
