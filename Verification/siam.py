"""
A second opinion, built the other way round: one blob of ink at a time.

The U-Net answers "which pixels of this word are a mark". This answers "is
this piece of ink a mark", once per connected blob, by learning an embedding
in which two marks land near each other and a mark and a letter do not. A
blob is then read by asking which of the labelled blobs it is nearest to.

WHY A BLOB AND NOT A WORD

A whole-word Siamese comparator was built here before and measured at 15% of
dropped marks caught, against 27% for the plain rules it was meant to replace.
That was arithmetic, not luck: a mark is 0.38% of its word's image while
ordinary print-versus-type variation moves 5.84% of it, so the thing being
detected is fifteen times smaller than the noise it hides in. No embedding of
a whole word can carry "is there a fatha over the third letter".

At blob level that ratio is gone. The mark fills the crop, and the question
asked of the embedding is one it can hold. This is the same technique on a
unit that suits it -- which is the whole difference from the one that failed.

WHAT IT IS SHOWN

Three channels, because ImageNet's first convolution takes three and there are
exactly three things worth saying about a blob:

    1  this blob alone
    2  every piece of ink in the window
    3  the window without this blob -- what it is sitting on

A mark is not a shape, it is a shape in a place. A dot alone is a dot; a dot
above a letter is a damma and a dot on the line is part of a jim. Channel 3 is
how the net gets to see the difference.

The crops are 64 pixels square. That is small on purpose: this runs on a CPU,
and a ResNet-18 is twenty-three times the U-Net's weights already.
"""

import os
import time

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import augment
import label
import models

CROP = 64            # pixels square, per blob
CONTEXT = 1.0        # how much of the blob's own size to keep around it
EMBED = 64           # length of the vector a blob is turned into
BANK = 600           # labelled blobs kept in the file, to read new ones against
NEAR = 5             # how many of them vote
LEAST_AREA = 12      # px; below this a blob is a speck of rendering

ARCH = "siamese resnet-18"

# ImageNet's own, because the weights were fitted with them
MEAN = np.float32([0.485, 0.456, 0.406])
STD = np.float32([0.229, 0.224, 0.225])


# ---- the net -------------------------------------------------------------

class Siamese(nn.Module):
    """ResNet-18 with its classifier replaced by a short vector.

    Pretrained, and it matters more here than it usually does: there are 1800
    labelled blobs, which is nothing like enough to learn edges and corners
    from scratch. What is being learned is the last part -- what makes these
    particular shapes alike -- on top of features somebody else paid for.
    """

    def __init__(self, embed=EMBED, pretrained=True):
        super().__init__()
        from torchvision.models import resnet18
        weights = None
        if pretrained:
            try:
                from torchvision.models import ResNet18_Weights
                weights = ResNet18_Weights.IMAGENET1K_V1
            except Exception:
                weights = None
        try:
            net = resnet18(weights=weights)
            self.pretrained = weights is not None
        except Exception as err:
            # no network, or no cache: a random start still trains, and the
            # card will say which of the two this model got
            print("  pretrained weights unavailable (%s); starting from random"
                  % err, flush=True)
            net = resnet18(weights=None)
            self.pretrained = False
        net.fc = nn.Linear(512, embed)
        self.net = net

    def forward(self, x):
        return F.normalize(self.net(x), dim=1)


# ---- what a blob looks like to it ----------------------------------------

def window(lab, i, st, context=CONTEXT):
    """The box around blob i, widened by a share of its own size."""
    x = int(st[i, cv2.CC_STAT_LEFT])
    y = int(st[i, cv2.CC_STAT_TOP])
    w = int(st[i, cv2.CC_STAT_WIDTH])
    h = int(st[i, cv2.CC_STAT_HEIGHT])
    # square, so that resizing does not stretch a dot into an oval
    side = max(w, h) * (1 + 2 * context)
    cx, cy = x + w / 2.0, y + h / 2.0
    half = side / 2.0
    return cx - half, cy - half, side


def crop_of(ink, lab, i, st, size=CROP, context=CONTEXT,
            rng=None, scale=0.0, rotate=0.0):
    """One blob as three channels: itself, everything, and everything else.

    The shake is done here rather than to the whole word, because here it is
    nearly free: a rotation of a 64-pixel crop costs microseconds and a
    rotation of a rendered line costs milliseconds a blob.
    """
    x0, y0, side = window(lab, i, st, context)
    if rng is not None and (scale or rotate):
        side *= 1.0 + float(rng.uniform(-scale, scale))
    turn = float(rng.uniform(-rotate, rotate)) if (rng is not None and rotate) else 0.0

    # one affine that takes the window to the crop, so the three channels are
    # cut in exactly the same place and the mask cannot slide off its ink
    m = cv2.getRotationMatrix2D((x0 + side / 2, y0 + side / 2), turn, size / side)
    m[0, 2] += size / 2 - (x0 + side / 2)
    m[1, 2] += size / 2 - (y0 + side / 2)

    mine = (lab == i).astype(np.float32)
    everything = (lab > 0).astype(np.float32)
    a = cv2.warpAffine(mine, m, (size, size), flags=cv2.INTER_AREA)
    b = cv2.warpAffine(everything, m, (size, size), flags=cv2.INTER_AREA)
    out = np.stack([a, b, np.clip(b - a, 0, 1)], 0)
    return (out - MEAN[:, None, None]) / STD[:, None, None]


def blobs_of(store):
    """Every labelled blob, as (page, code, blob number, what it is).

    The words are kept together in the returned order so that holding some
    back holds back whole words. Half a word in training and half in the
    scoring is a model marking its own homework with the answers beside it.
    """
    out = []
    for k in sorted(store):
        page, code = k.split("/", 1)
        ink, _, lab, st = augment.pieces(int(page), code, store[k])
        for i in range(1, st.shape[0]):
            if st[i, cv2.CC_STAT_AREA] < LEAST_AREA:
                continue
            out.append((k, int(page), code, i,
                        int(store[k].get(str(i), label.LETTER))))
    return out


def _cut(spec, rng=None, scale=0.0, rotate=0.0):
    _, page, code, i, y = spec
    ink, _, lab, st = augment.pieces(page, code, {})
    return crop_of(ink, lab, i, st, rng=rng, scale=scale, rotate=rotate), y


def batch_of(specs, rng, n, scale=0.0, rotate=0.0):
    """A batch with both classes in it, whatever the pool happens to hold."""
    marks = [s for s in specs if s[4] == label.MARK]
    letters = [s for s in specs if s[4] != label.MARK]
    half = max(1, n // 2)
    pick = ([marks[j] for j in rng.integers(len(marks), size=half)] if marks else [])
    pick += ([letters[j] for j in rng.integers(len(letters), size=n - len(pick))]
             if letters else [])
    xs, ys = [], []
    for s in pick:
        x, y = _cut(s, rng, scale, rotate)
        xs.append(x)
        ys.append(y)
    return (torch.from_numpy(np.stack(xs)),
            torch.tensor(ys, dtype=torch.long))


# ---- the loss ------------------------------------------------------------

def pair_loss(emb, y, margin=0.3):
    """Pull the same class together, push the rest apart -- every pair in the
    batch, which is where a Siamese gets its examples from cheaply.

    Cosine, because the embedding is normalised: two blobs are alike if they
    point the same way, and how long the vector is says nothing.
    """
    sim = emb @ emb.t()
    same = y[:, None] == y[None, :]
    off = ~torch.eye(len(y), dtype=torch.bool, device=sim.device)
    pos = same & off
    neg = (~same) & off
    loss = sim.new_zeros(())
    if pos.any():
        loss = loss + (1 - sim[pos]).mean()
    if neg.any():
        loss = loss + F.relu(sim[neg] - margin).mean()
    return loss


# ---- reading a blob against the ones that were labelled ------------------

@torch.inference_mode()
def embed(net, crops, chunk=64):
    out = []
    for i in range(0, len(crops), chunk):
        x = torch.from_numpy(np.stack(crops[i:i + chunk]))
        out.append(net(x).numpy())
    return np.concatenate(out) if out else np.zeros((0, EMBED), np.float32)


def vote(bank, bank_y, e, near=NEAR):
    """What the nearest labelled blobs say this one is."""
    if not len(bank):
        return np.zeros(len(e), np.uint8)
    sim = e @ bank.T
    k = min(near, bank.shape[0])
    top = np.argpartition(-sim, k - 1, axis=1)[:, :k]
    said = bank_y[top]
    return (said.mean(1) >= 0.5).astype(np.uint8)


@torch.inference_mode()
def marks_of(net, ink, least=LEAST_AREA):
    """Which pixels of an image are a mark, blob by blob.

    The same question the U-Net answers and the same shape of answer, so
    everything downstream -- the page views, Compare, the spelling judge --
    cannot tell which kind of model it is holding.
    """
    b = (np.asarray(ink) > 0).astype(np.uint8)
    out = np.zeros(b.shape, np.float32)
    if not b.any():
        return out
    n, lab, st, _ = cv2.connectedComponentsWithStats(b, 8)
    keep = [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= least]
    if not keep:
        return out
    crops = [crop_of(b, lab, i, st) for i in keep]
    said = vote(net.bank, net.bank_y, embed(net, crops))
    for i, mark in zip(keep, said):
        if mark:
            out[lab == i] = 1.0
    return out


# ---- training ------------------------------------------------------------

def train(store, steps=600, batch=32, lr=3e-4, seed=0, name=None,
          on_step=None, jitter=None, decay=1e-4, hold_out=0.0,
          on_score=None, should_stop=None, trained_from=None,
          pretrained=True, **ignored):
    """Learn an embedding of blobs from the hand labels.

    The same arguments the U-Net trainer takes, so the same form, the same
    search and the same fine-tuner can drive either of them. `width` means
    nothing here and is accepted and ignored rather than refused: a caller
    that has to know which trainer it is talking to is a caller that will get
    it wrong.
    """
    t0 = time.time()
    jitter = jitter or {}
    scale = float(jitter.get("scale") or 0.0)
    rotate = float(jitter.get("rotate") or 0.0)
    rng = np.random.default_rng(seed)
    torch.manual_seed(seed)

    keys = sorted(store)
    kept_keys = []
    if hold_out > 0 and len(keys) > 20:
        pick = np.random.default_rng(seed).permutation(len(keys))
        n = max(4, int(len(keys) * hold_out))
        kept_keys = [keys[i] for i in pick[:n]]
        keys = [keys[i] for i in pick[n:]]
    pool = blobs_of({k: store[k] for k in keys})
    held = blobs_of({k: store[k] for k in kept_keys}) if kept_keys else []
    if len(pool) < 8:
        raise ValueError("only %d labelled blobs: nothing to learn from" % len(pool))

    net = Siamese(pretrained=pretrained)
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=decay)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, lr, steps)
    net.train()
    done = steps
    for i in range(steps):
        x, y = batch_of(pool, rng, batch, scale, rotate)
        loss = pair_loss(net(x), y)
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if on_step and (i + 1) % 5 == 0:
            on_step(i + 1, steps, float(loss), time.time() - t0)
        if (i + 1) % 25 == 0:
            print("  step %4d/%d  loss %.4f  (%.0fs)" % (i + 1, steps, float(loss),
                                                         time.time() - t0), flush=True)
        if should_stop and should_stop():
            done = i + 1
            break

    net.eval()
    # The bank is part of the model. An embedding on its own answers nothing:
    # it says two blobs are alike, and something has to be the thing they are
    # compared against. Balanced, so a vote is not decided by which class
    # happened to be labelled more.
    take = rng.permutation(len(pool))
    marks = [pool[j] for j in take if pool[j][4] == label.MARK][:BANK // 2]
    letters = [pool[j] for j in take if pool[j][4] != label.MARK][:BANK // 2]
    chosen = marks + letters
    net.bank = embed(net, [_cut(s)[0] for s in chosen])
    net.bank_y = np.array([s[4] for s in chosen], np.float32)

    scored = {}
    if held:
        e = embed(net, [_cut(s)[0] for s in held])
        said = vote(net.bank, net.bank_y, e)
        truth = np.array([s[4] for s in held])
        right = float((said == truth).mean())
        found = float((said[truth == label.MARK] == label.MARK).mean()) \
            if (truth == label.MARK).any() else None
        scored = {"words": len(kept_keys), "blobs": len(held),
                  "ink labelled right": round(right, 4)}
        if found is not None:
            scored["marks found"] = round(found, 4)
        if on_score:
            on_score(scored)

    name = name or models.next_name()
    torch.save({"state": net.state_dict(), "bank": net.bank,
                "bank_y": net.bank_y, "crop": CROP, "context": CONTEXT,
                "embed": EMBED, "arch": ARCH}, models.path(name))
    shaken = ", ".join("%s %g" % (k, v) for k, v in sorted(jitter.items()) if v)
    models.record(
        name, words=len(keys), steps=done, jitter=jitter,
        arch=ARCH + ("" if net.pretrained else " (random start)"),
        seconds=int(time.time() - t0), trained_from=trained_from,
        crops=done * batch, blobs=len(pool), batch=batch, lr=lr,
        decay=decay, seed=seed, held_out=scored or None,
        pretrained=bool(net.pretrained), bank=len(chosen),
        asked_for=steps, stopped=done < steps,
        note="%s blob crops from %d labelled blobs in %d words%s%s%s"
             % ("{:,}".format(done * batch), len(pool), len(keys),
                "; stopped at %d of %d steps" % (done, steps) if done < steps else "",
                "; shaken by " + shaken if shaken else "",
                "; %.1f%% of held-out blobs read right"
                % (100 * scored["ink labelled right"]) if scored else ""))
    return net, name


def load(name):
    """A trained blob reader, weights and reference bank together."""
    blob = torch.load(models.path(name), map_location="cpu", weights_only=False)
    net = Siamese(embed=blob.get("embed", EMBED), pretrained=False)
    net.load_state_dict(blob["state"])
    net.eval()
    net.bank = np.asarray(blob["bank"], np.float32)
    net.bank_y = np.asarray(blob["bank_y"], np.float32)
    return net
