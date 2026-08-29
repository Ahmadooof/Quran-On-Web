"""
Draws a mushaf page straight from its QCF V2 woff2, at any resolution.

A V2 page font holds one glyph per printed word, and the words are set by
their own advance widths with no shaping and no kerning. So a page can be laid
out here exactly as the browser lays it out -- place each glyph at the running
advance, right to left -- without a browser or a shaping engine in the loop.

That matters twice over. It gives a digital reference at whatever resolution
the comparison needs, instead of a screenshot pinned to the screen's pixels.
And because it is the font's own geometry with nothing else on top, a
disagreement between this and the browser is the browser's doing, not the
font's -- which is the one clean way to separate the two uncertainties.
"""

import json
import os

import numpy as np
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(ROOT, "public", "fonts", "v2")
MUSHAF = os.path.join(ROOT, "public", "data", "mushaf.json")

_mushaf = None


def mushaf():
    global _mushaf
    if _mushaf is None:
        with open(MUSHAF, encoding="utf-8") as fh:
            _mushaf = json.load(fh)
    return _mushaf


def page_font(page):
    return TTFont(os.path.join(FONTS, "p%d.woff2" % page))


def flatten(pen_value, steps=8):
    """Contours as point lists, with quadratics sampled into line segments."""
    contours, cur, start = [], [], (0, 0)
    for op, args in pen_value:
        if op == "moveTo":
            if cur:
                contours.append(cur)
            start = args[0]
            cur = [start]
        elif op == "lineTo":
            cur.append(args[0])
        elif op == "qCurveTo":
            # TrueType off-curve runs: consecutive control points imply an
            # on-curve point at each midpoint between them.
            pts = list(args)
            on_end = pts[-1] if pts[-1] is not None else start
            ctrls = pts[:-1]
            prev = cur[-1] if cur else start
            for i, c in enumerate(ctrls):
                nxt = ctrls[i + 1] if i + 1 < len(ctrls) else on_end
                end = nxt if i + 1 == len(ctrls) else ((c[0] + nxt[0]) / 2, (c[1] + nxt[1]) / 2)
                for s in range(1, steps + 1):
                    t = s / steps
                    u = 1 - t
                    cur.append((u * u * prev[0] + 2 * u * t * c[0] + t * t * end[0],
                                u * u * prev[1] + 2 * u * t * c[1] + t * t * end[1]))
                prev = end
        elif op == "closePath":
            if cur:
                contours.append(cur)
                cur = []
    if cur:
        contours.append(cur)
    return contours


def glyph_contours(glyphset, name, seen=None):
    """Outline of one glyph, with composites resolved through their components."""
    pen = RecordingPen()
    glyphset[name].draw(pen)
    return flatten(pen.value)


def line_words(page, line):
    return line["v2"].split("|")


def render_line(page, line_idx, px_per_em, pad_frac=0.15):
    """One ayah line. Returns a uint8 ink mask and the word x-bounds."""
    font = page_font(page)
    line = mushaf()["pages"][str(page)][line_idx]
    return render_words(font, line_words(page, line), px_per_em, pad_frac)


def render_words(font, words, px_per_em, pad_frac=0.15, side_frac=0.15):
    """Draws a run of QCF words right-to-left. Returns (mask, word_x_bounds).

    The scale is given in pixels per em, never derived from this line's own ink
    height. The mushaf sets the whole page at one size, so a line that happens
    to carry tall ascenders is not a smaller line -- scaling each line to a
    fixed ink height silently shrinks it, and every width comparison after that
    is measuring the bug instead of the type.
    """
    upm = font["head"].unitsPerEm
    hmtx, cmap, gs = font["hmtx"], font.getBestCmap(), font.getGlyphSet()

    # RTL sets the pen right to left, but each glyph is still drawn in its own
    # left-to-right frame -- mirroring the outline itself would reverse the
    # letters. So only the origin moves leftward.
    # A few word codes carry a space of their own -- a gap the typeface designs
    # into the middle of a word. It has no glyph, so it is dropped here.
    names = [cmap[ord(ch)] for w in words for ch in w if ord(ch) in cmap]
    total_adv = sum(hmtx[n][0] for n in names)

    placed, cum = [], 0
    for n in names:
        cum += hmtx[n][0]
        placed.append((n, total_adv - cum))

    polys, ymin, ymax = [], 1e9, -1e9
    for name, ox in placed:
        for c in glyph_contours(gs, name):
            pts = [(ox + px, py) for px, py in c]
            polys.append(pts)
            for _, py in pts:
                ymin = min(ymin, py)
                ymax = max(ymax, py)

    scale = px_per_em / upm
    # Height and width are padded separately. Widening the strip moves every
    # word's box with it, so asking for more room above the marks must not
    # quietly change where the words sit.
    pad = int(round(px_per_em * pad_frac))
    side = int(round(px_per_em * side_frac))
    W = int(round(total_adv * scale)) + 2 * side
    H = int(round((ymax - ymin) * scale)) + 2 * pad

    # Even-odd fill: a letter's counter is wound against its outer contour, so
    # XORing the contours one at a time leaves the holes open. Filling them all
    # into one mask would blot every ha and mim solid. Each contour is drawn in
    # its own bounding box rather than a page-sized one -- a page holds tens of
    # thousands of them, and full-page buffers make that unaffordable.
    acc = np.zeros((H, W), dtype=bool)
    for pts in polys:
        px = [(side + x * scale, pad + (ymax - y) * scale) for x, y in pts]
        xs = [p[0] for p in px]
        ys = [p[1] for p in px]
        x0, x1 = int(max(0, min(xs) - 1)), int(min(W, max(xs) + 2))
        y0, y1 = int(max(0, min(ys) - 1)), int(min(H, max(ys) + 2))
        if x1 <= x0 or y1 <= y0:
            continue
        one = Image.new("1", (x1 - x0, y1 - y0), 0)
        ImageDraw.Draw(one).polygon([(x - x0, y - y0) for x, y in px], fill=1)
        acc[y0:y1, x0:x1] ^= np.array(one, dtype=bool)

    bounds, cum = [], 0
    for w in words:
        adv = sum(hmtx[cmap[ord(c)]][0] for c in w if ord(c) in cmap)
        x1 = side + (total_adv - cum) * scale
        x0 = side + (total_adv - cum - adv) * scale
        bounds.append((x0, x1))
        cum += adv
    return (acc * 255).astype(np.uint8), bounds


def render_page(page, px_per_em=48):
    """Every ayah line of a page, as (mask, word_bounds) pairs.

    Used to re-rank a shortlist of candidate pages against a photograph, so it
    is drawn small: the match turns on where the ink falls along each line, not
    on the shape of any one letter.
    """
    font = page_font(page)
    out = []
    for ln in mushaf()["pages"][str(page)]:
        if ln["t"] != "ayah":
            continue
        out.append(render_words(font, ln["v2"].split("|"), px_per_em))
    return out
