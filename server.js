const express = require('express');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

/* mushaf.json is 923 KB of glyph codes that compress to about 72 KB, so this
   is worth far more than it costs. The font files are woff2 and already
   compressed — squeezing them again only burns CPU. */
app.use(compression({
    filter: (req, res) => !/\.woff2?$/i.test(req.path) && compression.filter(req, res),
}));

/* The same Content-Security-Policy nginx serves in production, read out of
   deploy/security-headers.conf rather than written twice.
   
   Development used to send no policy at all, which meant the one class of bug
   the policy exists to catch was invisible until deploy: an inline script that
   works perfectly here is silently dropped in production, and whatever it was
   setting is simply never set. That is exactly how the audio base came to be
   undefined on the live site while every local test passed. */
const csp = (() => {
    try {
        const conf = fs.readFileSync(
            path.join(__dirname, 'deploy', 'security-headers.conf'), 'utf8');
        const m = /add_header\s+Content-Security-Policy\s+"([^"]+)"/.exec(conf);
        return m ? m[1] : null;
    } catch (e) { return null; }
})();

if (csp) {
    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', csp);
        next();
    });
} else {
    console.warn('no Content-Security-Policy found in deploy/security-headers.conf');
}

// dotfiles: 'deny' keeps public/data/.env (API credentials) from being served
app.use(express.static(path.join(__dirname, 'public'), {
    dotfiles: 'deny',
    // The page fonts never change once fetched, and there are 1208 of them.
    setHeaders: (res, filePath) => {
        if (/\.woff2?$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    },
}));

// The layout audit (tests/audit.html) runs against the real app.
app.use('/tests', express.static(path.join(__dirname, 'tests')));

/* In production nginx proxies these to Umami. There is nothing to proxy to
   locally, and a 404 here answers with HTML, which the browser then refuses as
   a script — two console errors on every dev session, in which a real one
   could hide. Answer with a no-op instead: development does not report. */
app.get('/stats.js', (req, res) => {
    res.type('application/javascript')
       .send('/* analytics is served by nginx in production */');
});
app.post('/api/send', (req, res) => res.status(204).end());

/* The audio tooling, when it is switched on.

   Finding where each ayah falls in a two-hour recitation starts with a
   loudness curve, and reading one means decoding MP3 — which nothing in Node
   here does, while every browser does it in hardware. So the decoding is a
   page (scripts/audio/envelope.html) and this is where it puts what it
   measured, for scripts/build-audio-timing.js to align.

   Behind a switch because it writes files to disk: production runs without it
   and the route does not exist there at all. */
if (process.env.QURAN_AUDIO_TOOLS === '1' || process.argv.includes('--audio-tools')) {
    const cache = path.join(__dirname, 'scripts', 'audio', 'cache');

    app.use('/audio-tools', express.static(path.join(__dirname, 'scripts', 'audio')));

    app.post('/audio-tools/envelope/:surah',
        express.raw({ type: '*/*', limit: '64mb' }), (req, res) => {
        const n = parseInt(req.params.surah, 10);
        if (!(n >= 1 && n <= 114)) return res.status(400).end();
        fs.mkdirSync(cache, { recursive: true });
        const stem = path.join(cache, String(n).padStart(3, '0'));
        fs.writeFileSync(stem + '.env', req.body);
        fs.writeFileSync(stem + '.json', JSON.stringify({
            surah: n,
            hop: Number(req.query.hop),          // seconds a byte covers
            floor: Number(req.query.floor),      // dB the byte 0 stands for
            ceil: Number(req.query.ceil),        // dB the byte 255 stands for
            duration: Number(req.query.duration),
            samples: req.body.length,
        }, null, 2));
        console.log(`envelope: surah ${n}, ${req.body.length} samples`);
        res.json({ ok: true, samples: req.body.length });
    });

    console.log('audio tools enabled at /audio-tools/envelope.html');
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Quran app running on ${url}`);
    // The verification scripts start the server themselves and must not have
    // a browser window opened at them.
    if (process.env.NO_OPEN) return;
    const cmd = process.platform === 'win32' ? `start ${url}`
              : process.platform === 'darwin' ? `open ${url}`
              : `xdg-open ${url}`;
    exec(cmd);
});
