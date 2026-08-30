/**
 * Where every ayah and every word falls in a published recitation.
 *
 *   node scripts/fetch-audio-timing.js 2 --reciter 159
 *
 * Writes public/surah/<n>/<nnn>.timing.json, the same file
 * build-audio-timing.js writes and the reader cannot tell apart — but from a
 * segmentation somebody has already made and checked, rather than one worked
 * out from the shape of the sound. Where a recitation has been segmented this
 * is the better source by a long way: the word times are measured rather than
 * spread across the ayah by how long each word ought to take.
 *
 * Run once, per surah. The result is committed and served from here; nothing
 * at runtime ever asks quran.com for anything.
 *
 * Two things to know before trusting the output:
 *
 *   The timings belong to one recording, not to a reciter. Maher has three on
 *   quranicaudio and they are 99, 108 and 135 minutes long; only the last is
 *   segmented. Play these timings over either of the others and they are
 *   nonsense. The audio_url this prints is the file they describe — serve that
 *   one, or none.
 *
 *   The published API at api.quran.com answers this same query with the
 *   verse timings present and every segments array empty. The site's own proxy
 *   answers with the segments. That is why the host below is quran.com and not
 *   the documented API, and why it sends a Referer.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const HOST = 'https://quran.com/api/proxy/content/api/qdc';

const EOL = String.fromCharCode(10);

function usage() {
  console.error('usage: node scripts/fetch-audio-timing.js <surah 1-114 | all> [--reciter <id>]');
  console.error('       --reciter defaults to 159 (Maher al-Muaiqly, year 1440)');
  process.exit(1);
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'Referer': 'https://quran.com/', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(url + ' — ' + res.status);
  return res.json();
}

/**
 * The reciter's name in both scripts, for the record. Not worth failing over.
 *
 * The Arabic one matters because it is the one an Arabic page says out loud —
 * a Latin name dropped into an Arabic sentence reads as a database field. Note
 * This catalogue tags some entries "beta" in English and تجريبي in Arabic —
 * their word about their own data, not a part of anyone's name, so it comes off
 * rather than being repeated to readers. Worth knowing all the same: it is why
 * this recitation is absent from their public reciter list.
 */
async function reciterNames(id) {
  const one = async (locale) => {
    const d = await get(HOST + '/audio/reciters?locale=' + locale);
    const r = (d.reciters || []).find(x => x.id === id);
    if (!r) return null;
    const t = (r.translated_name && r.translated_name.name) || r.name;
    return String(t).replace(/\s*-\s*(تجريبي|beta)\s*$/i, '').trim();
  };
  try {
    const en = await one('en');
    const ar = await one('ar');
    return { en: en || null, ar: ar && ar !== en ? ar : null };
  } catch (e) { return { en: null, ar: null }; }
}

/**
 * How many words each ayah of this surah is printed with.
 *
 * The check that matters. A segmentation numbers the words of an ayah its own
 * way, and if that numbering is not the mushaf's then every index is off and
 * the highlight lands on the wrong word — quietly, since the times themselves
 * would still look perfectly reasonable.
 */
function mushafWordCounts(surah) {
  const counts = {};
  require(path.join(ROOT, 'reference', 'words.json'))
    .filter(w => w.s === surah && w.type === 'word')
    .forEach(w => { counts[w.v] = (counts[w.v] || 0) + 1; });
  return counts;
}

/* A reciter's name as a folder: lowercase, punctuation dropped, spaces to
   hyphens. "Maher al-Muaiqly" becomes maher-al-muaiqly. */
function slug(name) {
  return String(name || 'reciter').toLowerCase()
    .replace(/['`‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function build(surah, reciter) {
  const url = HOST + '/audio/reciters/' + reciter + '/audio_files'
            + '?chapter=' + surah + '&segments=true';
  const data = await get(url);
  const file = (data.audio_files || [])[0];
  if (!file) throw new Error('no audio file for reciter ' + reciter + ', surah ' + surah);

  const timings = file.verse_timings || [];
  if (!timings.length) throw new Error('this recitation has no timings at all');

  const segmented = timings.filter(v => v.segments && v.segments.length).length;
  if (!segmented) {
    throw new Error('this recitation has ayah timings but no word segments.\n' +
      '  ' + file.audio_url + '\n' +
      '  Use build-audio-timing.js for it, or pick a segmented reciter.');
  }

  const counts = mushafWordCounts(surah);
  const wrong = [];

  const names = await reciterNames(reciter);
  const out = {
    surah: surah,
    reciter: names.en,
    reciterAr: names.ar,
    /* Which recording, and where it came from. The timings are worthless
       against any other file, so the one they describe is named here. */
    source: 'quran.com',
    reciterId: reciter,
    sourceAudio: file.audio_url,
    audio: String(surah).padStart(3, '0') + '.mp3',
    /* Where the file sits under whatever base is serving the audio. Written
       here so the reader, the page schema and the upload all read one answer
       to "where is it" instead of each rebuilding the path their own way. */
    audioPath: slug(names.en) + '/' + String(surah).padStart(3, '0') + '.mp3',
    duration: +(file.duration / 1000).toFixed(3),
    opening: timings[0].timestamp_from,
    ayah: [],
    word: [],
  };

  for (const v of timings) {
    const n = +v.verse_key.split(':')[1];
    const from = v.timestamp_from;
    out.ayah.push([from, v.timestamp_to]);

    /* [word, start, end], one-based, absolute in the file. Kept as pairs of
       "how far into the ayah" and "which word", so that the places where the
       reciter goes back over a phrase survive — 26 ayahs of Al-Baqarah do. */
    const segs = (v.segments || []).filter(s => s.length >= 3);
    const steps = [];
    for (const s of segs) steps.push(s[1] - from, s[0] - 1);
    out.word.push(steps);

    const distinct = new Set(segs.map(s => s[0]));
    const highest = Math.max.apply(null, Array.from(distinct));
    if (distinct.size !== counts[n] || highest !== counts[n]) {
      wrong.push(n + ': ' + distinct.size + '/' + highest + ' vs ' + counts[n]);
    }
  }

  return { out, wrong, segmented, total: timings.length };
}

function write(out) {
  const dir = path.join(ROOT, 'public', 'surah', String(out.surah));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, String(out.surah).padStart(3, '0') + '.timing.json');
  fs.writeFileSync(dest, JSON.stringify(out));
  return dest;
}

/**
 * Every surah in one go.
 *
 * A surah this reciter has no segmentation for is reported and skipped rather
 * than failing the run: the reader simply offers no recitation there, and
 * build-audio-timing.js can still work one out from the sound if the file is to
 * hand. The summary at the end exists so that a gap is something you are told
 * about now rather than something you discover in the reader later.
 */
async function all(reciter) {
  const done = [], skipped = [], mismatched = [];
  let bytes = 0;

  for (let n = 1; n <= 114; n++) {
    process.stdout.write('  ' + String(n).padStart(3) + '  ');
    try {
      const { out, wrong, total } = await build(n, reciter);
      bytes += fs.statSync(write(out)).size;
      done.push(n);
      if (wrong.length) mismatched.push(n + ' (' + wrong.length + ')');
      console.log(String(total).padStart(3) + ' ayahs, '
                  + (out.duration / 60).toFixed(1).padStart(6) + ' min'
                  + (wrong.length ? '   WORD COUNTS DIFFER on ' + wrong.length : ''));
    } catch (e) {
      skipped.push(n);
      console.log('skipped — ' + e.message.split(EOL)[0]);
    }
  }

  console.log(EOL + '  wrote     ' + done.length + ' of 114   ('
              + (bytes / 1048576).toFixed(1) + ' MB)');
  if (skipped.length) console.log('  no data   ' + skipped.join(', '));
  console.log(mismatched.length
    ? '  CHECK     word counts differ from the mushaf in: ' + mismatched.join(', ')
    : '  checked   word counts agree with the mushaf on every ayah of every surah');
}

async function main() {
  const which = process.argv[2];
  const i = process.argv.indexOf('--reciter');
  const reciter = i > 0 ? parseInt(process.argv[i + 1], 10) : 159;
  if (!reciter) usage();

  if (which === 'all') return all(reciter);

  const surah = parseInt(which, 10);
  if (!(surah >= 1 && surah <= 114)) usage();

  const { out, wrong, segmented, total } = await build(surah, reciter);

  console.log('\n  reciter    ' + (out.reciter || reciter) + '  (id ' + reciter + ')');
  console.log('  recording  ' + out.sourceAudio);
  console.log('  length     ' + (out.duration / 60).toFixed(2) + ' min');
  console.log('  ayahs      ' + total + ', ' + segmented + ' with word segments');
  console.log('  word count ' + (wrong.length
    ? wrong.length + ' ayah(s) disagree with the mushaf: ' + wrong.slice(0, 6).join('  ')
    : 'agrees with the mushaf on every ayah'));

  const dest = write(out);
  console.log('\n  wrote ' + path.relative(ROOT, dest)
              + '  (' + (fs.statSync(dest).size / 1024).toFixed(0) + ' KB)');
  console.log('\n  Serve THIS recording as ' + out.audio + ' — the timings fit no other:');
  console.log('  ' + out.sourceAudio);
}

if (require.main === module) {
  main().catch(e => { console.error('\n  ' + e.message + '\n'); process.exit(1); });
}
module.exports = { build };
