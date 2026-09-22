# Running the reader in a container

One image: nginx, the 604 page fonts, and the pages built for whatever domain
the copy answers on. No Node at runtime, no database, nothing to configure once
it is built.

```bash
docker run -p 8080:80 ahmadooof/quran
```

Then <http://localhost:8080>. That is a 1.4 GB pull, because the default tag
carries a recitation; `ahmadooof/quran:1.0-slim` is 166 MB without one. Or build it yourself:

```bash
docker compose up --build
```

## The published tags

| | | |
| --- | --- | --- |
| `ahmadooof/quran:latest`, `:1.0`, `:1.0-audio` | 1.4 GB | the reader with Maher al-Muaiqly's recitation inside |
| `ahmadooof/quran:1.0-slim` | 166 MB | the same without it, for pointing `AUDIO` at a host of your own |

`latest` carries the recitation, so a plain `docker run` is a mushaf you can
hear rather than one that 404s when you press play. It costs a 1.4 GB pull.
Reach for `:1.0-slim` when the audio will come from somewhere else.

Both are built for `http://localhost:8080`, because the domain is baked in — see
below. They are something to try, not something to deploy as they are; a real
deployment builds with its own `SITE`.

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

That adds 1.2–1.6 GB depending on the reciter — the published `:1.0-audio` is
**1.4 GB** against 166 MB without — and every rebuild moves it again. It is the right answer for an offline or
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

With a reciter inside (`:1.0-audio`): nginx serves the mp3s itself, with
`Accept-Ranges: bytes`, so seeking works the way it does off a bucket. The
reader's base reads `/audio` and the policy stays `media-src 'self'`, which
covers a same-origin path.
