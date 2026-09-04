/**
 * Where a recitation's pieces live, in one place.
 *
 * A recitation is one string — its id — and everything about where to find it
 * follows from that: `<id>/` is its folder on the audio bucket and, mirrored,
 * on disk; `<nnn>.<id>.timing.json` is what sits beside each surah page. The
 * reader, the page builder and the upload all need to agree on that, and the
 * way to make three scripts agree is to have them ask the same function.
 *
 * public/data/recitations.json is the list of which ones exist. It is what the
 * picker in the reader offers, and its `default` is the one a first-time
 * reader hears and the one the surah pages describe to a crawler.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const CATALOGUE = path.join(PUBLIC, 'data', 'recitations.json');

/** A reciter's name as an id: lowercase, punctuation dropped, spaces to
    hyphens. "Maher al-Muaiqly" becomes maher-al-muaiqly. */
function slug(name) {
  return String(name || 'reciter').toLowerCase()
    .replace(/['`‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function catalogue() {
  if (!fs.existsSync(CATALOGUE)) {
    throw new Error('no ' + path.relative(ROOT, CATALOGUE)
      + ' — the reader has no list of recitations to offer');
  }
  const d = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
  if (!d.recitations || !d.recitations.length) {
    throw new Error(path.relative(ROOT, CATALOGUE) + ' lists no recitations');
  }
  return d;
}

/** The id the catalogue calls default, which is what everything unasked uses. */
function defaultId() {
  const d = catalogue();
  return d.recitations.some(r => r.id === d.default) ? d.default : d.recitations[0].id;
}

/**
 * Which recitation a timing file belongs to.
 *
 * Read off its own audioPath rather than passed in beside it, so the file and
 * the name it is filed under can never drift apart.
 */
function idOf(timing) {
  const p = String(timing && timing.audioPath || '');
  const folder = p.split('/')[0];
  if (!folder || folder === p) {
    throw new Error('this timing file has no audioPath to take a recitation id from');
  }
  return folder;
}

function stem(surah) { return String(surah).padStart(3, '0'); }

/**
 * How long an MP3 actually runs, from its own frame headers.
 *
 * Every frame header states a bitrate and a sample rate, which give the
 * frame's length in bytes and the samples it carries; walking them adds up to
 * the duration whether or not the file was written with a header that declares
 * one. Nothing here decodes any audio — it only steps over it.
 *
 * This lives beside the paths rather than in one script because the question
 * it answers — is this recording the one these timings describe? — is asked
 * both when timings are written and when audio is fetched.
 */
const BITRATE = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLERATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000] };

function mp3Seconds(file) {
  const b = fs.readFileSync(file);
  let i = 0;
  /* An ID3v2 tag sits in front of the first frame, and its size is written
     seven bits to the byte — the high bit of each never joins in. */
  if (b.slice(0, 3).toString() === 'ID3') {
    i = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  }

  let seconds = 0;
  while (i < b.length - 4) {
    if (b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) { i++; continue; }
    const version = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
    const bits = (b[i + 2] >> 4) & 15, rate = (b[i + 2] >> 2) & 3;
    const padded = (b[i + 2] >> 1) & 1;
    if (layer !== 1 || bits === 0 || bits === 15 || rate === 3) { i++; continue; }
    const kbps = BITRATE[version === 3 ? 1 : 2][bits];
    const hz = (SAMPLERATE[version] || SAMPLERATE[2])[rate];
    if (!kbps || !hz) { i++; continue; }
    const samples = version === 3 ? 1152 : 576;
    const bytes = Math.floor(samples / 8 * kbps * 1000 / hz) + padded;
    /* Two bytes that look like a header but describe nothing playable are
       audio, not a frame. Step one byte on and keep looking. */
    if (bytes < 24) { i++; continue; }
    seconds += samples / hz;
    i += bytes;
  }
  return seconds;
}

/** public/surah/<n>/<nnn>.<id>.timing.json */
function timingFile(surah, id) {
  return path.join(PUBLIC, 'surah', String(surah), stem(surah) + '.' + id + '.timing.json');
}

/** public/audio/<id>/<nnn>.mp3 — laid out exactly as the bucket is. */
function audioFile(surah, id) {
  return path.join(PUBLIC, 'audio', id, stem(surah) + '.mp3');
}

/** Every recording on disk, keyed the way the bucket holds it. */
function audioOnDisk() {
  const root = path.join(PUBLIC, 'audio');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.mp3$/i.test(name)) continue;
      const file = path.join(dir, name);
      out.push({ key: id + '/' + name, file, size: fs.statSync(file).size });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

module.exports = {
  ROOT, PUBLIC, CATALOGUE,
  slug, catalogue, defaultId, idOf, stem, timingFile, audioFile, audioOnDisk,
  mp3Seconds,
};
