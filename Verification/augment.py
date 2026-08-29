"""
Makes the hard cases out of the easy ones.

The labelled words are all words where every mark stands clear of the letters,
because those are the only ones a person can label without guessing. That is
also what makes them useless on their own: a rule that finds marks in them is
not solving the problem, since about a third of marks in the mushaf are drawn
touching the letter beneath them and no measurement of blobs will ever pull
those apart.

So the touching is done here, on purpose. A mark is dragged towards its letter
and a bridge of ink is drawn between them until the two are one blob -- and the
answer is still known, because the mask was written down before the bridge was.
Every fused example is a question with its answer attached, and there is no
limit to how many can be made.

The fusions imitate what the typeface actually does: a mark settling onto the
stroke below it, a shadda and a fatha running together, ink laid on heavily
enough that neighbours meet.
"""

import numpy as np
import cv2

import label
import render


_CACHE = {}

# How many hard examples have been made since the process started. Worth
# knowing: the labelled set is a hundred-odd words and the training set is
# whatever this counter reaches, which are numbers three orders of magnitude
# apart and easily confused for each other.
DRAWN = 0


def pieces(page, code, classes, px_per_em=label.PX):
    """One word as (ink, class-per-pixel), from the hand labels.

    Cached, because drawing a glyph from its outlines costs a quarter of a
    second and training wants ten thousand samples: without this the fusion
    spends forty minutes redrawing ninety-seven words over and over.
    """
    ck = (page, code, px_per_em)
    if ck in _CACHE:
        ink, lab, st = _CACHE[ck]
        truth = np.zeros(ink.shape, np.uint8)
        for i in range(1, st.shape[0]):
            truth[lab == i] = int(classes.get(str(i), label.LETTER))
        return ink, truth, lab, st
    font = render.page_font(page)
    mask, _ = render.render_words(font, [code], px_per_em, pad_frac=0.1, side_frac=0.1)
    b = (mask > 127).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(b, 8)
    _CACHE[ck] = (b, lab, st)
    truth = np.zeros(b.shape, np.uint8)
    for i in range(1, n):
        truth[lab == i] = int(classes.get(str(i), label.LETTER))
    return b, truth, lab, st


def _bridge(canvas, a, b, width, rng):
    """Draw ink joining two blobs, as a stroke between their nearest points."""
    ya, xa = np.nonzero(a)
    yb, xb = np.nonzero(b)
    if not len(ya) or not len(yb):
        return
    # nearest pair, sampled rather than exhaustive -- a blob can be thousands
    # of pixels and the exact nearest pair does not matter
    ia = rng.choice(len(ya), size=min(60, len(ya)), replace=False)
    ib = rng.choice(len(yb), size=min(60, len(yb)), replace=False)
    pa = np.stack([xa[ia], ya[ia]], 1)
    pb = np.stack([xb[ib], yb[ib]], 1)
    d = ((pa[:, None, :] - pb[None, :, :]) ** 2).sum(2)
    i, j = np.unravel_index(int(np.argmin(d)), d.shape)
    cv2.line(canvas, tuple(pa[i]), tuple(pb[j]), 1, width)


def fuse(ink, truth, rng, strength=None):
    """Join some marks to their letters. Returns the fused ink; truth unchanged.

    The mask is not touched. That is the whole point: the pixels that were a
    mark are still a mark, and the model is asked to find them under ink that
    was added afterwards.
    """
    out = ink.copy()
    n, lab, st, _ = cv2.connectedComponentsWithStats(ink, 8)
    marks = [i for i in range(1, n)
             if truth[lab == i].max() != label.LETTER and st[i, cv2.CC_STAT_AREA] >= 15]
    letters = [i for i in range(1, n)
               if truth[lab == i].max() == label.LETTER and st[i, cv2.CC_STAT_AREA] >= 40]
    if not marks or not letters:
        return out

    share = rng.uniform(0.3, 1.0) if strength is None else strength
    chosen = rng.choice(marks, size=max(1, int(len(marks) * share)), replace=False)
    for m in chosen:
        piece = (lab == m)
        cy, cx = np.array(np.nonzero(piece)).mean(1)
        # the nearest letter, which is the one a mark would settle onto
        best, dist = None, 1e18
        for l in letters:
            ly = st[l, cv2.CC_STAT_TOP] + st[l, cv2.CC_STAT_HEIGHT] / 2
            lx = st[l, cv2.CC_STAT_LEFT] + st[l, cv2.CC_STAT_WIDTH] / 2
            d = (ly - cy) ** 2 + (lx - cx) ** 2
            if d < dist:
                best, dist = l, d
        if best is None:
            continue
        _bridge(out, piece, (lab == best), int(rng.integers(1, 5)), rng)

    if rng.random() < 0.4:                       # ink laid on heavily
        k = int(rng.integers(2, 4))
        out = cv2.dilate(out, np.ones((k, k), np.uint8))
    return out


def shake(ink, truth, rng, scale=0.0, rotate=0.0):
    """Turn and resize a word, taking its answer with it.

    Both are moved by the same matrix and both by nearest neighbour, so a
    pixel that was a mark is still exactly a mark afterwards -- anything
    smoother would blur the two classes into each other along every edge and
    quietly poison the labels.

    Worth doing because the type is the one thing that never varies: every
    glyph is drawn at one size, dead level, from the same outlines. A press
    and a camera give neither. A model shown only the unvarying case learns
    the size and the angle along with the shape.
    """
    if scale <= 0 and rotate <= 0:
        return ink, truth
    h, w = ink.shape
    f = 1.0 + (rng.uniform(-scale, scale) if scale > 0 else 0.0)
    a = rng.uniform(-rotate, rotate) if rotate > 0 else 0.0
    m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), a, f)
    move = lambda x: cv2.warpAffine(x, m, (w, h), flags=cv2.INTER_NEAREST,
                                    borderValue=0)
    return move(ink), move(truth)


def spread_ink(ink, truth, rng, amount=0.0):
    """Thicken the strokes, the way a press and paper do.

    The ink alone is thickened; the answer is not. A mark that grows a pixel
    is still that mark, and letting the label grow with it would teach the
    model that a mark is whatever the ink happens to cover today.
    """
    if amount <= 0 or rng.random() > amount:
        return ink
    k = int(rng.integers(2, 4))
    return cv2.dilate(ink, np.ones((k, k), np.uint8))


def sample(store, rng, px_per_em=label.PX, scale=0.0, rotate=0.0, spread=0.0):
    """One training pair: a word made hard on purpose, and its true classes."""
    global DRAWN
    DRAWN += 1
    keys = list(store)
    k = keys[rng.integers(len(keys))]
    page, code = k.split("/", 1)
    ink, truth, _, _ = pieces(int(page), code, store[k], px_per_em)
    ink = fuse(ink, truth, rng)
    ink, truth = shake(ink, truth, rng, scale, rotate)
    ink = spread_ink(ink, truth, rng, spread)
    return ink, truth, k
