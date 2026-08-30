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
import math
import os
import random
import threading
import time

import label
import models
import store
import unet

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "autotrain.json")

# EVERY SEARCH IS KEPT
#
# One file held the running search and was written over by the next one, which
# meant an afternoon of rounds existed only until somebody pressed Search
# again. The models survived -- they are files with cards -- but what was tried
# and what it scored and which of them the winner beat did not, and that is the
# part you cannot work out again afterwards.
#
# So each search gets a file of its own, named for when it began, and the
# newest one is also written to the old path so anything expecting it still
# finds it.
RUNS = os.path.join(HERE, "runs")

# WHAT A SETTING IS, DECLARED ONCE
#
# Each setting says what it may be, what scale it lives on, what steps it comes
# in, and what it is worth spending a quarter of an hour on. Everything else is
# worked out from that: how far a nudge moves, whether a move is big enough to
# be worth a round, what a sweep walks through, and what the plan says before
# anything runs.
#
# It was three tables that had to agree -- nudge functions, tiers, sweep ranges
# -- and a constant saying a move had to be a seventh of the setting's *current
# value*. Measuring against the value cannot work across settings of different
# natures: 0.02 -> 0.03 on a shake that lives in 0..0.35 is a fifty per cent
# move and nothing at all, while 0 -> anything is an infinite one, and a
# setting that happens to sit near zero gets nudged by amounts no model could
# feel. Measuring against the setting's own declared span asks every setting
# the same question in the same units -- how far across what this thing can be
# did we actually travel -- and it is the question that transfers to whatever
# is trained here next.

def _sig(v, n=3):
    """Three figures. No run can tell 0.00313367 from 0.00313, and the log
    should not claim otherwise."""
    if not v:
        return 0.0
    return round(v, n - 1 - int(math.floor(math.log10(abs(v)))))


class Knob:
    """One setting, and everything about it the search needs to know.

    low, high   the span the search treats as useful. Not a fence: a value
                that arrived from outside it -- someone trained a model by
                hand at lr 0.02 -- widens the span rather than being dragged
                back into it. What a person typed is evidence about where the
                good settings are.
    log         the span covers an order of magnitude or more, so halving
                matters as much as doubling, and moves are measured that way.
    quantum     the setting comes only in these steps. There is no such thing
                as 900.4 steps or 17 channels.
    step        the smallest change this setting can make that a model could
                feel, in its own units -- absolute for a linear setting (half
                a degree of rotation, five per cent of a batch's real share),
                a multiplier for one on a log scale (1.4 means a rate must at
                least go up by half or down by a third). This is the schema
                that replaces a single number deciding for all of them: a
                share of a span is the same question asked of every setting,
                and the step is where a setting gets to answer that a share of
                its span still is not enough to notice.
    places      decimals worth keeping, where a person reads the number.
    tier        what a round spent on it is worth. See below.
    tune        it belongs to fine-tuning rather than training.
    """

    def __init__(self, low, high, tier=2, log=False, quantum=None,
                 places=None, tune=False, step=None):
        self.low, self.high = float(low), float(high)
        self.tier, self.log, self.quantum = tier, log, quantum
        self.places, self.tune, self.step = places, tune, step

    def least(self, share, span):
        """How far a move must go, as a share of the span.

        Whichever is the larger of what the search asked for and what this
        setting says it takes to be noticed.
        """
        lo, hi = span
        want = max(0.0, min(1.0, share))
        if self.step:
            if self.log and self.step > 1 and hi > lo:
                mine = math.log(self.step) / (math.log(hi) - math.log(lo))
            elif not self.log and hi > lo:
                mine = self.step / (hi - lo)
            else:
                mine = 0.0
            want = max(want, min(1.0, mine))
        return want

    def span(self, v=None):
        """The span, widened to hold a value that came from outside it."""
        lo, hi = self.low, self.high
        if v is not None:
            lo, hi = min(lo, float(v)), max(hi, float(v))
        if self.log:
            lo = max(lo, 1e-12)
            hi = max(hi, lo * 1.001)
        return lo, hi

    def pos(self, v, span=None):
        """Where a value sits in its span, from 0 to 1."""
        lo, hi = span or self.span(v)
        v = min(max(float(v), lo), hi)
        if self.log:
            return ((math.log(max(v, 1e-12)) - math.log(lo))
                    / (math.log(hi) - math.log(lo)))
        return (v - lo) / (hi - lo) if hi > lo else 0.0

    def at(self, p, span=None):
        """The value at a position, in the steps the setting comes in."""
        lo, hi = span or self.span()
        p = min(1.0, max(0.0, p))
        v = (math.exp(math.log(lo) + p * (math.log(hi) - math.log(lo)))
             if self.log else lo + p * (hi - lo))
        return self.tidy(v)

    def tidy(self, v):
        if self.quantum:
            return int(max(self.quantum, round(v / self.quantum) * self.quantum))
        if self.places is not None:
            return round(v, self.places)
        return _sig(v)

    def units(self, v, share):
        """What a share of the span works out to near a value, in real units.

        So the plan can say "at least 0.0006" rather than "at least 12%",
        which is the difference between a number you can judge and one you
        have to do arithmetic on.
        """
        sp = self.span(v)
        share = self.least(share, sp)
        p = self.pos(v, sp)
        return self.at(max(0.0, p - share), sp), self.at(min(1.0, p + share), sp)

    def move(self, rng, v, least, reach):
        """A step away from v: at least `least` of the span, at most `reach`.

        None when there is no such step -- the setting is pinned against the
        end of its span, or its steps are coarser than the move asked for --
        and the round goes to a setting where the change can be seen.
        """
        sp = self.span(v)
        least = self.least(least, sp)
        p = self.pos(v, sp)
        ways = [(-1, p), (1, 1.0 - p)]
        rng.shuffle(ways)
        for sign, room in ways:
            if room < least:
                continue                  # not enough span left this way
            top = min(reach, room)
            d = min(least, top)
            while d <= top + 1e-9:
                got = self.at(p + sign * rng.uniform(d, top), sp)
                if got != v:
                    return got
                d = d * 1.5 + 0.02        # the steps ate it; ask for further
        return None


# What a round may change, and what each change is worth.
#
# Not every setting earns a round. A run that spent one on "rotate 3 -> 3.17"
# spent it on a sixth of a degree, while the round that moved the learning rate
# moved it by half again -- the sampler treated the two as equally interesting
# because it had no notion that they are not.
#
# So they are tiered, and a search works through the tier that matters before
# widening. The tiers are a starting opinion, not a measurement: sweep a
# setting to find out what it is really worth, and move it.
#
#   1  changes the model. Rate decides whether it learns at all; steps decide
#      how much; scale and real share decide what it is learning from.
#   2  changes it noticeably. Batch and width shift how it learns rather than
#      whether; ink spread is the one shake that imitates a press directly.
#   3  changes it slightly. A degree of rotation or a hundredth of scale is
#      below the difference two seeds make, and decay is not a setting you
#      tune, it is one you hold still.
KNOBS = {
    "lr":       Knob(5e-4, 6e-3, tier=1, log=True, step=1.4),
    "steps":    Knob(300, 2400, tier=1, log=True, quantum=25, step=1.25),
    "scale":    Knob(0.0, 0.35, tier=1, places=3, step=0.03),
    "batch":    Knob(8, 40, tier=2, quantum=4, step=4),
    "width":    Knob(8, 32, tier=2, quantum=4, step=4),
    "spread":   Knob(0.0, 0.9, tier=2, places=2, step=0.1),
    "rotate":   Knob(0.0, 8.0, tier=3, places=2, step=0.5),
    "decay":    Knob(0.0, 1e-3, tier=3, places=6, step=5e-5),

    # Fine-tuning's settings are its own. Its learning rate is already a
    # hundredth of the trainer's and is the last thing that should wander,
    # while how much of each batch is real is the whole question being asked.
    "t_lr":     Knob(2e-6, 6e-5, tier=1, log=True, tune=True, step=1.4),
    "t_share":  Knob(0.3, 0.9, tier=1, places=2, tune=True, step=0.05),
    "t_steps":  Knob(100, 900, tier=1, log=True, quantum=25, tune=True, step=1.25),
    "t_rotate": Knob(0.0, 5.0, tier=3, places=2, tune=True, step=0.5),
    "t_scale":  Knob(0.0, 0.15, tier=3, places=3, tune=True, step=0.02),
}

TIERS = {k: v.tier for k, v in KNOBS.items()}

# How much a change has to move to be worth a round, and how far it may go,
# both as a share of the setting's own span. Defaults and nothing more: they
# are arguments to a search, they are on the screen, and they are written into
# the log beside the rounds they governed.
#
# A twelfth of a span is roughly the smallest change that shows above the
# difference two seeds make; a move of nearly half a span is a different
# setting rather than a nudge of this one, which is the far end of what a
# search that means to learn something should try in one go.
LEAST_MOVE = 0.12
MOST_MOVE = 0.45

CHANGES_PER_ROUND = 1

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


def knobs(with_tune, tier=3):
    """Which settings a round may touch, at or below a tier."""
    return {k: v for k, v in KNOBS.items()
            if v.tier <= tier and (with_tune or not v.tune)}


def vary(base, rng, with_tune, tier=3, changes=CHANGES_PER_ROUND,
         least=LEAST_MOVE, reach=MOST_MOVE):
    """One candidate: the baseline with a setting or two moved.

    With changes=1 a round moves exactly one thing, which is the only way the
    result says anything about cause. Two at a time is quicker to stumble on a
    good pair and tells you nothing about which half did it -- the round that
    moved t_lr and t_scale together and won is a good result nobody can learn
    from.

    A setting that cannot move far enough to be worth a round is passed over
    rather than nudged pointlessly, and the round goes to one that can. If
    every setting in the tier is pinned -- which takes a large `least` and a
    baseline sitting on its limits -- the smallest move there is beats no move
    at all, and the log will show a change of almost nothing rather than a
    round that quietly repeated itself.
    """
    table = knobs(with_tune, tier)
    out = dict(base)
    want = min(changes, len(table))
    for relax in (least, least / 3.0, 0.0):
        for key in rng.sample(sorted(table), len(table)):
            if key in out and out[key] != base.get(key):
                continue                  # already moved this round
            got = table[key].move(rng, base.get(key, table[key].at(0.5)),
                                  relax, max(reach, relax))
            if got is None:
                continue
            out[key] = got
            if sum(1 for k in out if out[k] != base.get(k)) >= want:
                return out
    return out


def sweep_values(key, base, n=5):
    """One setting walked across its span, everything else left alone.

    A sweep is the honest way to find out what a setting is worth: the same
    model, the same seed, the same everything, and one number moving. What
    comes back is a shape -- flat, a slope, a peak -- and a flat one is how you
    learn a setting does not deserve the tier it was given.
    """
    kn = KNOBS.get(key)
    if kn is None:
        return []
    sp = kn.span(base.get(key))
    seen, keep = set(), []
    for i in range(max(2, n)):
        v = kn.at(i / float(max(1, n - 1)), sp)
        if v not in seen:                 # never run the same candidate twice
            seen.add(v)
            keep.append(v)
    return keep


# THE PIPELINE
#
# One search rather than three modes to choose between, because the order was
# never really a choice: you find out roughly where a setting wants to be, and
# then you nudge. Doing the nudging first is how a search spends six rounds
# creeping around a learning rate that was in the wrong decade.
#
#   Phase 1, sweep. The settings that decide the most, one at a time, each
#     walked across its span from the same starting point. Every round is one
#     change from a fixed baseline, so the numbers are comparable and what
#     comes back is a shape rather than a story.
#   Phase 2, nudge. From the best of phase 1, one setting changed per round,
#     top tier first, widening only when it stops paying.
#
# There is no third phase changing two at a time. A round that moves two
# settings and wins cannot say which one won, and the way out of a local
# hollow with a hundred labelled words is more labels, not more knobs.

PHASES = [("sweep", "the big settings, across their range"),
          ("nudge", "one setting a round, from the best so far")]


# Which of the top settings gets swept first, when the budget will not cover
# them all. It depends on what is being judged: a search graded on photographs
# lives or dies on how much of each fine-tuning batch is real, and one graded
# on type has no such setting at all.
SWEEP_FIRST = {
    "digital": ["lr", "scale", "steps", "t_share", "t_lr", "t_steps"],
    "physical": ["t_share", "t_lr", "lr", "scale", "t_steps", "steps"],
}


def phase_plan(settings, with_tune, budget, points=3, judge_by="digital"):
    """Phase one, worked out before anything runs.

    Each top-tier setting gets `points` candidates and only if all of them
    fit: half a sweep is half a shape, and the rounds are better spent
    finishing one setting's than starting two. If not even the first fits,
    it gets what there is -- three points of the setting that matters most
    beats none of it and two of something that happened to be cheap.
    """
    table = knobs(with_tune, 1)
    order = [k for k in SWEEP_FIRST.get(judge_by, SWEEP_FIRST["digital"])
             if k in table]
    order += [k for k in sorted(table) if k not in order]

    def points_for(key, n):
        return [{"phase": "sweep", "key": key,
                 "settings": dict(settings, **{key: v})}
                for v in sweep_values(key, settings, n)
                if v != settings.get(key)]

    out = []
    for key in order:
        got = points_for(key, points)
        if not got or len(out) + len(got) > budget:
            break              # in order, or the order was not an order
        out += got
    if not out and budget > 0 and order:
        out = points_for(order[0], points)[:budget]
    return out


def knob_facts(settings, with_tune, least=LEAST_MOVE):
    """Every setting the search knows about, for the plan.

    Its tier, the span it will be moved within, and what the smallest
    worthwhile change works out to in the setting's own units -- so the plan
    can be read without anyone working out what a share of a span is.
    """
    out = {}
    for key, kn in knobs(with_tune).items():
        v = settings.get(key)
        lo, hi = kn.span(v)
        row = {"tier": kn.tier, "log": kn.log,
               "low": kn.tidy(lo), "high": kn.tidy(hi)}
        if v is not None:
            down, up = kn.units(v, least)
            row.update({"now": v, "down": down, "up": up})
        out[key] = row
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
    # at least one each side, whatever the share works out to: a split that
    # leaves nothing to fine-tune on cannot run, and one that leaves nothing to
    # judge with is worse -- it runs, and means nothing
    n = min(len(keys) - 1, max(1, int(round(len(keys) * held))))
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
        store.save(STATE, _RUN)
        if _RUN.get("id"):
            if not os.path.isdir(RUNS):
                os.makedirs(RUNS)
            store.save(os.path.join(RUNS, _RUN["id"] + ".json"), _RUN)
    except Exception:
        pass


def kept():
    """Every search there is, newest first, as much as a list needs to know."""
    out = []
    for f in sorted(os.listdir(RUNS) if os.path.isdir(RUNS) else [], reverse=True):
        if not f.endswith(".json"):
            continue
        try:
            r = store.load(os.path.join(RUNS, f))
        except ValueError:
            continue
        best = r.get("best") or {}
        out.append({
            "id": r.get("id") or f[:-5],
            "started": r.get("started"), "rounds": len(r.get("log") or []),
            "asked_for": r.get("rounds"), "judge_by": r.get("judge_by"),
            "with_tune": r.get("with_tune"), "sweep": r.get("sweep"),
            "baseline": r.get("baseline"), "elapsed": r.get("elapsed"),
            "going": bool(r.get("going")),
            "best": best.get("physical") or best.get("digital"),
            "score": best.get("score"),
        })
    return out


def one(run_id):
    """A search, whole, as it was written down."""
    if not run_id or os.path.sep in run_id or "." in run_id:
        raise ValueError("no such search")
    path = os.path.join(RUNS, run_id + ".json")
    if not os.path.exists(path):
        raise ValueError("no search called %s" % run_id)
    return store.load(path)


def start(make_digital, judge_digital, make_physical=None, judge_physical=None,
          judge_by="digital", rounds=8, patience=4, seed=None, on_done=None,
          changes=CHANGES_PER_ROUND, tiers=True, sweep=None,
          least=LEAST_MOVE, reach=MOST_MOVE, points=3):
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
        "changes": changes, "tier": 1 if tiers else 3, "sweep": sweep,
        "least": least, "reach": reach, "phase": "sweep",
        "phases": [{"name": n, "what": w} for n, w in PHASES],
        "began": time.time(),
        "id": time.strftime("%Y%m%d-%H%M%S"),
        "started": time.strftime("%Y-%m-%d %H:%M"), "log": [],
        "note": "scoring what we are starting from",
    })

    def run():
        # Copies, because Python makes a name local to the whole function the
        # moment it is assigned anywhere in it: a sweep setting `rounds` in one
        # branch made every earlier read of it an error, and the search died
        # before its first round with a message about an unassociated variable.
        budget, give_up = rounds, patience
        try:
            settings = settings_of(base, tune_base)
            first = {"round": 0, "changed": "the model we started from",
                     "digital": base, "score_digital": judge_digital(base)}
            if with_tune and tune_base:
                first["physical"] = tune_base
                first["score_physical"] = judge_physical(tune_base)
            first["score"] = first.get("score_%s" % judge_by)
            first["kept"] = True
            first["settings"] = settings
            _RUN["best"] = {"settings": settings, "score": first["score"],
                            "digital": base, "physical": first.get("physical")}
            _RUN["log"].append(first)
            _save()

            # Phase one is a list of candidates worked out before anything
            # runs: one setting moved, everything else held at the baseline's
            # exact values. Asked for a single setting by name, that is the
            # whole search; otherwise it is the sweep the pipeline opens with.
            if sweep:
                queue = [{"phase": "sweep", "key": sweep,
                          "settings": dict(settings, **{sweep: v})}
                         for v in sweep_values(sweep, settings, rounds)]
                budget = len(queue)
                give_up = budget + 1        # a sweep runs to the end
                _RUN["rounds"] = budget
            else:
                # two rounds at least are kept back for the nudging, or the
                # sweep eats the budget and nothing is ever refined
                queue = phase_plan(settings, with_tune,
                                   max(0, budget - 2), points, judge_by)
            _RUN["phase"] = "sweep" if queue else "nudge"
            _RUN["sweeping"] = len(queue)

            while _RUN["going"] and _RUN["round"] < budget and _RUN["since"] < give_up:
                _RUN["round"] += 1
                n = _RUN["round"]
                began = time.time()
                if n <= len(queue):
                    # a sweep varies from where it started, not from the
                    # winner, or the shape it draws is of a moving target
                    cand = queue[n - 1]["settings"]
                    changed = what_changed(settings, cand)
                    _RUN["phase"] = "sweep"
                    _RUN["since"] = 0        # a sweep is not looking for a win
                else:
                    cand = vary(_RUN["best"]["settings"], rng, with_tune,
                                _RUN["tier"], changes, least, reach)
                    changed = what_changed(_RUN["best"]["settings"], cand)
                    _RUN["phase"] = "nudge"
                # every setting the candidate ran with, not only what moved:
                # a row that says "lr 0.002 -> 0.0028" and nothing else cannot
                # be read a week later without the rest of the table
                row = {"round": n, "changed": changed, "phase": _RUN["phase"],
                       "settings": dict(cand)}

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
                row["seconds"] = int(time.time() - began)
                # what is left, at what the rounds so far have cost -- better
                # than a guess made before anything ran, which is the only
                # other kind of estimate there is
                spent = [r["seconds"] for r in _RUN["log"] if r.get("seconds")]
                spent.append(row["seconds"])
                _RUN["per_round"] = int(sum(spent) / len(spent))
                _RUN["elapsed"] = int(time.time() - _RUN["began"])
                _RUN["eta"] = _RUN["per_round"] * max(0, budget - n)
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
                    # Nothing in this tier is working, so widen rather than
                    # stop: the settings that decide the most have been tried,
                    # and the next ones down are worth a look before giving up.
                    if _RUN["phase"] == "nudge" and tiers and _RUN["since"] >= give_up                             and _RUN["tier"] < 3:
                        _RUN["tier"] += 1
                        _RUN["since"] = 0
                        _RUN["note"] = ("nothing left in the first %d tier%s; "
                                        "widening to tier %d"
                                        % (_RUN["tier"] - 1,
                                           "" if _RUN["tier"] == 2 else "s",
                                           _RUN["tier"]))
                _save()

            _RUN["phase"] = "done"
            _RUN["note"] = ("stopped" if not _RUN["going"]
                            else "no better in %d rounds" % give_up
                            if _RUN["since"] >= give_up else "done")
        except Exception as err:
            _RUN["note"] = "stopped: %s" % err
        finally:
            _RUN["going"] = False
            _save()
            if on_done:
                on_done(state())

    threading.Thread(target=run, daemon=True).start()
    return state()
