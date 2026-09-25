/**
 * Two recited words that the mushaf prints in one glyph slot.
 *
 * Segmentations time بَعْدَ and مَا (and إِلْ and يَاسِينَ) as two words, while the
 * mushaf draws each pair as one word, so every index after them lights the
 * word one past the one being recited. Both halves are pointed at the one
 * slot and the rest moved back.
 *
 *   node scripts/joined-words.js    fix every timing file already on disk
 *
 * The importers call joinSlots() on each ayah, so a fresh import comes out
 * right. Running it on data already fixed changes nothing.
 */

const fs = require('fs');
const path = require('path');

// ayah -> the glyph slot holding both words, zero-based
const JOINED = { '2:181': 2, '8:6': 3, '13:37': 7, '37:130': 2 };

/**
 * One ayah's steps, [ms, word, ms, word, ...], with the pair on one slot.
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

/** Fixes the timing files in public/surah/ in place; returns how many ayahs changed. */
function fixAll() {
  const root = path.join(__dirname, '..', 'public', 'surah');
  const slots = require('./page-words').glyphSlots();
  let changed = 0;

  for (const key of Object.keys(JOINED)) {
    const [s, v] = key.split(':').map(Number);
    const dir = path.join(root, String(s));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.timing.json'))) {
      const file = path.join(dir, f);
      const t = JSON.parse(fs.readFileSync(file, 'utf8'));
      const was = t.word[v - 1];
      const now = joinSlots(key, was, slots[key]);
      if (now === was) continue;
      t.word[v - 1] = now;
      fs.writeFileSync(file, JSON.stringify(t));
      console.log('  %s  %s', key.padEnd(7), f);
      changed++;
    }
  }
  return changed;
}

module.exports = { JOINED, joinSlots };

if (require.main === module) {
  console.log('joined words: %d ayah timings fixed', fixAll());
}
