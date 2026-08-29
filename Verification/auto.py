"""
Training on its own: vary the best settings, train, score, and write it all down.

The loop is the one anybody would run by hand -- take the settings behind the
best model, change one or two, train, score, and see -- run without the hand,
because each round is a quarter of an hour of waiting and ten seconds of
interest.

WHAT A ROUND IS

A round can be the whole pipeline rather than half of it, and that is the point
of doing it this way. A digital model is not the thing you want; it is the
thing a photograph-reading model is made from. So a round can be:

    vary the settings -> train on the labelled words -> a digital model
                      -> fine-tune it on the confirmed photograph lines
                      -> a physical model

and both are scored: the digital one against the Uthmani spelling on pages
nothing was labelled on, the physical one against the confirmed lines that were
held back from its fine-tuning. Two numbers, two subjects, one round -- and you
choose which of them decides whether the round was a win.

That matters because they can disagree. A model shaken hard enough to read a
press reads clean type slightly worse, so a search judged on digital will walk
away from exactly the settings a search judged on physical would walk towards.
Having both on the table is the only way to see that happening.

WHY NOT K-FOLD

K-fold is the right instinct -- never grade a model on what it was taught -- but
a fold here is a whole training run, so five-fold costs five models and over an
hour to say something about a hundred-odd labelled words. The spelling already
covers every word of all six hundred and four pages, it never reaches the model,
and pages with nothing labelled on them are material no candidate has seen. A
share of the labelled words is held back on top of that. Both numbers are
measured on things the model was not shown, which is what K-fold was wanted for.

EVERY MODEL IS KEPT

Losers used to be deleted. They are not any more, and the reason is better than
tidiness: a model is thrown out on the strength of a score, and the score is a
thing we built and could have built wrong. Deleting the evidence that would show
that is the one mistake you cannot recover from afterwards. Two megabytes is
cheap; finding out in a month that the judge was wrong and the models are gone
is not. They are marked as beaten, and they stay.
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

# How far a setting may move in one round. Small on purpose: the point is to
# walk away from something good in short steps, not to start somewhere else
# each time and learn nothing about which change did the good.
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

# Fine-tuning's knobs move differently: its learning rate is already a
# hundredth of the trainer's and is the last thing that should wander, while
# how much of each batch is real is the whole question being asked.
TUNE_NUDGE = {
    "t_steps":  lambda r, v: int(max(50, min(2000, v * r.uniform(0.7, 1.5)))),
    "t_lr":     lambda r, v: float(max(1e-6, min(1e-4, v * r.uniform(0.6, 1.7)))),
    "t_share":  lambda r, v: round(max(0.2, min(0.9, v + r.uniform(-0.15, 0.15))), 2),
    "t_rotate": lambda r, v: round(max(0.0, min(6.0, v + r.uniform(-1.0, 1.0))), 2),
    "t_scale":  lambda r, v: round(max(0.0, min(0.2, v + r.uniform(-0.03, 0.03))), 3),
}

CHANGES_PER_ROUND = 2

# A win has to beat the difference between two runs of the same settings with
# different seeds. Half a point is about that; anything less is a coin.
REAL_WIN = 0.005


def settings_of(name, tune_from=None):
    """Everything a round needs, from the cards, filled out with defaults."""
    c = models.describe(name)
    j = c.get("jitter") or {}
    out = {
        "steps": c.get("steps") or 900,
        "lr": c.get("lr") or 2e-3,
        "width": c.get("width") or 16,
        "batch": c.get("batch") or 16,
        "decay": c.get("decay") or 1e-4,
        "scale": float(j.get("scale") or 0.0),
        "rotate": float(j.get("rotate") or 0.0),
        "spread": float(j.get("spread") or 0.0),
    }
    t = models.describe(tune_from) if tune_from else {}
    out.update({
        "t_steps": t.get("steps") or 300,
        "t_lr": t.get("lr") or 1e-5,
        "t_share": t.get("real_share") or 0.7,
        "t_rotate": t.get("rotate") if t.get("rotate") is not None else 2.0,
        "t_scale": t.get("scale") if t.get("scale") is not None else 0.05,
    })
    return out


def vary(base, rng, with_tune):
    """One candidate: the baseline with a couple of settings nudged."""
    table = dict(NUDGE)
    if with_tune:
        table.update(TUNE_NUDGE)
    out = dict(base)
    for key in rng.sample(sorted(table), min(CHANGES_PER_ROUND, len(table))):
        out[key] = table[key](rng, out[key])
    return out


def what_changed(base, cand):
    bits = ["%s %g→%g" % (k, base[k], cand[k])
            for k in sorted(cand) if cand[k] != base[k]]
    return ", ".join(bits) or "nothing"


def split_lines(keys, seed=3, held=0.34):
    """Confirmed lines split into what fine-tunes and what judges.

    The held-back lines are the whole point. A model fine-tuned on every
    confirmed line and scored on those same lines improves every round and
    means nothing by the end -- the failure this search is likeliest to walk
    into, because it is the one that rewards it.
    """
    keys = sorted(keys)
    rng = random.Random(seed)
    rng.shuffle(keys)
    n = max(2, int(round(len(keys) * held)))
    return sorted(keys[n:]), sorted(keys[:n])


# --------------------------------------------------------------------------


_RUN = {"going": False}


def state():
    return dict(_RUN)


def stop():
    _RUN["going"] = False
    _RUN["note"] = "stopping after this round"
    return state()


def _save():
    try:
        with open(STATE, "w", encoding="utf-8") as fh:
            json.dump(_RUN, fh, indent=1)
    except Exception:
        pass


def start(make_digital, judge_digital, make_physical=None, judge_physical=None,
          judge_by="digital", rounds=8, patience=4, seed=None, on_done=None):
    """Run the search beside everything else.

    make_digital(settings, seed) -> name;  judge_digital(name) -> score
    make_physical(name, settings, seed) -> name;  judge_physical(name) -> score

    All four are handed in, so this knows nothing about routes, spellings or
    photographs -- only that a bigger number is better.
    """
    store = label.load()
    if len(store) < 40:
        raise ValueError("only %d words labelled: a search would be fitting "
                         "settings to a handful of examples" % len(store))
    if not models.names():
        raise ValueError("train one model by hand first, to start from")
    if _RUN.get("going"):
        raise ValueError("a search is already running")

    with_tune = bool(make_physical)
    if judge_by == "physical" and not with_tune:
        raise ValueError("nothing to judge on a photograph unless the round "
                         "fine-tunes as well")

    # Where the settings come from, and it depends on what is being judged.
    #
    # Judged on digital, start from whichever model reads type best. Judged on
    # a photograph, start from whatever produced the best photograph reader --
    # which is not the same model. The best physical model was fine-tuned out
    # of some digital model, and it is that one's settings that are known to
    # lead somewhere good. Starting from the best digital model instead throws
    # away the one piece of evidence the search is being run on.
    tune_base = models.best_at("real")
    if judge_by == "physical" and tune_base:
        base = (models.parent_of(tune_base)
                or models.best_at("digital") or models.names()[0])
        why = "%s came out of %s, so its settings are the ones known to lead "               "to a good reader of photographs" % (tune_base, base)
    else:
        base = models.best_at("digital") or models.names()[0]
        why = "%s reads type best" % base
    rng = random.Random(seed)

    _RUN.clear()
    _RUN.update({
        "going": True, "round": 0, "rounds": rounds, "patience": patience,
        "since": 0, "baseline": base, "tune_baseline": tune_base, "why": why,
        "with_tune": with_tune, "judge_by": judge_by,
        "started": time.strftime("%Y-%m-%d %H:%M"), "log": [],
        "note": "scoring what we are starting from",
    })

    def run():
        try:
            settings = settings_of(base, tune_base)
            first = {"round": 0, "changed": "the model we started from",
                     "digital": base, "score_digital": judge_digital(base)}
            if with_tune and tune_base:
                first["physical"] = tune_base
                first["score_physical"] = judge_physical(tune_base)
            first["score"] = first.get("score_%s" % judge_by)
            first["kept"] = True
            _RUN["best"] = {"settings": settings, "score": first["score"],
                            "digital": base, "physical": first.get("physical")}
            _RUN["log"].append(first)
            _save()

            while _RUN["going"] and _RUN["round"] < rounds and _RUN["since"] < patience:
                _RUN["round"] += 1
                n = _RUN["round"]
                cand = vary(_RUN["best"]["settings"], rng, with_tune)
                changed = what_changed(_RUN["best"]["settings"], cand)
                row = {"round": n, "changed": changed}

                _RUN["note"] = "round %d: training — %s" % (n, changed)
                _save()
                dname = make_digital(cand, rng.randrange(10000))
                row["digital"] = dname
                _RUN["note"] = "round %d: scoring %s on digital" % (n, dname)
                _save()
                row["score_digital"] = judge_digital(dname)

                if with_tune:
                    _RUN["note"] = "round %d: fine-tuning %s" % (n, dname)
                    _save()
                    pname = make_physical(dname, cand, rng.randrange(10000))
                    row["physical"] = pname
                    _RUN["note"] = "round %d: scoring %s on the photograph" % (n, pname)
                    _save()
                    row["score_physical"] = judge_physical(pname)

                row["score"] = row.get("score_%s" % judge_by)
                won = row["score"] is not None and \
                    row["score"] > _RUN["best"]["score"] + REAL_WIN
                row["kept"] = won
                _RUN["log"].append(row)

                # Beaten or not, the models stay. A score is a thing we built
                # and could have built wrong, and deleting what would show that
                # is the one mistake there is no recovering from.
                for who, kind in ((row.get("digital"), "digital"),
                                  (row.get("physical"), "real")):
                    if who:
                        models.note_beaten(who, not won)
                if won:
                    _RUN["best"] = {"settings": cand, "score": row["score"],
                                    "digital": dname,
                                    "physical": row.get("physical")}
                    _RUN["since"] = 0
                    models.set_best(dname, "digital", True)
                    if row.get("physical"):
                        models.set_best(row["physical"], "real", True)
                else:
                    _RUN["since"] += 1
                _save()

            _RUN["note"] = ("stopped" if not _RUN["going"]
                            else "no better in %d rounds" % patience
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
