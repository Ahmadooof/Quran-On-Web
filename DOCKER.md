# Running the reader in a container

One image: nginx, the 604 page fonts, and the pages built for whatever domain
the copy answers on. No Node at runtime, no database, nothing to configure once
it is built.

```bash
docker run -p 8080:80 ahmadooof/quran
```

Then <http://localhost:8080>. That is a 1.4 GB pull, because the default tag
carries a recitation; `:slim` is 166 MB without one and `:full` is every
reciter. Or build it yourself:

```bash
docker compose up --build
```

## The published tags

Three, and only three:

| | | |
| --- | --- | --- |
| `ahmadooof/quran` | 1.4 GB | reading, and one recitation — Maher al-Muaiqly |
| `ahmadooof/quran:slim` | 166 MB | reading only, no recitations at all |
| `ahmadooof/quran:full` | 7.0 GB | reading, and all five recitations — 570 recordings |

They are rebuilt together whenever the site changes:

```bash
npm run docker:release -- --push
```

That script exists because the three differ only in which recitations reach the
build context, which `.dockerignore` decides — and getting that wrong is
silent. The build succeeds and the image is simply missing its audio. It
rewrites that file per tag and puts it back afterwards, even if a build fails.

One tag at a time, or built without pushing:

```bash
npm run docker:release -- --push slim
npm run docker:release
```

All three are built for `http://localhost:8080`, because the domain is baked in
— see below. They are something to try, not something to deploy as they are; a
real deployment builds with its own `SITE`.

**Only this machine can make the audio tags.** `public/audio/` is 5.5 GB and
gitignored, so CI cannot build them and a clone cannot reproduce them. `:slim`
is the one anybody can rebuild from source.

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
`AUDIO` was at build time. It defaults to `/audio`, the reciter inside the
image, so a plain build needs no arguments:

```bash
docker build -t quran .
```

**A host of your own** keeps the image at 166 MB, which is what a copy served
over the internet should do — 1.2 GB of audio belongs on object storage with
range requests, not in a container layer:

```bash
docker build -t quran   --build-arg SITE=https://quran.example.com   --build-arg AUDIO=https://audio.example.com .
```

Comment the reciter out of [.dockerignore](.dockerignore) as well, or its
files ride along unread.

**Another reading**: swap which line is uncommented in
[.dockerignore](.dockerignore). There are five, not four — Maher al-Muaiqly
appears twice, as two different recordings (Alharamain and 1440 AH), which is
how `:full` first shipped one short. The ids are the folder names in
[public/data/recitations.json](public/data/recitations.json), and the files go
at `public/audio/<reciter>/001.mp3` … `114.mp3`.

**None at all**: `--build-arg AUDIO=` and the reciter commented out. The mushaf
reads normally; pressing play gets a 404.

### A clone cannot rebuild the audio image

`public/audio/` is gitignored — it is 5.5 GB — so a fresh checkout has no
recitations and the exception in `.dockerignore` matches nothing. The build
still succeeds and still says `/audio`, and every mp3 404s. Anyone who wants
the audio image either brings their own files or pulls the published tag.

## What it weighs

| | |
| --- | --- |
| **1.4 GB** | the default build, with a reciter |
| 166 MB | with `AUDIO` pointed elsewhere and the reciter commented out |
| 162 MB | the web root, before any audio |

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
