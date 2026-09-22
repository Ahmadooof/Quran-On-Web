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

That is about **1.4 GB** on top of the image, against **~120 MB** without it,
and every rebuild moves it again. It is the right answer for an offline or
air-gapped copy and the wrong one for anything served over the internet.

The reciter ids are the folder names in
[public/data/recitations.json](public/data/recitations.json).

**Nothing.** Leave `AUDIO` empty, which is the default. The mushaf reads
normally; pressing play gets a 404.

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

## Untested here

The Dockerfile has not been built — there is no Docker on the machine it was
written on, the same way `nginx -t` could not be run for the configs in
DEPLOY.md. What *was* checked is the part that actually differs from a normal
deploy: the build stage's steps were run by hand with
`SITE=http://localhost:8080 AUDIO=/audio`, and the pages came out naming
`http://localhost:8080`, the audio base `/audio`, and a policy of `media-src
'self'` — which covers a same-origin path and, correctly, does not try to name
one as a source. If the build fails, it will fail in the first few lines and
say which.
