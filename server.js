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
