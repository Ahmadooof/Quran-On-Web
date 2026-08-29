"""
The routes. Every picture is drawn here; nothing is decided in the browser.

    python app.py        opens http://127.0.0.1:5000

The shape of the work is a loop, and the three views are its three steps: read
a stretch of pages with a model and see where it is wrong, correct those by
clicking, train a new model on the corrections, then set the new model against
the old one on pages neither has been taught and see which is right more often.
Round again until the answer stops improving.

A page is sized to fit the width it is shown at, from the measure the mushaf is
set to -- there is nothing to adjust, and no reason to want to.
"""

import base64
import json
import os
import sys
import time
import threading
import traceback
import webbrowser

import cv2
import numpy as np
from flask import Flask, jsonify, request, send_from_directory

import bands
import label
import models
import photo
import render
import tune

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
app = Flask(__name__, static_folder=STATIC, static_url_path="/static")

# A V2 line is set to this many ems, measured from the fonts themselves and
# recorded by scripts/build-mushaf.js. It is what makes a page fit a width
# without anyone choosing a type size.
MEASURE = 15.98
SHEET = 1400          # the width a page is drawn at, in pixels
GAP = 0.30            # ems between lines, enough to see a mark stand clear


def bgr(text, fallback):
    """A #rrggbb from the browser as the b,g,r triple OpenCV wants."""
    t = (text or "").lstrip("#")
    if len(t) != 6:
        return fallback
    try:
        r, g, b = (int(t[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return fallback
    return (b, g, r)


def png(img, width=None):
    if img.dtype != np.uint8:
        img = np.clip(img, 0, 255).astype(np.uint8)
    if width and img.shape[1] > width:
        s = width / img.shape[1]
        img = cv2.resize(img, (width, max(1, int(img.shape[0] * s))))
    ok, buf = cv2.imencode(".png", img)
    return "data:image/png;base64," + base64.b64encode(buf).decode() if ok else ""


def settle(ink, hot, floor, small=2.5):
    """Give a small blob of ink one verdict instead of a per-pixel one.

    The net decides pixel by pixel, which is right where a mark is drawn
    touching the letter beneath it: there the two are one blob and only the
    pixels can separate them, so a big blob is left alone. But a blob no bigger
    than a mark cannot be a letter with a mark stuck to it, and there is no
    such thing as half a fatha. Those are settled by majority.
    """
    out = hot.copy()
    n, lab, st, _ = cv2.connectedComponentsWithStats(ink, 8)
    for i in range(1, n):
        area = st[i, cv2.CC_STAT_AREA]
        if area < 20 or area > small * floor:
            continue
        sel = (lab == i)
        out[sel] = hot[sel].mean() >= 0.5
    return out


_READ = {}


def read(page, model=None):
    """A page's ink, and what a model makes of it.

    Read at label.PX and never at the size it will be shown at. A convolution
    has a fixed reach in pixels, so a net taught what a fatha looks like at 200
    px to the em does not know the same fatha at 72 -- asked at that size it
    found 290 marks on a page that spells 471.

    Kept, because none of it depends on how the page will be painted or how
    wide the screen is.
    """
    ck = (page, model)
    if ck in _READ:
        return _READ[ck]

    font = render.page_font(page)
    lines = [ln for ln in render.mushaf()["pages"][str(page)] if ln["t"] == "ayah"]
    text = label.uthmani()
    # The ayah markers are drawn but not spelled: the number inside the
    # ornament is a digit and carries no marks, while the ornament itself has
    # flourishes the model quite reasonably calls marks. Scoring them counts a
    # difference of design as a fault -- on page 3 it alone cost 8 points.
    markers = set(render.mushaf()["marks"].get(str(page), ""))
    net = None
    if model:
        import unet
        net = unet.load(model)
    floor = (0.2 * label.PX) ** 2 * 0.25

    out = []
    for i, ln in enumerate(lines):
        words = ln["v2"].split("|")
        mask, bounds = render.render_words(font, words, label.PX,
                                           pad_frac=0.0, side_frac=0.1)
        ink = (mask > 127).astype(np.uint8)
        picked = np.zeros(ink.shape, bool)
        doubt = 0.0
        per_word = []
        if net is not None:
            import unet
            p = unet.marks_of(net, ink)
            on = ink > 0
            doubt = float((1.0 - 2.0 * np.abs(p[on] - 0.5)).mean()) if on.any() else 0.0
            hot = settle(ink, (p > 0.5) & on, floor)
            k, lab, st, _ = cv2.connectedComponentsWithStats(
                (hot * 255).astype(np.uint8), 8)
            big = [j for j in range(1, k) if st[j, cv2.CC_STAT_AREA] >= floor]
            for j in big:
                picked |= (lab == j)
            # how many marks fell inside each word, against what it is spelled
            for code, (x0, x1) in zip(words, bounds):
                a, b = int(round(x0)), int(round(x1))
                found = sum(1 for j in big
                            if a <= st[j, cv2.CC_STAT_LEFT] + st[j, cv2.CC_STAT_WIDTH] / 2 < b)
                per_word.append({"code": code,
                                 "text": text.get((page, code), ""),
                                 "found": found,
                                 "spelled": label.expected(text.get((page, code), "")),
                                 "marker": any(c in markers for c in code),
                                 "x0": a, "x1": b})
        out.append({"ink": ink, "marks": picked, "doubt": doubt,
                    "words": per_word, "bounds": bounds, "codes": words})
    _READ[ck] = out
    return out


def sheet_of(page, model, ink_colour, mark_colour, width=SHEET):
    """A whole page as one picture, plus where everything landed on it.

    The map is returned with the picture so a click can be traced back to the
    word and the piece of ink it fell on. Nothing about the geometry is guessed
    in the browser.
    """
    lines, marks = painted(page, model)
    px = label.PX
    gap = int(round(px * GAP))
    W = max(l["ink"].shape[1] for l in lines)
    H = sum(l["ink"].shape[0] for l in lines) + gap * (len(lines) + 1)
    big = np.full((H, W, 3), 255, np.uint8)

    scale = width / float(W)
    where, y = [], gap
    for i, l in enumerate(lines):
        ink, picked = l["ink"], marks[i]
        x = (W - ink.shape[1]) // 2
        tile = np.full(ink.shape + (3,), 255, np.uint8)
        tile[ink > 0] = ink_colour
        tile[picked] = mark_colour
        big[y:y + ink.shape[0], x:x + ink.shape[1]] = tile
        where.append({"line": i + 1, "top": y, "left": x,
                      "height": int(ink.shape[0]), "width": int(ink.shape[1])})
        y += ink.shape[0] + gap

    small = cv2.resize(big, (width, max(1, int(H * scale))), interpolation=cv2.INTER_AREA)
    return small, where, scale, lines


def recount(page, li, line, edits):
    """One line's word counts, redone with the staged edits applied."""
    lab, st, n = blobs_of_line(line)
    marks = line["marks"].copy()
    for blob, cls in edits.items():
        marks[lab == blob] = bool(cls)
    floor = (0.2 * label.PX) ** 2 * 0.25
    k, l2, s2, _ = cv2.connectedComponentsWithStats(
        (marks * 255).astype(np.uint8), 8)
    big = [j for j in range(1, k) if s2[j, cv2.CC_STAT_AREA] >= floor]
    out = []
    for w in line["words"]:
        found = sum(1 for j in big
                    if w["x0"] <= s2[j, cv2.CC_STAT_LEFT] + s2[j, cv2.CC_STAT_WIDTH] / 2 < w["x1"])
        out.append(dict(w, found=found))
    return dict(line, words=out)


def page_report(page, model):
    """What a model made of a page, as numbers rather than a picture.

    Staged edits count. Correcting a word and watching the agreement move is
    the whole point of the number being there.
    """
    lines = read(page, model)
    staged = pending(page)["paint"]
    found = spelled = agree = words = 0
    doubt = []
    worst = []
    # enumerate, not lines.index: a line holds numpy arrays, and asking a list
    # where one of those is compares the arrays element by element
    for i, l in enumerate(lines):
        doubt.append(l["doubt"])
        if i in staged:
            l = recount(page, i, l, staged[i])
        for w in l["words"]:
            if w["marker"]:
                continue                 # an ayah marker is not a word
            words += 1
            found += w["found"]
            spelled += w["spelled"]
            if w["found"] == w["spelled"]:
                agree += 1
            else:
                worst.append({"line": i + 1, "text": w["text"],
                              "found": w["found"], "spelled": w["spelled"]})
    return {"page": page, "words": words, "found": found, "spelled": spelled,
            "agree": agree,
            "agreement": round(agree / words, 3) if words else 0.0,
            "doubt": round(float(np.mean(doubt)), 4) if doubt else 0.0,
            "disagreements": sorted(worst, key=lambda w: (w["line"],))[:60]}


# --------------------------------------------------------------------------


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/models")
def model_list():
    return jsonify(models=[models.describe(n) for n in models.names()])


@app.get("/review")
def review():
    """One page read by a model, with the marks drawn on.

    One page per request, not a stretch of them. A page takes half a minute of
    honest convolution, so asking for five means two and a half minutes of
    nothing on screen; asked one at a time they arrive as they are read and the
    wait is visible instead of blank.
    """
    try:
        n = request.args.get("page", 3, type=int)
        model = request.args.get("model") or None
        ink = bgr(request.args.get("ink"), (30, 30, 30))
        mark = bgr(request.args.get("mark"), (40, 40, 230))
        img, where, scale, _ = sheet_of(n, model, ink, mark)
        r = page_report(n, model) if model else {"page": n}
        staged = sum(len(v) for v in pending(n)["paint"].values())
        done = checked().get(str(n))
        return jsonify(page=dict(r, img=png(img), where=where, scale=scale,
                                 staged=staged, checked=done,
                                 tall=int(round(img.shape[0] / scale)),
                                 natural=int(round(img.shape[1] / scale))),
                       model=model)
    except FileNotFoundError as err:
        return jsonify(error=str(err))
    except Exception:
        return jsonify(error=traceback.format_exc()[-2000:])


# Which pages have been gone over. Kept on disk, because the point of it is to
# still be true next week: a page read, corrected and saved is one you need not
# look at again, and without a record of that the same pages get done twice
# while others are never touched at all.
CHECKED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "checked.json")


def checked():
    try:
        with open(CHECKED, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def mark_checked(page, fixes):
    ix = checked()
    was = ix.get(str(page), {})
    ix[str(page)] = {"when": time.strftime("%Y-%m-%d %H:%M"),
                     "fixes": was.get("fixes", 0) + fixes,
                     "visits": was.get("visits", 0) + 1}
    with open(CHECKED, "w", encoding="utf-8") as fh:
        json.dump(ix, fh, indent=1)
    return ix[str(page)]


# Edits wait here until they are asked for. A click used to go straight into
# labels.json, which meant a slip was already recorded before it was noticed --
# and the page carried on showing the model's opinion rather than yours.
# Staged, the picture answers immediately and nothing is written until Save.
_PENDING = {}


def nearest_blob(lab, x, y, reach):
    """The piece of ink nearest a click, or 0 if there is none within reach.

    By the ink itself, not by where a blob's bounding box happens to be
    centred. A joined run of letters is one blob a thousand pixels wide, and
    its box centre can sit half a word away from the stroke actually under the
    cursor -- measured that way a click five pixels off a letter found nothing
    at all, which is what made the ink feel unclickable between the glyphs.
    """
    h, w = lab.shape
    xi, yi = int(round(x)), int(round(y))
    if 0 <= yi < h and 0 <= xi < w and lab[yi, xi]:
        return int(lab[yi, xi])
    r = int(reach)
    y0, y1 = max(0, yi - r), min(h, yi + r + 1)
    x0, x1 = max(0, xi - r), min(w, xi + r + 1)
    if y0 >= y1 or x0 >= x1:
        return 0
    win = lab[y0:y1, x0:x1]
    ys, xs = np.nonzero(win)
    if not len(ys):
        return 0
    d = (ys + y0 - yi) ** 2 + (xs + x0 - xi) ** 2
    return int(win[ys[d.argmin()], xs[d.argmin()]])


def order_blobs(stats, which):
    """Pieces of ink in a fixed reading order: rightmost first, then downward.

    Two drawings of the same word break into the same pieces, so ordering both
    the same way lets them be paired off without any coordinates being carried
    from one drawing to the other.
    """
    return sorted(which, key=lambda i: (
        -(stats[i, cv2.CC_STAT_LEFT] + stats[i, cv2.CC_STAT_WIDTH] / 2),
        stats[i, cv2.CC_STAT_TOP]))


def pending(page):
    return _PENDING.setdefault(page, {"paint": {}, "labels": {}})


def blobs_of_line(line):
    """The pieces of ink in one line, numbered. Cached on the line itself."""
    if "lab" not in line:
        n, lab, st, _ = cv2.connectedComponentsWithStats(line["ink"], 8)
        line["lab"], line["stats"], line["count"] = lab, st, n
    return line["lab"], line["stats"], line["count"]


def painted(page, model):
    """What each line should look like now: the model, plus anything staged."""
    lines = read(page, model)
    edits = pending(page)["paint"]
    out = []
    for i, l in enumerate(lines):
        marks = l["marks"].copy()
        if i in edits:
            lab, _, _ = blobs_of_line(l)
            for blob, cls in edits[i].items():
                sel = (lab == blob)
                marks[sel] = bool(cls)
        out.append(marks)
    return lines, out


@app.post("/fix")
def fix():
    """Flip one piece of ink, and hand back the page with it flipped.

    The click arrives in the coordinates of the picture on screen; it is put
    back into the page's own by the scale the picture was drawn at, and then
    into the word's own by the bounds the font gave. What is remembered is a
    blob of a word, which stays true at whatever size anything is drawn later.
    """
    try:
        d = request.get_json(silent=True) or {}
        page, model = int(d["page"]), d.get("model")
        ink = bgr(d.get("ink"), (30, 30, 30))
        mark = bgr(d.get("mark"), (40, 40, 230))
        lines = read(page, model)
        li = int(d["line"]) - 1
        if not 0 <= li < len(lines):
            return jsonify(error="no such line")
        line = lines[li]
        x, y = float(d["x"]), float(d["y"])

        lab, st, n = blobs_of_line(line)
        blob = nearest_blob(lab, x, y, 0.15 * label.PX)
        if blob == 0:
            return jsonify(hit=None)

        was = bool(line["marks"][lab == blob].mean() >= 0.5)
        p = pending(page)
        now = not bool(p["paint"].get(li, {}).get(blob, was))
        p["paint"].setdefault(li, {})[blob] = now

        # The same piece, named the way the labels are kept: word and blob.
        #
        # Not by mapping coordinates. A line is drawn with no vertical padding
        # and a word with a tenth of an em of it, and each is placed against
        # its own ink extent, so no fixed offset carries from one to the other
        # -- that arithmetic was wrong and silently recorded nothing.
        #
        # The blobs themselves can be matched instead. The same word drawn
        # alone breaks into the same pieces in the same order, so both are
        # sorted the same way and paired off by position in the list.
        cx = st[blob, cv2.CC_STAT_LEFT] + st[blob, cv2.CC_STAT_WIDTH] / 2
        word = None
        for code, (bx0, bx1) in zip(line["codes"], line["bounds"]):
            if not bx0 <= cx < bx1:
                continue
            mine = order_blobs(st, [i for i in range(1, n)
                                    if st[i, cv2.CC_STAT_AREA] >= 20
                                    and bx0 <= st[i, cv2.CC_STAT_LEFT]
                                    + st[i, cv2.CC_STAT_WIDTH] / 2 < bx1])
            _, wlab, wst, keep = label.blobs(page, code)
            theirs = order_blobs(wst, keep)
            if blob in mine and len(mine) == len(theirs):
                i = theirs[mine.index(blob)]
                p["labels"].setdefault(code, {})[str(i)] = int(now)
                word = label.uthmani().get((page, code), code)
            break

        img, where, scale, _ = sheet_of(page, model, ink, mark)
        return jsonify(hit=blob, word=word, now=label.NAMES[int(now)],
                       staged=sum(len(v) for v in p["paint"].values()),
                       img=png(img), where=where, scale=scale)
    except Exception:
        return jsonify(error=traceback.format_exc()[-1500:])


@app.post("/save")
def save_page():
    """Write one page's staged edits into the labels, and forget them here."""
    try:
        d = request.get_json(silent=True) or {}
        page = int(d["page"])
        p = _PENDING.get(page)
        if not p or not p["labels"]:
            # nothing staged still counts as having looked: a page with nothing
            # wrong on it is checked just as much as one that needed fixing
            was = mark_checked(page, 0)
            return jsonify(saved=0, words=len(label.load()), checked=was,
                           next=min(604, page + 1))
        store = label.load()
        touched = 0
        for code, blobs in p["labels"].items():
            k = label.key(page, code)
            classes = store.get(k) or label.guess(page, code)
            classes.update({b: int(c) for b, c in blobs.items()})
            store[k] = classes
            touched += 1
        label.save(store)
        fixes = sum(len(v) for v in p["paint"].values())
        _PENDING.pop(page, None)
        was = mark_checked(page, fixes)
        return jsonify(saved=touched, words=len(store), checked=was,
                       next=min(604, page + 1))
    except Exception:
        return jsonify(error=traceback.format_exc()[-1500:])


@app.post("/revert")
def revert_page():
    """Throw away one page's staged edits."""
    page = int((request.get_json(silent=True) or {}).get("page", 0))
    _PENDING.pop(page, None)
    return jsonify(staged=0)


PHOTOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "PhysicalQuran")


def photo_read(img, mask, lines, factor, tall, net, mark_c):
    """A photograph read a line at a time, with the marks laid over it.

    Pulled out of the route so two models can be run over the same photograph
    and shown side by side. The reading itself has not changed: each line is
    enlarged to the scale the net was taught at and passed alone, because a
    whole scaled page is twenty megapixels and one pass over that wants some
    fifteen gigabytes -- which does not fail, it swaps, and the machine stops.

    The photograph is shown as photographed. Redrawing it as clean ink on
    white throws away the very thing it is here to show -- how heavy the press
    laid it on, where the paper has aged, what the camera softened.
    """
    floor = (0.2 * label.PX) ** 2 * 0.25
    picked = np.zeros(mask.shape, bool)
    found = 0
    pad = int(tall * bands.PAD)

    # Enough of the working to see where an answer went wrong. A page with
    # nothing marked on it has three quite different causes -- the net never
    # became confident, or it did and the pieces came out too small to count,
    # or there was no ink to read in the first place -- and the picture alone
    # cannot tell them apart.
    ink_px = hot_px = unsure_px = 0
    blobs_all = blobs_kept = 0
    sizes = []
    best_p = 0.0

    for a, b in lines:
        top, bot = max(0, a - pad), min(mask.shape[0], b + pad)
        strip = mask[top:bot]
        if net is None or not strip.any():
            continue
        big = cv2.resize(strip, None, fx=factor, fy=factor,
                         interpolation=cv2.INTER_AREA)
        big = (big > 110).astype(np.uint8)
        import unet
        p = unet.marks_of(net, big)
        on = big > 0
        ink_px += int(on.sum())
        hot_px += int(((p > 0.5) & on).sum())
        unsure_px += int(((p > 0.2) & (p < 0.8) & on).sum())
        if on.any():
            best_p = max(best_p, float(p[on].max()))
        hot = settle(big, (p > 0.5) & on, floor)
        k, lab, st, _ = cv2.connectedComponentsWithStats(
            (hot * 255).astype(np.uint8), 8)
        keep = np.zeros(big.shape, np.uint8)
        for j in range(1, k):
            area = int(st[j, cv2.CC_STAT_AREA])
            blobs_all += 1
            sizes.append(area)
            if area >= floor:
                keep[lab == j] = 255
                blobs_kept += 1
                found += 1
        back = cv2.resize(keep, (strip.shape[1], strip.shape[0]),
                          interpolation=cv2.INTER_NEAREST) > 110
        picked[top:bot] |= (back & (strip > 0))

    working = {
        "ink pixels read": ink_px,
        "called a mark": hot_px,
        "share of ink called a mark": round(hot_px / ink_px, 4) if ink_px else 0,
        "undecided (0.2-0.8)": unsure_px,
        "highest confidence": round(best_p, 3),
        "blobs before the size filter": blobs_all,
        "blobs kept": blobs_kept,
        "size filter (px)": int(floor),
        "median blob (px)": int(np.median(sizes)) if sizes else 0,
        "largest blob (px)": int(max(sizes)) if sizes else 0,
    }
    out = img.copy() if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    out[picked] = mark_c
    return out, found, working


@app.get("/photos")
def photo_list():
    try:
        names = sorted(f for f in os.listdir(PHOTOS)
                       if f.lower().endswith((".jpg", ".jpeg", ".png", ".dng", ".tif")))
    except Exception:
        names = []
    return jsonify(photos=names)


@app.get("/physical")
def physical():
    """A photograph of a printed page, read by a net trained only on type.

    The question this tab exists to ask. Everything else has been type against
    type: the model has never seen a press, only the outlines the press was set
    from. Ink spreads on paper, strokes thicken, a camera adds its own
    softness, and none of that is in what it was taught.

    Two things have to be got right, and both were got wrong first.

    Scale. A convolution has a fixed reach in pixels, so the photograph is
    resized until its lines stand as tall as the type's do at 200 px to the em.
    Fed at its own size the answer means nothing.

    Size. The net is given one line at a time, exactly as it is for type. A
    whole scaled page is 20 MP, and one pass over that wants some fifteen
    gigabytes -- which does not fail, it swaps, and the machine stops. A line
    is a fiftieth of that and the seams between them are already known.
    """
    try:
        import unet
        name = request.args.get("file", "")
        model = request.args.get("model") or None
        ink_c = bgr(request.args.get("ink"), (30, 30, 30))
        mark_c = bgr(request.args.get("mark"), (40, 40, 230))
        path = os.path.join(PHOTOS, os.path.basename(name))
        if not os.path.exists(path):
            return jsonify(error="no such photograph: %s" % name)

        # How large to open the photograph. It matters more than it looks:
        # capped at 2600 px a capture's lines come out 81 px tall and have to
        # be blown up 3.9x to match the type, which turns crisp marks into
        # crumbs -- 2545 pieces found with a median of 56 px against a 400 px
        # filter, so nine in ten were thrown away. Opened larger, the same
        # lines need almost no scaling at all.
        detail = max(1200, min(9000, request.args.get("detail", 5200, type=int)))
        # Cut by the shared code, not by a copy of it here. The fine-tuning
        # labels name a blob by its number in a strip, so the strip a label
        # was written against and the strip a model is asked about have to be
        # the same pixels -- two implementations of "where are the lines"
        # drift apart and take the labels with them.
        img, mask, lines, factor, tall = bands.cut(path, detail)

        net = unet.load(model) if model else None
        out, found, working = photo_read(img, mask, lines, factor, tall,
                                         net, mark_c)
        return jsonify(file=name, lines=len(lines), found=found,
                       line_height=round(tall, 1), scaled_by=round(factor, 3),
                       ink=round(float((mask > 0).mean()), 4),
                       working=working, img=png(out, 1500))
    except FileNotFoundError as err:
        return jsonify(error=str(err))
    except Exception:
        return jsonify(error=traceback.format_exc()[-2000:])


@app.get("/checked")
def checked_list():
    """Which pages have been gone over, and where to pick up."""
    ix = checked()
    done = sorted(int(k) for k in ix)
    # Where to pick up: the first page not yet gone over, counting from where
    # the sweep began rather than from page 1. Someone who started at 3 and has
    # reached 4 wants 5 next, not to be sent back to a page they chose to skip.
    nxt = done[0] if done else 1
    while str(nxt) in ix and nxt < 604:
        nxt += 1
    return jsonify(pages=done, count=len(done), resume=nxt,
                   fixes=sum(v.get("fixes", 0) for v in ix.values()))


@app.get("/labels")
def label_count():
    store = label.load()
    marks = sum(1 for w in store.values() for v in w.values() if int(v) == 1)
    return jsonify(words=len(store), marks=marks,
                   letters=sum(len(w) for w in store.values()) - marks)


@app.post("/train")
def train_now():
    """Train a new model on everything labelled so far, and keep it by name."""
    try:
        import unet
        arg = request.args
        steps = max(50, min(20000, arg.get("steps", 900, type=int)))
        jitter = {
            "scale": max(0.0, min(0.5, arg.get("scale", 0.0, type=float))),
            "rotate": max(0.0, min(15.0, arg.get("rotate", 0.0, type=float))),
            "spread": max(0.0, min(1.0, arg.get("spread", 0.0, type=float))),
        }
        store = label.load()
        if len(store) < 10:
            return jsonify(error="only %d words labelled - too few to train on" % len(store))
        net, name = unet.train(
            store, steps=steps, jitter=jitter,
            batch=max(2, min(64, arg.get("batch", 16, type=int))),
            lr=max(1e-5, min(1e-1, arg.get("lr", 2e-3, type=float))),
            width=max(8, min(32, arg.get("width", 16, type=int))),
            decay=max(0.0, min(1e-1, arg.get("decay", 1e-4, type=float))),
            seed=arg.get("seed", 0, type=int),
            hold_out=max(0.0, min(0.5, arg.get("holdout", 0.0, type=float))))
        unet._LOADED[name] = net
        _READ.clear()                    # every page must be read again
        return jsonify(model=models.describe(name))
    except Exception:
        return jsonify(error=traceback.format_exc()[-2000:])


@app.get("/trainplan")
def train_plan():
    """How many synthetic examples a run of this length would make.

    Asked because the two numbers are easy to confuse and three orders of
    magnitude apart: a hundred and twenty words are labelled, and the model is
    trained on fourteen thousand crops made out of them. Neither number alone
    says what the training set is.
    """
    steps = max(1, min(20000, request.args.get("steps", 900, type=int)))
    batch = max(2, min(64, request.args.get("batch", unet_batch(), type=int)))
    store = label.load()
    return jsonify(steps=steps, batch=batch, crops=steps * batch,
                   words=len(store))


def unet_batch():
    import unet
    import inspect
    return inspect.signature(unet.train).parameters["batch"].default


# --------------------------------------------------------------------------
# fine-tuning: confirming real lines by hand, then nudging a model onto them


PENDING_BAND = {}


def band_key(file, detail, line):
    return tune.key(os.path.basename(file), detail, line)


# One line, cut out and read once. A click used to cost a fresh convolution
# over the whole strip -- three seconds to change the colour of one dot, which
# is not a rate anyone labels a page at.
_BANDS = {}
_BAND_ORDER = []
BANDS_KEPT = 8


def band_read(file, detail, line, model):
    """One line cut out, its pieces numbered, and the model's first opinion."""
    ck = (os.path.basename(file), int(detail), int(line), model or "")
    if ck in _BANDS:
        return _BANDS[ck]
    path = os.path.join(PHOTOS, os.path.basename(file))
    img, mask, lines, factor, tall = bands.cut(path, detail)
    if not 0 <= line < len(lines):
        raise ValueError("that photograph has %d lines" % len(lines))
    big, (top, bot), raw = bands.strip(mask, lines, line, factor, tall)
    lab, st, keep = bands.pieces(big, tune.LEAST)

    proposed = {i: tune.LETTER for i in keep}
    if model:
        import unet
        floor = (0.2 * label.PX) ** 2 * 0.25
        p = unet.marks_of(unet.load(model), big)
        # Every blob's share of the model's opinion in two passes over the
        # strip, rather than one pass per blob. A line is two million pixels
        # and holds a hundred and fifty pieces of ink, and comparing the whole
        # label image against each piece in turn cost four seconds a click.
        flat = lab.ravel()
        n = int(lab.max()) + 1
        size = np.bincount(flat, minlength=n).astype(float)
        size[size == 0] = 1
        mean = np.bincount(flat, weights=p.ravel(), minlength=n) / size
        hot = np.bincount(flat, weights=(p > 0.5).ravel().astype(float),
                          minlength=n) / size
        for i in keep:
            # A piece the model reads as part mark and part letter is a mark
            # welded to the stroke under it, and the honest answer is that it
            # is both. Handing back a guess there would put the one case worth
            # labelling under whichever way the average happened to fall, so
            # it comes back as skip and is the first thing anyone looks at.
            mixed = 0.15 < hot[i] < 0.85
            if st[i, cv2.CC_STAT_AREA] > 3 * floor and mixed:
                proposed[i] = tune.SKIP
            else:
                proposed[i] = tune.MARK if mean[i] >= 0.5 else tune.LETTER

    _BANDS[ck] = dict(img=img, big=big, lab=lab, stats=st, keep=keep,
                      top=top, bot=bot, raw=raw, factor=factor,
                      proposed=proposed, lines=len(lines))
    _BAND_ORDER.append(ck)
    while len(_BAND_ORDER) > BANDS_KEPT:
        _BANDS.pop(_BAND_ORDER.pop(0), None)
    return _BANDS[ck]


def band_classes(file, detail, line, model):
    """What each piece of ink in one line is taken to be, as things stand.

    A confirmed line comes back as it was confirmed; anything else starts from
    the model's opinion. Either way the clicks made since are laid on top, and
    none of it is written down until the line is confirmed.
    """
    b = band_read(file, detail, line, model)
    k = band_key(file, detail, line)
    stored = tune.load().get(k)
    classes = ({int(a): int(c) for a, c in stored["blobs"].items()} if stored
               else dict(b["proposed"]))
    classes.update(PENDING_BAND.get(k, {}))
    return dict(b, classes=classes, stored=bool(stored))


def paint_band(b, mark_c, skip_c):
    """The line as photographed, with the verdicts laid over the ink only."""
    # by lookup rather than a pass per blob, for the same reason as above
    table = np.zeros(int(b["lab"].max()) + 1, np.uint8)
    for i, c in b["classes"].items():
        table[i] = c
    cls = table[b["lab"]]
    back = cv2.resize(cls, (b["raw"].shape[1], b["raw"].shape[0]),
                      interpolation=cv2.INTER_NEAREST)
    src = b["img"][b["top"]:b["bot"]]
    out = src.copy() if src.ndim == 3 else cv2.cvtColor(src, cv2.COLOR_GRAY2BGR)
    on = b["raw"] > 0
    out[(back == tune.MARK) & on] = mark_c
    out[(back == tune.SKIP) & on] = skip_c
    return out


@app.get("/photolines")
def photo_lines():
    """How many lines a photograph has, and which of them are confirmed."""
    try:
        name = os.path.basename(request.args.get("file", ""))
        detail = max(1200, min(9000, request.args.get("detail", 5200, type=int)))
        path = os.path.join(PHOTOS, name)
        if not os.path.exists(path):
            return jsonify(error="no such photograph: %s" % name)
        _, _, lines, factor, tall = bands.cut(path, detail)
        store = tune.load()
        done = [i for i in range(len(lines))
                if tune.key(name, detail, i) in store]
        return jsonify(file=name, lines=len(lines), done=done,
                       line_height=round(tall, 1), scaled_by=round(factor, 3))
    except Exception:
        return jsonify(error=traceback.format_exc()[-1500:])


@app.get("/band")
def band_view():
    """One line of a photograph, with what each piece of ink is taken to be."""
    try:
        name = os.path.basename(request.args.get("file", ""))
        detail = max(1200, min(9000, request.args.get("detail", 5200, type=int)))
        line = request.args.get("line", 0, type=int)
        model = request.args.get("model") or None
        mark_c = bgr(request.args.get("mark"), (40, 40, 230))
        skip_c = bgr(request.args.get("skip"), (150, 150, 150))
        b = band_classes(name, detail, line, model)
        tally = {"mark": 0, "letter": 0, "skip": 0}
        for c in b["classes"].values():
            tally[["letter", "mark", "skip"][int(c)]] += 1
        k = band_key(name, detail, line)
        return jsonify(file=name, line=line, lines=b["lines"],
                       img=png(paint_band(b, mark_c, skip_c), 1600),
                       pieces=len(b["keep"]), tally=tally,
                       confirmed=b["stored"],
                       staged=len(PENDING_BAND.get(k, {})))
    except Exception:
        return jsonify(error=traceback.format_exc()[-1500:])


@app.post("/bandfix")
def band_fix():
    """Move one piece of ink to the next verdict: letter, mark, skip, round."""
    try:
        d = request.get_json(silent=True) or {}
        name = os.path.basename(d.get("file", ""))
        detail, line = int(d["detail"]), int(d["line"])
        model = d.get("model") or None
        mark_c = bgr(d.get("mark"), (40, 40, 230))
        skip_c = bgr(d.get("skip"), (150, 150, 150))
        b = band_classes(name, detail, line, model)
        big = b["big"]
        # the click arrives as a fraction of the picture, which survives every
        # resize between the strip and the screen
        xi = float(d["fx"]) * big.shape[1]
        yi = float(d["fy"]) * big.shape[0]
        blob = nearest_blob(b["lab"], xi, yi, 0.15 * label.PX)
        if blob == 0 or blob not in b["classes"]:
            return jsonify(hit=None)

        was = int(b["classes"][blob])
        now = (was + 1) % 3
        k = band_key(name, detail, line)
        PENDING_BAND.setdefault(k, {})[blob] = now
        b["classes"][blob] = now
        tally = {"mark": 0, "letter": 0, "skip": 0}
        for c in b["classes"].values():
            tally[["letter", "mark", "skip"][int(c)]] += 1
        return jsonify(hit=blob, now=["letter", "mark", "skip"][now],
                       tally=tally, staged=len(PENDING_BAND[k]),
                       img=png(paint_band(b, mark_c, skip_c), 1600))
    except Exception:
        return jsonify(error=traceback.format_exc()[-1500:])


@app.post("/bandsave")
def band_save():
    """Confirm one line: every piece of ink in it, as it now stands.

    All of it, not only what was clicked. A line saved says the whole line is
    right, which is what makes it usable as truth later -- storing only the
    corrections would leave the rest meaning "whichever model happened to be
    loaded that afternoon", and that is not a label.
    """
    try:
        d = request.get_json(silent=True) or {}
        name = os.path.basename(d.get("file", ""))
        detail, line = int(d["detail"]), int(d["line"])
        b = band_classes(name, detail, line, d.get("model") or None)
        k = band_key(name, detail, line)
        store = tune.load()
        store[k] = {"blobs": {str(i): int(c) for i, c in b["classes"].items()},
                    "when": time.strftime("%Y-%m-%d %H:%M")}
        tune.save(store)
        PENDING_BAND.pop(k, None)
        tune._BUILT.pop(k, None)   # it will be rebuilt from what was just saved
        return jsonify(saved=len(b["classes"]), real=tune.summary(),
                       next=line + 1 if line + 1 < b["lines"] else None)
    except Exception:
        return jsonify(error=traceback.format_exc()[-1500:])


@app.post("/bandrevert")
def band_revert():
    d = request.get_json(silent=True) or {}
    k = band_key(os.path.basename(d.get("file", "")), int(d["detail"]), int(d["line"]))
    PENDING_BAND.pop(k, None)
    return jsonify(staged=0)


@app.get("/real")
def real_count():
    return jsonify(**tune.summary())


@app.post("/tune")
def tune_now():
    """Fine-tune a model on the confirmed real lines."""
    try:
        base = request.args.get("base") or None
        if not base:
            return jsonify(error="choose a model to fine-tune from")
        arg = request.args
        net, name = tune.run(
            base, label.load(), PHOTOS,
            steps=max(20, min(5000, arg.get("steps", 300, type=int))),
            lr=max(1e-7, min(1e-3, arg.get("lr", 1e-5, type=float))),
            real_share=max(0.1, min(0.9, arg.get("share", 0.7, type=float))),
            batch=max(2, min(64, arg.get("batch", 16, type=int))),
            rotate=max(0.0, min(10.0, arg.get("rotate", 2.0, type=float))),
            scale=max(0.0, min(0.3, arg.get("scale", 0.05, type=float))),
            seed=arg.get("seed", 0, type=int),
            freeze=arg.get("freeze", "1") != "0")
        import unet
        unet._LOADED[name] = net
        _READ.clear()
        return jsonify(model=models.describe(name))
    except Exception:
        return jsonify(error=traceback.format_exc()[-2000:])


# --------------------------------------------------------------------------
# what has been labelled, and getting rid of what should not have been


@app.get("/labelled")
def labelled_list():
    """Every hand-labelled word, so it can be looked at and thrown out.

    A wrong label is worse than a missing one -- it is taught as fact to every
    model afterwards and there is nothing in the training that will ever argue
    with it. The only defence is being able to find it again.
    """
    store = label.load()
    text = label.uthmani()
    rows = []
    for k, classes in store.items():
        page, code = k.split("/", 1)
        marks = sum(1 for v in classes.values() if int(v) == label.MARK)
        rows.append({"key": k, "page": int(page), "code": code,
                     "text": text.get((int(page), code), ""),
                     "marks": marks, "letters": len(classes) - marks,
                     "spelled": label.expected(text.get((int(page), code), "")),
                     "checked": str(int(page)) in checked()})
    rows.sort(key=lambda r: (r["page"], r["code"]))
    by_page = {}
    for r in rows:
        by_page[r["page"]] = by_page.get(r["page"], 0) + 1
    return jsonify(words=rows, pages=sorted(by_page), per_page=by_page,
                   total=len(rows))


@app.post("/labelled/delete")
def labelled_delete():
    """Throw away named words, or a whole page of them."""
    try:
        d = request.get_json(silent=True) or {}
        store = label.load()
        keys = list(d.get("keys") or [])
        if d.get("page") is not None:
            want = "%d/" % int(d["page"])
            keys += [k for k in store if k.startswith(want)]
        gone = 0
        for k in set(keys):
            if store.pop(k, None) is not None:
                gone += 1
        label.save(store)
        if d.get("page") is not None:
            ix = checked()
            if ix.pop(str(int(d["page"])), None) is not None:
                with open(CHECKED, "w", encoding="utf-8") as fh:
                    json.dump(ix, fh, indent=1)
        _READ.clear()
        return jsonify(deleted=gone, left=len(store))
    except Exception:
        return jsonify(error=traceback.format_exc()[-1500:])


@app.get("/real/list")
def real_list():
    """Every confirmed line of every photograph."""
    store = tune.load()
    rows = []
    for k, v in store.items():
        file, detail, line = tune.parts(k)
        t = {0: 0, 1: 0, 2: 0}
        for c in v.get("blobs", {}).values():
            t[int(c)] = t.get(int(c), 0) + 1
        rows.append({"key": k, "file": file, "detail": detail, "line": line,
                     "letters": t[0], "marks": t[1], "skipped": t[2],
                     "pieces": len(v.get("blobs", {})), "when": v.get("when")})
    rows.sort(key=lambda r: (r["file"], r["detail"], r["line"]))
    # the summary counts lines too, and jsonify will not take the name twice
    tally = tune.summary()
    tally.pop("lines", None)
    return jsonify(lines=rows, **tally)


@app.post("/real/delete")
def real_delete():
    """Throw away confirmed lines, or every line of one photograph."""
    try:
        d = request.get_json(silent=True) or {}
        store = tune.load()
        keys = list(d.get("keys") or [])
        if d.get("file"):
            want = os.path.basename(d["file"])
            keys += [k for k in store if tune.parts(k)[0] == want]
        gone = 0
        for k in set(keys):
            if store.pop(k, None) is not None:
                gone += 1
            tune._BUILT.pop(k, None)
        tune.save(store)
        return jsonify(deleted=gone, **tune.summary())
    except Exception:
        return jsonify(error=traceback.format_exc()[-1500:])


# --------------------------------------------------------------------------
# a model's own card: what it was taught, and how it has done since


@app.post("/model/best")
def model_best():
    """Mark a model best at reading type, or best at reading a photograph."""
    try:
        name = request.args.get("name")
        job = request.args.get("job")
        on = request.args.get("on", "1") != "0"
        return jsonify(model=models.set_best(name, job, on),
                       models=[models.describe(n) for n in models.names()])
    except Exception:
        return jsonify(error=traceback.format_exc()[-1200:])


@app.post("/model/forget")
def model_forget():
    try:
        name = request.args.get("name")
        import unet
        unet._LOADED.pop(name, None)
        models.forget(name)
        for k in [k for k in _READ if k[1] == name]:
            _READ.pop(k, None)
        return jsonify(models=[models.describe(n) for n in models.names()])
    except Exception:
        return jsonify(error=traceback.format_exc()[-1200:])


@app.post("/model/test")
def model_test():
    """One page of type, or one photograph, and the number that comes out.

    Kept on the card afterwards. A model's score is the only thing that makes
    two of them comparable, and a score you have to re-run to see is a score
    nobody looks at.
    """
    try:
        name = request.args.get("name")
        if not name:
            return jsonify(error="which model?")
        page = request.args.get("page", type=int)
        file = request.args.get("file")
        if file:
            import unet
            detail = max(1200, min(9000, request.args.get("detail", 5200, type=int)))
            keys = tune.lines_of(file, detail)
            if not keys:
                return jsonify(error="no confirmed lines in %s at detail %d - "
                                     "confirm a few in Fine-tune first"
                                     % (os.path.basename(file), detail))
            r = tune.score_on_real(unet.load(name), keys, PHOTOS)
            what = "photo:%s" % os.path.basename(file)
            return jsonify(model=models.note_test(name, what, r), what=what, result=r)
        page = page or 200
        r = page_report(page, name)
        keep = {"words": r["words"], "found": r["found"], "spelled": r["spelled"],
                "agreement": r["agreement"], "doubt": r["doubt"]}
        what = "page:%d" % page
        return jsonify(model=models.note_test(name, what, keep), what=what, result=keep)
    except Exception:
        return jsonify(error=traceback.format_exc()[-2000:])


@app.get("/comparereal")
def compare_real():
    """Two models over the same photograph, refereed by the confirmed lines.

    This is the comparison the Compare tab could not make. There, the spelling
    says how many marks a word carries and the models are scored against it --
    but a photograph has no words anything here can read, so that referee is
    unavailable and the tab simply had nothing to say about a press.

    The lines confirmed by hand are the referee instead. They are the only
    ground truth a photograph will ever have, and they cost something to make,
    which is exactly why they should be used for more than training.
    """
    try:
        import unet
        a = request.args.get("a")
        b = request.args.get("b")
        file = os.path.basename(request.args.get("file", ""))
        detail = max(1200, min(9000, request.args.get("detail", 5200, type=int)))
        mark_c = bgr(request.args.get("mark"), (40, 40, 230))
        if not a or not b:
            return jsonify(error="two models are needed")
        path = os.path.join(PHOTOS, file)
        if not os.path.exists(path):
            return jsonify(error="no such photograph: %s" % file)

        img, mask, lines, factor, tall = bands.cut(path, detail)
        keys = tune.lines_of(file, detail)
        out = {}
        for who in (a, b):
            net = unet.load(who)
            row = {"scored": bool(keys)}
            # A model fine-tuned on these very lines is being marked on its own
            # homework. Still worth showing -- it says the fine-tune took --
            # but it is not evidence that it generalises, and the difference
            # matters enough to be said on the page rather than remembered.
            taught = set(models.describe(who).get("real_keys") or [])
            row["taught_on"] = len(taught & set(keys))
            if keys:
                row.update(tune.score_on_real(net, keys, PHOTOS))
            painted_page, row["found"], row["working"] = photo_read(
                img, mask, lines, factor, tall, net, mark_c)
            row["img"] = png(painted_page, 1100)
            out[who] = row

        verdict = None
        if keys:
            ga, gb = out[a]["agreement"], out[b]["agreement"]
            verdict = (a if ga > gb else b) if abs(ga - gb) >= 0.002 else None
        return jsonify(file=file, detail=detail, lines_confirmed=len(keys),
                       a=a, b=b, better=verdict, **{"models": out})
    except Exception:
        return jsonify(error=traceback.format_exc()[-2000:])


@app.get("/bandrank")
def band_rank():
    """The lines of a photograph, hardest first.

    Labelling in file order spends the afternoon on lines the model already
    reads correctly. Ranked by how unsure it is, the first line you look at is
    the one your answer changes the most -- and the ones already confirmed are
    marked so they are not done twice.
    """
    try:
        import unet
        file = os.path.basename(request.args.get("file", ""))
        detail = max(1200, min(9000, request.args.get("detail", 5200, type=int)))
        model = request.args.get("model") or None
        path = os.path.join(PHOTOS, file)
        if not os.path.exists(path):
            return jsonify(error="no such photograph: %s" % file)
        _, mask, lines, factor, tall = bands.cut(path, detail)
        done = set(tune.lines_of(file, detail))
        net = unet.load(model) if model else None
        rows = []
        for i in range(len(lines)):
            big, _, _ = bands.strip(mask, lines, i, factor, tall)
            on = big > 0
            row = {"line": i, "ink": int(on.sum()),
                   "confirmed": tune.key(file, detail, i) in done}
            if net is not None and on.any():
                p = unet.marks_of(net, big)
                row["doubt"] = round(float((1.0 - 2.0 * np.abs(p[on] - 0.5)).mean()), 4)
                row["marks"] = round(float((p[on] > 0.5).mean()), 4)
            rows.append(row)
        order = sorted(rows, key=lambda r: (r["confirmed"], -r.get("doubt", 0)))
        return jsonify(file=file, detail=detail, lines=len(lines),
                       confirmed=len(done), rows=order)
    except Exception:
        return jsonify(error=traceback.format_exc()[-2000:])


@app.get("/compare")
def compare():
    """Two models over the same pages, with the spelling as the referee."""
    try:
        a = request.args.get("a")
        b = request.args.get("b")
        first = request.args.get("from", 200, type=int)
        span = min(request.args.get("span", 5, type=int), 40)
        ink = bgr(request.args.get("ink"), (30, 30, 30))
        mark = bgr(request.args.get("mark"), (40, 40, 230))
        n = request.args.get("page", type=int)
        rows, totals = [], {a: [0, 0], b: [0, 0]}
        pages = [n] if n else range(first, min(605, first + span))
        for n in pages:
            row = {"page": n}
            for who in (a, b):
                r = page_report(n, who)
                img, _, _, _ = sheet_of(n, who, ink, mark, width=560)
                row[who] = dict(r, img=png(img))
                totals[who][0] += r["agree"]
                totals[who][1] += r["words"]

            # Where the two of them actually part company, word by word. Two
            # models can agree with the spelling equally often and still read
            # the page quite differently, and the summary hides that -- these
            # are the words where one changed its mind about the other.
            wa = {w["code"]: w for l in read(n, a) for w in l["words"] if not w["marker"]}
            wb = {w["code"]: w for l in read(n, b) for w in l["words"] if not w["marker"]}
            differs = []
            for code, x in wa.items():
                y = wb.get(code)
                if y is None or x["found"] == y["found"]:
                    continue
                differs.append({"text": x["text"], "spelled": x["spelled"],
                                a: x["found"], b: y["found"],
                                "closer": (a if abs(x["found"] - x["spelled"])
                                           < abs(y["found"] - y["spelled"]) else b)})
            row["differs"] = sorted(
                differs, key=lambda d: -abs(d[a] - d[b]))[:40]
            row["same"] = len(wa) - len(differs)
            rows.append(row)
        summary = {who: {"agreement": round(v[0] / v[1], 3) if v[1] else 0,
                         "words": v[1]} for who, v in totals.items()}
        better = max(summary, key=lambda w: summary[w]["agreement"])
        gap = abs(summary[a]["agreement"] - summary[b]["agreement"])
        return jsonify(rows=rows, summary=summary, a=a, b=b,
                       better=better if gap >= 0.005 else None,
                       verdict=("%s agrees with the spelling on %.1f%% of words, "
                                "%s on %.1f%%" % (a, 100 * summary[a]["agreement"],
                                                  b, 100 * summary[b]["agreement"]))
                       + ("" if gap >= 0.005 else " - too close to call"))
    except FileNotFoundError as err:
        return jsonify(error=str(err))
    except Exception:
        return jsonify(error=traceback.format_exc()[-2000:])


if __name__ == "__main__":
    PORT = int(os.environ.get("PORT", 5000))
    quiet = "--no-browser" in sys.argv or os.environ.get("NO_BROWSER")
    if not quiet and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        threading.Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:%d/" % PORT)).start()
    print("QCF check on http://127.0.0.1:%d/  (ctrl-c to stop)" % PORT)
    app.run(debug=False, port=PORT, threaded=True)
