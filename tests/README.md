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
build, and any issue found — a line running past the sheet, a fit that does not
settle, a sheet crowding the lane the turn buttons stand in, a surah break
bursting out of its line, a missing break or closing line, a page taller than
the screen, a page whose type size drifts from the norm, a page that took too
long to build. Click a row to see that page rendered.

Three of those checks exist because of faults this audit did not catch when it
was only measuring a page once, and they are worth knowing about before
changing how lines are fitted:

**A line past the sheet is measured on every line, shrunk or not.** It used to
skip the lines the fitter had pulled in, on the reasoning that those were the
handled cases — which assumes the pulling worked. Page 27's fourteenth line was
shrunk by the wrong amount for as long as that held.

**The fit has to settle.** A page is fitted when it is built and again on every
resize event, so the audit fits each page twice more and fails it if any line
changes. It did change: clearing a line's font size and measuring in the same
breath returns the width from *before* the clear, because the browser does not
re-measure text until it next lays the page out. A shrunk line therefore looked
as though it already fitted, lost its shrink and hung over the margin, and the
call after that put it back — a flicker in and out of the margin on every frame
of a resize.

That same fact is why the overflow of a *shrunk* line is checked against the
fitter's own arithmetic — the width it recorded times the factor it applied —
rather than by measuring the page. Measure it and every fitted line reports an
overflow of exactly the amount it was fitted by.

**The turn lane must stay clear.** `#content-area` holds `--turn-lane` open on
each side for the page-turn buttons, so if a sheet reaches into it a button is
over the words. The lane is checked rather than the buttons, which means it
holds for pages the reader has not turned to and for screen sizes where the
buttons are hidden.

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

## Are the words on the right lines?

`test:fonts` measures every one of the 8,807 body lines from the font's own
advance widths. The mushaf justifies each line to the measure, so a line that
stops short is saying something: either a surah ends on it, or a word that
belongs to it has been put somewhere else.

That second case is why the check exists. A word on the wrong line still
renders, still looks like Arabic, still fills the page — nothing else here
would see it. It shows up only as a gap in the line the word left.

The set of legitimately short lines is **pinned, not counted**. A count with
enough slack to avoid false failures would also hide a single misplaced word,
which is the fault worth catching. Four mid-surah lines measure short because
the mushaf sets them with wider word spacing rather than kashida, and spacing
is not in the glyph advances.

It was tested by breaking it on purpose: moving one word from p367 line 5 onto
line 6 — the fault that prompted the check — fails it by name.

If it fails after rebuilding `mushaf.json`, compare the line it names against a
Madinah mushaf before touching the list. Editions differ: the Madinah 15-line,
IndoPak and other prints break lines differently, and about 6% of our lines
begin with an ayah marker because that is where this print puts them.

## Command line

```bash
npm test
```

| script | what it checks |
| --- | --- |
| `npm run test:data` | every tashkeel, waqf and sajdah mark in `mushaf.json`, against two independent copies of the text |
| `npm run test:fonts` | the glyphs those words need are actually in the woff2 files, and that every line is drawn to the full measure |
| `npm run test:perf` | boot payload, compression, cache headers, per-page build cost |

`test:data` needs the reference texts: `npm run fetch:reference` (downloads to
`reference/`, not in git).
