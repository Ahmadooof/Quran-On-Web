/**
 * Fetch the recording a set of timing files describes.
 *
 *   node scripts/fetch-audio.js maher-al-muaiqly
 *   node scripts/fetch-audio.js all
 *
 * Puts it in public/audio/<id>/<nnn>.mp3, which is where
 * scripts/upload-audio.js looks and exactly how the bucket is laid out. The
 * files are a gigabyte or so per recitation and are gitignored; this is how a
 * fresh checkout gets them back.
 *
 * Each surah's own timing file says which recording it belongs to, so nothing
 * here has to know a URL pattern — and there is no way to fetch a file that
 * the timings do not describe. That matters more than it sounds: timings
 * belong to one recording, and the failure when they are paired with another
 * is silent. The audio plays, the highlight moves, and it is simply never on
 * the right word.
 *
 * Resumable, patient, and it checks its work. A file already the size the
 * server reports is left alone, so a run that is interrupted picks up where it
 * stopped rather than starting the gigabyte again.
 *
 * Patient because the far end will not hand over a gigabyte without pausing
 * for breath: somewhere past the eight hundredth megabyte it simply stops
 * accepting connections for a while. That is not an error to report and give
 * up on — it is the host asking to be left alone for a minute, and the answer
 * is to wait longer each time and try again rather than to abandon eighty
 * files that were about to succeed.
 *
 * Afterwards every file is measured from its own frame headers and held
 * against the length its timings claim: the reader warns at two seconds apart,
 * so anything approaching that is named here, while the files are still in
 * hand and something can be done about it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const rec = require('./recitations');
const EOL = String.fromCharCode(10);

function usage() {
  console.error('usage: node scripts/fetch-audio.js <recitation id | all> [--force]');
  console.error('       ids come from public/data/recitations.json');
  process.exit(1);
}

/** Every surah this recitation has timings for, and the recording they name. */
function wanted(id) {
  const out = [];
  for (let n = 1; n <= 114; n++) {
    const file = rec.timingFile(n, id);
    if (!fs.existsSync(file)) continue;
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!t.sourceAudio) throw new Error(path.basename(file) + ' does not say where its audio came from');
    out.push({ surah: n, url: t.sourceAudio, duration: t.duration, dest: rec.audioFile(n, id) });
  }
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Try something across a flaky connection, backing off between attempts.
 *
 * A refused connection, a reset, a 429 or a 5xx are all the same thing here —
 * the far end is not ready — and all are worth waiting out. A 404 is not: that
 * file is not coming however long anyone waits, so it is thrown straight back.
 */
async function patiently(what, label) {
  const waits = [2000, 5000, 15000, 40000, 90000];
  for (let i = 0; ; i++) {
    try {
      return await what();
    } catch (e) {
      if (e.permanent || i >= waits.length) throw e;
      process.stdout.write('  ' + label + '  ' + e.message
        + ' — waiting ' + (waits[i] / 1000) + 's' + EOL);
      await sleep(waits[i]);
    }
  }
}

function permanent(message) {
  const e = new Error(message);
  e.permanent = true;
  return e;
}

async function sizeOf(url) {
  const r = await fetch(url, { method: 'HEAD' });
  if (r.status === 404) throw permanent('HTTP 404 — no such recording');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return +r.headers.get('content-length') || 0;
}

function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

async function one(id, force) {
  const list = wanted(id);
  if (!list.length) throw new Error('no timing files for "' + id + '"');
  fs.mkdirSync(path.dirname(list[0].dest), { recursive: true });

  console.log(EOL + '  ' + id + '   ' + list.length + ' surahs');

  let got = 0, had = 0, bytes = 0;
  for (const item of list) {
    const stem = rec.stem(item.surah);
    const size = await patiently(() => sizeOf(item.url), stem);
    if (!force && fs.existsSync(item.dest) && fs.statSync(item.dest).size === size) {
      had++;
      continue;
    }

    const body = await patiently(async () => {
      const res = await fetch(item.url);
      if (res.status === 404) throw permanent(stem + ' — HTTP 404');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      /* A short read is a corrupt file that would sit there looking finished,
         and the next run would skip it because a wrong size is still a size.
         Worth another attempt rather than a failed run. */
      if (size && buf.length !== size) {
        throw new Error('got ' + buf.length + ' of ' + size + ' bytes');
      }
      return buf;
    }, stem);

    fs.writeFileSync(item.dest, body);
    got++; bytes += body.length;
    process.stdout.write('  ' + stem + '  ' + mb(body.length).padStart(9) + EOL);
  }

  console.log('  fetched   ' + got + ', already had ' + had + ', ' + mb(bytes));

  /* Does each recording match the timings shipped beside it? */
  const off = [];
  for (const item of list) {
    if (!fs.existsSync(item.dest)) continue;
    const real = rec.mp3Seconds(item.dest);
    const gap = Math.abs(real - item.duration);
    if (gap >= 2) {
      off.push(rec.stem(item.surah) + ' (audio ' + real.toFixed(1)
        + 's, timings ' + item.duration.toFixed(1) + 's)');
    }
  }
  console.log(off.length
    ? '  CHECK     ' + off.length + ' surah(s) disagree with their timings by 2s or more:' + EOL
      + '            ' + off.join(EOL + '            ')
    : '  checked   every recording matches the timings shipped with it');

  return off.length;
}

async function main() {
  const which = process.argv[2];
  if (!which) usage();
  const force = process.argv.includes('--force');

  const ids = which === 'all'
    ? rec.catalogue().recitations.map(r => r.id)
    : [which];

  let bad = 0;
  for (const id of ids) bad += await one(id, force);
  if (bad) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(e => { console.error(EOL + '  ' + e.message + EOL); process.exit(1); });
}
module.exports = { wanted };
