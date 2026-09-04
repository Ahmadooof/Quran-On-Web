# Word segmentations

One folder per recitation, named with the same id the timing files and the
audio bucket use. Each holds a QUL export in two files:

- `surah.json` — one entry per surah: the recording's url and its length.
- `segments.json` — one entry per ayah, keyed `"<surah>:<ayah>"`, holding the
  word segments in absolute time.

`scripts/import-qul-timing.js` turns a pair into the 114 timing files the
reader loads, and `scripts/fetch-audio.js` then fetches the recording those
timings name.

## Why these are committed

They are the provenance of every timing file we ship, and they cannot be
fetched again without a hand: the exports sit behind a sign-in at
<https://qul.tarteel.ai/resources/recitation>, so nothing in this repository
can download one. Committing them keeps the timings reproducible from source
rather than only as generated output. Nine megabytes is a fair price for that.

Take the **Surah by Surah** export, not the Ayah by Ayah one. The latter
describes 6,236 separate per-ayah files, and the reader plays one recording per
surah and seeks inside it.

## Why QUL rather than quran.com

A QUL export names the recording it was segmented against, so the timings and
the audio are one matched pair by construction.

quran.com returns a segmentation and an audio url in the same reply, and they
are not always the same cut of the recitation. That happened here: one
reciter's ayahs all began about three seconds late, and every check short of
listening passed — the durations agreed, the word counts agreed, and the
highlight moved smoothly on the wrong words. `scripts/fetch-audio-timing.js`
is still there for recitations QUL has not segmented, and carries an `--audio`
flag for exactly that failure.
