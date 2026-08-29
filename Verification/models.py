"""
The trained nets, kept side by side so they can be argued with.

Training is not a thing done once. A model is trained, its mistakes are
corrected by hand, and it is trained again -- and the only way to know the
second is better than the first is to set them against the same pages and
look. So every model is kept under its own name rather than overwriting one
file, and nothing is thrown away because it was superseded.

The score each one is judged by is its agreement with the spelling: how many
marks it finds in a word against how many that word's Uthmani text says it
carries. The spelling never reaches the model, so it is a real second opinion
and not an echo.
"""

import json
import os
import time

import store

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "models")
CARD = os.path.join(STORE, "index.json")


def load_index():
    return store.load(CARD)


def save_index(ix):
    os.makedirs(STORE, exist_ok=True)
    store.save(CARD, ix)


def path(name):
    return os.path.join(STORE, "%s.pt" % name)


def names():
    """Every model on disk, newest first."""
    if not os.path.isdir(STORE):
        return []
    out = [f[:-3] for f in os.listdir(STORE) if f.endswith(".pt")]
    return sorted(out, key=lambda n: os.path.getmtime(path(n)), reverse=True)


def next_name():
    """v1, v2, v3 -- the next one along."""
    used = {n for n in names() if n.startswith("v") and n[1:].isdigit()}
    i = 1
    while "v%d" % i in used:
        i += 1
    return "v%d" % i


# What a model can be best at. Two, because they are different jobs and the
# same net is not obviously best at both: type is clean and the answer is
# checkable against the spelling, a photograph is neither. A model shaken hard
# enough to read a press can easily read type slightly worse, and being made to
# choose one champion would hide exactly that.
JOBS = ("digital", "real")


def describe(name):
    ix = load_index().get(name, {})
    p = path(name)
    return {"name": name,
            "trained": ix.get("trained"),
            "words": ix.get("words"),
            "steps": ix.get("steps"),
            "crops": ix.get("crops"),
            "jitter": ix.get("jitter") or {},
            "lr": ix.get("lr"),
            "real_share": ix.get("real_share"),
            "tuned_from": ix.get("tuned_from"),
            "real_lines": ix.get("real_lines"),
            "real_keys": ix.get("real_keys") or [],
            "best": ix.get("best") or [],
            "tests": ix.get("tests") or {},
            "note": ix.get("note", ""),
            "size kb": round(os.path.getsize(p) / 1024) if os.path.exists(p) else None}


def set_best(name, job, on=True):
    """Mark one model best at one job, and take the sash off whoever had it.

    Exclusive on purpose. "Best" that several models hold at once is not a
    judgement, it is a list, and the point of the mark is to answer which one
    to reach for without reading five cards.
    """
    if job not in JOBS:
        raise ValueError("no such job: %s" % job)
    ix = load_index()
    ix.setdefault(name, {})
    for n, card in ix.items():
        held = [j for j in (card.get("best") or []) if j != job or (n == name and on)]
        if held:
            card["best"] = held
        else:
            card.pop("best", None)
    if on:
        ix[name]["best"] = sorted(set(ix[name].get("best", []) + [job]))
    save_index(ix)
    return describe(name)


def best_at(job):
    """Whichever model is marked best at a job, or None."""
    ix = load_index()
    for n in names():                       # newest first, so a tie goes new
        if job in (ix.get(n, {}).get("best") or []):
            return n
    return None


def note_test(name, what, result):
    """Remember how a model did on something, so cards can be read side by side."""
    ix = load_index()
    ix.setdefault(name, {}).setdefault("tests", {})[what] = result
    save_index(ix)
    return describe(name)


def forget(name):
    """Remove a model and its card."""
    if os.path.exists(path(name)):
        os.remove(path(name))
    ix = load_index()
    ix.pop(name, None)
    save_index(ix)


def record(name, **facts):
    """Write down what a model was made of, without forgetting what it is.

    The card used to be replaced outright, so anything said about a model
    afterwards -- which job it is best at, how it scored -- was destroyed the
    next time anything wrote to it. A mark that disappears silently is worse
    than no mark: it is one you go on believing in.
    """
    ix = load_index()
    was = ix.get(name, {})
    card = dict(facts, trained=time.strftime("%Y-%m-%d %H:%M"))
    for keep in ("best", "tests"):
        if was.get(keep) and keep not in facts:
            card[keep] = was[keep]
    ix[name] = card
    save_index(ix)
    return describe(name)
