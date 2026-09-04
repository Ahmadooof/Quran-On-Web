/**
 * Where every ayah and every word falls in a published recitation.
 *
 *   node scripts/fetch-audio-timing.js 2 --reciter 159
 *
 * Writes public/surah/<n>/<nnn>.<id>.timing.json from a segmentation somebody
 * has already made and checked.
 *
 * This, or scripts/import-qul-timing.js, is where every timing file comes
 * from. There was once a third way — measuring the loudness of a recording,
 * working out from the shape of the sound where each ayah must end, and
 * spreading the words across it by how long each ought to take. It is gone.
 * Times arrived at that way sit in the file looking exactly like measured
 * ones and are wrong in a way nobody can see: the highlight drifts, and there
 * is nothing to check it against. A recitation nobody has segmented is a
 * recitation this reader does not offer.
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
const rec = require('./recitations');

const HOST = 'https://quran.com/api/proxy/content/api/qdc';

const EOL = String.fromCharCode(10);

function usage() {
  console.error('usage: node scripts/fetch-audio-timing.js <surah 1-114 | all> [--reciter <id>] [--audio <url>]');
  console.error('       --reciter defaults to 159 (Maher al-Muaiqly, year 1440)');
  console.error('       --audio   the recording these timings describe, when the');
  console.error('                 catalogue names one they do not fit. <nnn> and <n>');
  console.error('                 stand for the surah number.');
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
 * a Latin name dropped into an Arabic sentence reads as a database field.
 *
 * This catalogue tags some entries "beta" in English and تجريبي in Arabic —
 * their word about their own data, not a part of anyone's name, so it comes off
 * rather than being repeated to readers. Worth knowing all the same: it is why
 * those recitations are absent from their public reciter list.
 *
 * The tag is matched loosely because it is not spelled reliably: one entry
 * carries تجريي, a letter short of the word. Anchored to the exact spelling,
 * the strip missed it and the reciter went into the picker, and into every
 * page's schema, with a note about someone else's data hanging off his name.
 */
async function reciterNames(id) {
  const one = async (locale) => {
    const d = await get(HOST + '/audio/reciters?locale=' + locale);
    const r = (d.reciters || []).find(x => x.id === id);
    if (!r) return null;
    const t = (r.translated_name && r.translated_name.name) || r.name;
    return String(t).replace(/\s*[-–—]\s*(تجري\S*|beta)\s*$/i, '').trim();
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

const slug = rec.slug;

async function build(surah, reciter, audio) {
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
      '  Pick a segmented reciter — word times are never inferred here.');
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
    /* Which recording these timings actually describe.
     *
     * Normally the catalogue's own answer, since the timings and the url come
     * out of one reply and ought to be the same thing. For one reciter they
     * were not: Yasser Ad-Dussary's segmentation is made against the master at
     * quran/yasser_ad-dussary/, while the reply hands out a re-encode at
     * qdc/yasser_ad-dussary/mp3/ that carries about three seconds more before
     * the first ayah. Both are the same recitation and very nearly the same
     * length, so nothing about the pair looks wrong — the ayahs simply all
     * begin three seconds late, and clicking one lands inside it.
     *
     * Hence --audio. The times are never touched; only the recording they are
     * hung on is corrected. */
    sourceAudio: audio
      ? audio.replace(/<nnn>/g, String(surah).padStart(3, '0')).replace(/<n>/g, String(surah))
      : file.audio_url,
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
  const dest = rec.timingFile(out.surah, rec.idOf(out));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out));
  return dest;
}

/**
 * Every surah in one go.
 *
 * A surah this reciter has no segmentation for is reported and skipped rather
 * than failing the run: the reader falls back to the default recording there,
 * and nothing invents times for the gap. The summary at the end exists so
 * that a gap is something you are told about now rather than something you
 * discover in the reader later.
 */
async function all(reciter, audio) {
  const done = [], skipped = [], mismatched = [];
  let bytes = 0;

  for (let n = 1; n <= 114; n++) {
    process.stdout.write('  ' + String(n).padStart(3) + '  ');
    try {
      const { out, wrong, total } = await build(n, reciter, audio);
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
  const j = process.argv.indexOf('--audio');
  const audio = j > 0 ? process.argv[j + 1] : null;
  if (!reciter) usage();

  if (which === 'all') return all(reciter, audio);

  const surah = parseInt(which, 10);
  if (!(surah >= 1 && surah <= 114)) usage();

  const { out, wrong, segmented, total } = await build(surah, reciter, audio);

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
