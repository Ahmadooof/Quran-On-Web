"""
Reading and writing the little JSON files this project keeps its work in.

Written after losing the same thing twice. Both times the shape was the same:
a file is read, changed, and written back; two copies of the app are running
against it; a read caught the file half-written, the exception was swallowed,
the empty result looked like "there is nothing here", and the next write made
that true. Nothing failed loudly at any point.

Three rules, and each one answers a step of that.

  * A write goes to a temporary file and is renamed over the original. A
    rename is atomic, so a reader sees either the old file whole or the new
    one whole, and never the middle of a write.

  * A read distinguishes a file that is not there -- which is fine, and means
    nothing has been saved yet -- from one that is there and cannot be
    understood, which is not fine and must not be reported as emptiness.

  * Every write leaves the previous contents in a .last file. Not a backup
    system; the difference between a slip costing a click and costing a day.
"""

import io
import json
import os


def load(path, default=None):
    """What is in the file, or default if there is no file.

    A file that exists but will not parse raises. Returning {} there is how a
    transient failure turns into a permanent one: the caller treats it as
    "nothing saved yet" and saves nothing over the top of everything.
    """
    if not os.path.exists(path):
        return {} if default is None else default
    with io.open(path, encoding="utf-8") as fh:
        text = fh.read()
    if not text.strip():
        raise ValueError("%s is empty; %s.last may still have it"
                         % (os.path.basename(path), os.path.basename(path)))
    try:
        return json.loads(text)
    except ValueError as err:
        raise ValueError("%s will not parse (%s); %s.last may still have it"
                         % (os.path.basename(path), err, os.path.basename(path)))


def save(path, data, indent=1, ensure_ascii=False):
    """Write it whole, keep what was there, and never leave a half-written file."""
    if os.path.exists(path):
        try:
            os.replace(path, path + ".last")
        except OSError:
            pass                            # a missing spare must not stop a save
    tmp = path + ".writing"
    with io.open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=indent, ensure_ascii=ensure_ascii)
    os.replace(tmp, path)
