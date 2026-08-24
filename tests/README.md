# Tests

Everything that checks the app lives here.

## Layout audit — the visual one

Renders all 604 pages inside a frame the size of a real screen, measures each sheet, and lists what looks wrong. Nothing has to be
opened surah by surah.

```bash
npm start
```

Then open <http://localhost:3000/tests/audit.html>.

Pick a screen size and zoom level, hit **Run**, and read the table: type size,
line fill, lines that had to be shrunk, sheet height, how long the page took to
build, and any issue found — a line running past the sheet, a surah break
bursting out of its line, a missing break or closing line, a page taller than
the screen, a page whose type size drifts from the norm, a page that took too
long to build. Click a row to see that page rendered.

**It is also the performance test.** `build` is our own cost for one page:
filling its word spans and fitting its lines. A page turn is one of those, so
it is what the reader waits for once the font is in hand.

It is budgeted across the run, not page by page — `BUILD_MEDIAN_MS` and
`BUILD_P95_MS` at the top of `audit.js`, currently 5ms and 30ms. The first few
pages of any sweep pay for the browser warming up and can take a hundred
milliseconds; flagging those would say nothing about the code, while a change
that makes rendering slower moves the median. The card turns red if either
budget is passed. It currently sits around **2ms median** with the window
actually painting — a hidden or throttled window reports lower, because the
browser skips work it would otherwise do, so compare like with like.

It has already earned its keep: it caught a change of mine that made fitting a
page 250x slower (0.6ms to 166ms) by moving where the container query for the
type size was evaluated. Nothing looked different on screen.

`font` is the fetch beside it, reported but not budgeted: that is the network's
time, not ours, and the reader fetches the pages ahead so a turn rarely waits
on it.

Run the sweep before and after a change that touches rendering and the two
numbers are directly comparable.

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
