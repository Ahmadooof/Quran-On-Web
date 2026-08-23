# القرآن الكريم — Quran Web App

A Madinah Mushaf reader: the printed page reproduced line for line, in the two
King Fahd Complex mushaf typefaces, with dark/light mode, bilingual UI and
saved pages.

## Setup

```bash
npm install
npm run setup
npm start
```

Open `http://localhost:3000`.

`npm run setup` does the two one-off jobs:

| Command                | What it does                                                        |
|------------------------|---------------------------------------------------------------------|
| `npm run fetch:fonts`  | Downloads the QCF page fonts into `public/fonts/` (~140 MB)          |
| `npm run build:mushaf` | Builds `public/data/mushaf.json`, the 604-page line layout           |

Both are resumable and safe to re-run — the font fetch skips files it already
has, and the layout build writes nothing unless all 604 pages come back
intact. Neither needs credentials.

## The font

The reader sets the mushaf in **QCF V2**, the current Madinah Mushaf face from
the King Fahd Glorious Quran Printing Complex. `mushaf.json` carries QCF V1
codes as well and the test suite checks them, but nothing in the reader draws
them — `public/fonts/v1` can be deleted, and `npm run test:fonts` will skip
that half rather than fail.

These are *page fonts*, not ordinary Arabic fonts. They contain no letters:
each glyph is a whole word, drawn exactly as it appears on one specific page,
so there is one font file per mushaf page — 604 per version. Page 5's codes
render as the wrong words in page 6's font.

That has three consequences worth knowing:

- The glyph codes in `public/data/mushaf.json` and the files in
  `public/fonts/` must come from the same source. Rebuild them together.
- A page's font is registered from JavaScript as the page scrolls into reach,
  rather than as 1208 `@font-face` rules the browser would have to carry.
- Verse numbers are glyphs in the line, not markup, so they are set by the
  typeface and cannot drift out of the text block.

### How the type is sized

Every page font of a version is drawn to one scale — the ayah marker measures
1.245em on all 604 V1 pages — so **the mushaf is set at a single type size
throughout**. A version's line width in ems (`fit.body` in `mushaf.json`) is
all the reader needs; nothing is measured per page, which is what used to make
the size jump between surahs.

The size is the smallest of three bounds, worked out in CSS on the sheet:

| bound | what it is |
|---|---|
| zoom | the size asked for: `--page-measure × zoom ÷ fit.body` |
| width | the same against the width the sheet **actually got** (`100cqw`) |
| height | one whole page on screen: `(screen − chrome) × zoom ÷ (15 lines × 1.92)` |

The sheet is then made exactly as wide as the lines it holds. Two things fall
out of that. A line can no longer run past the sheet, because the width bound
is the real width rather than the width the sheet asked for — on a screen too
narrow to grant it, zooming now stops instead of overflowing. And at 100% a
full mushaf page fits the screen, so the zoom control reads as a fit: click the
percentage to come back to it.

The height bound always divides by 15, the mushaf's line grid, not by the
page's own line count. Pages 1 and 2 have eight lines because their ornamental
frame leaves less room, but they are set in the *same* type — dividing by eight
would draw Al-Fatihah at nearly twice the size of everything else.

Two facing pages halve the width each one gets, so the width bound divides by
`--m-cols` — 1 normally, 2 in spread mode. Without that the type would be sized
for the whole container and run straight off the sheet.

`--sheet-chrome` is everything a sheet spends on something other than type:
its padding, the folio, the gap above it. It is deliberately small, because
every pixel of it is a pixel of type the reader does not get.

The two versions still fill the measure differently. **V2 bakes the
justification into its glyph advances**: every line is drawn to nearly the same
width (the median fills 98% of the measure), so the words sit flush with barely
a gap. **V1 does not** — its lines run from 12 to 21em and fill about 71%, and
the leftover space is spread between the words, which is how a V1 mushaf is set.

Two ends are still settled at runtime. A handful of lines are drawn wider than
the rest and are set slightly smaller. At the other end, a line well short of
the measure is centred rather than pulled out to both margins — that is what
the framed opening spread needs, and what a surah's closing line needs. The
threshold differs by version, because the versions intend different word
spacing: below 92% of the measure a V2 line is genuinely short, while a V1 line
filling two thirds is ordinary and wants its gaps.

## Data

| File                            | What it is                                            |
|---------------------------------|--------------------------------------------------------|
| `public/data/mushaf.json`       | 604 pages × their lines, with V1 and V2 glyph codes    |
| `public/data/surahs.json`       | The 114-surah index, 13 KB — all the reader loads      |

Both are written by `npm run build:mushaf`.

`mushaf.json` is built from `api.quran.com` v4, which gives every word its
printed page and line. Ornamental lines are inferred from the gaps that leaves
in the line grid: a surah's header, and its Basmalah, go into the empty lines
directly above its first word.

On 18 pages the mushaf leaves only one line free above a surah that needs two,
and squeezes the Basmalah onto the header's line — those lines carry `b:1` in
the data. Page 77 (An-Nisa) is one of them.

**The reader does not follow the mushaf here.** It gives the Basmalah a line of
its own on all 114 openings, so every surah opens the same way — and it costs
no page height. A sheet is always exactly its slot count tall, and every line
in it is one line high, ornamental or not.

The room comes from the header line. Where a surah opens at the *top* of a page
the running head already names it, so no header line is drawn at all. Where one
opens *partway down*, the head belongs to the surah above it — heading page 106
"Al-Ma'idah" would be a lie about its top half — so that break is drawn and
names itself, in the same tag the head uses.

Every line is one line tall, ornamental or not, and a sheet is simply as tall
as the lines it draws. So a page that opens a surah at its top comes out one
line shorter than one that does not — 14 lines against 15. Nothing flexes and
nothing is special-cased; the height follows from the line count.

That is the print, not a gap in the data: all 14 of page 77's text lines
measure a full 15.5–15.8em in the V2 font, so the page really does give 14 of
its 15 lines to text. `npm run test:fonts` checks this for every page.

`juzPages` holds the page each of the 30 juz opens on. They are not evenly
spaced — juz 7 opens on page 121 and juz 11 on page 201 — so they are read from
the API rather than calculated.

The Basmalah itself is drawn from page 1's font: Al-Fatihah 1:1 *is* the
Basmalah, so the glyphs already exist there in both versions and always match
the selected face.

The surah name comes from `sura-names.woff2`, one calligraphic glyph per surah
at U+E001–E114, addressed by reading the surah's decimal number as hexadecimal.
Those glyphs draw the **name only** — there is none for the word "سورة". The
name is set once per sheet. Where a surah opens at the top of a page the
running head names it and the header line is left blank; where one opens
partway down, the head belongs to the surah above it, so the break carries the
name itself — otherwise page 106 would head the whole sheet "Al-Ma'idah" while
its top half is still An-Nisa. `surahs.json` also holds a vocalised `full` name
("سُورَةُ البَقَرَةِ") from alquran.cloud — api.quran.com spells them bare —
which rides along as the head's label.

The Basmalah can only come from page 1. The same codes exist in other page
fonts, but they mean that page's own words there: `ﱁﱂﱃﱄ` is the Basmalah in
p1.woff2 and Al-Baqarah's opening four words in p2.woff2. Al-Fatihah 1:1 *is*
the Basmalah, so page 1 is the one place those glyphs are what they say, and
all 112 Basmalahs are drawn from it.

## Speed

Two things dominate, and both are handled:

- **Boot payload.** The reader loads `surahs.json` (13 KB) and `mushaf.json`
  (923 KB, ~72 KB gzipped) and nothing else. Responses are compressed, and the
  page fonts are served `immutable` — they never change once fetched.
- **Page building.** A surah can run to 48 pages of 15 lines each. Building
  them all up front meant 6400 word spans before anything appeared, so pages
  are built when they come into reach and dropped once well past — an emptied
  page still reserves its height, so scrolling does not jump. Registered fonts
  are capped at 24 for the same reason.

  That cap is why a built page has to be dropped once it is out of view. A page
  left built while its face is evicted underneath it renders its glyph codes as
  raw text, which is what turning spreads quickly used to do: the spread mode
  hydrated pages and never dropped them. It now keeps only the two on screen,
  and `hydrate()` treats a page whose face has gone as unbuilt and rebuilds it.

## Testing

Everything that checks the app is in `tests/` — see [tests/README.md](tests/README.md).

### The layout audit

The one that answers "does any page look wrong?" without opening 114 surahs.
With the server up, open <http://localhost:3000/tests/audit.html>, pick a screen
size and zoom, and hit Run. It renders all 604 pages in both versions inside a
frame the size of that screen, measures every sheet, and lists what is off: a
line running past the sheet, a page taller than the screen, a missing surah
header or closing line, a type size that drifts from its version's norm. Click
a row to see the page.

### Command line

```bash
npm run fetch:reference   # one-off: downloads the texts to check against
npm test
```

30 checks in three groups. `npm run test:data`, `test:fonts` and `test:perf`
run them separately; each exits non-zero on failure.

**Data** — the layout against two unrelated copies of the Quran (Tanzil and
alquran.cloud) plus a word-by-word reference: 6236 verses, 83665 words in
reading order, verse counts and spelling verse for verse, one header per surah,
112 Basmalahs, and page ranges that match where the words actually print.

**Fonts** — this is what proves the marks are drawn. A V2 page font encodes its
page's words as one unbroken ascending run of codes, so a printed word the
layout skipped would leave a hole in that run. Checking that the run has no
holes, on all 604 pages, means no diacritic, pause mark, sajdah sign or ayah
marker can be missing. It also confirms the pages really are drawn to one scale
(line width 15.56em, spread 2.9%), which is what lets the whole mushaf be set at
a single size.

**Speed** — starts the real server and holds it to a budget: boot payload over
the wire, compression on text but not on woff2, immutable caching on the page
fonts, `.env` not served, and how many spans a page and a surah actually
build.

### On testing the marks

Your list — tashkeel, waqf signs, recitation marks, section marks — cannot be
checked by looking for those characters in what we render, because we render
glyphs, not letters: a QCF glyph is a whole word with its marks already drawn
in. So the suite checks it from both ends. `check-data.js` counts every mark
in the Uthmani spelling of the words we lay out and compares against Tanzil;
`check-fonts.py` proves the glyphs standing for those words are all present
and all used.

Two marks are reported as written differently rather than missing: this mushaf
spells sukun U+0652 where your list has U+06E1, and madda U+0653 where the list
has U+06E4. Both are the same mark under a different convention. The end-of-ayah
sign is not a character here at all — it is its own glyph, and is checked by
confirming all 6236 verses close with exactly one.

## Features

- The Madinah Mushaf page by page, 15 lines to a page
- A whole page on screen at 100%, and zoom either side of it
- Drag the page to scroll, and it glides on when you let go
- Turn pages with the arrow keys or the rail, landing each one at the top
- A help panel listing every key and gesture, and what the browser stores
- Two reading modes: one page at a time, or two facing as the mushaf opens
- A handle on the index's edge that slides with it, open or shut
- A page dimmer in the rail, beside the light/dark toggle, veiling the whole UI
- Every sheet carries a running head: juz, surah and folio
- Three text weights, drawn as a hairline stroke the face has no cut for
- Surahs organised by Juz (1–30) in the index
- Saved pages in `localStorage` (no login, persist until cleared)
- Dark / light mode, Arabic / English UI
- Surah search by name or number
- Remembers the last page read
- Responsive — adapts to mobile, tablet and desktop
