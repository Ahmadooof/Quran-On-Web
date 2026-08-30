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

  * One writer at a time, and each one writes to a temporary file of its own.
    The rename is atomic; two threads sharing one temporary file are not. A
    search running in its own thread saves a model card while a request saves
    another, both open "index.json.writing", and what gets renamed into place
    is the two of them interleaved -- which is how a file comes to have a
    second JSON document starting at line 427.
"""

import io
import json
import os
import shutil
import threading
import time

_LOCKS = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(path):
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(os.path.abspath(path), threading.Lock())


def load(path, default=None):
    """What is in the file, or default if there is no file.

    A file that exists but will not parse raises. Returning {} there is how a
    transient failure turns into a permanent one: the caller treats it as
    "nothing saved yet" and saves nothing over the top of everything.
    """
    if not os.path.exists(path):
        return {} if default is None else default
    # Windows refuses to open a file at the instant it is being replaced, so a
    # reader that happens to land on that instant gets a permission error
    # rather than any content. It lasts microseconds; the answer is to look
    # again rather than to report a catastrophe.
    def read():
        with io.open(path, encoding="utf-8") as fh:
            return fh.read()
    text = _try(read)
    if not text.strip():
        raise ValueError("%s is empty; %s.last may still have it"
                         % (os.path.basename(path), os.path.basename(path)))
    try:
        return json.loads(text)
    except ValueError as err:
        # The spare is a mechanical copy of this file as it was one write ago,
        # so falling back to it loses at most that write -- against losing the
        # afternoon to a five hundred. The unreadable file is not deleted: it
        # is moved aside under .broken, so whatever went wrong can still be
        # looked at.
        spare = path + ".last"
        if os.path.exists(spare):
            with io.open(spare, encoding="utf-8") as fh:
                text = fh.read()
            try:
                got = json.loads(text)
            except ValueError:
                got = None
            if got is not None:
                try:
                    os.replace(path, path + ".broken")
                    save(path, got)
                except OSError:
                    pass
                print("%s would not parse (%s); used %s.last instead and kept "
                      "the bad one as %s.broken"
                      % (os.path.basename(path), err, os.path.basename(path),
                         os.path.basename(path)))
                return got
        raise ValueError("%s will not parse (%s); %s.last may still have it"
                         % (os.path.basename(path), err, os.path.basename(path)))


def _try(what, tries=(0.02, 0.05, 0.1, 0.2, None)):
    """Do it, and on Windows do it again in a moment if the file was busy.

    Windows will not let a file be replaced while anybody has it open, and it
    will not let a file be opened at the instant it is replaced. Both last
    microseconds and both raise the same kind of error, so both are answered
    the same way: wait, and look again.
    """
    for wait in tries:
        try:
            return what()
        except OSError:
            if wait is None:
                raise
            time.sleep(wait)


def save(path, data, indent=1, ensure_ascii=False):
    """Write it whole, keep what was there, and never leave a half-written file."""
    with _lock_for(path):
        # written first, so that the spare is a copy of a file that parses
        # rather than a file that has just been renamed out from under a reader
        tmp = "%s.%d.%d.writing" % (path, os.getpid(), threading.get_ident())
        with io.open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=indent, ensure_ascii=ensure_ascii)
        if os.path.exists(path):
            try:
                # copied and not renamed: a rename would take the file away
                # for an instant, and a reader arriving in that instant sees
                # nothing there and concludes nothing was ever saved
                _try(lambda: shutil.copyfile(path, path + ".last"))
            except OSError:
                pass                        # a missing spare must not stop a save
        _try(lambda: os.replace(tmp, path))
