"""
Training on its own: try a variation on the best model, keep it if it wins.

The loop is the one anybody would do by hand -- take the settings that gave the
best model, change one or two of them a little, train, score, keep the winner
-- run without the hand. What makes it worth automating is that each round
takes a quarter of an hour and the interesting part takes ten seconds, so a
person doing it spends a day waiting and stops early.

On how a candidate is judged, and why it is not K-fold.

K-fold is the right instinct: never grade a model on what it was taught. But a
fold here means a whole training run, so five-fold cross-validation costs five
models -- over an hour -- to produce one number about a hundred-odd labelled
words.

There is a better test already built, and it is bigger and cheaper both. The
Uthmani spelling says how many marks each word carries. It never reaches the
model -- the net sees ink and nothing else -- so it is a genuinely outside
opinion, and it covers every word of all six hundred and four pages rather than
the hundred that happen to be labelled. A candidate is trained once and scored
on pages it has never seen, which is what cross-validation was wanted for.

The labelled words still get a look in: a share of them is held back from every
run and scored at the end, so each candidate carries two numbers that were both
measured on things it was not shown. They disagree sometimes, and when they do
that is worth knowing rather than averaging away.

What it will not do:

  * accept a candidate on a tie. A model kept for a difference smaller than the
    noise between two runs is a model kept by accident, and the next round then
    varies from a worse starting point.

  * keep the losers. A checkpoint is two megabytes and a search makes dozens.
    Only models that beat the baseline are written down; the rest are trained,
    scored, and thrown away, which is what they are for.

  * run on labels nobody has checked. The whole thing rests on the labels being
    right, and a search that optimises against bad labels will find settings
    that fit them beautifully.
"""

import json
import os
import random
import threading
import time

import label
import models
import unet

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "autotrain.json")

# How much a setting may move in one round. Small on purpose: the point is to
# walk away from a good model in short steps, not to restart the search
# somewhere else each time.
NUDGE = {
    "steps":   lambda r, v: int(max(200, min(4000, v * r.uniform(0.7, 1.45)))),
    "lr":      lambda r, v: float(max(2e-4, min(1e-2, v * r.uniform(0.6, 1.7)))),
    "width":   lambda r, v: int(max(8, min(32, v + r.choice([-4, 0, 4])))),
    "batch":   lambda r, v: int(max(4, min(48, v + r.choice([-4, 0, 4, 8])))),
    "decay":   lambda r, v: float(max(0.0, min(1e-2, v * r.uniform(0.5, 2.0)))),
    "scale":   lambda r, v: round(max(0.0, min(0.4, v + r.uniform(-0.06, 0.06))), 3),
    "rotate":  lambda r, v: round(max(0.0, min(10.0, v + r.uniform(-1.5, 1.5))), 2),
    "spread":  lambda r, v: round(max(0.0, min(1.0, v + r.uniform(-0.15, 0.15))), 2),
}

# Two at a time. One is a slow walk; everything at once is a different model
# each round and nothing is learned about which change did the good.
CHANGES_PER_ROUND = 2

# A win has to be worth more than the difference between two runs of the same
# settings with different seeds. Half a point of agreement is about that.
REAL_WIN = 0.005


# Fine-tuning has its own knobs, and they move differently: the learning rate
# is already a hundredth of the trainer's and is the last thing you want to
# wander far, while how much of each batch is real is the whole question.
TUNE_NUDGE = {
    "steps":      lambda r, v: int(max(50, min(2000, v * r.uniform(0.7, 1.5)))),
    "lr":         lambda r, v: float(max(1e-6, min(1e-4, v * r.uniform(0.6, 1.7)))),
    "batch":      lambda r, v: int(max(4, min(48, v + r.choice([-4, 0, 4, 8])))),
    "real_share": lambda r, v: round(max(0.2, min(0.9, v + r.uniform(-0.15, 0.15))), 2),
    "rotate":     lambda r, v: round(max(0.0, min(6.0, v + r.uniform(-1.0, 1.0))), 2),
    "scale":      lambda r, v: round(max(0.0, min(0.2, v + r.uniform(-0.03, 0.03))), 3),
}


def tune_settings_of(name):
    """The fine-tuning settings a model was made with, plus the defaults."""
    c = models.describe(name)
    return {
        "steps": c.get("steps") or 300,
        "lr": c.get("lr") or 1e-5,
        "batch": c.get("batch") or 16,
        "real_share": c.get("real_share") or 0.7,
        "rotate": c.get("rotate") if c.get("rotate") is not None else 2.0,
        "scale": c.get("scale") if c.get("scale") is not None else 0.05,
    }


def settings_of(name):
    """The settings a model was trained with, filled out with the defaults."""
    card = models.describe(name)
    j = card.get("jitter") or {}
    return {
        "steps": card.get("steps") or 900,
        "lr": card.get("lr") or 2e-3,
        "width": card.get("width") or 16,
        "batch": card.get("batch") or 16,
        "decay": card.get("decay") or 1e-4,
        "scale": float(j.get("scale") or 0.0),
        "rotate": float(j.get("rotate") or 0.0),
        "spread": float(j.get("spread") or 0.0),
    }


def vary(base, rng, table=None):
    """One candidate: the baseline with a couple of settings nudged."""
    table = table or NUDGE
    out = dict(base)
    for key in rng.sample(sorted(table), CHANGES_PER_ROUND):
        out[key] = table[key](rng, out[key])
    return out


def what_changed(base, cand):
    bits = []
    for k in sorted(cand):
        if cand[k] != base[k]:
            bits.append("%s %g→%g" % (k, base[k], cand[k]))
    return ", ".join(bits) or "nothing"


# --------------------------------------------------------------------------


_RUN = {"going": False}


def state():
    return dict(_RUN)


def stop():
    _RUN["going"] = False
    return state()


def _save():
    try:
        with open(STATE, "w", encoding="utf-8") as fh:
            json.dump(_RUN, fh, indent=1)
    except Exception:
        pass


def split_lines(keys, seed=3, held=0.34):
    """Confirmed lines split into what fine-tunes and what judges.

    The held-back lines are the whole point. A model fine-tuned on every
    confirmed line and then scored on those same lines will look better every
    round and mean nothing by the end -- which is the failure the search is
    most likely to walk into, because it is the one that rewards it.
    """
    keys = sorted(keys)
    rng = random.Random(seed)
    rng.shuffle(keys)
    n = max(2, int(round(len(keys) * held)))
    return sorted(keys[n:]), sorted(keys[:n])


def start(judge, pages, rounds=8, patience=4, seed=None, on_done=None):
    """Run the search in the background. judge(name, pages) -> a score.

    judge is handed in rather than imported so this module knows nothing about
    routes, page reports or the spelling -- it only knows that a bigger number
    is better.
    """
    store = label.load()
    if len(store) < 40:
        raise ValueError("only %d words labelled: a search would be fitting "
                         "settings to a handful of examples" % len(store))
    if not models.names():
        raise ValueError("train one model by hand first, to start from")
    if _RUN.get("going"):
        raise ValueError("a search is already running")

    base_name = (models.best_at("digital") or models.names()[0])
    rng = random.Random(seed)

    _RUN.clear()
    _RUN.update({
        "going": True, "round": 0, "rounds": rounds, "patience": patience,
        "baseline": base_name, "best": None, "since": 0,
        "started": time.strftime("%Y-%m-%d %H:%M"), "pages": pages,
        "log": [], "note": "scoring the model we are starting from",
    })

    def run():
        try:
            base = settings_of(base_name)
            best_score = judge(base_name, pages)
            _RUN["best"] = {"name": base_name, "score": best_score,
                            "settings": base}
            _RUN["log"].append({"name": base_name, "score": best_score,
                                "changed": "the model we started from",
                                "kept": True})
            _save()

            while _RUN["going"] and _RUN["round"] < rounds and _RUN["since"] < patience:
                _RUN["round"] += 1
                cand = vary(_RUN["best"]["settings"], rng)
                changed = what_changed(_RUN["best"]["settings"], cand)
                _RUN["note"] = "round %d: training with %s" % (_RUN["round"], changed)
                _save()

                jitter = {k: cand[k] for k in ("scale", "rotate", "spread")}
                net, name = unet.train(
                    store, steps=cand["steps"], batch=cand["batch"],
                    lr=cand["lr"], width=cand["width"], decay=cand["decay"],
                    jitter=jitter, seed=rng.randrange(10000), hold_out=0.15)
                unet._LOADED[name] = net

                _RUN["note"] = "round %d: scoring %s" % (_RUN["round"], name)
                _save()
                score = judge(name, pages)
                won = score > _RUN["best"]["score"] + REAL_WIN
                _RUN["log"].append({"name": name, "score": score,
                                    "changed": changed, "kept": won})

                if won:
                    _RUN["best"] = {"name": name, "score": score, "settings": cand}
                    _RUN["since"] = 0
                    models.set_best(name, "digital", True)
                else:
                    # trained, scored, and no better: two megabytes of nothing
                    unet._LOADED.pop(name, None)
                    models.forget(name)
                    _RUN["since"] += 1
                _save()

            _RUN["note"] = ("stopped" if not _RUN["going"] else
                            "no better in %d rounds" % patience
                            if _RUN["since"] >= patience else "done")
        except Exception as err:
            _RUN["note"] = "stopped: %s" % err
        finally:
            _RUN["going"] = False
            _save()
            if on_done:
                on_done(state())

    threading.Thread(target=run, daemon=True).start()
    return state()


# --------------------------------------------------------------------------


def start_physical(judge, train_keys, judge_keys, make, rounds=8, patience=4,
                   seed=None, on_done=None):
    """The same loop over fine-tuning settings, judged on lines held back.

    make(settings, keys) trains a candidate and returns its name; judge(name)
    scores it. Both are handed in for the same reason as before: this knows
    that a bigger number is better and nothing else.
    """
    if _RUN.get("going"):
        raise ValueError("a search is already running")
    base_name = models.best_at("real")
    if not base_name:
        tuned = [n for n in models.names() if models.describe(n).get("tuned_from")]
        base_name = tuned[0] if tuned else None
    if not base_name:
        raise ValueError("fine-tune one model by hand first, to start from")

    rng = random.Random(seed)
    _RUN.clear()
    _RUN.update({
        "going": True, "round": 0, "rounds": rounds, "patience": patience,
        "baseline": base_name, "best": None, "since": 0, "kind": "physical",
        "started": time.strftime("%Y-%m-%d %H:%M"),
        "trains_on": len(train_keys), "judges_on": len(judge_keys),
        "log": [], "note": "scoring the model we are starting from",
    })

    def run():
        try:
            base = tune_settings_of(base_name)
            best_score = judge(base_name)
            _RUN["best"] = {"name": base_name, "score": best_score, "settings": base}
            _RUN["log"].append({"name": base_name, "score": best_score,
                                "changed": "the model we started from", "kept": True})
            _save()

            while _RUN["going"] and _RUN["round"] < rounds and _RUN["since"] < patience:
                _RUN["round"] += 1
                cand = vary(_RUN["best"]["settings"], rng, TUNE_NUDGE)
                changed = what_changed(_RUN["best"]["settings"], cand)
                _RUN["note"] = "round %d: fine-tuning with %s" % (_RUN["round"], changed)
                _save()

                name = make(cand, train_keys, rng.randrange(10000))
                _RUN["note"] = "round %d: scoring %s" % (_RUN["round"], name)
                _save()
                score = judge(name)
                won = score > _RUN["best"]["score"] + REAL_WIN
                _RUN["log"].append({"name": name, "score": score,
                                    "changed": changed, "kept": won})
                if won:
                    _RUN["best"] = {"name": name, "score": score, "settings": cand}
                    _RUN["since"] = 0
                    models.set_best(name, "real", True)
                else:
                    unet._LOADED.pop(name, None)
                    models.forget(name)
                    _RUN["since"] += 1
                _save()

            _RUN["note"] = ("stopped" if not _RUN["going"] else
                            "no better in %d rounds" % patience
                            if _RUN["since"] >= patience else "done")
        except Exception as err:
            _RUN["note"] = "stopped: %s" % err
        finally:
            _RUN["going"] = False
            _save()
            if on_done:
                on_done(state())

    threading.Thread(target=run, daemon=True).start()
    return state()
