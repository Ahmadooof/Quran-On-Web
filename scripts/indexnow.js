/**
 * Tell the search engines that take being told.
 *
 * IndexNow is one POST: a key, the key's file on the domain to prove it is
 * ours, and the urls. Bing, Yandex, Seznam and Naver share the submission
 * between them. Google does not take part — its only door is Search Console,
 * which is a person signing in, not a script.
 *
 *     node scripts/indexnow.js            # every url in the sitemap
 *     node scripts/indexnow.js /surah/2/  # just these
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const HOST = 'readqurantoday.com';
const SITE = `https://${HOST}`;

/** The key is the name of the file that holds it, sitting at the site's root. */
function key() {
  const found = fs.readdirSync(path.join(ROOT, 'public'))
    .filter((f) => /^[0-9a-f]{8,128}\.txt$/.test(f));
  if (!found.length) throw new Error('no IndexNow key file in public/');
  return found[0].replace(/\.txt$/, '');
}

function sitemapUrls() {
  const xml = fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
  return (xml.match(/<loc>([^<]+)<\/loc>/g) || []).map((m) => m.slice(5, -6));
}

function submit(urlList, k) {
  const body = JSON.stringify({
    host: HOST,
    key: k,
    keyLocation: `${SITE}/${k}.txt`,
    urlList,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.indexnow.org',
      path: '/indexnow',
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let said = '';
      res.on('data', (d) => { said += d; });
      res.on('end', () => resolve({ status: res.statusCode, said: said.trim() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const k = key();
  const asked = process.argv.slice(2);
  const urls = asked.length ? asked.map((u) => (u.startsWith('http') ? u : SITE + u)) : sitemapUrls();

  console.log('key      %s', k);
  console.log('urls     %d', urls.length);

  const res = await submit(urls, k);
  console.log('response %d %s', res.status, res.said || '(no body)');

  /* 200 taken, 202 taken and the key will be checked, 403 the key file does not
     match, 422 a url is not on this host. */
  if (res.status !== 200 && res.status !== 202) process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
