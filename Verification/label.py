"""
Hand-labelling, so that at least some of the ground truth is certain.

Everything measured so far agrees on where the automatic split fails: about a
third of dots and marks are drawn touching the letter they belong to, and once
two things are one blob of ink no measurement of blobs will separate them. The
shape test is exact about the dots it can see and silent about the rest.

So the rest are settled by hand. A glyph arrives already split as well as the
machine can manage; the work is correcting it, not doing it from nothing, and a
word takes a few clicks rather than a few minutes.

What is stored is per blob, not per pixel: which connected piece of ink is a
letter, which is one of a letter's dots, and which is a diacritic. That is
enough to rebuild the two masks exactly, and it stays true if the glyph is
redrawn at another size.
"""

import json
import os

import cv2
import numpy as np

import render

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "labels.json")

_TEXT = None


def uthmani():
    """{(page, glyph): the word's Uthmani spelling} from reference/words.json.

    Keyed by page as well as glyph, because a QCF code only means anything
    inside its own page's font: keyed by the code alone all 604 pages collapse
    onto each other, and page 3 comes back spelled as Al-Ikhlas.
    """
    global _TEXT
    if _TEXT is None:
        path = os.path.join(HERE, "..", "reference", "words.json")
        with open(path, encoding="utf-8") as fh:
            _TEXT = {(w["page"], w["v2"]): w["text"]
                     for w in json.load(fh) if w.get("v2")}
    return _TEXT

# Two classes, and only two. Telling a fatha from a waqf sign is a question
# about what a mark means; telling ink that is a mark from ink that is a letter
# is a question about what is drawn, and only the second can be answered from a
# picture. Splitting the marks four ways left two of the classes with eight
# examples and none, which taught the model nothing and cost every label an
# extra decision.
LETTER, MARK = 0, 1
COLOURS = {LETTER: (30, 30, 30), MARK: (40, 40, 230)}
NAMES = {LETTER: "letter", MARK: "mark"}
CLASSES = (LETTER, MARK)

# The wasla drawn over an alef wasla is a sign in its own right, sitting clear
# above the letter, and the model calls it a mark. Counting only combining
# characters missed it and so scored the model wrong for being right.
#
# The hamza is deliberately not here. It is drawn into the letter it belongs
# to -- an alef with a hamza is one shape, not an alef with something added --
# so it counts as a letter, and the labels say the same. Referee and labels
# have to agree about this or the model is taught one thing and marked against
# another.
BUILT_IN = "ٱ"

# What a word's spelling says it carries. Every combining mark counts the
# same, because the model is not being asked to tell them apart.
MARK_CHARS = set(
    "ًٌٍَُِّْٓٔ"
    "ٰٕٖۖۗۘۙۚۛۜ"
    "ۣ۟۠ۡۢۥۦ۩۪۫"
    "ۭ۬۝۞")

EVERY = MARK_CHARS


def expected(text):
    """How many marks the word's spelling says it has, drawn ones included."""
    return (sum(1 for ch in text if ch in MARK_CHARS)
            + sum(1 for ch in text if ch in BUILT_IN))

PX = 200          # every labelled glyph is drawn at this size, so the blob
                  # numbering is stable between sessions


_BLOBS = {}


def blobs(page, code):
    """(mask, labels, stats) for one word, at the fixed labelling size.

    Cached. Drawing a word from its outlines costs 0.4s, and a single click
    used to pay it three times over -- once to guess, once to draw, once to
    find which blob was hit. The drawing never changes: same font, same code,
    same size.
    """
    ck = (page, code)
    if ck not in _BLOBS:
        font = render.page_font(page)
        mask, _ = render.render_words(font, [code], PX, pad_frac=0.1, side_frac=0.1)
        b = (mask > 127).astype(np.uint8)
        n, lab, st, _ = cv2.connectedComponentsWithStats(b, 8)
        keep = [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= 20]
        _BLOBS[ck] = (mask, lab, st, keep)
    return _BLOBS[ck]


_GUESS = {}


def guess(page, code):
    """The trained net's split, as a class per blob -- a starting point.

    Measuring blobs used to do this, by calling anything small and clear of the
    letters a mark. It managed 37% of words exactly against the spelling; the
    net manages 79%, because a third of marks are drawn touching the letter
    beneath them and no measurement of a blob will ever separate those.

    """
    if (page, code) in _GUESS:
        return dict(_GUESS[(page, code)])
    import unet
    mask, lab, st, keep = blobs(page, code)
    ink = (mask > 127).astype(np.uint8)
    hot = (unet.marks_of(_net(), ink) > 0.5) & (ink > 0)
    out = {}
    for i in keep:
        piece = (lab == i)
        out[str(i)] = MARK if (piece & hot).sum() > piece.sum() * 0.5 else LETTER
    _GUESS[(page, code)] = out
    return dict(out)


_NET = None


def _net():
    """The trained net, loaded once. Labelling asks it for every word."""
    global _NET
    if _NET is None:
        import unet
        _NET = unet.load()
    return _NET


def load():
    try:
        with open(STORE, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def save(store):
    with open(STORE, "w", encoding="utf-8") as fh:
        json.dump(store, fh, indent=1, ensure_ascii=False)


def key(page, code):
    return "%d/%s" % (page, code)


def draw(page, code, classes, scale=1.0):
    """The word, each blob painted by its class."""
    mask, lab, st, keep = blobs(page, code)
    vis = np.full(mask.shape + (3,), 255, np.uint8)
    for i in keep:
        vis[lab == i] = COLOURS.get(int(classes.get(str(i), LETTER)), COLOURS[LETTER])
    if scale != 1.0:
        vis = cv2.resize(vis, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return vis


def blob_at(page, code, x, y):
    """Which blob a click landed on, or the nearest one within reach."""
    mask, lab, st, keep = blobs(page, code)
    h, w = lab.shape
    x, y = int(round(x)), int(round(y))
    if 0 <= x < w and 0 <= y < h and lab[y, x] in keep:
        return int(lab[y, x])
    best, dist = None, 1e9
    for i in keep:
        cx = st[i, cv2.CC_STAT_LEFT] + st[i, cv2.CC_STAT_WIDTH] / 2
        cy = st[i, cv2.CC_STAT_TOP] + st[i, cv2.CC_STAT_HEIGHT] / 2
        d = (cx - x) ** 2 + (cy - y) ** 2
        if d < dist:
            best, dist = i, d
    return best if dist < (0.12 * PX) ** 2 else None


def to_label(pages, per_page=None):
    """Words worth labelling: any with at least one diacritic in its spelling."""
    text = uthmani()
    out = []
    for pg in pages:
        try:
            render.page_font(pg)
        except Exception:
            continue
        skip = set(render.mushaf()["marks"].get(str(pg), ""))
        seen = 0
        for ln in render.mushaf()["pages"][str(pg)]:
            if ln["t"] != "ayah":
                continue
            for code in ln["v2"].split("|"):
                if any(c in skip for c in code):
                    continue
                txt = text.get((pg, code))
                if not txt or not any(c in EVERY for c in txt):
                    continue
                out.append({"page": pg, "code": code, "text": txt})
                seen += 1
                if per_page and seen >= per_page:
                    break
            if per_page and seen >= per_page:
                break
    return out


def doubt(page, code, net, px_per_em=PX):
    """How badly a word wants a person to look at it.

    Two things make a word worth a click, and they are not the same thing.

    The net can be *unsure*: its output sits near a half over much of the ink,
    which is it saying it cannot tell. And it can be confidently *wrong*: the
    marks it finds do not number what the spelling says the word carries. The
    second is the more useful signal, because a model is most dangerous where
    it is certain and mistaken, and the spelling is an independent witness that
    costs nothing.

    Returns (score, marks found, marks spelled, mean doubt). Higher is worse.
    """
    import unet
    mask, lab, st, keep = blobs(page, code)
    ink = (mask > 127).astype(np.uint8)
    p = unet.marks_of(net, ink)
    on = ink > 0
    if not on.any():
        return 0.0, 0, 0, 0.0

    # how far from a decision, averaged over ink: 0 is certain, 1 is a coin toss
    unsure = float((1.0 - 2.0 * np.abs(p[on] - 0.5)).mean())

    floor = (0.2 * px_per_em) ** 2 * 0.25
    hot = ((p > 0.5) & on).astype(np.uint8) * 255
    n, _, stats, _ = cv2.connectedComponentsWithStats(hot, 8)
    found = sum(1 for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= floor)

    spelled = expected(uthmani().get((page, code), ""))

    off = abs(found - spelled)
    return off + unsure, found, spelled, unsure


def worth_labelling(pages, net, per_page=None, skip=None):
    """Words ranked by how much a person's attention would be worth on them."""
    skip = skip or set()
    out = []
    for d in to_label(pages, per_page=per_page):
        k = key(d["page"], d["code"])
        if k in skip:
            continue
        score, found, spelled, unsure = doubt(d["page"], d["code"], net)
        d = dict(d, score=round(score, 3), found=found, spelled=spelled,
                 unsure=round(unsure, 3))
        out.append(d)
    return sorted(out, key=lambda d: -d["score"])
