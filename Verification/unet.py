"""
A small U-Net that separates marks from letters, pixel by pixel.

It reads nothing but ink. The input is the binary image the woff2 draws, and
the output is one number per pixel: does this pixel belong to a mark. The
Unicode never reaches it -- that is used to choose words worth labelling and
to check the labels afterwards, and it stops there. A model told the answer in
words would learn to read the answer instead of the picture.

Trained on crops rather than whole words, for two reasons. A word is whatever
width it happens to be, and squeezing them all to one size would teach the net
that a fatha is a certain number of pixels across when it is really a certain
fraction of an em. And a net built only of convolutions does not care what size
its input is, so it can be trained on small squares and then run over a whole
line at once.

The loss counts ink only. Nine tenths of any crop is blank paper, and a model
scored on that gets a fine result by calling everything background.

    python unet.py train
    python unet.py check
"""

import json
import io
import os
import sys
import time

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import augment
import label

import models

HERE = os.path.dirname(os.path.abspath(__file__))
CROP = 128

# About twice a line of type. Beyond this a single forward pass needs more
# memory than a laptop has, and asking for it hangs the machine rather than
# raising anything.
MOST_PIXELS = 3_000_000

# Torch's own choice of thread count is left alone. Forcing it was tried and
# measured across 4, 6, 8, 10 and 12 threads: 3.8s, 3.9s, 4.9s, 7.9s, 4.1s --
# no trend, just noise on a machine doing other things. A number picked out of
# that would be superstition.


class UNet(nn.Module):
    """Three steps down, three back up, with the skips that give it its name."""

    def __init__(self, width=16):
        super().__init__()
        def block(a, b):
            return nn.Sequential(
                nn.Conv2d(a, b, 3, padding=1), nn.BatchNorm2d(b), nn.ReLU(inplace=True),
                nn.Conv2d(b, b, 3, padding=1), nn.BatchNorm2d(b), nn.ReLU(inplace=True))
        w = width
        self.d1, self.d2, self.d3 = block(1, w), block(w, w * 2), block(w * 2, w * 4)
        self.mid = block(w * 4, w * 8)
        self.u3, self.u2, self.u1 = block(w * 12, w * 4), block(w * 6, w * 2), block(w * 3, w)
        self.out = nn.Conv2d(w, 1, 1)
        self.pool = nn.MaxPool2d(2)

    def forward(self, x):
        c1 = self.d1(x)
        c2 = self.d2(self.pool(c1))
        c3 = self.d3(self.pool(c2))
        m = self.mid(self.pool(c3))
        u = lambda t, s: F.interpolate(t, size=s.shape[-2:], mode="nearest")
        x = self.u3(torch.cat([u(m, c3), c3], 1))
        x = self.u2(torch.cat([u(x, c2), c2], 1))
        x = self.u1(torch.cat([u(x, c1), c1], 1))
        return self.out(x)


def crops(store, rng, n, size=CROP, jitter=None):
    """n random squares of fused word, each with the mask it really has.

    A crop is kept only if it holds some ink and some mark, or the batch fills
    up with blank paper and the net learns nothing from it.
    """
    xs, ys = [], []
    guard = 0
    while len(xs) < n and guard < n * 60:
        guard += 1
        ink, truth, _ = augment.sample(store, rng, **(jitter or {}))
        h, w = ink.shape
        if h < 8 or w < 8:
            continue
        pad = lambda a: np.pad(a, ((0, max(0, size - h)), (0, max(0, size - w))))
        ink, truth = pad(ink), pad(truth)
        h, w = ink.shape
        y = int(rng.integers(0, max(1, h - size + 1)))
        x = int(rng.integers(0, max(1, w - size + 1)))
        ci = ink[y:y + size, x:x + size]
        ct = truth[y:y + size, x:x + size]
        if ci.sum() < 40:
            continue
        mark = ((ct != label.LETTER) & (ci > 0)).sum()
        if mark < 8 and rng.random() < 0.7:
            continue                      # keep a few letter-only crops, not many
        xs.append(ci.astype(np.float32))
        ys.append(((ct != label.LETTER) & (ci > 0)).astype(np.float32))
    x = torch.from_numpy(np.stack(xs)).unsqueeze(1)
    y = torch.from_numpy(np.stack(ys)).unsqueeze(1)
    return x, y


def masked_loss(logit, target, ink):
    """Binary cross-entropy over the ink, and nothing else."""
    per = F.binary_cross_entropy_with_logits(logit, target, reduction="none")
    return (per * ink).sum() / ink.sum().clamp(min=1)


def train(store, steps=900, batch=16, lr=2e-3, seed=0, name=None,
          on_step=None, jitter=None, width=16, decay=1e-4, hold_out=0.0,
          on_score=None, should_stop=None):
    """Train from nothing on the labelled words.

    width is the net's first-layer channel count and everything else scales
    from it, so it is the one number that changes how much the model can hold:
    16 is 488k parameters. Larger is not obviously better here -- there are a
    hundred-odd labelled words behind an unlimited supply of variations on
    them, and past some size the model starts learning the variations.

    hold_out keeps a share of the words out of the training entirely and
    scores against them at the end. It costs those words, which is a real
    price when there are so few, but a score on words the model was taught is
    not a score at all.
    """
    keys = sorted(store)
    kept = {}
    if hold_out > 0 and len(keys) > 20:
        pick = np.random.default_rng(seed).permutation(len(keys))
        n = max(4, int(len(keys) * hold_out))
        kept = {keys[i]: store[keys[i]] for i in pick[:n]}
        store = {keys[i]: store[keys[i]] for i in pick[n:]}
    rng = np.random.default_rng(seed)
    torch.manual_seed(seed)
    net = UNet(width)
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=decay)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, lr, steps)
    net.train()
    t0 = time.time()
    drawn0 = augment.DRAWN
    done = steps
    for i in range(steps):
        x, y = crops(store, rng, batch, jitter=jitter)
        logit = net(x)
        loss = masked_loss(logit, y, x)
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        if on_step and (i + 1) % 5 == 0:
            on_step(i + 1, steps, float(loss), time.time() - t0)
        if (i + 1) % 50 == 0:
            print("  step %4d/%d  loss %.4f  (%.0fs)" % (i + 1, steps, float(loss),
                                                         time.time() - t0), flush=True)
        # Stopped part way, the model is saved as it stands. Half an hour of
        # arithmetic that produces nothing because someone changed their mind
        # about the last ten minutes of it is half an hour thrown away, and the
        # weights at step 600 of 900 are a real model -- undertrained, and
        # its card says so.
        if should_stop and should_stop():
            done = i + 1
            break
    name = name or models.next_name()
    torch.save(net.state_dict(), models.path(name))
    shaken = ", ".join("%s %g" % (k, v) for k, v in sorted((jitter or {}).items()) if v)
    made = augment.DRAWN - drawn0
    held = {}
    if kept:
        iou, acc = score(net, kept, np.random.default_rng(seed + 11))
        held = {"words": len(kept), "mark pixels found (IoU)": round(iou, 4),
                "ink labelled right": round(acc, 4)}
        if on_score:
            on_score(held)
    models.record(name, words=len(store), steps=done, jitter=jitter or {},
                  crops=done * batch, drawn=made, batch=batch, lr=lr,
                  width=width, decay=decay, seed=seed, held_out=held or None,
                  asked_for=steps, stopped=done < steps,
                  note="%s synthetic crops from %d labelled words%s%s%s"
                       % ("{:,}".format(done * batch), len(store),
                          "; stopped at %d of %d steps" % (done, steps)
                          if done < steps else "",
                          "; shaken by " + shaken if shaken else "",
                          "; %.1f%% right on %d held-out words"
                          % (100 * held["ink labelled right"], held["words"])
                          if held else ""))
    return net, name


_LOADED = {}


def load(name=None):
    """A model by name, or the newest one. Kept, since a page asks repeatedly."""
    name = name or (models.names() or [None])[0]
    if name is None:
        raise FileNotFoundError("no model has been trained yet")
    if name not in _LOADED:
        net = UNet()
        net.load_state_dict(torch.load(models.path(name), map_location="cpu"))
        net.eval()
        _LOADED[name] = net
    return _LOADED[name]


@torch.inference_mode()
def marks_of(net, ink, pad=16):
    """Which pixels of a word are a mark. Whole word at once, any size.

    The blank rows above and below the ink are dropped before the convolution
    and put back after. A line's canvas is a sixth empty, and that sixth costs
    exactly what the type costs: 7.6s becomes 6.1s.

    Anything much larger than a line is refused rather than attempted. The net
    holds sixteen channels at full resolution on the way down and keeps them
    for the way back up, so the memory it needs grows with the area of what it
    is given: a line of type is 1.2 MP and fits easily, while a whole page of
    photograph is 20 MP and wants some fifteen gigabytes. Asking for that does
    not fail cleanly -- the machine swaps and stops responding. Whatever is too
    big must be cut into pieces by the caller, which knows where the seams are.
    """
    if ink.size > MOST_PIXELS:
        raise ValueError(
            "%.1f MP is too much for one pass (the limit is %.1f MP, about a "
            "line of type). Cut it into strips and read those."
            % (ink.size / 1e6, MOST_PIXELS / 1e6))
    rows = np.nonzero((ink > 0).any(1))[0]
    if not len(rows):
        return np.zeros(ink.shape, np.float32)
    top, bot = int(rows.min()), int(rows.max()) + 1
    band = ink[top:bot]

    a = np.pad(band.astype(np.float32), pad)
    h, w = a.shape
    H, W = (h + 15) // 16 * 16, (w + 15) // 16 * 16
    a = np.pad(a, ((0, H - h), (0, W - w)))
    p = torch.sigmoid(net(torch.from_numpy(a)[None, None]))[0, 0].numpy()
    out = np.zeros(ink.shape, np.float32)
    out[top:bot] = p[pad:pad + band.shape[0], pad:pad + band.shape[1]]
    return out


@torch.no_grad()
def score(net, store, rng, n=250):
    """Agreement on words the training never saw, over ink pixels only."""
    net.eval()
    inter = union = right = total = 0
    for _ in range(n):
        ink, truth, _ = augment.sample(store, rng)
        p = marks_of(net, ink) > 0.5
        want = (truth != label.LETTER) & (ink > 0)
        got = p & (ink > 0)
        inter += int((got & want).sum()); union += int((got | want).sum())
        right += int((got == want)[ink > 0].sum()); total += int((ink > 0).sum())
    return inter / max(1, union), right / max(1, total)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "train"
    store = json.load(io.open(os.path.join(HERE, "labels.json"), encoding="utf-8"))
    keys = sorted(store)
    rng0 = np.random.default_rng(7)
    held = set(rng0.choice(len(keys), size=max(8, len(keys) // 5), replace=False).tolist())
    tr = {k: v for i, k in enumerate(keys) if i not in held for v in [store[k]]}
    va = {k: store[k] for i, k in enumerate(keys) if i in held}
    print("%d words to train on, %d held out" % (len(tr), len(va)))
    net = train(tr)[0] if cmd == "train" else load()
    iou, acc = score(net, va, np.random.default_rng(11))
    print("\nheld-out words:")
    print("  mark pixels found (IoU) : %.3f" % iou)
    print("  ink pixels labelled right: %.1f%%" % (100 * acc))
