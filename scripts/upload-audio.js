/**
 * Put the recitations on the bucket that serves them.
 *
 *   node scripts/upload-audio.js --list
 *   node scripts/upload-audio.js --bucket <name> [--dry-run] [--force]
 *   node scripts/upload-audio.js --bucket <name> --fix-headers
 *
 * The audio is over a gigabyte per recording and has no business in the
 * repository or on the app's own server, so it lives on R2 and the reader is
 * pointed at it with the quran-audio-base meta tag. This is what gets it
 * there. It sends whatever is under public/audio/, so a run after adding a
 * recording uploads that recording and leaves the rest alone.
 *
 * R2 speaks the S3 API, and S3 requests are signed rather than authenticated
 * with a header you can copy — so the signing is done here rather than by
 * pulling in an SDK. It is sixty lines of HMAC against Node's own crypto, and
 * it means this script adds nothing to the dependency tree to move some files
 * once.
 *
 * The credentials come from public/data/.env, which is gitignored. They are
 * read into memory and used to sign; nothing here prints them, and nothing
 * here writes them anywhere.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const rec = require('./recitations');
/* The project root first: credentials under public/ are one misconfigured
   static handler away from being served, so that is the worse of the two
   places for them to live and the second one only stays supported so an older
   checkout keeps working. */
const ENV_PATHS = [path.join(ROOT, '.env'), path.join(ROOT, 'public', 'data', '.env')];

/* R2 has no regions, but SigV4 insists on one and every client agrees to say
   "auto". */
const EOL = String.fromCharCode(10);
const REGION = 'auto';
const SERVICE = 's3';

/**
 * What every object is stored with.
 *
 * The cache lifetime is the important half. Without it the edge will not serve
 * a recording on its own authority: it goes back to R2 to revalidate, which
 * turned every listener into an origin request and left `cf-cache-status:
 * REVALIDATED` on files that had not changed in months.
 *
 * A year, and immutable, is honest here — a recording is never edited in
 * place. When a different one arrives it arrives under a different id, so it
 * is a different key and no cache anywhere has to be told anything.
 *
 * This is also what keeps a bill from being someone else's to write. Egress
 * from R2 costs nothing; reads do, and only when the edge misses. Long-lived
 * cached objects mean a script hammering the audio is hammering Cloudflare's
 * cache rather than our origin. (The other half of that is a cache rule which
 * ignores the query string, so `?v=random` cannot manufacture a miss —
 * that one lives in the Cloudflare dashboard, not here.)
 */
const OBJECT_HEADERS = {
  'content-type': 'audio/mpeg',
  'cache-control': 'public, max-age=31536000, immutable',
};

/* ---------- credentials -------------------------------------------------- */

function loadEnv() {
  const file = ENV_PATHS.find(p => fs.existsSync(p));
  if (!file) {
    throw new Error('no credentials found — looked in '
      + ENV_PATHS.map(p => path.relative(ROOT, p)).join(' and '));
  }
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }

  /* The spelling in the file is what it is; this is not the place to be
     fussy about it, only to say plainly which one is missing. */
  const need = {
    key: env.CloudFlareAccessKey,
    secret: env.CloudFlareSecrectAccessKey || env.CloudFlareSecretAccessKey,
    account: env.CloudFlareAccountID,
  };
  const missing = Object.keys(need).filter(k => !need[k]);
  if (missing.length) throw new Error('missing from .env: ' + missing.join(', '));

  /* The endpoint is derivable from the account id, so a stated one is only
     used when it is actually an endpoint and not, say, a dashboard link. */
  const stated = (env.CloudFlareS3API || '').trim();
  const host = /^https?:\/\/[^/]+\.r2\.cloudflarestorage\.com/i.test(stated)
    ? new URL(stated).host
    : need.account + '.r2.cloudflarestorage.com';

  return { ...need, host };
}

/* ---------- signature version 4 ------------------------------------------ */

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

/**
 * Sign one request, and return the headers that make it acceptable.
 *
 * `hash` is the SHA-256 of the body, which S3 requires up front — that is why
 * a file is read whole rather than streamed: it has to be hashed before the
 * first byte can be sent, so it is going through memory either way.
 */
function sign(cred, method, host, key, hash, extra) {
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const scope = `${day}/${REGION}/${SERVICE}/aws4_request`;

  const headers = Object.assign({
    host: host,
    'x-amz-content-sha256': hash,
    'x-amz-date': now,
  }, extra || {});

  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonicalHeaders = names.map(n => {
    const k = Object.keys(headers).find(h => h.toLowerCase() === n);
    return n + ':' + String(headers[k]).trim() + '\n';
  }).join('');
  const signed = names.join(';');

  const canonical = [
    method,
    key,
    '',                       // no query string is used anywhere here
    canonicalHeaders,
    signed,
    hash,
  ].join('\n');

  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');

  let k = hmac('AWS4' + cred.secret, day);
  k = hmac(k, REGION);
  k = hmac(k, SERVICE);
  k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(toSign).digest('hex');

  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${cred.key}/${scope},`
    + ` SignedHeaders=${signed}, Signature=${signature}`;
  return headers;
}

function send(cred, method, key, body, extra) {
  const hash = sha256(body || '');
  const headers = sign(cred, method, cred.host, key, hash, extra);
  if (body && body.length) headers['content-length'] = body.length;

  return fetch('https://' + cred.host + key, { method, headers, body: body || undefined })
    .then(async (res) => ({ status: res.status, ok: res.ok, text: await res.text() }));
}

/* ---------- what is on the bucket ---------------------------------------- */

async function listBuckets(cred) {
  const res = await send(cred, 'GET', '/');
  if (!res.ok) throw new Error('could not list buckets — HTTP ' + res.status + '\n  ' + res.text.slice(0, 300));
  return [...res.text.matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
}

/** Which objects the bucket already holds, and how big each one is, so a run
    that is repeated does not upload 1.4 GB a second time. */
async function listObjects(cred, bucket) {
  const res = await send(cred, 'GET', '/' + bucket);
  if (!res.ok) return {};
  /* Each object is read out of its own <Contents> block, taking Key and Size
     wherever they fall inside it. Matching the two in a fixed order across the
     whole document looked tidier and quietly matched nothing at all, so every
     run thought the bucket was empty and offered to send all of it again. */
  const have = {};
  for (const block of res.text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([^<]+)<\/Key>/.exec(block[1]);
    const size = /<Size>(\d+)<\/Size>/.exec(block[1]);
    if (key && size) have[key[1]] = +size[1];
  }
  return have;
}

/* ---------- the files ----------------------------------------------------- */

/**
 * Every recitation on disk, keyed the way the reader will ask for it.
 *
 * Grouped by recording, not by surah. Keying them the way they once sat
 * locally — <surah>/<nnn>.mp3 — made 114 folders holding one file each, which
 * says nothing the filename does not already say and left nowhere for a second
 * recording to go. public/audio/<id>/<nnn>.mp3 is flat inside, and adding
 * another recording is then a sibling rather than a rearrangement.
 *
 * That layout is the bucket's layout, so the key is simply where the file
 * already is — there is no second answer to "where is it" for the two to
 * disagree about. See scripts/recitations.js.
 */
function localFiles() {
  return rec.audioOnDisk();
}

function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

/**
 * Give objects already on the bucket the headers they should have been stored
 * with, without sending their bytes again.
 *
 * S3 copies an object onto itself when the source and destination are the same
 * key, and REPLACE tells it to take the new metadata rather than carry the old
 * across. The bytes never leave R2 — five gigabytes of audio is corrected by
 * a few hundred requests carrying nothing.
 */
async function fixHeaders(cred, bucket) {
  const have = Object.keys(await listObjects(cred, bucket)).sort();
  if (!have.length) { console.log(EOL + '  nothing on the bucket to correct.'); return; }

  console.log(EOL + '  restating headers on ' + have.length + ' objects (no bytes re-sent)');
  let done = 0;
  for (const key of have) {
    const res = await send(cred, 'PUT', '/' + bucket + '/' + key, null, Object.assign({
      'x-amz-copy-source': '/' + bucket + '/' + key,
      'x-amz-metadata-directive': 'REPLACE',
    }, OBJECT_HEADERS));
    if (!res.ok) {
      throw new Error(key + ' — HTTP ' + res.status + EOL + '  ' + res.text.slice(0, 300));
    }
    done++;
    if (done % 50 === 0 || done === have.length) {
      console.log('  ' + String(done).padStart(4) + '/' + have.length);
    }
  }
  console.log('  corrected  ' + done + ' objects');
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? (argv[i + 1] || true) : null;
  };

  const cred = loadEnv();
  console.log('  endpoint   https://' + cred.host);
  console.log('  key        ' + cred.key.slice(0, 4) + '…' + cred.key.slice(-2)
              + '   (secret held, never printed)');

  const buckets = await listBuckets(cred);
  console.log('  buckets    ' + (buckets.length ? buckets.join(', ') : '(none)'));

  const bucket = arg('bucket');
  if (!bucket || bucket === true) {
    console.log('\n  Credentials work. Choose one with --bucket <name> to upload.');
    return;
  }
  if (!buckets.includes(bucket)) {
    if (!argv.includes('--create')) {
      throw new Error('no bucket called "' + bucket + '" — pass --create to make it');
    }
    /* R2 takes the S3 CreateBucket verb, so this needs no second credential
       and no second way of talking to Cloudflare. */
    const made = await send(cred, 'PUT', '/' + bucket);
    if (!made.ok) throw new Error('could not create "' + bucket + '" — HTTP '
                                  + made.status + '\n  ' + made.text.slice(0, 300));
    console.log('  created    ' + bucket);
  }

  if (argv.includes('--fix-headers')) return fixHeaders(cred, bucket);

  const files = localFiles();
  const total = files.reduce((s, f) => s + f.size, 0);
  console.log('\n  local      ' + files.length + ' files, ' + mb(total));

  const have = await listObjects(cred, bucket);
  const todo = files.filter(f => have[f.key] !== f.size);
  console.log('  already up ' + (files.length - todo.length));
  console.log('  to upload  ' + todo.length + ', ' + mb(todo.reduce((s, f) => s + f.size, 0)));

  if (argv.includes('--dry-run')) {
    console.log('\n  --dry-run: nothing sent.');
    return;
  }

  let done = 0, sent = 0;
  for (const f of todo) {
    const body = fs.readFileSync(f.file);
    const res = await send(cred, 'PUT', '/' + bucket + '/' + f.key, body, OBJECT_HEADERS);
    if (!res.ok) throw new Error(f.key + ' — HTTP ' + res.status + '\n  ' + res.text.slice(0, 300));
    done++; sent += f.size;
    console.log('  ' + String(done).padStart(3) + '/' + todo.length + '  '
                + f.key.padEnd(12) + mb(f.size).padStart(9));
  }
  console.log('\n  uploaded   ' + done + ' files, ' + mb(sent));
}

if (require.main === module) {
  main().catch(e => { console.error('\n  ' + e.message + '\n'); process.exit(1); });
}
