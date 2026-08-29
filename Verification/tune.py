"""
Fine-tuning: teaching a model trained on type what a press and a camera do.

The model is taught twice, and the two lessons are not the same lesson.

The first is the one it has had until now. There are a hundred and twenty
labelled words and no more, but every one of them can be fused, turned, resized
and thickened into a question that has never been asked before, so the supply
is unlimited and none of it is real. That teaches the shape of a mark -- what a
fatha is, where a shadda sits, how a mark differs from the stroke it lands on.
Shape is the hard part and synthetic data is enough for it.

The second is what synthetic data cannot give, because it is not a property of
the shape at all. Paper is not white and ink is not black; a press bleeds and a
camera softens; a page is never quite flat and never quite square to the lens;
the threshold that turns a photograph into ink breaks a stroke here and welds
two there. No amount of drawing bridges between glyphs invents that, and a
model that has only ever seen the outlines is being asked to generalise across
a gap it has no information about.

So a few real lines are labelled by hand and the model is nudged -- not
retrained -- towards them:

  * from the pretrained weights, never from scratch. A hundred real lines
    cannot teach a net what a mark is; they can only adjust one that already
    knows.

  * at a hundredth of the learning rate, and with no cycle. Training proper
    ramps up and back down to travel a long way; this is meant to travel a
    short one, and a large step here does not adapt the model, it overwrites
    it with a hundred lines' worth of opinion.

  * mixed with synthetic crops in every batch. A net fine-tuned on the real
    set alone forgets the type it was taught on within a few hundred steps --
    it is the oldest failure in the technique and the cheapest to avoid.

  * with the normalisation frozen. Batch-norm keeps a running mean and
    variance of what it has seen, and letting sixteen crops of one photograph
    rewrite statistics gathered over fourteen thousand is how a fine-tune that
    looks fine at every step comes out worse than it went in.
"""

import io
import json
import os
import time

import cv2
import numpy as np
import torch

import bands
import label
import models
import unet

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "real.json")

# A line of a photograph, confirmed by a person, is the unit here -- not a
# whole page. Fifteen lines is a page and a page is more than anyone will read
# blob by blob in one sitting, and the sitting is what gets the labels honest.
LEAST = 20             # ink smaller than this is not offered for labelling

# What a person can say about one piece of ink. The third one is the point of
# the other two being trustworthy: a mark drawn touching the letter beneath it
# is a single piece of ink that is honestly both, and forcing a choice there
# would teach the model that a welded mark is a letter -- which is the one
# case the whole exercise exists to get right. Skipped ink is shown, and then
# left out of the loss entirely. The synthetic set, which is built by welding
# marks on purpose and so knows the answer underneath, keeps teaching that.
LETTER, MARK, SKIP = 0, 1, 2


def load():
    try:
        with io.open(STORE, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def save(store):
    with io.open(STORE, "w", encoding="utf-8") as fh:
        json.dump(store, fh, indent=1)


def key(file, detail, line):
    return "%s|%d|%d" % (file, int(detail), int(line))


def parts(k):
    file, detail, line = k.rsplit("|", 2)
    return file, int(detail), int(line)


def summary():
    store = load()
    blobs = sum(len(v.get("blobs", {})) for v in store.values())
    tally = {LETTER: 0, MARK: 0, SKIP: 0}
    for v in store.values():
        for c in v.get("blobs", {}).values():
            tally[int(c)] = tally.get(int(c), 0) + 1
    return {"lines": len(store), "photos": len({parts(k)[0] for k in store}),
            "blobs": blobs, "marks": tally[MARK], "letters": tally[LETTER],
            "skipped": tally[SKIP]}


# --------------------------------------------------------------------------
# turning the confirmed lines back into something to train on


_BUILT = {}
_ORDER = []
MOST_KEPT = 40         # a strip is a couple of megabytes; forty is plenty


def rebuild(k, photos):
    """One confirmed line as (ink, truth, judged), as it was when labelled.

    Nothing about the strip is stored -- only which blob was which. It is cut
    out of the photograph again from the same file at the same detail, which
    gives the same pixels, which gives the same blobs in the same order.
    """
    if k in _BUILT:
        return _BUILT[k]
    file, detail, line = parts(k)
    path = os.path.join(photos, os.path.basename(file))
    _, mask, lines, factor, tall = bands.cut(path, detail)
    if line >= len(lines):
        raise ValueError("%s no longer has a line %d" % (file, line))
    big, _, _ = bands.strip(mask, lines, line, factor, tall)
    lab, st, keep = bands.pieces(big, LEAST)

    classes = load()[k]["blobs"]
    truth = np.zeros(big.shape, np.uint8)
    judged = np.zeros(big.shape, bool)
    for i in keep:
        c = int(classes.get(str(i), LETTER))
        sel = (lab == i)
        if c == SKIP:
            continue                     # shown, never scored
        judged |= sel
        if c == MARK:
            truth[sel] = 1
    _BUILT[k] = (big, truth, judged)
    _ORDER.append(k)
    while len(_ORDER) > MOST_KEPT:
        _BUILT.pop(_ORDER.pop(0), None)
    return _BUILT[k]


def real_crops(keys, photos, rng, n, size=unet.CROP, rotate=0.0, scale=0.0):
    """n squares cut out of the confirmed lines, with the classes they carry.

    Barely augmented, and deliberately. The photograph already has the noise,
    the bleed and the broken strokes in it -- that is the entire reason it is
    here -- and piling the synthetic distortions on top would drown the one
    real signal in this set under the same imitations the model has already
    had fourteen thousand of. A little turning is allowed because the page was
    held at one angle to the lens and that angle should not be learned.
    """
    xs, ys, ws = [], [], []
    guard = 0
    while len(xs) < n and guard < n * 40:
        guard += 1
        k = keys[rng.integers(len(keys))]
        try:
            ink, truth, judged = rebuild(k, photos)
        except Exception:
            continue
        if rotate or scale:
            ink, truth, judged = augment_all(ink, truth, judged, rng, rotate, scale)
        h, w = ink.shape
        if h < 8 or w < 8:
            continue
        pad = lambda a: np.pad(a, ((0, max(0, size - h)), (0, max(0, size - w))))
        ink, truth, judged = pad(ink), pad(truth), pad(judged)
        h, w = ink.shape
        y = int(rng.integers(0, max(1, h - size + 1)))
        x = int(rng.integers(0, max(1, w - size + 1)))
        ci = ink[y:y + size, x:x + size]
        ct = truth[y:y + size, x:x + size]
        cj = judged[y:y + size, x:x + size] & (ci > 0)
        # a crop is scored on judged ink only, so one with none in it
        # contributes nothing to the loss and is not worth a forward pass
        if cj.sum() < 40:
            continue
        if (ct & cj).sum() < 8 and rng.random() < 0.7:
            continue
        xs.append(ci.astype(np.float32))
        ys.append((ct & cj).astype(np.float32))
        ws.append(cj.astype(np.float32))
    if not xs:
        raise ValueError("no usable crops in the confirmed lines - the ink in "
                         "them may all be marked skip")
    t = lambda a: torch.from_numpy(np.stack(a)).unsqueeze(1)
    return t(xs), t(ys), t(ws)


def augment_all(ink, truth, judged, rng, rotate, scale):
    """Turn and resize a strip, taking both its answers with it.

    Every one of the three moves by the same matrix and by nearest neighbour --
    the ink, which pixel is a mark, and which pixel anyone actually vouched
    for. Interpolating any of them would smear the classes into each other
    along every edge, and smearing the third would quietly start scoring the
    model on ink that was deliberately set aside.
    """
    h, w = ink.shape
    f = 1.0 + (rng.uniform(-scale, scale) if scale > 0 else 0.0)
    a = rng.uniform(-rotate, rotate) if rotate > 0 else 0.0
    m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), a, f)
    move = lambda x: cv2.warpAffine(x.astype(np.uint8), m, (w, h),
                                    flags=cv2.INTER_NEAREST, borderValue=0)
    return move(ink), move(truth), move(judged).astype(bool)


def freeze_norm(net):
    """Keep the running statistics as they were learned on the type.

    Not the weights -- those still move. Only the mean and variance the layer
    normalises by, which were gathered over the whole synthetic set and are a
    better estimate than sixteen crops of one page can give.
    """
    for m in net.modules():
        if isinstance(m, torch.nn.BatchNorm2d):
            m.eval()


# --------------------------------------------------------------------------


def run(base, syn_store, photos, steps=300, batch=16, lr=1e-5,
        real_share=0.7, rotate=2.0, scale=0.05, seed=0, name=None,
        on_step=None):
    """Nudge a trained model towards the photographs. Returns (net, name)."""
    store = load()
    keys = sorted(store)
    if len(keys) < 3:
        raise ValueError("only %d line%s confirmed - label a few more first"
                         % (len(keys), "" if len(keys) == 1 else "s"))
    rng = np.random.default_rng(seed)
    torch.manual_seed(seed)

    net = unet.UNet()
    net.load_state_dict(torch.load(models.path(base), map_location="cpu"))
    net.train()
    freeze_norm(net)
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=1e-4)

    nr = max(1, min(batch - 1, int(round(batch * real_share))))
    t0 = time.time()
    for i in range(steps):
        xr, yr, wr = real_crops(keys, photos, rng, nr, rotate=rotate, scale=scale)
        xs, ys = unet.crops(syn_store, rng, batch - nr)
        # the synthetic crops are scored over all their ink; the real ones only
        # over the ink a person actually vouched for
        x = torch.cat([xr, xs]); y = torch.cat([yr, ys]); w = torch.cat([wr, xs])
        loss = unet.masked_loss(net(x), y, w)
        opt.zero_grad(); loss.backward(); opt.step()
        if on_step and (i + 1) % 10 == 0:
            on_step(i + 1, steps, float(loss), time.time() - t0)
        if (i + 1) % 25 == 0:
            print("  step %4d/%d  loss %.4f  (%.0fs)"
                  % (i + 1, steps, float(loss), time.time() - t0), flush=True)

    name = name or models.next_name()
    net.eval()
    torch.save(net.state_dict(), models.path(name))
    s = summary()
    models.record(name, words=len(syn_store), steps=steps,
                  tuned_from=base, real_lines=s["lines"], lr=lr,
                  real_share=real_share,
                  note="fine-tuned from %s on %d real line%s from %d photograph%s "
                       "(%d of every %d crops real, lr %g)"
                       % (base, s["lines"], "" if s["lines"] == 1 else "s",
                          s["photos"], "" if s["photos"] == 1 else "s",
                          nr, batch, lr))
    return net, name
