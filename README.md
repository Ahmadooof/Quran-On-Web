<<<<<<< HEAD
# Quran-On-Web
=======
# القرآن الكريم — Quran Web App

Traditional Islamic Quran reader with dark/light mode, bilingual UI, bookmarks, and full-screen reading mode.

## Setup

```bash
npm install
npm start
```

Open `http://localhost:3000`

## Data File

Place your Quran JSON file at:

```
public/data/quran.json
```

Expected shape — array of surahs:

```json
[
  {
    "id": 1,
    "name": "الفاتحة",
    "transliteration": "Al-Fatihah",
    "type": "meccan",
    "total_verses": 7,
    "verses": [
      { "id": 1, "text": "بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ" }
    ]
  }
]
```

## Features

- Surahs organized by Juz (1–30) in the left sidebar
- Full-screen reading mode — sidebar hides automatically
- Bookmarks saved in `localStorage` (no login needed, persist until manually cleared)
- Per-ayah bookmark button (hover over any ayah)
- Page-level bookmark via the toolbar bookmark button
- Dark / Light mode toggle
- Arabic / English UI toggle
- Surah search by name or number
- Previous / Next surah navigation
- Remembers last-read surah across sessions
- Responsive — adapts to mobile, tablet, and desktop
>>>>>>> 9d7a478 (Initial commit: Quran reader web app)
