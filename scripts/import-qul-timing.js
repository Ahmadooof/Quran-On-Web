/**
 * Where every ayah and every word falls in a recitation QUL has segmented.
 *
 *   node scripts/import-qul-timing.js all --slug saad-al-ghamdi
 *        --name "Saad al-Ghamdi" --name-ar "سعد الغامدي"
 *
 * The export is two files — surah.json, naming the recording each surah's
 * timings belong to, and segments.json, holding the word segments keyed
 * "<surah>:<ayah>" — read from qul/<slug>/ unless --from says otherwise.
 *
 * Writes public/surah/<n>/<nnn>.<id>.timing.json, the same file
 * fetch-audio-timing.js writes and the reader cannot tell apart. The id is the
 * recitation's, so a second recording by the same reciter sits beside the
 * first rather than on top of it; name it in public/data/recitations.json and
 * the reader offers it.
 *
 * Prefer this over quran.com wherever both have a recitation. A QUL export
 * carries the url of the recording it was made against, so the timings and the
 * audio are one matched pair by construction. quran.com hands out a
 * segmentation and an audio url in the same reply which are not always the
 * same cut — that is not a hypothetical, and the failure is silent: every ayah
 * began three seconds late for one reciter here, and every check but listening
 * passed.
 *
 * Three things are checked or corrected on the way through, because a
 * segmentation can be complete and still be wrong in ways the times never show:
 *
 *   The word count per ayah has to be the mushaf's, or every index after the
 *   disagreement lights the wrong word.
 *
 *   Segments come in the order they are recited, and where a reciter goes back
 *   over a phrase the indices go back with him — that is the format working as
 *   intended, not a fault. What is a fault is a pair of neighbours whose
 *   labels are swapped while their times run on: the audio cannot say a later
 *   word first, so the labels are what is wrong. Those are corrected, and only
 *   those — a single swap that leaves the ayah strictly ascending is provably
 *   a mislabel, while anything more tangled might be a genuine repeat and is
 *   reported rather than guessed at.
 *
 *   And where the recording is already on disk it is measured and believed
 *   over the export, which states a length taken from some other cut of the
 *   same recitation. Only the closing time is ever moved, and how many surahs
 *   needed it is reported — one reciter needed all but one, which is worth
 *   seeing rather than silently accepting. An ayah that *starts* after the
 *   audio ends is a different matter: that means the pair do not belong
 *   together at all, and it stops rather than papering over it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rec = require('./recitations');
const EOL = String.fromCharCode(10);

function usage() {
  console.error('usage: node scripts/import-qul-timing.js <surah 1-114 | all> --name <name> [options]');
  console.error('       --name <name>     reciter, in English            (required)');
  console.error('       --slug <slug>     the recitation id              (default: from --name)');
  console.error('       --name-ar <name>  reciter, in Arabic');
  console.error('       --from <dir>      the QUL export                 (default: qul/<slug>)');
  process.exit(1);
}

const slugify = rec.slug;

/** How many words each ayah of this surah is printed with. */
function mushafWordCounts(surah) {
  const counts = {};
  require(path.join(ROOT, 'reference', 'words.json'))
    .filter(w => w.s === surah && w.type === 'word')
    .forEach(w => { counts[w.v] = (counts[w.v] || 0) + 1; });
  return counts;
}

/**
 * The one repair this makes: two neighbours whose labels are swapped.
 *
 * Returns the corrected segments, or null where the order is either already
 * sound or too tangled to call. Descents are counted first because a
 * recitation that doubles back has many, and this must keep its hands off
 * those: only a sequence one swap away from strictly ascending is touched.
 */
function unswap(segs) {
  const idx = segs.map(s => s[0]);
  const descents = [];
  for (let i = 1; i < idx.length; i++) if (idx[i] < idx[i - 1]) descents.push(i);
  if (descents.length !== 1) return null;

  const i = descents[0];
  const fixed = idx.slice();
  const t = fixed[i - 1]; fixed[i - 1] = fixed[i]; fixed[i] = t;
  for (let k = 1; k < fixed.length; k++) if (fixed[k] <= fixed[k - 1]) return null;

  const out = segs.map(s => s.slice());
  out[i - 1][0] = idx[i];
  out[i][0] = idx[i - 1];
  return out;
}

const mp3Seconds = rec.mp3Seconds;

function build(surah, data, who) {
  const meta = data.surahs[String(surah)];
  if (!meta) throw new Error('surah ' + surah + ' is not in surah.json');

  const counts = mushafWordCounts(surah);
  const keys = Object.keys(counts).map(Number).sort((a, b) => a - b);

  const out = {
    surah: surah,
    reciter: who.name,
    reciterAr: who.nameAr,
    source: 'qul.tarteel.ai',
    sourceAudio: meta.audio_url,
    audio: String(surah).padStart(3, '0') + '.mp3',
    audioPath: who.slug + '/' + String(surah).padStart(3, '0') + '.mp3',
    duration: +meta.duration,
    opening: 0,
    ayah: [],
    word: [],
  };

  const wrong = [], tangled = [];
  let swapped = 0;

  for (const n of keys) {
    const v = data.segments[surah + ':' + n];
    if (!v || !v.segments || !v.segments.length) {
      throw new Error('ayah ' + surah + ':' + n + ' has no segments');
    }
    const from = v.timestamp_from;
    out.ayah.push([from, v.timestamp_to]);
    if (n === keys[0]) out.opening = from;

    let segs = v.segments.filter(s => s.length >= 3);
    const fixed = unswap(segs);
    if (fixed) { segs = fixed; swapped++; }
    else if (segs.some((s, i) => i && s[0] < segs[i - 1][0])) tangled.push(n);

    /* [how far into the ayah, which word], flat and one after another, so the
       places where the reciter goes back over a phrase survive. */
    const steps = [];
    for (const s of segs) steps.push(s[1] - from, s[0] - 1);
    out.word.push(steps);

    const distinct = new Set(segs.map(s => s[0]));
    const highest = Math.max.apply(null, Array.from(distinct));
    if (distinct.size !== counts[n] || highest !== counts[n]) {
      wrong.push(n + ': ' + distinct.size + '/' + highest + ' vs ' + counts[n]);
    }
  }

  /* The recording itself, where it is already here, over what the export says
     about it. Only the closing time is ever moved: an ayah that starts after
     the audio ends would mean the alignment is wrong rather than padded, and
     that is not something to paper over, so it is reported instead. */
  const file = rec.audioFile(surah, who.slug);
  let clamped = null;
  if (fs.existsSync(file)) {
    const real = mp3Seconds(file);
    const ms = Math.round(real * 1000);
    const last = out.ayah[out.ayah.length - 1];
    if (out.ayah.some(a => a[0] >= ms)) {
      throw new Error('surah ' + surah + ': the audio is ' + real.toFixed(1)
        + 's but an ayah starts after it ends — these timings are not this recording');
    }
    if (last[1] > ms) { clamped = (last[1] - ms) / 1000; last[1] = ms; }
    out.duration = +real.toFixed(3);
  }

  return { out, wrong, tangled, swapped, clamped, total: keys.length };
}

function write(out) {
  const dest = rec.timingFile(out.surah, rec.idOf(out));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out));
  return dest;
}

function load(dir) {
  const read = (f) => {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) throw new Error('no ' + f + ' in ' + dir);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  };
  return { surahs: read('surah.json'), segments: read('segments.json') };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  const which = argv[0];

  /* No default reciter. There were four of these before long, and a default
     is only ever right for the first — it silently writes one recitation's
     name over another's timings the moment anyone forgets the flag. */
  const name = arg('name', null);
  const slug = arg('slug', name ? slugify(name) : null);
  if (!name || !slug) usage();

  const who = { name: name, nameAr: arg('name-ar', name), slug: slug };

  /* The export sits under its own id unless told otherwise, so the ordinary
     run needs no path at all. */
  const dir = path.resolve(ROOT, arg('from', path.join('qul', slug)));

  const data = load(dir);

  if (which === 'all') {
    const wrong = [], tangled = [], clamped = [];
    let swapped = 0, bytes = 0;
    for (let n = 1; n <= 114; n++) {
      const r = build(n, data, who);
      bytes += fs.statSync(write(r.out)).size;
      swapped += r.swapped;
      if (r.wrong.length) wrong.push(n + ' (' + r.wrong.join(', ') + ')');
      if (r.tangled.length) tangled.push(n + ':' + r.tangled.join(','));
      if (r.clamped) clamped.push(n + ' (' + r.clamped.toFixed(1) + 's)');
      process.stdout.write('  ' + String(n).padStart(3) + '  '
        + String(r.total).padStart(3) + ' ayahs, '
        + (r.out.duration / 60).toFixed(1).padStart(6) + ' min'
        + (r.clamped ? '   trimmed ' + r.clamped.toFixed(1) + 's of padding' : '')
        + (r.wrong.length ? '   WORD COUNTS DIFFER' : '') + EOL);
    }
    console.log(EOL + '  wrote     114 of 114   (' + (bytes / 1048576).toFixed(1) + ' MB)');
    console.log('  relabelled ' + swapped + ' ayah(s) whose words were named out of order');
    console.log(clamped.length
      ? '  trimmed   ' + clamped.length + ' surah(s) claimed to end after the audio does: '
        + clamped.join('  ')
      : '  trimmed   no surah claims to end after its audio does');
    console.log(tangled.length
      ? '  repeats   ' + tangled.length + ' surah(s) have ayahs the reciter goes back over: '
        + tangled.slice(0, 8).join('  ')
      : '  repeats   none');
    console.log(wrong.length
      ? '  CHECK     word counts differ from the mushaf in: ' + wrong.join('  ')
      : '  checked   word counts agree with the mushaf on every ayah of every surah');
    return;
  }

  const surah = parseInt(which, 10);
  if (!(surah >= 1 && surah <= 114)) usage();

  const r = build(surah, data, who);
  console.log(EOL + '  reciter    ' + r.out.reciter);
  console.log('  recording  ' + r.out.sourceAudio);
  console.log('  length     ' + (r.out.duration / 60).toFixed(2) + ' min');
  console.log('  ayahs      ' + r.total + ', all with word segments');
  console.log('  relabelled ' + r.swapped + ' ayah(s) whose words were named out of order');
  console.log('  trimmed    ' + (r.clamped
    ? r.clamped.toFixed(1) + 's the last ayah claimed after the audio ends'
    : 'nothing — the timings end where the audio does'));
  console.log('  repeats    ' + (r.tangled.length
    ? 'ayah ' + r.tangled.join(', ') + ' go back over a phrase' : 'none'));
  console.log('  word count ' + (r.wrong.length
    ? r.wrong.length + ' ayah(s) disagree with the mushaf: ' + r.wrong.slice(0, 6).join('  ')
    : 'agrees with the mushaf on every ayah'));

  const dest = write(r.out);
  console.log(EOL + '  wrote ' + path.relative(ROOT, dest)
    + '  (' + (fs.statSync(dest).size / 1024).toFixed(0) + ' KB)');
  console.log(EOL + '  Serve THIS recording as ' + r.out.audio + ' — the timings fit no other:');
  console.log('  ' + r.out.sourceAudio);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(EOL + '  ' + e.message + EOL); process.exit(1); }
}
module.exports = { build, load };
