const express = require('express');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// dotfiles: 'deny' keeps public/data/.env (API credentials) from being served
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Quran app running on ${url}`);
    const cmd = process.platform === 'win32' ? `start ${url}`
              : process.platform === 'darwin' ? `open ${url}`
              : `xdg-open ${url}`;
    exec(cmd);
});
