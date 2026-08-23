# Tests

Everything that checks the app lives here.

## Layout audit — the visual one

Renders all 604 pages in both QCF versions inside a frame the size of a real
screen, measures each sheet, and lists what looks wrong. Nothing has to be
opened surah by surah.

```bash
npm start
```

Then open <http://localhost:3000/tests/audit.html>.

Pick a screen size and zoom level, hit **Run**, and read the table: type size,
line fill, lines that had to be shrunk, sheet height, and any issue found —
a line running past the sheet, a surah band bursting out of its line, a missing
surah header or closing line, a page taller than the screen, a page whose type
size drifts from its version's norm. Click a row to see that page rendered.

One caveat: the audit measures what the browser reports, so it needs a window
that is actually being drawn. In a hidden or throttled tab the browser stops
recomputing styles and the numbers go stale.

`frame.html` is the app shell with no content: same CSS, same geometry, so a
sheet measured in it is the sheet the reader gets. `audit.js` builds the
running head and the folio around each page for the same reason — leave either
out and every sheet measures shorter than it really is.

## Command line

```bash
npm test
```

| script | what it checks |
| --- | --- |
| `npm run test:data` | every tashkeel, waqf and sajdah mark in `mushaf.json`, against two independent copies of the text |
| `npm run test:fonts` | the glyphs those words need are actually in the woff2 files |
| `npm run test:perf` | boot payload, compression, cache headers, per-page build cost |

`test:data` needs the reference texts: `npm run fetch:reference` (downloads to
`reference/`, not in git).
