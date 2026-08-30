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

import io
import json
import os

import store
import shutil

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


# A mark is one character to the spelling and sometimes more than one piece of
# ink in the font, and the two were being compared as though they were the same
# number. They are not, and it is not a property of the character alone.
#
# Tanwin is a doubled vowel. Standing free it is drawn as two strokes; before
# the small meem of iqlab it is drawn assimilated, as one. That is not a guess:
# of the labelled words, all eighteen with a tanwin before a small meem come to
# exactly one piece, and the one with a free tanwin comes to exactly two.
#
# The waqf signs shaped like letters carry that letter's dots, and the dot is a
# separate piece of ink. Measured rather than assumed: the jim waqf on فوقها is
# a body of 1041 pixels with an 86-pixel dot beneath it, and the qala waqf on
# السفهاء is 1777 pixels with a 194-pixel piece above.
#
# Only what there is evidence for is here. A mark drawn from more pieces than
# this says shows up as a word whose count disagrees -- which is exactly how
# these were found, so the next one will be found the same way.
# Sets, not strings. "x in some_string" is a substring test, and the empty
# string is a substring of everything -- so a tanwin at the end of a word, with
# nothing after it to look at, tested as though it were followed by a small
# meem and was counted as assimilated. It is the loosest kind of bug: right for
# every word but the one shape it is wrong for.
# Bumped whenever the counting changes. A score measured under an older rule is
# not wrong so much as answering a different question, and the difference is
# invisible unless something writes down which rule was in force.
#   1  every mark counted as one
#   2  pieces, not characters: free tanwin two, waqf jim and qala two
COUNT_RULE = 2

TANWIN = set("ًٌٍ")        # fathatan, dammatan, kasratan
ASSIMILATES = set("ۭۢ")          # the small meems tanwin leans into

TWO_PIECES = {
    "ۚ": "waqf jim -- its body and its dot",
    "ۗ": "waqf qala -- its body and the qaf's dots",
}


def pieces_of(text, i):
    """How many pieces of ink the mark at text[i] is drawn as."""
    ch = text[i]
    if ch in TANWIN:
        after = text[i + 1] if i + 1 < len(text) else ""
        return 1 if after in ASSIMILATES else 2
    return 2 if ch in TWO_PIECES else 1


def expected(text):
    """How many marks the word's spelling says it has, drawn ones included."""
    return sum(pieces_of(text, i) for i, ch in enumerate(text)
               if ch in MARK_CHARS or ch in BUILT_IN)

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


# The reading order of a word's pieces, which is the only thing the pairing
# between a word drawn alone and the same word inside a line actually needs.
#
# Kept on disk, not merely in memory. Working it out means drawing the word
# from its outlines -- four tenths of a second -- and a page has a hundred and
# thirty words on it, so the first look at a page cost the best part of a
# minute and cost it again after every restart. The order is a list of small
# integers and never changes: same font, same code, same size.
ORDER = os.path.join(HERE, "blob-order.json")
_ORDER = None


def _order_store():
    global _ORDER
    if _ORDER is None:
        try:
            with io.open(ORDER, encoding="utf-8") as fh:
                _ORDER = json.load(fh)
        except Exception:
            _ORDER = {}
    return _ORDER


def order_of(page, code):
    """The word's pieces, rightmost first then downward. Cached to disk."""
    store = _order_store()
    k = key(page, code)
    if k not in store:
        _, _, st, keep = blobs(page, code)
        store[k] = sorted(keep, key=lambda i: (
            -(st[i, cv2.CC_STAT_LEFT] + st[i, cv2.CC_STAT_WIDTH] / 2),
            st[i, cv2.CC_STAT_TOP]))
        _order_store.dirty = True
    return store[k]


def flush_order():
    """Write out any orders worked out since the last call."""
    if not getattr(_order_store, "dirty", False):
        return
    with io.open(ORDER, "w", encoding="utf-8") as fh:
        json.dump(_order_store(), fh)
    _order_store.dirty = False


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
    return store.load(STORE)


def save(labels):
    """Write the labels, keeping the previous copy beside them.

    These are the only thing in the project that cannot be made again.
    """
    store.save(STORE, labels)


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
