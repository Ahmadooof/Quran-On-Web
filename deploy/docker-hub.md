# The Madinah Mushaf

The Quran as it is printed — whole pages in the QCF V2 fonts, two at a time on
a wide screen, one on a phone. Nothing to configure.

```bash
docker run -p 8080:80 ahmadooof/quran
```

Then http://localhost:8080.

- **Site** — https://readqurantoday.com
- **Source** — https://github.com/Ahmadooof/Quran-On-Web
- **Detail** — [DOCKER.md](https://github.com/Ahmadooof/Quran-On-Web/blob/main/DOCKER.md)

## Tags

| tag | size | |
| --- | --- | --- |
| `latest` | 1.4 GB | reading, and one recitation — Maher al-Muaiqly |
| `slim` | 166 MB | reading only, no recitations at all |
| `full` | 7.4 GB | reading, and all five recitations |

## Inside

nginx and 604 page fonts. No Node at runtime, no database.

- 114 surahs, each also as plain text a search engine can read
- Search by surah name, page, juz, or the words of an ayah
- The word being recited is marked as it is read
- Reads offline once a page has been seen

## Your own domain

Every page carries the domain — canonical tag, sitemap, and the policy that
lets the recitations play — so it is set at build time, not run time. The
published tags say `localhost:8080`; for a real site, rebuild:

```bash
docker build -t quran --build-arg SITE=https://your.site .
```

Port 80, plain http. Put your own TLS in front of it.
