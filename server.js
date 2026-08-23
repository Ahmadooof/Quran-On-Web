const express = require('express');
const compression = require('compression');
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
