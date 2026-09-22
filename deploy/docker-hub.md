# The Madinah Mushaf, a full page at a time

The Quran as it is printed — page 1 to 604, each page set in its own font so
the lines break where the mushaf breaks them. Open it and read; there is
nothing to configure.

- **Site** — https://readqurantoday.com
- **Source** — https://github.com/Ahmadooof/Quran-On-Web
- **Running it** — [DOCKER.md](https://github.com/Ahmadooof/Quran-On-Web/blob/main/DOCKER.md)

```bash
docker run -p 8080:80 ahmadooof/quran
```

Then http://localhost:8080.

## Tags

| tag | size | |
| --- | --- | --- |
| `latest` | 1.4 GB | the reader and one recitation — Maher al-Muaiqly |
| `slim` | 166 MB | the reader alone, when the audio comes from somewhere else |
| `full` | 5.7 GB | every recitation: four reciters, 456 surah recordings |

## What is inside

nginx and static files. No Node at runtime, no database, no configuration — the
build stage that generates the pages is thrown away, so what ships is the web
server and 604 page fonts.

- 114 surahs, and each one also as plain text a search engine can read
- Search by surah name, page, juz or the words of an ayah
- Recitation with the word being read marked as it is read
- Reads offline once a page has been seen

## Your own domain

Every page names where it lives — the canonical tag, `og:url`, the JSON-LD, the
sitemap, and the policy that decides whether the recitations play. So the domain
is set when the image is built, not when it runs:

```bash
docker build -t quran \
  --build-arg SITE=https://quran.example.com \
  --build-arg AUDIO=https://audio.example.com .
```

The published tags are built for `http://localhost:8080`. They are something to
try; a real deployment builds with its own `SITE`.

Put it behind your own TLS. It listens on port 80 and speaks plain http on
purpose — certificates are the job of whatever already terminates for your site.

## The fonts

The pages are drawn in the QCF fonts of the Madinah Mushaf, one per page. That
is what makes this a mushaf rather than a web page, and it is why the image is
166 MB before any audio.
