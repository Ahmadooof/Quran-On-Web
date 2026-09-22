# Running the reader in a container

One image: nginx, the 604 page fonts, and the pages built for whatever domain
the copy answers on. No Node at runtime, no database, nothing to configure once
it is built.

```bash
docker compose up --build
```

Then <http://localhost:8080>. It opens on al-Fatihah with no interaction.

## The domain is a build argument, not an environment variable

Every page names where it lives — the canonical tag, `og:url`, the JSON-LD, the
sitemap, and the policy that decides whether the recitations are allowed to
play. Those are written into the files by `npm run build:pages`, so the domain
has to be known when the image is built:

```bash
docker build -t quran --build-arg SITE=https://quran.example.com .
docker run -p 8080:80 quran
```

Change the domain, rebuild. Everything follows from [site.json](site.json),
which is the only place it appears.

Put the container behind your own TLS — a reverse proxy, or whatever already
terminates for the rest of your site. It listens on port 80 and speaks plain
http on purpose; certificates are not its job.

## The recitations

The reader asks for `<base>/<reciter>/<surah>.mp3`, and the base is whatever
`AUDIO` was at build time. Three ways to answer:

**A host of your own.** 5.5 GB of audio belongs on object storage with range
requests, not in a container layer:

```bash
docker build -t quran \
  --build-arg SITE=https://quran.example.com \
  --build-arg AUDIO=https://audio.example.com .
```

**One reciter inside the image.** Uncomment its line in
[.dockerignore](.dockerignore), put the files at
`public/audio/<reciter>/001.mp3` … `114.mp3`, and build with a path rather than
a host:

```bash
docker build -t quran --build-arg AUDIO=/audio .
```

That adds **1.2–1.6 GB** depending on the reciter, against 166 MB without, and
every rebuild moves it again. It is the right answer for an offline or
air-gapped copy and the wrong one for anything served over the internet.

The reciter ids are the folder names in
[public/data/recitations.json](public/data/recitations.json).

**Nothing.** Leave `AUDIO` empty, which is the default. The mushaf reads
normally; pressing play gets a 404.

## What it weighs

| | |
| --- | --- |
| **166 MB** | to pull |
| 397 MB | on disk, as `docker images` reports it |
| 162 MB | the web root itself |

Of that web root, 95 MB is the 604 page fonts and 65 MB is `surah/` — which is
228 pages and 572 recitation timing files, one per surah per reciter. Those
timings are only read while audio plays, so with no `AUDIO` set they are about
54 MB the copy never touches.

## What is not in the image

| | |
| --- | --- |
| `/admin/` | the tools for whoever runs *this* site, and the password they sit behind is not in here |
| analytics | `/stats.js` answers with an empty script so the console stays clean |
| the feedback service | it exists for the Android app's reports, and needs Node and a database |
| the recitations | unless you put one in, as above |

## Two things worth knowing

**Font licensing is yours to check.** The image carries the QCF mushaf faces.
They are what makes the reader a mushaf rather than a web page, and
redistributing them is a decision about their licence, not about Docker.

**On Windows, Git Bash rewrites `/audio`.** MSYS treats an argument that looks
like a path as one, so `--build-arg AUDIO=/audio` arrives as
`C:/Program Files/Git/audio` and the recitations quietly 404. Prefix the
command with `MSYS_NO_PATHCONV=1`, or use PowerShell.

## What was checked

Built and run, both ways.

Plain (`docker compose up --build`): the front page lists all 114 surahs, and
`/surah/18/` builds 418 words and draws page 293 in the QCF faces — the fonts
load and apply, which is the one thing a container could plausibly get wrong.
The page fonts come back `immutable`, css gzipped, html `no-cache`, `/admin/`
404s, and `/stats.js` answers with an empty script.

With a domain and an audio host
(`--build-arg SITE=https://quran.example.com --build-arg AUDIO=https://audio.example.com`):
the canonical tag, the sitemap and the audio meta all name them, and the policy
comes back `media-src 'self' https://audio.example.com`.

What has **not** been exercised is a reciter inside the image — the
`.dockerignore` exception and `AUDIO=/audio` are written but were not built,
since it is 1.4 GB to prove a path substitution. If it misbehaves it will be a
404 on `/audio/<reciter>/001.mp3`, which the admin links page would show.
