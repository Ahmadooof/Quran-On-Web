# Mushaf fonts

Fetch everything in this directory with:

```bash
npm run fetch:fonts
```

| Path                | What it is                                              | Size    |
|---------------------|---------------------------------------------------------|---------|
| `v1/p1…p604.woff2`  | QCF V1 — one font per mushaf page                        | ~46 MB  |
| `v2/p1…p604.woff2`  | QCF V2 — one font per mushaf page                        | ~93 MB  |
| `sura-names.woff2`  | Ornamental surah headers                                 | ~87 KB  |

The page fonts are **not** in git — 1208 files at ~140 MB. The fetch script
skips files that are already present, so an interrupted run just resumes.

## Why one font per page

These are the King Fahd Complex mushaf typefaces. They do not encode Arabic
letters: each glyph is a whole word, drawn exactly as it is printed on one
specific page of the Madinah Mushaf. Page 5's glyph codes render as the wrong
words in page 6's font, so the codes in `public/data/mushaf.json` and the font
files here have to come from the same source — rebuild both together.

Because of that, the app registers a page's font from JavaScript as the page
comes into view rather than declaring 1208 `@font-face` rules up front.

## Where the Basmalah comes from

The page fonts contain only the ayah words, so none of them carries a
Basmalah — but Al-Fatihah 1:1 *is* the Basmalah, so page 1's font has it in
both versions. Every surah's Basmalah line is drawn from those glyphs, which
is why it always matches the selected version's face.

Source: `static.qurancdn.com`. Licence: <http://dm.qurancomplex.gov.sa/copyright-2/>
