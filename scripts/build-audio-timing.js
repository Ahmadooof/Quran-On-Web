/**
 * Where every ayah — and every word — falls in a surah's recitation.
 *
 *   node scripts/build-audio-timing.js 2
 *
 * Reads the loudness curve scripts/audio/envelope.html measured, and writes
 * public/surah/<n>/<nnn>.timing.json for the reader to follow along with.
 *
 * The problem is that a two-hour recitation is one file with no marks in it.
 * What it does have is pauses, because a reciter stops at the end of an ayah —
 * but he also breathes in the middle of a long one, and this recording is
 * compressed hard enough that its quietest moment is only about 25 dB below
 * its loudest, so "find the silences" alone yields several times too many.
 *
 * So the pauses are treated as candidates rather than as answers, and the
 * choice among them is made against how long each ayah ought to take. Length
 * is known from the text: recitation runs at a fairly even pace, so an ayah's
 * share of the surah's letters is close to its share of the surah's minutes.
 * A dynamic program then picks the one set of 286 boundaries that best trades
 * off landing in a real pause against giving each ayah the time it is due —
 * which is what makes a missing pause survivable, since the ayahs on either
 * side of it immediately look the wrong length.
 *
 * Within an ayah there is nothing to find: reciters do not pause between
 * words. The words are laid out over the ayah's span by the same measure of
 * length, but against *energy* rather than clock time — so a breath inside an
 * ayah is passed over rather than being counted as a word and a half, and the
 * highlight rests on the word being held instead of running ahead of it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, 'audio', 'cache');

/* ---------- how long a word takes to say -------------------------------- */

/* Letters are the bulk of it, and a plain letter is one unit. The marks that
   earn more are the ones that are held: a madd is drawn out to several times
   an ordinary vowel, a shadda doubles its consonant, tanween adds a syllable,
   and the dagger alif is a long vowel the orthography leaves unwritten. The
   short vowels, the sukun and the waqf marks add nothing — they are already
   paid for by the letter they sit on.

   This does not have to be exact. It is a prior: it decides which of several
   nearby pauses an ayah should end at, and picking the pause is a far coarser
   judgement than predicting a duration. */
const HELD = {
  'ً': 1, 'ٌ': 1, 'ٍ': 1,      // tanween
  'ّ': 1,                                 // shadda
  'ٰ': 1,                                 // dagger alif
  'ٓ': 3,                                 // maddah
  'ۥ': 1, 'ۦ': 1,                    // small waw and ya
};

/* The letters that open twenty-nine surahs — الٓمٓ, كٓهيعٓصٓ, طه — are not read
   as a word but spelled out, so each one costs its whole name: "alif laaam
   miiim" for three letters' worth of ink. Every name here is two beats except
   alif's three, and the maddah on some of them is the madd lazim, the longest
   there is, which the loop below pays for as it does any other maddah.

   Nothing else in the Quran is read this way, so the rule is worth stating
   plainly rather than trying to infer letter by letter. */
const MUQATTA = new Set('ابجحرسصطعقكلمنهي'.split(''));

function isLetter(c) {
  return (c >= 0x0621 && c <= 0x063A) || (c >= 0x0641 && c <= 0x064A) ||
         c === 0x0649 || c === 0x0671;
}

/** Spelled out rather than read: only these letters, and not a vowel or a
    sukun among them, which no ordinary Arabic word manages. */
function spelledOut(text) {
  let letters = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (isLetter(c)) {
      if (!MUQATTA.has(ch)) return false;
      letters++;
    } else if (c >= 0x064B && c <= 0x0652) {
      return false;                       // a vowel or a sukun: an ordinary word
    }
  }
  return letters > 0;
}

function weigh(text) {
  const named = spelledOut(text);
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    /* Arabic letters, minus the tatweel at 0640 that only stretches the
       drawing, and minus the combining marks above 064A. */
    if (isLetter(c)) { w += named ? (ch === 'ا' ? 3 : 2) : 1; continue; }
    w += HELD[ch] || 0;
  }
  return w;
}

/* ---------- the loudness curve ------------------------------------------ */

function loadEnvelope(surah) {
  const stem = path.join(CACHE, String(surah).padStart(3, '0'));
  if (!fs.existsSync(stem + '.env')) {
    throw new Error('no envelope for surah ' + surah + '.\n' +
      'Start the server with --audio-tools, open /audio-tools/envelope.html\n' +
      'and measure it first.');
  }
  const meta = JSON.parse(fs.readFileSync(stem + '.json', 'utf8'));
  const raw = fs.readFileSync(stem + '.env');
  const span = meta.ceil - meta.floor;

  const db = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) db[i] = meta.floor + (raw[i] / 255) * span;
  return { db, hop: meta.hop, duration: meta.duration };
}

/** A mean over ±r samples. 70 ms of smoothing takes the flutter out of the
    curve without blunting a pause worth finding. */
function smooth(a, r) {
  const n = a.length, out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < Math.min(r, n); i++) sum += a[i];
  for (let i = 0; i < n; i++) {
    const add = i + r, drop = i - r - 1;
    if (add < n) sum += a[add];
    if (drop >= 0) sum -= a[drop];
    out[i] = sum / (Math.min(n - 1, i + r) - Math.max(0, i - r) + 1);
  }
  return out;
}

/**
 * How loud the recitation is around each moment — the level a pause is a drop
 * from. Taken as a high percentile of a window either side, so it follows the
 * recording's own drift instead of assuming one level for two hours, and is
 * not itself pulled down by the pauses it is meant to measure.
 */
function speechLevel(db, hop) {
  const n = db.length;
  const win = Math.round(15 / hop);             // 15 s either side
  const step = Math.round(1 / hop);             // recomputed once a second
  const knots = [];
  for (let c = 0; c < n; c += step) {
    const a = Math.max(0, c - win), z = Math.min(n, c + win);
    const s = Array.prototype.slice.call(db.subarray(a, z)).sort((x, y) => x - y);
    knots.push(s[Math.floor(s.length * 0.8)]);
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = i / step, k = Math.min(knots.length - 1, Math.floor(p));
    const k2 = Math.min(knots.length - 1, k + 1), f = p - k;
    out[i] = knots[k] * (1 - f) + knots[k2] * f;
  }
  return out;
}

/* A pause is scored over a quarter second, not at a point: what tells an ayah
   ending from a consonant's stop is that the quiet lasts. */
const PAUSE_WINDOW = 0.25;
/* Past 25 dB down it is silence either way, and letting a deep dip go on
   scoring would rank one very quiet moment above a longer, real pause. */
const DIP_CAP = 25;

/**
 * Every moment that could be the end of an ayah, and how much of a pause it
 * is. Local peaks of "how far below the recitation's level is it, right here,
 * for a quarter of a second" — which finds every real pause, at the cost of
 * finding perhaps three times too many. Choosing among them is the DP's job.
 */
function candidates(db, hop) {
  const n = db.length;
  const sm = smooth(db, Math.round(0.035 / hop));
  const level = speechLevel(db, hop);

  const dip = new Float64Array(n);
  for (let i = 0; i < n; i++) dip[i] = Math.min(DIP_CAP, Math.max(0, level[i] - sm[i]));

  const r = Math.round(PAUSE_WINDOW / hop / 2);
  const score = smooth(dip, r);

  /* Local maxima, thinned so two candidates are never within 200 ms of each
     other — the same pause found twice is not two places to end an ayah. */
  const apart = Math.round(0.2 / hop);
  const at = [], sc = [];
  for (let i = 1; i < n - 1; i++) {
    if (score[i] < 2) continue;                       // flat: not a pause at all
    if (score[i] < score[i - 1] || score[i] < score[i + 1]) continue;
    if (at.length && i - at[at.length - 1] < apart) {
      if (score[i] > sc[sc.length - 1]) { at[at.length - 1] = i; sc[sc.length - 1] = score[i]; }
      continue;
    }
    at.push(i); sc.push(score[i]);
  }
  return { at, score: sc, level, sm };
}

/**
 * Where the recitation starts — the first sound that lasts, so that a click or
 * a moment of hiss at the head of the file is not mistaken for it.
 */
function onset(db, level, hop) {
  const need = Math.round(0.25 / hop);
  let run = 0;
  for (let i = 0; i < db.length; i++) {
    if (db[i] > level[i] - 12) {
      if (++run >= need) return i - need;
    } else run = 0;
  }
  return 0;
}

/**
 * Where the first ayah begins.
 *
 * Most recordings open with the isti'adhah and the Basmalah, which are recited
 * but belong to no ayah; some start on the first ayah outright. Rather than
 * assume either, measure: if the stretch between the first sound and the first
 * real pause is about as long as the Basmalah should take, that is what it
 * was, and the first ayah starts after it. Otherwise the recitation began at
 * the first sound.
 *
 * This has to be decided here and not left to the alignment, because an
 * opening of no fixed length is one the alignment will always make longer —
 * every ayah is elastic, so sliding the whole surah later costs it nothing.
 */
function firstAyah(cand, from, basmalah) {
  const strong = cand.score.slice().sort((a, b) => b - a)[Math.floor(cand.at.length * 0.25)];

  let head = -1;
  for (let i = 0; i < cand.at.length; i++) {
    if (cand.at[i] <= from) continue;
    if (cand.score[i] < strong) continue;
    head = cand.at[i];
    break;
  }
  if (head > 0 && head - from > basmalah * 0.7 && head - from < basmalah * 1.6) return head;

  /* No Basmalah: start at the candidate nearest the first sound, so the ayah
     opens on the silence before it rather than a syllable into the word. */
  let best = from, gap = Infinity;
  for (let i = 0; i < cand.at.length; i++) {
    const d = Math.abs(cand.at[i] - from);
    if (d < gap) { gap = d; best = cand.at[i]; }
  }
  return best;
}

/* ---------- choosing which pauses are the ayah endings ------------------- */

/* What a pause is worth against being the right length. Raise it and the
   boundaries snap to the deepest silences whatever that does to the lengths;
   lower it and they drift to wherever the arithmetic wants, pause or no
   pause. At 0.09 a full-depth pause is worth about as much as being 30% off
   the expected length, which is roughly how much ayah-to-ayah variation the
   letter count fails to predict. */
const PAUSE_WEIGHT = 0.09;

/* An ayah may run to two and a half times what its letters suggest, or down to
   two fifths. Outside that the pairing is not a near miss to be scored, it is
   wrong — and refusing to consider it is also what keeps the search small. */
const SLOWEST = 2.5;
const FASTEST = 0.4;

/**
 * Fit the segments to the candidates: one boundary each, in order, cheapest
 * overall. Segment 0 is the opening — the isti'adhah and the Basmalah, which
 * are recited but are not ayahs — and is allowed whatever length it turns out
 * to have; the rest are the ayahs, each with the length its letters predict.
 *
 * Cost is the log of how far off the length is, squared, so that running to
 * twice the expected time and to half of it cost the same. Straight ratios
 * would make every ayah rather short and one enormous, which is exactly the
 * failure a missing pause causes.
 */
function align(cand, expected, start) {
  const C = cand.at.length;
  const S = expected.length;                    // segments, the opening included
  const INF = Infinity;

  const cost = new Float64Array(S * C).fill(INF);
  const from = new Int32Array(S * C).fill(-1);

  /* Normalised so a candidate's pause is worth PAUSE_WEIGHT at its deepest. */
  const best = Math.max.apply(null, cand.score);
  const bonus = i => PAUSE_WEIGHT * (cand.score[i] / best);

  /* The opening is settled before the search begins, so there is exactly one
     place the first ayah can start from. */
  for (let j = 0; j < C; j++) if (cand.at[j] === start) { cost[j] = 0; break; }

  for (let s = 1; s < S; s++) {
    const e = expected[s];
    const lo = e * FASTEST, hi = e * SLOWEST;
    const row = s * C, prev = row - C;

    /* Both ends of the reachable window only move forward as j does, so they
       are carried along rather than searched for each time. */
    let a = 0, b = 0;
    for (let j = 0; j < C; j++) {
      const t = cand.at[j];
      while (a < j && t - cand.at[a] > hi) a++;
      while (b < j && t - cand.at[b] >= lo) b++;

      let bestCost = INF, bestFrom = -1;
      for (let i = a; i < b; i++) {
        const c = cost[prev + i];
        if (c === INF) continue;
        const r = Math.log((t - cand.at[i]) / e);
        const total = c + r * r;
        if (total < bestCost) { bestCost = total; bestFrom = i; }
      }
      if (bestFrom < 0) continue;
      cost[row + j] = bestCost - bonus(j);
      from[row + j] = bestFrom;
    }
  }

  /* The last ayah ends where the recitation does, so the final boundary is the
     last candidate the DP could reach rather than the cheapest one. */
  let end = -1;
  for (let j = C - 1; j >= 0; j--) {
    if (cost[(S - 1) * C + j] < INF) { end = j; break; }
  }
  if (end < 0) throw new Error('no alignment found — is this the right recitation?');

  const marks = new Array(S);
  for (let s = S - 1, j = end; s >= 0; s--) { marks[s] = cand.at[j]; j = from[s * C + j]; }
  return marks;
}

/* ---------- laying the words out inside an ayah -------------------------- */

/* Anything this far below the recitation's level is a breath or a room, not a
   word, and counts for nothing when the words are spread over the ayah. */
const GATE_DB = 18;

/**
 * Where each word of an ayah begins.
 *
 * Not by clock time: an ayah with a breath in the middle would put the
 * highlight a word or two ahead by the time the reciter came back. By energy —
 * a word gets the stretch of the ayah holding its share of the sound — so
 * silence inside an ayah costs no words at all and a held syllable gets the
 * time it is actually held.
 */
function placeWords(db, level, from, to, weights) {
  const power = new Float64Array(to - from + 1);
  let total = 0;
  for (let i = from; i < to; i++) {
    const gate = Math.pow(10, (level[i] - GATE_DB) / 10);
    const p = Math.max(0, Math.pow(10, db[i] / 10) - gate);
    total += p;
    power[i - from + 1] = total;                // running sum, one past the start
  }

  const sum = weights.reduce((a, b) => a + b, 0);
  const starts = [from];
  if (total <= 0 || sum <= 0) {
    /* Silence, or an ayah with nothing to weigh: fall back to even spacing
       rather than piling every word onto the first frame. */
    for (let k = 1; k < weights.length; k++) {
      starts.push(from + Math.round((to - from) * k / weights.length));
    }
    return starts;
  }

  let want = 0, i = 0;
  for (let k = 0; k < weights.length - 1; k++) {
    want += weights[k] / sum * total;
    while (i < power.length - 1 && power[i] < want) i++;
    starts.push(Math.min(to - 1, from + i));
  }
  return starts;
}

/* ---------- putting it together ------------------------------------------ */

function build(surah, reciter) {
  const words = require(path.join(ROOT, 'reference', 'words.json'))
    .filter(w => w.s === surah);
  if (!words.length) throw new Error('no words for surah ' + surah);

  const { db, hop, duration } = loadEnvelope(surah);

  /* Grouped into ayahs, keeping the closing number out of it: it is printed,
     not recited, so it must not be given a share of the sound. */
  const ayahs = [];
  for (const w of words) {
    let a = ayahs[ayahs.length - 1];
    if (!a || a.v !== w.v) { a = { v: w.v, spoken: [], weights: [] }; ayahs.push(a); }
    if (w.type === 'end') continue;
    a.spoken.push(w);
    a.weights.push(Math.max(1, weigh(w.text)));
  }

  const total = ayahs.reduce((s, a) => s + a.weights.reduce((x, y) => x + y, 0), 0);

  const cand = candidates(db, hop);

  /* The Basmalah is not part of any surah's count but is recited before all
     but one of them, so how long it takes is worth knowing before deciding
     whether this recording opens with it. Its own words are Al-Fatihah's
     first ayah, and the rough pace comes from the file as a whole. */
  const basmalah = require(path.join(ROOT, 'reference', 'words.json'))
    .filter(w => w.s === 1 && w.v === 1 && w.type === 'word')
    .reduce((s, w) => s + weigh(w.text), 0);

  const head = firstAyah(cand, onset(db, cand.level, hop),
                         basmalah / total * db.length);

  const speech = db.length - head;
  const expected = [0].concat(ayahs.map(
    a => a.weights.reduce((x, y) => x + y, 0) / total * speech));
  const marks = align(cand, expected, head);

  /* Times as whole milliseconds: the highlight is a thing on a screen, and no
     eye is going to catch a hundredth of a second. */
  const ms = f => Math.round(f * hop * 1000);

  const out = {
    surah: surah,
    reciter: reciter || null,
    /* Ayah boundaries are found in the recording; word times are laid out
       across them. Recorded on the file so that anyone reading one knows which
       numbers were measured and which were inferred. */
    source: 'envelope',
    audio: String(surah).padStart(3, '0') + '.mp3',
    duration: +duration.toFixed(3),
    /* Where the first ayah starts — everything before it is the isti'adhah and
       the Basmalah, which the reader shows as an opening rather than as text
       being read. */
    opening: ms(marks[0]),
    ayah: [],
    word: [],
  };

  for (let i = 0; i < ayahs.length; i++) {
    const from = marks[i], to = marks[i + 1];
    out.ayah.push([ms(from), ms(to)]);
    const starts = placeWords(db, cand.level, from, to, ayahs[i].weights);
    /* Pairs: how far into the ayah, and which word starts then. Nothing here
       ever goes backwards, so the second half of each pair is just the word's
       position — but the timings fetched from a published segmentation do go
       backwards where the reciter repeats a phrase, and the reader has one way
       of reading both. */
    const steps = [];
    starts.forEach((f, k) => steps.push(ms(f) - ms(from), k));
    out.word.push(steps);
  }

  return { out, ayahs, hop, cand };
}

/* ---------- what the fit looks like -------------------------------------- */

/**
 * The check that the alignment is right at all.
 *
 * Nothing here can listen, so the test is whether the answer holds together:
 * if the boundaries are the real ones, an ayah's measured length tracks its
 * letter count closely, because that is how reciting works. If they have
 * slipped, some ayah has been given its neighbour's time and the agreement
 * collapses — long before it would be obvious from any single number.
 */
function report(out, ayahs) {
  const durations = out.ayah.map(a => (a[1] - a[0]) / 1000);
  const weights = ayahs.map(a => a.weights.reduce((x, y) => x + y, 0));
  const n = durations.length;

  const mean = a => a.reduce((x, y) => x + y, 0) / n;
  const md = mean(durations), mw = mean(weights);
  let sdw = 0, sd = 0, sw = 0;
  for (let i = 0; i < n; i++) {
    sdw += (durations[i] - md) * (weights[i] - mw);
    sd += (durations[i] - md) ** 2;
    sw += (weights[i] - mw) ** 2;
  }
  const r = sdw / Math.sqrt(sd * sw);

  /* Seconds per letter, and how steady it is. A reciter holds a pace; a
     boundary in the wrong place shows up as an ayah at twice or half it. */
  const pace = durations.map((d, i) => d / weights[i]);
  const sorted = pace.slice().sort((a, b) => a - b);
  const q = p => sorted[Math.floor(p * n)];
  const strays = pace.filter(p => p < q(0.5) * 0.6 || p > q(0.5) * 1.7).length;

  console.log('\n  ayahs            ' + n);
  console.log('  opening          ' + (out.opening / 1000).toFixed(1) + ' s');
  console.log('  shortest ayah    ' + Math.min.apply(null, durations).toFixed(1) + ' s');
  console.log('  longest ayah     ' + Math.max.apply(null, durations).toFixed(1) + ' s');
  console.log('  length vs text   r = ' + r.toFixed(4));
  console.log('  pace             ' + q(0.5).toFixed(3) + ' s/letter'
              + '  (p10 ' + q(0.1).toFixed(3) + ', p90 ' + q(0.9).toFixed(3) + ')');
  console.log('  off the pace     ' + strays + ' ayah' + (strays === 1 ? '' : 's'));
  return { r, strays };
}

function main() {
  const surah = parseInt(process.argv[2], 10);
  if (!(surah >= 1 && surah <= 114)) {
    console.error('usage: node scripts/build-audio-timing.js <surah 1-114> [--reciter "Name"]');
    process.exit(1);
  }

  const reciter = process.argv.includes('--reciter')
    ? process.argv[process.argv.indexOf('--reciter') + 1] : null;
  const { out, ayahs, cand } = build(surah, reciter);
  console.log('surah ' + surah + ': ' + cand.at.length + ' candidate pauses for '
              + ayahs.length + ' ayahs');
  const fit = report(out, ayahs);

  const dir = path.join(ROOT, 'public', 'surah', String(surah));
  const file = path.join(dir, String(surah).padStart(3, '0') + '.timing.json');
  fs.writeFileSync(file, JSON.stringify(out));
  console.log('\n  wrote ' + path.relative(ROOT, file)
              + '  (' + (fs.statSync(file).size / 1024).toFixed(0) + ' KB)');

  if (fit.r < 0.9) {
    console.log('\n  WARNING: the lengths do not track the text closely enough.');
    console.log('  The boundaries have probably slipped somewhere.');
  }
}

if (require.main === module) main();
module.exports = { build, weigh };
