"""
One photograph, cut into the lines the model reads one at a time.

This was written twice before it was written once. Reading a photograph and
labelling a photograph both have to cut it into the same strips at the same
scale, and when each did its own cutting the labels pointed at pieces of ink
that no longer existed by the time anything was trained on them -- a blob is
numbered by where it falls in the strip, so a strip half a pixel taller is a
different set of blobs wearing the same numbers.

So the cutting lives here, once, and both callers ask for it.

Two things decide what comes out.

Where the lines are, from the gaps between them: a mushaf line is solid ink
across the measure and the space above it is empty, so the count of ink pixels
in each row of the page has fifteen humps in it.

How much to enlarge, from how tall those lines stand. A convolution has a fixed
reach in pixels. The net was taught at two hundred pixels to the em, and a
photograph opened at whatever size the camera gave means nothing to it until
its lines stand as tall as the type's do.
"""

import os

import numpy as np
import cv2

import label
import photo
import render

# How much blank paper to keep above and below a line, as a share of its
# height. The net wants some background to see an edge against, and a mark
# that sits high above its letter is otherwise cut in half by the seam.
PAD = 0.35

_PAGE = {}


def line_height_of_type():
    """How tall a line of the type stands at the size the net was taught at."""
    if "want" not in _PAGE:
        drawn = render.render_page(3, label.PX)[0][0]
        rows = np.nonzero((drawn > 127).any(1))[0]
        _PAGE["want"] = float(rows.max() - rows.min() + 1) if len(rows) else 150.0
    return _PAGE["want"]


def find(mask, floor=0.15, smooth=9):
    """Where the lines sit in a page of ink, as (top, bottom) rows."""
    proj = (mask > 0).sum(1).astype(float)
    sm = np.convolve(proj, np.ones(smooth) / smooth, "same")
    out, start = [], None
    for i, on in enumerate(sm > sm.max() * floor):
        if on and start is None:
            start = i
        elif not on and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(sm)))
    return [b for b in out if b[1] - b[0] > mask.shape[0] * 0.01]


_CUT = {}
_ORDER = []
MOST_KEPT = 6          # photographs are large; a few is all anything needs


def cut(path, detail):
    """A photograph as (picture, ink, lines, how much to enlarge).

    Kept, because opening a fifty-megapixel capture and thresholding it takes
    seconds and the labelling asks for one line after another out of the same
    page.
    """
    ck = (os.path.abspath(path), int(detail))
    if ck in _CUT:
        return _CUT[ck]
    img = photo.load(path, longest=detail)
    mask = photo.ink(img)
    lines = find(mask)
    if not lines:
        raise ValueError("no lines found in that photograph")
    tall = float(np.median([b - a for a, b in lines]))
    factor = max(0.3, min(4.0, (line_height_of_type() / tall) if tall else 1.0))
    _CUT[ck] = (img, mask, lines, factor, tall)
    _ORDER.append(ck)
    while len(_ORDER) > MOST_KEPT:
        _CUT.pop(_ORDER.pop(0), None)
    return _CUT[ck]


def strip(mask, lines, i, factor, tall):
    """One line, enlarged to the scale the net was taught at.

    Returns the strip as binary ink, and where it came from, so what is found
    in it can be put back on the photograph it came out of.
    """
    a, b = lines[i]
    pad = int(tall * PAD)
    top, bot = max(0, a - pad), min(mask.shape[0], b + pad)
    raw = mask[top:bot]
    big = cv2.resize(raw, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
    # resize on a binary image gives grey along every edge; put it back to ink
    return (big > 110).astype(np.uint8), (top, bot), raw


def pieces(big, least=20):
    """The blobs of one strip, numbered. The unit a person labels in.

    Numbered by connected components, which is deterministic given the same
    strip -- and the strip is deterministic given the same photograph and the
    same detail. That is what lets a label written today still mean the same
    piece of ink next week without storing an outline for it.
    """
    n, lab, st, _ = cv2.connectedComponentsWithStats(big, 8)
    keep = [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= least]
    return lab, st, keep
