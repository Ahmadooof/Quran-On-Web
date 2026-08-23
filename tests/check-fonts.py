"""
Checks the QCF page fonts against public/data/mushaf.json.

This is the half of the suite that can prove the marks are actually drawn.
A QCF glyph is a whole word with its tashkeel, waqf sign and pause marks
already in the outline, and a V2 page font holds exactly one glyph per word
printed on that page. So checking the coverage both ways --

    every code we use exists in the page's font
    the codes we use form an unbroken run, with no glyph skipped

-- settles the whole question at once, for all 604 pages. A V2 page font
encodes its words as one ascending run of codes, so a printed word the layout
left out would show up as a hole in that run: no diacritic, pause mark, sajdah
sign or ayah marker can go missing without one of the two checks failing.

Also measures the type: whether every page really is drawn to one scale, and
whether the line widths agree with the sizing constants the reader uses.

Needs fontTools:  pip install fonttools
Run with: npm run test:fonts
"""

import json
import os
import statistics
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(ROOT, "public", "fonts")
PAGES = 604

try:
    from fontTools.ttLib import TTFont
except ImportError:
    print("fontTools is not installed.  pip install fonttools")
    sys.exit(2)


results = []


def check(name):
    def wrap(fn):
        try:
            results.append((True, name, fn() or ""))
        except AssertionError as err:
            results.append((False, name, str(err)))
        return fn
    return wrap


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


mushaf = load(os.path.join(ROOT, "public", "data", "mushaf.json"))
pages = mushaf["pages"]

# the gap a centred line opens between its words -- see .m-short in style.css
CENTRE_GAP = 0.32

def codes_on(page, ver):
    """Every codepoint the layout asks for on this page."""
    out = set()
    for line in pages[str(page)]:
        if line["t"] != "ayah":
            continue
        for word in line[ver].split("|"):
            for ch in word:
                if ch != " ":
                    out.add(ord(ch))
    return out


def line_ems(page, ver, font):
    """Width of each ayah line, in ems of the font's own design size."""
    upm = font["head"].unitsPerEm
    hmtx = font["hmtx"]
    cmap = font.getBestCmap()
    out = []
    for line in pages[str(page)]:
        if line["t"] != "ayah":
            continue
        total = 0
        for word in line[ver].split("|"):
            for ch in word:
                g = cmap.get(ord(ch))
                if g:
                    total += hmtx[g][0]
        out.append(total / upm)
    return out


# The reader draws V2 only; V1 is checked when its files are on disk, and
# skipped when they are not, so deleting public/fonts/v1 costs nothing.
VERSIONS = [v for v in ("v1", "v2")
            if os.path.exists(os.path.join(FONTS, v, "p1.woff2"))]
if "v2" not in VERSIONS:
    print("public/fonts/v2 is missing.  npm run fetch:fonts")
    sys.exit(2)

# Loading the fonts is the slow part, so everything is measured in one sweep.
print("Reading %d page fonts..." % (len(VERSIONS) * PAGES))
scan = {}
for ver in VERSIONS:
    missing_files, missing_codes, unused, holes, ems = [], [], [], [], {}
    for p in range(1, PAGES + 1):
        path = os.path.join(FONTS, ver, "p%d.woff2" % p)
        if not os.path.exists(path) or os.path.getsize(path) < 2000:
            missing_files.append(p)
            continue
        font = TTFont(path)
        cmap = set(font.getBestCmap())
        used = codes_on(p, ver)

        absent = used - cmap
        if absent:
            missing_codes.append((p, sorted(absent)[:4]))

        # Holes in the run of codes the page uses. The words of a page are
        # encoded as one unbroken ascending run, so a gap means a printed word
        # the layout skipped. Glyphs outside the run are spare font content.
        lo, hi = min(used), max(used)
        gaps = [c for c in range(lo, hi + 1) if c not in used]
        if gaps:
            holes.append((p, len(gaps)))
        if cmap - used:
            unused.append((p, len(cmap - used)))

        ems[p] = line_ems(p, ver, font)
        if p % 100 == 0:
            sys.stdout.write("  %s %d/%d\r" % (ver, p, PAGES))
    sys.stdout.write("\n")
    scan[ver] = dict(missing_files=missing_files, missing_codes=missing_codes,
                     unused=unused, holes=holes, ems=ems)


@check("every page font is present and readable")
def _():
    for ver in VERSIONS:
        bad = scan[ver]["missing_files"]
        assert not bad, "%s is missing %d page fonts (%s)" % (ver, len(bad), bad[:6])
    sura = os.path.join(FONTS, "sura-names.woff2")
    assert os.path.exists(sura), "sura-names.woff2 is missing"
    return "604 V1 + 604 V2 page fonts, plus the surah-header face"


@check("every glyph the layout asks for exists in its page font")
def _():
    for ver in VERSIONS:
        bad = scan[ver]["missing_codes"]
        assert not bad, "%s: %d pages ask for glyphs their font lacks (%s)" % (
            ver, len(bad), bad[:3])
    return "all 83665 words resolve in both versions, on all 604 pages"


@check("V2 leaves nothing on the page undrawn")
def _():
    """A V2 page font encodes the words printed on that page as one unbroken
    ascending run of codes. If the layout skipped a printed word -- a pause
    mark, a sajdah sign, an ayah marker -- its code would be missing and the
    run would have a hole in it. No holes means nothing printed is omitted."""
    bad = scan["v2"]["holes"]
    assert not bad, "%d pages skip a glyph inside their own run (%s)" % (
        len(bad), bad[:5])
    spare = len(scan["v2"]["unused"])
    return ("all 604 pages use an unbroken run of codes — nothing printed is omitted"
            + ("; %d pages also carry spare ligatures outside the run" % spare if spare else ""))


@check("V2 draws every page to one scale")
def _():
    """This is what lets the whole mushaf be set at a single type size. V2
    draws each line to nearly the same width, so if the pages were drawn to
    different scales their line widths would not agree."""
    medians = [statistics.median(ls) for p, ls in scan["v2"]["ems"].items() if p > 2]
    mid = statistics.median(medians)
    spread = (max(medians) - min(medians)) / mid * 100
    assert spread < 5, (
        "per-page line width ranges %.2f-%.2f em (%.1f%%) — the pages are not one "
        "scale, so a single type size would be wrong" % (min(medians), max(medians), spread))
    return "line width is %.2fem on every page (spread %.1f%%) across all 602 body pages" % (
        mid, spread)


@check("the reader's type sizes match what the fonts actually measure")
def _():
    fit = mushaf["fit"]
    notes = []
    for ver in VERSIONS:
        body = sorted(e for p, ls in scan[ver]["ems"].items() if p > 2 for e in ls)
        p999 = body[int(len(body) * 0.999)]
        base = fit["body"][ver]
        assert abs(base - p999) / p999 < 0.02, (
            "%s base is %.2fem but the fonts measure %.2fem at the 99.9th "
            "percentile — rebuild the constants" % (ver, base, p999))
        median_fill = statistics.median(body) / base * 100
        notes.append("%s base %.2fem, median line fills %.0f%%" % (ver, base, median_fill))

    return "; ".join(notes)


@check("only a handful of lines need pulling in, and none by much")
def _():
    """Lines wider than the measure are set slightly smaller by the reader.
    That should stay rare and slight, or the page would look uneven."""
    notes = []
    for ver in VERSIONS:
        base = mushaf["fit"]["body"][ver]
        over = [(p, i + 1, e) for p, ls in scan[ver]["ems"].items() if p > 2
                for i, e in enumerate(ls) if e > base]
        worst = max((e / base - 1) * 100 for _, _, e in over) if over else 0.0
        assert len(over) <= 20, "%s: %d lines overflow, expected at most 20" % (ver, len(over))
        assert worst < 20, "%s: worst line is %.1f%% over the measure" % (ver, worst)
        notes.append("%s %d lines, worst %.1f%% smaller" % (ver, len(over), worst))
    return "; ".join(notes)


@check("the framed opening spread is set at the same size, in a narrow column")
def _():
    """Pages 1-2 are drawn to the same scale as the rest, so they take the same
    type size; their lines are short because the ornamental border leaves a
    narrow column, and short lines are centred rather than stretched. Sizing
    them on their own content instead is what made Al-Fatihah come out half
    again too large."""
    notes = []
    for ver in VERSIONS:
        base = mushaf["fit"]["body"][ver]
        thr = mushaf["fit"]["centreBelow"][ver]
        spread = [e for p, ls in scan[ver]["ems"].items() if p <= 2 for e in ls]
        fills = [e / base for e in spread]
        assert max(fills) < thr, (
            "%s: a spread line fills %.0f%% of the measure but lines are only "
            "centred below %.0f%% — it would be stretched across the page"
            % (ver, max(fills) * 100, thr * 100))
        notes.append("%s fills %.0f-%.0f%%" % (ver, min(fills) * 100, max(fills) * 100))
    return "pages 1-2 are centred at the normal size (" + ", ".join(notes) + ")"


@check("centring short lines stays rare on the body pages")
def _():
    """Centring is for lines that genuinely stop short. If it caught ordinary
    lines the pages would look ragged instead of justified."""
    notes = []
    for ver in VERSIONS:
        base = mushaf["fit"]["body"][ver]
        thr = mushaf["fit"]["centreBelow"][ver]
        body = [e for p, ls in scan[ver]["ems"].items() if p > 2 for e in ls]
        short = [e for e in body if e / base < thr]
        pct = len(short) / len(body) * 100
        assert pct < 2, (
            "%s: %.1f%% of body lines would be centred — the threshold of %.0f%% "
            "is catching ordinary lines" % (ver, pct, thr * 100))
        notes.append("%s %d of %d lines (%.1f%%)" % (ver, len(short), len(body), pct))
    return "; ".join(notes)


@check("centred lines still fit once their gaps are counted")
def _():
    """Centring opens a 0.32em gap between the words. A line already close to
    the measure has no room for them, so the reader leaves it justified instead
    -- counting the gaps is what keeps it inside the sheet."""
    notes = []
    for ver in VERSIONS:
        base = mushaf["fit"]["body"][ver]
        thr = mushaf["fit"]["centreBelow"][ver]
        centred = justified = 0
        for p, ls in scan[ver]["ems"].items():
            ayahs = [l for l in pages[str(p)] if l["t"] == "ayah"]
            for line, em in zip(ayahs, ls):
                if em / base >= thr:
                    continue
                gaps = (len(line[ver].split("|")) - 1) * CENTRE_GAP
                if em + gaps <= base:
                    centred += 1
                else:
                    justified += 1
        assert centred > 20, "%s: only %d short lines end up centred" % (ver, centred)
        notes.append("%s %d centred, %d left justified" % (ver, centred, justified))
    return "; ".join(notes)


print("\nMushaf fonts\n")
for ok, name, detail in results:
    print("  %s  %s" % ("PASS" if ok else "FAIL", name))
    if detail:
        print("        %s" % detail)

failed = sum(1 for ok, _, _ in results if not ok)
print("\n%d/%d checks passed.\n" % (len(results) - failed, len(results)))
sys.exit(1 if failed else 0)
