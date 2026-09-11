# The Android app

A native shell around the reader. Right now it is one activity holding one
WebView; the surah list, the player and the settings will be built natively
around it, and the WebView will be left with the one thing it is genuinely good
at — drawing the mushaf.

## Why a WebView at all

The page is drawn from 604 QCF fonts whose glyphs are private-use codepoints,
laid out line by line and fitted to the sheet, with a word-level highlight
following the recitation. That is solved, in `public/js/mushaf.js`, and it is
the most expensive thing in this repository. Rewriting it in Kotlin and again
in Swift would be solving it twice more; neither can load a woff2 face, so it
would also mean converting all 604 fonts and carrying them 30-50% larger.

## Why it works with no network

Everything the reader reads is inside the app: the fonts, `mushaf.json`, the
stylesheet and the scripts, copied into `app/src/main/assets/` at build time.
There is no first-run download and no cache — offline is not a mode, it is the
only way a page is ever loaded. A correction to the text ships as an app
update, which is the honest way round.

The recitations are not bundled: five of them come to 5.7 GB against a 95 MB
mushaf. They stream from the CDN, and a reader who wants one keeps it on the
device.

## Build

Open `android/` in Android Studio and run. Nothing to do first: copying the
reader into the app is a build task, `syncWebAssets`, which every build depends
on. It runs when `public/` has changed and reports UP-TO-DATE when it has not,
so a build after an edit takes about twenty seconds and one after no edit takes
one.

`npm run sync:android` still exists and does the same thing by hand. You should
not need it.

## Working on the look of the app

Every build being correct is not the same as every build being quick: 95 MB is
copied and the app reinstalled for a one-line change to a stylesheet. So a
build can be pointed at the site as it is being served instead:

    npm start                 # in the repository root
    ./gradlew installDebug -PdevServer=http://10.0.2.2:3000

`10.0.2.2` is the emulator's route to this machine's localhost; on a real
device use this machine's address on the network. Now a change to the CSS is a
reload away.

That build does **not** work offline — it is fetching the site. It is a tool
for designing, not something to hand to anyone. A build with no `-PdevServer`
is the real app: the package, offline, always.

## Styling the app differently from the site

The shell adds `QuranShell/android` to the user agent, and the reader turns
that into `data-shell="android"` on `<body>`. So an app-only rule is:

    body[data-shell="android"] .drawer-tabs { … }

in the same stylesheet as everything else. Not a second copy of the CSS: one
that has to be kept in step by hand always stops being kept in step.

The assets are ignored by git — they are derived from `public/`, which already
holds them. Run the sync again after any change to the web app, or the app will
build with the copy it had.

There is no Gradle wrapper committed. Android Studio writes one on first open;
from the command line, `gradle wrapper` once.

## Next

- The bridge: `renderPage(n)`, `highlight(word)`, and a tap on a word coming
  back out, so the native side can drive the page and the player.
- A native surah list and player, replacing the drawer and the floating window
  that the web layout uses.
- Downloads written to app storage rather than through the browser.
