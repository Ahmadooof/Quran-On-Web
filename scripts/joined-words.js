/**
 * Two recited words that the mushaf prints in one glyph slot.
 *
 * بَعْدَ مَا (2:181, 8:6, 13:37) is two words drawn as one slot of two glyphs.
 * The reader splits that slot into its halves, so each word is marked as it is
 * recited; the timings are made to name both, which some segmentations do not.
 *
 * إِلْ يَاسِينَ (37:130) is one name, and most segmentations time it so. Where one
 * counts two, both are pointed at the one slot and the rest moved back.
 *
 *   node scripts/joined-words.js    fix every timing file already on disk
 *
 * The importers call pairUp() on each ayah, so a fresh import comes out right.
 * Running it on data already fixed changes nothing.
 */

const fs = require('fs');
const path = require('path');

// ayah -> the slot whose two glyphs are two words, zero-based; public/js/mushaf.js keeps the same list
const PAIRS = { '2:181': 2, '8:6': 3, '13:37': 7 };

// ayah -> the slot two timed words share, zero-based
const JOINED = { '37:130': 2 };

/** How many more words an ayah has than glyph slots. */
function extra(key) {
  return PAIRS[key] === undefined ? 0 : 1;
}

/**
 * One ayah's steps, [ms, word, ms, word, ...], with both halves of a pair named.
 *
 * Where the second half is timed with no step for the first just before it, the
 * segmentation heard the pair as one: its span is shared between the two, the
 * first half taking its opening. A first half left after the last step is a
 * stray label and goes. A repeat, where the reciter goes back to the first
 * half, already has both and is left as it is.
 */
function splitPair(key, steps, slots) {
  const j = PAIRS[key];
  if (j === undefined || !steps || !steps.length) return steps;

  let at = [];
  for (let i = 0; i < steps.length; i += 2) at.push([steps[i], steps[i + 1]]);

  /* Counted the mushaf's way (quran.com's segmentations): the pair is one index,
     so it is halved in time and every word after it moves up one. */
  if (Math.max.apply(null, at.map((s) => s[1])) === slots - 1) {
    const words = [];
    at.forEach((step, i) => {
      if (step[1] < j) words.push(step);
      else if (step[1] > j) words.push([step[0], step[1] + 1]);
      else {
        const next = i + 1 < at.length ? at[i + 1][0] : step[0] + 600;
        words.push([step[0], j], [Math.round(step[0] + (next - step[0]) / 2), j + 1]);
      }
    });
    at = words;
  }

  if (at.length > 1 && at[at.length - 1][1] === j) at.pop();

  const out = [];
  at.forEach((step, i) => {
    const prev = out.length ? out[out.length - 1][1] : -1;
    if (step[1] === j + 1 && prev !== j) {
      const start = step[0];
      const next = i + 1 < at.length ? at[i + 1][0] : start + 600;
      out.push([start, j], [Math.round(start + (next - start) / 2), j + 1]);
    } else {
      out.push(step);
    }
  });

  const flat = [];
  out.forEach((s) => flat.push(s[0], s[1]));
  return flat.join() === steps.join() ? steps : flat;
}

/**
 * One ayah's steps with a joined pair on its one slot.
 * `slots` is how many words the mushaf prints in the ayah.
 */
function joinSlots(key, steps, slots) {
  const j = JOINED[key];
  if (j === undefined || !steps || !steps.length) return steps;

  let hi = -1;
  for (let i = 1; i < steps.length; i += 2) hi = Math.max(hi, steps[i]);
  if (hi !== slots) return steps;   // already one index per slot

  const out = [];
  for (let i = 0; i < steps.length; i += 2) {
    out.push(steps[i], steps[i + 1] > j ? steps[i + 1] - 1 : steps[i + 1]);
  }

  // A lone step back to the pair after the ayah's last word is a stray label, not a repeat
  const n = out.length;
  if (n >= 4 && out[n - 1] === j && out[n - 3] === slots - 1) out.splice(n - 2, 2);
  return out;
}

/** Whichever the ayah needs; `slots` is its printed glyph slots. */
function pairUp(key, steps, slots) {
  return PAIRS[key] !== undefined ? splitPair(key, steps, slots) : joinSlots(key, steps, slots);
}

/** Fixes the timing files in public/surah/ in place; returns how many ayahs changed. */
function fixAll() {
  const root = path.join(__dirname, '..', 'public', 'surah');
  const slots = require('./page-words').glyphSlots();
  let changed = 0;

  for (const key of Object.keys(PAIRS).concat(Object.keys(JOINED))) {
    const [s, v] = key.split(':').map(Number);
    const dir = path.join(root, String(s));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.timing.json'))) {
      const file = path.join(dir, f);
      const t = JSON.parse(fs.readFileSync(file, 'utf8'));
      const was = t.word[v - 1];
      const now = pairUp(key, was, slots[key]);
      if (now === was) continue;
      t.word[v - 1] = now;
      fs.writeFileSync(file, JSON.stringify(t));
      console.log('  %s  %s', key.padEnd(7), f);
      changed++;
    }
  }
  return changed;
}

module.exports = { PAIRS, JOINED, extra, pairUp };

if (require.main === module) {
  console.log('joined words: %d ayah timings fixed', fixAll());
}
