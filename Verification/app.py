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

import random

import auto
import bands
import label
import models
import photo
import render
import tune

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
app = Flask(__name__, static_folder=STATIC, static_url_path="/static")

# Never cache the front end. This is a tool being changed while it is open, and
# a browser holding yesterday's app.js does not fail loudly -- it runs old code
# against new routes and reports errors on line numbers that no longer mean
# anything, which is a slow and thoroughly misleading way to lose an hour.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

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


def sheet_of(page, model, ink_colour, mark_colour, width=SHEET, boxes=None,
             prefer_labels=False):
    """A whole page as one picture, plus where everything landed on it.

    The map is returned with the picture so a click can be traced back to the
    word and the piece of ink it fell on. Nothing about the geometry is guessed
    in the browser.
    """
    lines, marks = painted(page, model, prefer_labels)
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
        # Ring the words worth looking at. "Where they differ" used to be a
        # list of words under the page, which leaves you reading a word and
        # then hunting the page for it -- and an Arabic word you cannot find
        # is one you cannot check.
        for w in (l["words"] if boxes else []):
            if w["code"] not in boxes:
                continue
            cv2.rectangle(tile, (w["x0"] - 4, 2),
                          (w["x1"] + 4, ink.shape[0] - 3), (20, 130, 240), 3)
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


# When this process loaded its code. Python changes need a restart and static
# files do not, so a running server and the files beside it drift apart -- and
# the symptom is never "restart me", it is a column that went blank or a button
# that quietly does nothing. Cheap to detect: compare what is on disk now with
# what was there when we started.
OURS = [f for f in os.listdir(os.path.dirname(os.path.abspath(__file__)))
        if f.endswith(".py")]
LOADED_AT = {f: os.path.getmtime(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), f)) for f in OURS}


@app.get("/health")
def health():
    here = os.path.dirname(os.path.abspath(__file__))
    changed = []
    for f, was in LOADED_AT.items():
        try:
            if os.path.getmtime(os.path.join(here, f)) > was + 1:
                changed.append(f)
        except OSError:
            changed.append(f)
    return jsonify(stale=bool(changed), changed=sorted(changed))


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/word")
def word_picture():
    """One labelled word, painted by what it was labelled.

    The reason the Labels view needed to exist at all. A table saying a word
    has four marks cannot tell you whether they are the right four -- the only
    thing that can is the word itself with the labels shown on it, which is
    exactly how they were made in the first place.
    """
    try:
        page = request.args.get("page", type=int)
        code = request.args.get("code", "")
        scale = max(0.2, min(2.0, request.args.get("scale", 0.55, type=float)))
        store = label.load()
        classes = store.get(label.key(page, code))
        if classes is None:
            return jsonify(error="that word is not labelled")
        img = label.draw(page, code, classes, scale)
        ok, buf = cv2.imencode(".png", img)
        return app.response_class(buf.tobytes(), mimetype="image/png")
    except Exception:
        return jsonify(error=traceback.format_exc()[-800:])


@app.post("/wordfix")
def word_fix():
    """Flip one piece of ink in one labelled word.

    Seeing that a label is wrong and being able only to delete it is half a
    tool. Deleting throws away the whole word -- every other blob in it that
    was right -- to correct one dot, and then the word has to be found and
    labelled again from nothing. Here the click lands on the piece that is
    wrong and changes only that.

    Written straight through rather than staged. A flip is its own undo:
    click again and it goes back, and the picture redraws so you can see
    which it now is. Staging would add a step to a correction whose whole
    point is that it is immediate.
    """
    try:
        d = request.get_json(silent=True) or {}
        page, code = int(d["page"]), d["code"]
        store = label.load()
        k = label.key(page, code)
        classes = store.get(k)
        if classes is None:
            return jsonify(error="that word is not labelled")
        mask, lab, st, keep = label.blobs(page, code)
        h, w = lab.shape
        blob = label.blob_at(page, code, float(d["fx"]) * w, float(d["fy"]) * h)
        if blob is None:
            return jsonify(hit=None)
        was = int(classes.get(str(blob), label.LETTER))
        now = label.MARK if was == label.LETTER else label.LETTER
        classes[str(blob)] = now
        store[k] = classes
        label.save(store)
        _READ.clear()                # every page read with a model is now stale
        marks = sum(1 for v in classes.values() if int(v) == label.MARK)
        text = label.uthmani().get((page, code), "")
        return jsonify(hit=blob, now=label.NAMES[now], marks=marks,
                       letters=len(classes) - marks,
                       spelled=label.expected(text))
    except Exception:
        return jsonify(error=traceback.format_exc()[-1200:])


# The composed page, kept against the state of the labels it was drawn from.
# Keyed by the file's modification time rather than by a counter we bump, so a
# second copy of this app writing the same labels.json invalidates it too --
# which happens, and a picture of labels that are no longer there is worse than
# a slow one.
_LABELPAGE = {}
_LABELPAGE_ORDER = []
LABELPAGES_KEPT = 12


@app.get("/labelpage")
def label_page():
    """A whole page painted by the labels rather than by a model.

    The gallery shows a word at a time, which is right for judging one label
    and wrong for judging a page of them: it cannot show what is missing. Here
    the labelled words are drawn in their colours and everything not labelled
    is left pale, so coverage and correctness are the same picture -- which
    words have been done, which have not, and whether the marks on the done
    ones look like marks.
    """
    try:
        n = request.args.get("page", 3, type=int)
        ink_c = bgr(request.args.get("ink"), (30, 30, 30))
        mark_c = bgr(request.args.get("mark"), (40, 40, 230))
        pale = (205, 205, 205)
        try:
            stamp = os.path.getmtime(label.STORE)
        except OSError:
            stamp = 0
        ck = (n, ink_c, mark_c, stamp)
        if ck in _LABELPAGE:
            return jsonify(**_LABELPAGE[ck])
        store = label.load()
        auto = auto_keys()
        text = label.uthmani()

        lines = read(n, None)          # no model: the type and nothing else
        px = label.PX
        gap = int(round(px * GAP))
        W = max(l["ink"].shape[1] for l in lines)
        H = sum(l["ink"].shape[0] for l in lines) + gap * (len(lines) + 1)
        big = np.full((H, W, 3), 255, np.uint8)

        # The word list on a line is only built when a model has run over it,
        # and this view deliberately runs none -- so the codes and bounds are
        # read straight off the line, which are there either way.
        markers = set(render.mushaf()["marks"].get(str(n), ""))
        done = missing = odd = 0
        y = gap
        for l in lines:
            ink = l["ink"]
            x = (W - ink.shape[1]) // 2
            tile = np.full(ink.shape + (3,), 255, np.uint8)
            tile[ink > 0] = pale
            lab, st, _ = blobs_of_line(l)
            for code, (bx0, bx1) in zip(l["codes"], l["bounds"]):
                if any(c in markers for c in code):
                    continue                      # an ayah marker is not a word
                bx0, bx1 = int(round(bx0)), int(round(bx1))
                k = label.key(n, code)
                classes = store.get(k)
                if classes is None:
                    missing += 1
                    continue
                pairs = word_pairs(l, n, code, bx0, bx1)
                if not pairs:
                    continue
                done += 1
                marks = sum(1 for v in classes.values() if int(v) == label.MARK)
                if marks != label.expected(text.get((n, code), "")):
                    odd += 1
                for line_blob, word_blob in pairs.items():
                    cls = int(classes.get(str(word_blob), label.LETTER))
                    tile[lab == line_blob] = mark_c if cls == label.MARK else ink_c
                if k in auto:
                    cv2.rectangle(tile, (bx0 - 3, 2),
                                  (bx1 + 3, ink.shape[0] - 3), (150, 150, 150), 1)
            big[y:y + ink.shape[0], x:x + ink.shape[1]] = tile
            y += ink.shape[0] + gap

        label.flush_order()          # so the next restart does not redraw them
        out = {"page": n, "labelled": done, "unlabelled": missing,
               "disagreeing": odd, "img": png(big, SHEET)}
        _LABELPAGE[ck] = out
        _LABELPAGE_ORDER.append(ck)
        while len(_LABELPAGE_ORDER) > LABELPAGES_KEPT:
            _LABELPAGE.pop(_LABELPAGE_ORDER.pop(0), None)
        return jsonify(**out)
    except Exception:
        return jsonify(error=traceback.format_exc()[-1500:])


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
        mine = request.args.get("mine") == "1"
        img, where, scale, _ = sheet_of(n, model, ink, mark, prefer_labels=mine)
        r = page_report(n, model) if model else {"page": n}
        staged = sum(len(v) for v in pending(n)["paint"].values())
        done = checked().get(str(n))
        store = label.load()
        left = sum(1 for l in read(n, model) for code in l["codes"]
                   if label.key(n, code) not in store)
        return jsonify(page=dict(r, img=png(img), where=where, scale=scale,
                                 staged=staged, checked=done, unlabelled=left,
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


def word_pairs(line, page, code, bx0, bx1):
    """Match the pieces of one word inside a line to the same word drawn alone.

    A line is drawn with no vertical padding and a word with a tenth of an em
    of it, each against its own ink extent, so no fixed offset carries from one
    to the other -- that arithmetic was wrong once already and silently
    recorded nothing. The blobs themselves can be matched instead: the same
    word breaks into the same pieces in the same order, so both are sorted the
    same way and paired off by position.

    Returns {blob in the line: blob in the word}, or None when the two do not
    break into the same number of pieces and no pairing can be trusted.
    """
    lab, st, n = blobs_of_line(line)
    mine = order_blobs(st, [i for i in range(1, n)
                            if st[i, cv2.CC_STAT_AREA] >= 20
                            and bx0 <= st[i, cv2.CC_STAT_LEFT]
                            + st[i, cv2.CC_STAT_WIDTH] / 2 < bx1])
    theirs = label.order_of(page, code)      # from disk, not from a redraw
    if len(mine) != len(theirs) or not mine:
        return None
    return dict(zip(mine, theirs))


def blobs_of_line(line):
    """The pieces of ink in one line, numbered. Cached on the line itself."""
    if "lab" not in line:
        n, lab, st, _ = cv2.connectedComponentsWithStats(line["ink"], 8)
        line["lab"], line["stats"], line["count"] = lab, st, n
    return line["lab"], line["stats"], line["count"]


def painted(page, model, prefer_labels=False):
    """What each line should look like now: the model, plus anything staged.

    With prefer_labels, a word already labelled by hand is drawn from its
    label and not from the model. That is the difference between asking a
    model to read a page and asking it for help with one: help means it fills
    the gaps and leaves alone what you have already decided. Painting over
    your own work and calling it assistance is how an afternoon gets undone
    without anyone noticing.
    """
    lines = read(page, model)
    edits = pending(page)["paint"]
    store = label.load() if prefer_labels else {}
    out = []
    for i, l in enumerate(lines):
        marks = l["marks"].copy()
        if store:
            lab, _, _ = blobs_of_line(l)
            for code, (bx0, bx1) in zip(l["codes"], l["bounds"]):
                classes = store.get(label.key(page, code))
                if classes is None:
                    continue
                pairs = word_pairs(l, page, code, int(round(bx0)), int(round(bx1)))
                if not pairs:
                    continue
                for line_blob, word_blob in pairs.items():
                    marks[lab == line_blob] = (
                        int(classes.get(str(word_blob), label.LETTER)) == label.MARK)
        # staged clicks are the newest thing anyone said, so they go on last
        if i in edits:
            lab, _, _ = blobs_of_line(l)
            for blob, cls in edits[i].items():
                marks[lab == blob] = bool(cls)
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
            pairs = word_pairs(line, page, code, bx0, bx1)
            if pairs and blob in pairs:
                p["labels"].setdefault(code, {})[str(pairs[blob])] = int(now)
                word = label.uthmani().get((page, code), code)
            break

        img, where, scale, _ = sheet_of(page, model, ink, mark,
                                        prefer_labels=bool(d.get("mine")))
        label.flush_order()
        return jsonify(hit=blob, word=word, now=label.NAMES[int(now)],
                       staged=sum(len(v) for v in p["paint"].values()),
                       img=png(img), where=where, scale=scale)
    except Exception:
        return jsonify(error=traceback.format_exc()[-1500:])


# Which labels were taken from the model rather than put there by hand. Not a
# judgement on them, a provenance: they are corroborated, not checked, and if
# the model that proposed them turns out to have been poor they can all be
# taken back at once without touching a single label anyone actually looked at.
AUTO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "auto.json")


def auto_keys():
    try:
        with open(AUTO, encoding="utf-8") as fh:
            return set(json.load(fh))
    except Exception:
        return set()


def note_auto(keys):
    if not keys:
        return
    with open(AUTO, "w", encoding="utf-8") as fh:
        json.dump(sorted(auto_keys() | set(keys)), fh, indent=1)


def forget_auto(keys):
    left = auto_keys() - set(keys)
    with open(AUTO, "w", encoding="utf-8") as fh:
        json.dump(sorted(left), fh, indent=1)


@app.post("/save")
def save_page():
    """Write one page's labels: what you corrected, and what the spelling agrees.

    The second half is the part that was missing, and it was most of the value.
    A click was the only thing that ever became a label, so a page of a hundred
    and thirty words where the model was right about a hundred and twenty gave
    up eighteen -- the rest were looked at, found correct, and thrown away.

    A word whose mark count matches its Uthmani spelling is not the model
    marking its own homework: the spelling never reaches the model, it is
    written down in the text, and it is the same referee the whole project is
    scored by. Where it agrees, the reading is corroborated by something
    outside the model and is worth keeping.

    It is corroboration and not proof, and the difference is recorded rather
    than glossed. A count can be right while the pixels are wrong -- a dot
    taken for a mark and a real mark missed leaves the total unchanged -- so
    these are marked as harvested, shown as such, and can be dropped wholesale.
    """
    try:
        d = request.get_json(silent=True) or {}
        page = int(d["page"])
        model = d.get("model") or None
        take_agreed = bool(d.get("agreed")) and model
        p = _PENDING.get(page)
        staged = (p or {}).get("labels") or {}

        store = label.load()
        touched, harvested = 0, []
        for code, blobs in staged.items():
            k = label.key(page, code)
            classes = store.get(k) or label.guess(page, code)
            classes.update({b: int(c) for b, c in blobs.items()})
            store[k] = classes
            touched += 1

        if take_agreed:
            lines = read(page, model)
            edits = (p or {}).get("paint") or {}
            for i, l in enumerate(lines):
                shown = recount(page, i, l, edits[i]) if i in edits else l
                marks = l["marks"].copy()
                if i in edits:
                    lab, _, _ = blobs_of_line(l)
                    for b, c in edits[i].items():
                        marks[lab == b] = bool(c)
                for w in shown["words"]:
                    k = label.key(page, w["code"])
                    if (w["marker"] or w["found"] != w["spelled"]
                            or w["code"] in staged or k in store):
                        continue
                    pairs = word_pairs(l, page, w["code"], w["x0"], w["x1"])
                    if not pairs:
                        continue
                    lab, _, _ = blobs_of_line(l)
                    classes = {}
                    for line_blob, word_blob in pairs.items():
                        hot = marks[lab == line_blob]
                        classes[str(word_blob)] = int(
                            label.MARK if hot.mean() >= 0.5 else label.LETTER)
                    store[k] = classes
                    harvested.append(k)
                    touched += 1

        label.save(store)
        label.flush_order()
        note_auto(harvested)
        fixes = sum(len(v) for v in ((p or {}).get("paint") or {}).values())
        _PENDING.pop(page, None)
        was = mark_checked(page, fixes)
        return jsonify(saved=touched, harvested=len(harvested),
                       words=len(store), checked=was, next=min(604, page + 1))
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


# A training run used to happen inside the request that asked for it, which
# meant no progress, no way to stop, and a server that answered nothing for a
# quarter of an hour. It runs beside the request now, and the page asks how it
# is getting on.
_JOB = {"going": False}


def job_state():
    out = dict(_JOB)
    out.pop("stop", None)
    return out


@app.get("/train/status")
def train_status():
    """How the run is going. Falls back to what was last written to disk, so a
    restart part way through still says what was happening rather than
    pretending nothing ever was."""
    if not _JOB and os.path.exists(JOBFILE):
        try:
            with open(JOBFILE, encoding="utf-8") as fh:
                return jsonify(**dict(json.load(fh), going=False))
        except Exception:
            pass
    return jsonify(**job_state())


@app.post("/train/stop")
def train_stop():
    """Ask the run to stop. What it has trained so far is still saved."""
    _JOB["stop"] = True
    _JOB["note"] = "stopping — the model will be saved as it stands"
    return jsonify(**job_state())


JOBFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "training.json")


def _job_save():
    try:
        with open(JOBFILE, "w", encoding="utf-8") as fh:
            json.dump(job_state(), fh, indent=1)
    except Exception:
        pass


def run_in_background(what, kind, name_hint):
    """Start a training job and report on it. what(on_step, should_stop)."""
    if _JOB.get("going"):
        raise ValueError("something is already training")
    _JOB.clear()
    _JOB.update({"going": True, "kind": kind, "step": 0, "steps": 0,
                 "loss": None, "seconds": 0, "note": "starting",
                 "what": name_hint, "stop": False})

    def on_step(i, n, loss, secs):
        _JOB.update({"step": i, "steps": n, "loss": round(loss, 4),
                     "seconds": int(secs),
                     "note": "step %d of %d" % (i, n)})
        if i % 25 == 0:
            _job_save()

    def go():
        try:
            card = what(on_step, lambda: bool(_JOB.get("stop")))
            _JOB["model"] = card
            _JOB["note"] = ("stopped at step %d — %s saved as it stands"
                            % (_JOB["step"], card["name"])
                            if _JOB.get("stop") else "%s saved" % card["name"])
        except Exception:
            _JOB["note"] = "failed: " + traceback.format_exc()[-300:]
        finally:
            _JOB["going"] = False
            _job_save()
            _READ.clear()

    threading.Thread(target=go, daemon=True).start()
    return job_state()


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
        opts = dict(
            steps=steps, jitter=jitter,
            batch=max(2, min(64, arg.get("batch", 16, type=int))),
            lr=max(1e-5, min(1e-1, arg.get("lr", 2e-3, type=float))),
            width=max(8, min(32, arg.get("width", 16, type=int))),
            decay=max(0.0, min(1e-1, arg.get("decay", 1e-4, type=float))),
            seed=arg.get("seed", 0, type=int),
            hold_out=max(0.0, min(0.5, arg.get("holdout", 0.0, type=float))))

        def work(on_step, should_stop):
            net, name = unet.train(store, on_step=on_step,
                                   should_stop=should_stop, **opts)
            unet._LOADED[name] = net
            return models.describe(name)

        return jsonify(**run_in_background(work, "train", "a new model"))
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


@app.post("/tune")
def tune_now():
    """Fine-tune a model on the confirmed real lines."""
    try:
        base = request.args.get("base") or None
        if not base:
            return jsonify(error="choose a model to fine-tune from")
        arg = request.args
        opts = dict(
            steps=max(20, min(5000, arg.get("steps", 300, type=int))),
            lr=max(1e-7, min(1e-3, arg.get("lr", 1e-5, type=float))),
            real_share=max(0.1, min(0.9, arg.get("share", 0.7, type=float))),
            batch=max(2, min(64, arg.get("batch", 16, type=int))),
            rotate=max(0.0, min(10.0, arg.get("rotate", 2.0, type=float))),
            scale=max(0.0, min(0.3, arg.get("scale", 0.05, type=float))),
            seed=arg.get("seed", 0, type=int),
            freeze=arg.get("freeze", "1") != "0")

        def work(on_step, should_stop):
            import unet
            net, name = tune.run(base, label.load(), PHOTOS, on_step=on_step,
                                 should_stop=should_stop, **opts)
            unet._LOADED[name] = net
            return models.describe(name)

        return jsonify(**run_in_background(work, "tune", "fine-tuned from " + base))
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
    auto = auto_keys()
    rows = []
    for k, classes in store.items():
        page, code = k.split("/", 1)
        marks = sum(1 for v in classes.values() if int(v) == label.MARK)
        rows.append({"key": k, "page": int(page), "code": code,
                     "text": text.get((int(page), code), ""),
                     "marks": marks, "letters": len(classes) - marks,
                     "spelled": label.expected(text.get((int(page), code), "")),
                     "auto": k in auto,
                     "checked": str(int(page)) in checked()})
    rows.sort(key=lambda r: (r["page"], r["code"]))
    by_page = {}
    for r in rows:
        by_page[r["page"]] = by_page.get(r["page"], 0) + 1
    marks = sum(r["marks"] for r in rows)
    return jsonify(words=rows, pages=sorted(by_page), per_page=by_page,
                   total=len(rows), marks=marks,
                   harvested=sum(1 for r in rows if r["auto"]),
                   letters=sum(r["letters"] for r in rows),
                   agree=sum(1 for r in rows if r["marks"] == r["spelled"]))


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
        label.save(store)          # keeps labels.json.last as it was before this
        forget_auto(keys)
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


@app.post("/model/note")
def model_note():
    """Record on a model's card what Compare just measured about it.

    Models lists; Compare judges. Testing a model is comparing it -- against
    the spelling, or against the lines you confirmed -- so there is no reason
    for two places to do it, and every reason for the answer to end up on the
    card rather than being re-run by whoever wonders next.
    """
    try:
        name = request.args.get("name")
        what = request.args.get("what")
        if not name or not what:
            return jsonify(error="which model, and what was measured?")
        return jsonify(model=models.note_test(
            name, what, request.get_json(silent=True) or {}))
    except Exception:
        return jsonify(error=traceback.format_exc()[-800:])


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
        who = wanted_models(request.args)
        file = os.path.basename(request.args.get("file", ""))
        detail = max(1200, min(9000, request.args.get("detail", 5200, type=int)))
        mark_c = bgr(request.args.get("mark"), (40, 40, 230))
        if not who:
            return jsonify(error="choose at least one model")
        path = os.path.join(PHOTOS, file)
        if not os.path.exists(path):
            return jsonify(error="no such photograph: %s" % file)

        img, mask, lines, factor, tall = bands.cut(path, detail)
        keys = tune.lines_of(file, detail)
        wide = 1500 if len(who) == 1 else max(520, int(1300 / len(who)))
        out = {}
        for name in who:
            net = unet.load(name)
            row = {"scored": bool(keys)}
            # A model fine-tuned on these very lines is being marked on its own
            # homework. Still worth showing -- it says the fine-tune took --
            # but it is not evidence that it generalises, and the difference
            # matters enough to be said on the page rather than remembered.
            taught = set(models.describe(name).get("real_keys") or [])
            row["taught_on"] = len(taught & set(keys))
            if keys:
                row.update(tune.score_on_real(net, keys, PHOTOS))
            painted_page, row["found"], row["working"] = photo_read(
                img, mask, lines, factor, tall, net, mark_c)
            row["img"] = png(painted_page, wide)
            out[name] = row

        best = None
        if keys and len(who) > 1:
            rank = sorted(who, key=lambda m: -out[m]["agreement"])
            if out[rank[0]]["agreement"] - out[rank[1]]["agreement"] >= 0.002:
                best = rank[0]
        return jsonify(file=file, detail=detail, lines_confirmed=len(keys),
                       models=who, rows=out, better=best, on="photo")
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


def wanted_models(arg):
    """The models a request is asking about, in the order it asked."""
    names = [n for n in (arg.get("models") or "").split(",") if n]
    if not names:                       # the two-model form, still understood
        names = [n for n in (arg.get("a"), arg.get("b")) if n]
    have = set(models.names())
    return [n for n in names if n in have]


def judge_on_pages(name, pages):
    """A model's agreement with the spelling over pages it has never seen.

    The pages are chosen away from anything labelled, so nothing the model was
    taught appears in its own examination -- which is the whole of what K-fold
    would have been bought at five times the price.
    """
    agree = words = 0
    for n in pages:
        r = page_report(n, name)
        agree += r["agree"]
        words += r["words"]
    return round(agree / words, 4) if words else 0.0


def unseen_pages(how_many=3, seed=7):
    """Pages with no labelled word on them, spread across the mushaf."""
    store = label.load()
    used = {int(k.split("/", 1)[0]) for k in store}
    rng = random.Random(seed)
    out = []
    while len(out) < how_many:
        n = rng.randint(2, 604)
        if n not in used and n not in out:
            out.append(n)
    return sorted(out)


# A search over fine-tuning needs confirmed lines it did not fine-tune on, and
# enough of them from enough photographs to mean something. Six lines from one
# capture describe one afternoon's light and one angle to the lens; a model
# tuned to them and scored on them will improve every round and have learned
# the room.
LEAST_LINES, LEAST_PHOTOS = 8, 2


# How many confirmed lines make a search worth trusting, as against how many
# make it possible at all. Below these the answer is thin -- some lines have to
# be held back to judge with, and lines from one capture only describe that
# capture's light and angle -- but thin is a thing to be told, not a thing to
# be stopped from doing. It is your afternoon and your evidence.
WORTH_LINES, WORTH_PHOTOS = 8, 2


@app.post("/autotrain")
def autotrain_start():
    """Vary the settings behind the best model, train, score, write it down.

    With tune=1 a round is the whole pipeline -- train a digital model, fine-
    tune it on the confirmed lines, score both -- because a digital model is
    not the thing anyone wants; it is what a photograph-reading model is made
    out of. Judged by whichever of the two you say.
    """
    try:
        import unet
        arg = request.args
        rounds = max(1, min(40, arg.get("rounds", 8, type=int)))
        patience = max(1, min(20, arg.get("patience", 4, type=int)))
        with_tune = arg.get("tune") == "1"
        judge_by = arg.get("judge", "digital")
        # one setting a round by default: two is quicker to stumble on a good
        # pair and leaves you unable to say which half of it did the good
        changes = max(1, min(3, arg.get("changes", 1, type=int)))
        tiers = arg.get("tiers", "1") != "0"
        # how many values each swept setting is tried at, in phase one
        points = max(2, min(7, arg.get("points", 3, type=int)))
        # How far a candidate has to move a setting, and how far it may, both
        # as a share of that setting's own span. Given rather than fixed: the
        # right smallest-worth-a-round differs between a fifteen-minute
        # training run and something that takes a day.
        least = min(0.6, max(0.0, arg.get("least", auto.LEAST_MOVE, type=float)))
        reach = min(1.0, max(least, arg.get("reach", auto.MOST_MOVE, type=float)))
        sweep = arg.get("sweep") or None
        if sweep and sweep not in auto.knobs(with_tune):
            return jsonify(error="no setting called %s to sweep" % sweep)
        pages = unseen_pages(max(1, min(8, arg.get("pages", 3, type=int))))
        store = label.load()

        train_keys = judge_keys = None
        if with_tune:
            keys = sorted(tune.load())
            if len(keys) < 2:
                return jsonify(error=(
                    "%d confirmed line%s. Two is the fewest that can work at "
                    "all: one to fine-tune on and one to judge with."
                    % (len(keys), "" if len(keys) == 1 else "s")))
            train_keys, judge_keys = auto.split_lines(keys)

        def make_digital(cand, seed):
            jitter = {k: cand[k] for k in ("scale", "rotate", "spread")}
            net, name = unet.train(
                store, steps=cand["steps"], batch=cand["batch"], lr=cand["lr"],
                width=cand["width"], decay=cand["decay"], jitter=jitter,
                seed=seed, hold_out=0.15,
                trained_from=auto.state().get("baseline"))
            unet._LOADED[name] = net
            _READ.clear()
            return name

        def make_physical(base, cand, seed):
            net, name = tune.run(
                base, store, PHOTOS, keys=train_keys, seed=seed,
                steps=cand["t_steps"], lr=cand["t_lr"],
                real_share=cand["t_share"], rotate=cand["t_rotate"],
                scale=cand["t_scale"])
            unet._LOADED[name] = net
            _READ.clear()
            return name

        def judge_physical(name):
            r = tune.score_on_real(unet.load(name), judge_keys, PHOTOS)
            return r["mark pixels found (IoU)"]

        st = auto.start(
            make_digital, lambda n: judge_on_pages(n, pages),
            make_physical if with_tune else None,
            judge_physical if with_tune else None,
            judge_by=judge_by, rounds=rounds, patience=patience,
            changes=changes, tiers=tiers, sweep=sweep,
            least=least, reach=reach, points=points)
        return jsonify(**st)
    except Exception as err:
        return jsonify(error=str(err))


@app.get("/autotrain/plan")
def autotrain_plan():
    """What a search would do, before anyone starts one.

    Worked out here rather than in the browser: which model it starts from
    depends on what is being judged, and having the page guess at that is how
    the page comes to say something the search does not do.
    """
    with_tune = request.args.get("tune") == "1"
    judge_by = request.args.get("judge", "digital")
    tune_base = models.best_at("real")
    if with_tune and judge_by == "physical" and tune_base:
        base = (models.parent_of(tune_base)
                or models.best_at("digital") or (models.names() or [None])[0])
        why = "%s was fine-tuned out of %s" % (tune_base, base)
    else:
        base = models.best_at("digital") or (models.names() or [None])[0]
        why = "%s reads type best" % base if base else "nothing trained yet"

    least = min(0.6, max(0.0, request.args.get("least", auto.LEAST_MOVE,
                                               type=float)))
    settings = auto.settings_of(base, tune_base) if base else {}
    out = {"base": base, "tune_base": tune_base, "why": why,
           # each setting with its tier, the span it will be moved within, and
           # what the smallest worthwhile change comes to in its own units --
           # so nobody has to work out what a share of a span is
           "knobs": auto.knob_facts(settings, with_tune, least),
           "least": least, "reach": auto.MOST_MOVE,
           # what phase one will sweep, worked out the same way the search
           # will work it out, so the plan cannot describe a different search
           "phases": [{"name": n, "what": w} for n, w in auto.PHASES],
           "phase1": [{"key": c["key"], "value": c["settings"][c["key"]]}
                      for c in auto.phase_plan(
                          settings, with_tune,
                          max(0, request.args.get("rounds", 8, type=int) - 2),
                          max(2, min(7, request.args.get("points", 3, type=int))),
                          judge_by)] if settings else [],
           "pages": unseen_pages(3), "with_tune": with_tune, "judge_by": judge_by,
           # the settings the first round starts from, so they can be read
           # before anything runs rather than worked out from the model cards
           "settings": settings}
    if with_tune:
        keys = sorted(tune.load())
        train_keys, judge_keys = auto.split_lines(keys) if keys else ([], [])
        photos = sorted({tune.parts(k)[0] for k in keys})
        thin = []
        if len(keys) < WORTH_LINES:
            thin.append("%d confirmed line%s is thin: one either way will move "
                        "the score more than most of these settings do"
                        % (len(keys), "" if len(keys) == 1 else "s"))
        if len(photos) < WORTH_PHOTOS:
            thin.append("every line is from one photograph, so the winner will "
                        "be whichever reads that capture's light and angle")
        out.update({
            "thin": thin,
            "photos": photos,
            "trains_on": len(train_keys), "judges_on": len(judge_keys),
            "judge_photos": sorted({tune.parts(k)[0] for k in judge_keys}),
            "judge_lines": [{"photo": tune.parts(k)[0], "line": tune.parts(k)[2] + 1}
                            for k in judge_keys],
        })
    return jsonify(**out)


def agreement_between(pairs):
    """Do two scorings rank the same candidates the same way? Kendall's tau.

    Worth knowing rather than assuming. If the digital score and the
    photograph score put the candidates in the same order, either can stand
    for the other and the search is cheap. If they disagree, the choice of
    judge decided the outcome -- and that is a thing to know before believing
    the winner.
    """
    n = len(pairs)
    if n < 3:
        return None
    same = other = 0
    for i in range(n):
        for k in range(i + 1, n):
            a = (pairs[i][0] - pairs[k][0]) * (pairs[i][1] - pairs[k][1])
            if a > 0:
                same += 1
            elif a < 0:
                other += 1
    total = same + other
    return round((same - other) / total, 3) if total else None


@app.get("/autotrain/report")
def autotrain_report():
    """The whole search as numbers, and what looks wrong about them.

    Pictures are for finding out what a model did to a page. Whether a search
    means anything is arithmetic: how far apart the scores were, whether the
    gaps beat the noise, whether the two judges agreed, how big the sample
    the winner was chosen on. All of it small enough to read at once, with
    the things that would make the result meaningless said outright rather
    than left to be noticed.
    """
    want = request.args.get("id")
    if want:
        try:
            st = auto.one(want)
        except ValueError as err:
            return jsonify(error=str(err))
    else:
        st = auto.state()
    if not st.get("log") and not want and os.path.exists(auto.STATE):
        try:
            with open(auto.STATE, encoding="utf-8") as fh:
                st = json.load(fh)
        except Exception:
            pass
    log = st.get("log") or []
    if not log:
        return jsonify(error="no search has run yet")

    judge_by = st.get("judge_by", "digital")
    key = "score_" + judge_by
    scored = [r for r in log if r.get(key) is not None]
    vals = [r[key] for r in scored]
    baseline = vals[0] if vals else None
    best = max(vals) if vals else None

    rows = []
    for r in log:
        d, p = r.get("score_digital"), r.get("score_physical")
        rows.append({
            "round": r.get("round", 0),
            "digital_model": r.get("digital"),
            "physical_model": r.get("physical"),
            "digital": d, "physical": p,
            "deciding": r.get(key),
            "vs_baseline": None if r.get(key) is None or baseline is None
                           else round(r[key] - baseline, 4),
            "changed": r.get("changed"),
            "kept": bool(r.get("kept")),
        })

    both = [(r["digital"], r["physical"]) for r in rows
            if r["digital"] is not None and r["physical"] is not None]
    tau = agreement_between(both)

    wins = [r for r in rows[1:] if r["kept"]]
    margins = sorted(round(r["vs_baseline"], 4) for r in wins
                     if r["vs_baseline"] is not None)
    spread = round(max(vals) - min(vals), 4) if len(vals) > 1 else 0.0

    judge_lines = st.get("judges_on")
    keys = sorted(tune.load())
    _, held = auto.split_lines(keys) if keys else ([], [])
    photos = sorted({tune.parts(k)[0] for k in held}) if held else []

    # What would make the answer above not mean what it looks like.
    concerns = []
    if len(vals) < 3:
        concerns.append("only %d candidate%s scored: too few to tell a real "
                        "difference from a lucky seed" % (len(vals),
                        "" if len(vals) == 1 else "s"))
    if spread and spread < auto.REAL_WIN * 2:
        concerns.append("every candidate scored within %.4f of every other, "
                        "which is about the difference two seeds make: the "
                        "search could not tell them apart" % spread)
    if margins and margins[-1] < auto.REAL_WIN * 2:
        concerns.append("the best win was %.4f, barely over the %.4f a win has "
                        "to beat -- treat the winner as a tie" %
                        (margins[-1], auto.REAL_WIN))
    if tau is not None and tau < 0:
        concerns.append("the two scorings rank candidates oppositely "
                        "(tau %.2f): whichever you judged by decided the "
                        "winner, and the other would have chosen differently"
                        % tau)
    if judge_by == "physical":
        if held and len(held) < 4:
            concerns.append("judged on %d confirmed line%s: one line either way "
                            "moves the score more than most of these settings do"
                            % (len(held), "" if len(held) == 1 else "s"))
        if len(photos) < 2:
            concerns.append("every judging line is from %s, so the winner is "
                            "the one that reads that capture's light and angle"
                            % (photos[0] if photos else "one photograph"))
    if len(wins) == len(rows) - 1 and len(rows) > 2:
        concerns.append("every round beat the one before it, which is more "
                        "often a judge that drifts than a search that works")

    return jsonify(
        judge_by=judge_by, baseline=st.get("baseline"),
        tune_baseline=st.get("tune_baseline"), why=st.get("why"),
        rounds=len(rows) - 1, wins=len(wins),
        baseline_score=baseline, best_score=best,
        gained=None if best is None or baseline is None
               else round(best - baseline, 4),
        spread=spread, win_margins=margins,
        agreement=tau, judged_on_lines=len(held), judged_on_photos=photos,
        pages=st.get("pages"), rows=rows, concerns=concerns)


@app.get("/autotrain/runs")
def autotrain_runs():
    """Every search kept, newest first."""
    try:
        return jsonify(runs=auto.kept(), now=auto.state().get("id"))
    except Exception as err:
        return jsonify(error=str(err))


@app.get("/autotrain/run")
def autotrain_run():
    """One search, whole, as it was written down while it ran."""
    try:
        return jsonify(**auto.one(request.args.get("id", "")))
    except Exception as err:
        return jsonify(error=str(err))


@app.get("/autotrain")
def autotrain_state():
    return jsonify(**auto.state())


@app.post("/autotrain/stop")
def autotrain_stop():
    return jsonify(**auto.stop())


@app.get("/compare")
def compare():
    """Any number of models over one page of type, refereed by the spelling.

    Two was a special case that had grown a shape of its own -- an "older" and
    a "newer" and a table with two columns in it. Three models is a perfectly
    ordinary question to have, especially once some are fine-tuned and some
    are not, and there was no reason beyond the code for it to be unaskable.
    """
    try:
        who = wanted_models(request.args)
        if len(who) < 1:
            return jsonify(error="choose at least one model")
        n = request.args.get("page", 200, type=int)
        ink = bgr(request.args.get("ink"), (30, 30, 30))
        mark = bgr(request.args.get("mark"), (40, 40, 230))
        only = request.args.get("only") == "1"

        reports = {m: page_report(n, m) for m in who}
        # every word any two of them read differently
        seen = {}
        for m in who:
            for l in read(n, m):
                for w in l["words"]:
                    if not w["marker"]:
                        seen.setdefault(w["code"], {})[m] = w
        differs = []
        for code, by in seen.items():
            counts = {m: by[m]["found"] for m in who if m in by}
            if len(set(counts.values())) < 2:
                continue
            any_w = next(iter(by.values()))
            best = min(counts, key=lambda m: abs(counts[m] - any_w["spelled"]))
            differs.append({"code": code, "text": any_w["text"],
                            "spelled": any_w["spelled"],
                            "found": counts, "closer": best})
        differs.sort(key=lambda d: -(max(d["found"].values()) - min(d["found"].values())))
        boxes = {d["code"] for d in differs} if only else None

        wide = 1400 if len(who) == 1 else max(420, int(1200 / len(who)))
        out = {}
        for m in who:
            img, _, _, _ = sheet_of(n, m, ink, mark, width=wide, boxes=boxes)
            out[m] = dict(reports[m], img=png(img))
        return jsonify(page=n, models=who, rows=out, differs=differs[:80],
                       same=len(seen) - len(differs), on="type")
    except FileNotFoundError as err:
        return jsonify(error=str(err))
    except Exception:
        return jsonify(error=traceback.format_exc()[-2000:])


if __name__ == "__main__":
    PORT = int(os.environ.get("PORT", 5000))
    quiet = "--no-browser" in sys.argv or os.environ.get("NO_BROWSER")
    if not quiet and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        threading.Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:%d/" % PORT)).start()

    # Reload when the code changes, so a change to a .py file does not have to
    # be followed by going and restarting this. It was, over and over, and the
    # symptom of forgetting is never "restart me" -- it is a column that came
    # back empty from a route that did not have that field yet.
    #
    # The cost is real and worth knowing: a reload kills whatever is training.
    # Every job writes its state to disk as it goes, so what happened is still
    # on record, and --no-reload turns it off for a long run.
    reload = "--no-reload" not in sys.argv
    print("QCF check on http://127.0.0.1:%d/  (ctrl-c to stop)%s"
          % (PORT, "" if reload else "  [reload off]"))
    app.run(debug=False, port=PORT, threaded=True, use_reloader=reload)
