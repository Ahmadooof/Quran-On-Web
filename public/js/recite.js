/**
 * Recitation: play a surah, and light the words as they are read.
 *
 * The audio is one file per surah, so where each ayah and word falls in it is
 * worked out ahead of time and shipped beside it as <nnn>.<recitation>.timing
 * .json. This module follows the clock and moves the highlight.
 *
 * There is no bar along the foot of the screen: the menu a word opens is the
 * player, so nothing takes a strip of the page from people not listening.
 * One highlight whatever the reason for it — a band is an ayah, coloured ink
 * is the word — so listening looks like the same page carrying on.
 *
 * Nothing here reads the mushaf data: every word carries its own ayah.
 */
(function (global) {
  'use strict';

  /* Where the recordings live: tens of megabytes a surah, so the base is
     settable — point it at a CDN and nothing else changes. Read from a meta
     tag, since script-src 'self' means an inline script naming it never runs
     and every recitation would 404 against our own server. */
  function configured() {
    var el = document.querySelector('meta[name="quran-audio-base"]');
    var v = el && el.getAttribute('content');
    /* A global still wins where one is set, so a page that wants to override
       the tag — a test harness, mainly — still can. String() because a global
       is whatever someone assigned it, and trim() on a number would throw. */
    return String(global.QURAN_AUDIO_BASE || v || '/surah').trim() || '/surah';
  }

  var AUDIO_BASE = configured().replace(/\/$/, '');

  var audio = null;
  var timing = null;          // the loaded timing file, or null
  var surah = null;
  var host = null;            // { goToPage, currentPage, ayahPage }

  var playing = false;
  var frame = null;
  var lit = { ayah: null, word: null, el: null };

  /* The word the pointer is on, if any. */
  var overWord = null;

  /* What the reader asked to hear again, and how often. `left` counts down and
     Infinity is the loop that does not stop; "once" is a number, so there is no
     "no repeat" to leave switched off by mistake.

     `on` is off to begin with, because reciting carries on through the ayahs
     that follow. The scope starts at the surah: a repeat almost always means
     again from the top. */
  var repeat = { on: false, scope: 'surah', times: Infinity, left: Infinity, from: 1, to: 1 };

  /* The ayah playback is currently inside, 1-based. */
  var at = 0;

  /* Where to stop, when the reader asked for one word rather than a stretch of
     recitation, and which word that was. Null the rest of the time. */
  var stopAt = null;
  var stopWord = null;

  /* ---------- which recitation ----------
     A recording is named by an id that is at once its folder on the bucket and
     the name its timing files carry, so "where is it" is that one string. The
     list is data, so the picker and the disk cannot disagree. */

  var VOICES_URL = '/data/recitations.json';
  var REMEMBERED = 'quran-recitation';

  var voices = null;          // { default: id, recitations: [...] }, once fetched
  var voice = null;           // the id in use

  var catalogue = null;       // the fetch, kept so it is made once

  function loadVoices() {
    if (catalogue) return catalogue;
    catalogue = fetch(VOICES_URL)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (d) {
        voices = d && d.recitations && d.recitations.length ? d : null;
        return voices;
      });
    return catalogue;
  }

  function known(id) {
    return !!(voices && voices.recitations.some(function (v) { return v.id === id; }));
  }

  /* The recitation to use: what this reader chose, if it is still on offer.
     Checked against the list rather than trusted, so a withdrawn recording
     does not leave anyone with a reader that silently plays nothing. */
  function chosen() {
    if (!voices) return null;
    if (voice && known(voice)) return voice;
    var was = null;
    try { was = localStorage.getItem(REMEMBERED); } catch (e) { /* denied */ }
    voice = known(was) ? was : (known(voices.default) ? voices.default : voices.recitations[0].id);
    return voice;
  }

  function voiceOf(id) {
    if (!voices) return null;
    for (var i = 0; i < voices.recitations.length; i++) {
      if (voices.recitations[i].id === id) return voices.recitations[i];
    }
    return null;
  }

  /* ---------- the timing file --------------------------------------------- */

  function pad(n) { return String(n).padStart(3, '0'); }

  function timingUrl(id, which) {
    return '/surah/' + id + '/' + pad(id) + '.' + which + '.timing.json';
  }

  function fetchTiming(url) {
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /* This surah's timings, falling back to the default recording where the
     chosen one has none: timings are added a surah at a time, and losing the
     ability to listen at all would be a poor way to report that. */
  function load(id) {
    return loadVoices().then(function () {
      var which = chosen();
      if (!which) return null;
      return fetchTiming(timingUrl(id, which)).then(function (t) {
        if (t || which === voices.default || !known(voices.default)) return t;
        return fetchTiming(timingUrl(id, voices.default));
      });
    });
  }

  /** Which ayah covers this moment. The list is in order, so a walk from where
      we were costs nothing while playing and a search only on a seek. */
  function ayahAt(t) {
    var a = timing.ayah;
    if (at >= 1 && at <= a.length) {
      var i = at - 1;
      if (t >= a[i][0] && t < a[i][1]) return at;
      if (i + 1 < a.length && t >= a[i + 1][0] && t < a[i + 1][1]) return at + 1;
    }
    var lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (t < a[mid][0]) hi = mid - 1;
      else if (t >= a[mid][1]) lo = mid + 1;
      else return mid + 1;
    }
    /* Between two ayahs — the pause after one is still that one's, so the
       highlight rests where the reciter left it rather than going out. */
    return Math.max(1, Math.min(a.length, lo));
  }

  /* Which word of an ayah is being said. The timings are pairs of time and
     word: the word is named rather than implied by position because a reciter
     doubles back — twenty-six ayahs of Al-Baqarah do. */
  function wordAt(v, t) {
    var w = timing.word[v - 1];
    if (!w || !w.length) return 0;
    var d = t - timing.ayah[v - 1][0];
    for (var i = w.length - 2; i >= 0; i -= 2) if (d >= w[i]) return w[i + 1];
    return w[1];
  }

  /* Where one word sits: its end is where the next begins, and the last word
     of an ayah runs to the ayah's end, taking the reciter's pause with it. */
  function wordTime(v, k) {
    var w = timing.word[v - 1], span = timing.ayah[v - 1];
    if (!w || !w.length) return span;
    /* The first time this word is said, where it is said more than once — that
       is the one the reader pointed at. */
    for (var i = 0; i < w.length; i += 2) {
      if (w[i + 1] !== k) continue;
      return [span[0] + w[i], i + 2 < w.length ? span[0] + w[i + 2] : span[1]];
    }
    return span;
  }

  /* ---------- the highlight ------------------------------------------------ */

  /**
   * Move the mark. Reaches the DOM only where something actually changed:
   * this runs on an animation frame, and at sixty a second a blind rewrite
   * would be the one thing here that could cost a frame.
   */
  function light(key, w) {
    lit.ayah = key;
    var id = key === null || w === null ? null : key + '/' + w;

    /* The element is held, not just its name. Clearing asks for "no word", and
       comparing names alone made that a no-op whenever the name was already
       null — so the last word marked stayed marked for good. */
    if (id === lit.word && lit.el && lit.el.isConnected) return;

    var next = id
      ? document.querySelector('.m-word[data-a="' + key + '"][data-w="' + w + '"]')
      : null;

    /* A timing that names a word this page does not print. It happens: the
       mushaf sets إِل ياسين at 37:130 as one word and the segmentation counts
       two, so its last index belongs to nothing. Rather than put the mark out —
       which reads as the recitation having stopped — the word already marked is
       left alone until a timing arrives that does match something. */
    if (id && !next) return;

    if (lit.el) lit.el.classList.remove('r-word');
    lit.el = next;
    if (next) next.classList.add('r-word');
    lit.word = id;
  }

  function clear() { light(null, null); }

  /* Put the mark back after a page is built. What is marked is remembered by
     ayah and word, not by element, since the spans are made and destroyed. */
  function repaint() {
    var a = lit.ayah, w = lit.word;
    lit.ayah = lit.word = null;
    lit.el = null;
    if (a) light(a, w ? +w.split('/')[1] : null);
  }

  /* ---------- following the recitation ------------------------------------ */

  /* A page turn while reciting is the app moving the reader, not the reader
     moving. Held briefly so the scroll it starts is not immediately undone by
     the next frame asking for the same turn again. */
  var turning = 0;

  function follow(v) {
    if (!host || !host.ayahPage) return;
    if (Date.now() < turning) return;
    var p = host.ayahPage(v);
    if (!p || p === host.currentPage()) return;
    turning = Date.now() + 900;
    host.goToPage(p);
  }

  /* Driven from two places: a frame moves the word smoothly but stops in a
     tab nobody watches, and timeupdate keeps coming four times a second — too
     coarse to follow words with, right for not losing the place. */
  function update() {
    if (!playing || !timing || !audio) return;

    var t = audio.currentTime * 1000;
    var v = ayahAt(t);

    if (v !== at) { at = v; follow(v); }
    light(surah.id + ':' + v, wordAt(v, t));
    progress(t);

    /* Playing one word, and it is over. A word ends where the next starts, so
       the highlight has stepped on; it is put back on the one asked for. */
    if (stopAt !== null && t >= stopAt) {
      stopAt = null;
      pause();
      if (stopWord !== null) light(surah.id + ':' + at, stopWord);
      return true;
    }
    return done(t);
  }

  function tick() {
    frame = null;
    if (!playing) return;
    if (update()) return;                 // something stopped it
    frame = requestAnimationFrame(tick);
  }

  /**
   * Has the stretch being repeated just finished, and what happens next.
   * Checked against the clock rather than waiting for the audio to end,
   * because the loop is usually a few ayahs in the middle of two hours.
   */
  function done(t) {
    /* Switched off is switched off. The scope and the count are remembered so
       they come back when it is switched on again, but while it is off they
       decide nothing — the recitation simply reads on. */
    if (!repeat.on) return false;

    var end = repeat.scope === 'ayah'  ? timing.ayah[repeat.from - 1][1]
            : repeat.scope === 'range' ? timing.ayah[repeat.to - 1][1]
            : repeat.scope === 'surah' ? timing.ayah[timing.ayah.length - 1][1]
            : null;
    if (end === null || t < end) return false;

    if (repeat.left !== Infinity && --repeat.left <= 0) {
      /* The last time through. Stop where the reader asked it to stop rather
         than running on into whatever follows, and set the count back up so
         that pressing play again gives the same number of passes rather than
         one stray one. */
      pause();
      repeat.left = repeat.times;
      sync();
      return true;
    }
    seek(repeat.scope === 'surah' ? 1 : repeat.from);
    return false;
  }

  /* ---------- transport ---------------------------------------------------- */

  function play() {
    if (!audio || !timing) return;
    note('');
    var p = audio.play();
    /* Older browsers return nothing at all from play(). */
    if (!p || !p.then) { playing = true; sync(); if (!frame) frame = requestAnimationFrame(tick); return; }
    p.then(function () {
      playing = true;
      sync();
      if (!frame) frame = requestAnimationFrame(tick);
    }, function (err) {
      /* A refused autoplay, a file that will not load, a codec the browser
         will not take. Whichever it was, say so on the menu: a play button
         that looks pressed and makes no sound is the worst of the outcomes. */
      playing = false;
      sync();
      note(err && err.name === 'NotAllowedError'
        ? (lang() === 'ar' ? 'المتصفح منع التشغيل — اضغط مرة أخرى'
                           : 'The browser blocked playback — press again')
        : (lang() === 'ar' ? 'تعذّر تشغيل التلاوة'
                           : 'This recitation could not be played'));
    });
  }

  function pause() {
    if (audio) audio.pause();
    playing = false;
    if (frame) { cancelAnimationFrame(frame); frame = null; }
    sync();
  }

  /* Play or stop — and, the first time, decide where play means. The menu is
     open on a word, so that word's ayah is where the reader is. Fires only
     while nothing has been positioned; after that, play returns to it. */
  function toggle() {
    if (playing) { pause(); return; }
    if (at < 1 && timing) seek(menuAt.v || 1);
    play();
  }

  /* Show the player and start the surah from its first word: the half of
     listen() that is the same however it was asked for. */
  function begin() {
    if (!timing || !surah) return false;
    if (!menu) build();
    menuAt = { v: 1, w: 0 };
    note('');
    light(surah.id + ':1', 0);
    menu.hidden = false;
    minimized = false;
    sync();

    if (!moved) {
      menu.style.left = menu.style.top = '';
      var m = menu.getBoundingClientRect();
      place((window.innerWidth - m.width) / 2,
            Math.max(8, window.innerHeight - m.height - 24));
    }

    seek(1);
    play();
    return true;
  }

  /** Jump to an ayah and carry the highlight there at once, playing or not. */
  function seek(v) {
    if (!timing || !audio) return;
    stopAt = stopWord = null;
    v = Math.max(1, Math.min(timing.ayah.length, v));
    at = v;
    /* "Repeat the ayah" means the one being listened to, so moving to another
       moves the loop with it. Left behind, it pointed at wherever the loop was
       first set, and the clock was then already past that ayah's end the
       instant playback resumed — so pressing play stopped it again at once. */
    if (repeat.scope === 'ayah') { repeat.from = repeat.to = v; repeat.left = repeat.times; }

    /* Where the timing file says this ayah begins, and nothing else. Ayah 1
       was special-cased once for a recording that seemed to start late; the
       real cause was the wrong cut, and correcting the audio removed both. */
    var from = timing.ayah[v - 1][0];
    audio.currentTime = from / 1000;
    light(surah.id + ':' + v, 0);
    progress(from);
    sync();
    follow(v);
  }

  /* ---------- the menu, which is the whole player -------------------------- */

  var menu = null;
  var el = {};
  var menuAt = { v: 0, w: null };
  // The dock's play starts from the pressed ayah until something has played from it
  var fresh = true;
  /* Once the reader has carried the menu somewhere it stays there: reopening
     it on the next word must not snatch it back across the page. */
  var moved = false;

  /* Folded back to its bar. Like `moved`, this survives being reopened on
     another word — it was asked for, and a menu that unfolded itself every
     time a word was clicked would have to be folded again on every one. It
     does not survive the menu being shut, because that is the reader finishing
     with the player rather than tidying it away. */
  var minimized = false;

  /* Where the menu was standing before it was sent to the corner, so that
     restoring puts it back rather than somewhere new. This is the whole of
     what makes minimising feel like minimising: a window that came back
     somewhere else would have been closed and reopened, not restored. */
  var parked = null;

  /* The fold or unfold currently playing, kept so that a second press cancels
     the first rather than fighting it. */
  var motion = null;

  function ar(n) {
    return String(n).replace(/\d/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'[d]; });
  }

  function lang() { return document.body.getAttribute('data-lang') || 'ar'; }
  function num(n) { return lang() === 'ar' ? ar(n) : String(n); }

  function clock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  var MENU =
    '<div id="r-menu" hidden>' +
      '<div class="r-menu-bar">' +
        '<span class="r-grip" aria-hidden="true"></span>' +
        '<span class="r-menu-head"></span>' +
        /* Folds the menu back to its bar. The player keeps playing and keeps
           saying where it is — what goes away is everything that is only there
           to be pressed, which is most of the height and all of what covers
           the page being read. */
        '<button class="r-menu-min" data-act="minimize" aria-label="تصغير">' +
          '<svg class="r-min-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
               'stroke-width="2.2" stroke-linecap="round">' +
            '<path d="M6.5 12.5h11"/>' +
          '</svg>' +
          '<svg class="r-max-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
               'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M7 14l5-5 5 5"/>' +
          '</svg>' +
        '</button>' +
        '<button class="r-menu-close" data-act="close" aria-label="إغلاق">' +
          '<svg class="r-x-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
               'stroke-width="2.2" stroke-linecap="round">' +
            '<path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/>' +
          '</svg>' +
        '</button>' +
      '</div>' +

      /* The transport, shown only once there is a place in the recitation to
         be at. Before that it would be three buttons that do nothing. */
      '<div class="r-now" hidden>' +
        '<div class="r-seek"><i class="r-played"></i></div>' +
        '<div class="r-transport">' +
          '<button class="r-btn" data-act="prev" aria-label="الآية السابقة">' +
            '<svg class="ic" viewBox="0 0 24 24"><path d="M8 6h2v12H8zm9 0v12l-8-6z"/></svg>' +
          '</button>' +
          '<button class="r-btn r-play" data-act="toggle" aria-label="تشغيل">' +
            '<svg class="ic r-ic-play" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>' +
            '<svg class="ic r-ic-pause" viewBox="0 0 24 24"><path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z"/></svg>' +
          '</button>' +
          '<button class="r-btn" data-act="next" aria-label="الآية التالية">' +
            '<svg class="ic" viewBox="0 0 24 24"><path d="M14 6h2v12h-2zm-7 0l8 6-8 6z"/></svg>' +
          '</button>' +
          '<span class="r-time"></span>' +
        '</div>' +
      '</div>' +

      '<div class="r-acts">' +
        '<button data-act="ayah">' +
          '<svg class="ic" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>' +
          '<span class="lang-ar">تشغيل الآية</span><span class="lang-en">Play this ayah</span>' +
        '</button>' +
        '<button data-act="word">' +
          '<svg class="ic" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>' +
          '<span class="lang-ar">تشغيل الكلمة</span><span class="lang-en">Play this word</span>' +
        '</button>' +
        '<button data-act="repeat" class="r-repeat">' +
          '<svg class="ic" viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>' +
          '<span class="lang-ar">التكرار</span><span class="lang-en">Repeat</span>' +
          '<span class="r-repeat-value"></span>' +
        '</button>' +
        /* Only where there is in fact a choice to make. One recitation and
           this is a row that opens a list of one and changes nothing. */
        '<button data-act="voice" class="r-voice" hidden>' +
          '<svg class="ic" viewBox="0 0 24 24"><path d="M12 12.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2zm0 1.8c-4.2 0-7.2 2.2-7.2 4.6V21h14.4v-2.4c0-2.4-3-4.6-7.2-4.6z"/></svg>' +
          '<span class="lang-ar">القارئ</span><span class="lang-en">Reciter</span>' +
          '<span class="r-voice-value"></span>' +
        '</button>' +
      '</div>' +

      /* Its own panel rather than a third group inside the repeat one: what is
         being repeated and who is reciting are not settings of one another,
         and folding them together would mean opening the repeat panel to
         change reciter. */
      '<div class="r-panel r-voices" hidden></div>' +

      /* Folded into the same menu rather than opening a second panel of its
         own: one surface to learn, and nothing that grows the page. */
      '<div class="r-panel" hidden>' +
        '<div class="r-group">' +
          '<span class="r-legend"><span class="lang-ar">ما يُعاد</span>' +
                                 '<span class="lang-en">Repeat</span></span>' +
          '<button class="r-chip" data-scope="ayah"><span class="lang-ar">الآية</span><span class="lang-en">Ayah</span></button>' +
          '<button class="r-chip" data-scope="range"><span class="lang-ar">مقطع</span><span class="lang-en">Range</span></button>' +
          '<button class="r-chip" data-scope="surah"><span class="lang-ar">السورة</span><span class="lang-en">Surah</span></button>' +
        '</div>' +
        '<div class="r-group">' +
          '<span class="r-legend"><span class="lang-ar">كم مرة</span>' +
                                 '<span class="lang-en">How many</span></span>' +
          '<button class="r-chip" data-times="1">١<span class="r-x">×</span></button>' +
          '<button class="r-chip" data-times="3">٣<span class="r-x">×</span></button>' +
          '<button class="r-chip" data-times="5">٥<span class="r-x">×</span></button>' +
          '<button class="r-chip" data-times="7">٧<span class="r-x">×</span></button>' +
          '<button class="r-chip r-inf" data-times="inf" aria-label="بلا نهاية">∞</button>' +
        '</div>' +
        '<div class="r-group r-range">' +
          '<span class="r-legend"><span class="lang-ar">من الآية</span>' +
                                 '<span class="lang-en">From ayah</span></span>' +
          '<input class="r-from" type="number" min="1" step="1" />' +
          '<span class="r-legend"><span class="lang-ar">إلى</span>' +
                                 '<span class="lang-en">to</span></span>' +
          '<input class="r-to" type="number" min="1" step="1" />' +
        '</div>' +
      '</div>' +

      '<div class="r-note" hidden></div>' +

      /* Minimised, the whole player is a circle in the corner with a ring for
         how far through the surah it is. Inside the menu rather than beside
         it, so one element carries the player in both of its shapes. */
      '<button class="r-bubble" data-act="minimize">' +
        '<svg class="r-bubble-ring" viewBox="0 0 54 54" aria-hidden="true">' +
          '<circle class="r-ring-track" cx="27" cy="27" r="24.5"/>' +
          '<circle class="r-ring-line" cx="27" cy="27" r="24.5"/>' +
        '</svg>' +
        /* Bars, not a face and not a play triangle. A play triangle would
           promise that pressing this starts something, when what it does is
           bring the window back; bars say "there is sound here" and nothing
           more, and they can rise and fall while it is actually running. */
        '<svg class="r-bubble-ic" viewBox="0 0 24 24" aria-hidden="true">' +
          '<rect class="r-bar" x="5.2" y="8" width="2.8" height="8" rx="1.4"/>' +
          '<rect class="r-bar" x="10.6" y="4.5" width="2.8" height="15" rx="1.4"/>' +
          '<rect class="r-bar" x="16" y="9" width="2.8" height="6" rx="1.4"/>' +
        '</svg>' +
      '</button>' +
      /* The phone's player: one row in the Android app's order, shown only on a phone. */
      '<div class="r-dock">' +
        '<button data-act="follow">' +
          '<svg class="ic" viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A9 9 0 0 0 13 3.06V1h-2v2.06A9 9 0 0 0 3.06 11H1v2h2.06A9 9 0 0 0 11 20.94V23h2v-2.06A9 9 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/></svg>' +
          '<span class="lang-ar">تتبع</span><span class="lang-en">Follow</span>' +
        '</button>' +
        '<button data-act="voice" class="r-dock-voice">' +
          '<svg class="ic" viewBox="0 0 24 24"><path d="M12 12.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2zm0 1.8c-4.2 0-7.2 2.2-7.2 4.6V21h14.4v-2.4c0-2.4-3-4.6-7.2-4.6z"/></svg>' +
          '<span class="lang-ar">القارئ</span><span class="lang-en">Reciter</span>' +
        '</button>' +
        '<button data-act="play" class="r-dock-play">' +
          '<span class="r-dock-disc">' +
            '<svg class="ic r-ic-play" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>' +
            '<svg class="ic r-ic-pause" viewBox="0 0 24 24"><path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z"/></svg>' +
          '</span>' +
          '<span class="r-when-paused"><span class="lang-ar">تشغيل</span><span class="lang-en">Play</span></span>' +
          '<span class="r-when-playing"><span class="lang-ar">إيقاف</span><span class="lang-en">Pause</span></span>' +
        '</button>' +
        '<button data-act="repeat" class="r-dock-repeat">' +
          '<svg class="ic" viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>' +
          '<span class="lang-ar">تكرار</span><span class="lang-en">Repeat</span>' +
        '</button>' +
        '<button data-act="close">' +
          '<svg class="ic" viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>' +
          '<span class="lang-ar">إغلاق</span><span class="lang-en">Close</span>' +
        '</button>' +
      '</div>' +
    '</div>';

  /* The ring's circumference, which is the length of dash a full surah draws.
     r=24.5 in a 54-wide box, so 2πr. */
  var RING = 2 * Math.PI * 24.5;

  function note(text) {
    if (!el.note) return;
    el.note.textContent = text || '';
    el.note.hidden = !text;
  }

  /** Put the menu somewhere it fits, and never off the edge of the screen. */
  function place(left, top) {
    var pad = 8, m = menu.getBoundingClientRect();
    menu.style.left = Math.max(pad, Math.min(window.innerWidth - m.width - pad, left)) + 'px';
    menu.style.top = Math.max(pad, Math.min(window.innerHeight - m.height - pad, top)) + 'px';
  }

  /**
   * Let the menu be dragged by its title bar. It opens over the page it is
   * about, so whatever it offers to play, it is also covering — rather than
   * guess at a position that is never in the way, let it be moved out of it.
   */
  function draggable(bar) {
    var from = null, was = null;
    bar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;     // the close button is not a handle
      if (minimized) return;                      // parked: the corner is its place
      var r = menu.getBoundingClientRect();
      from = { x: e.clientX, y: e.clientY };
      was = { x: r.left, y: r.top };
      /* Keeps the drag alive if the pointer runs off the bar. Throws when the
         pointer is already gone, which is harmless. */
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* gone */ }
      menu.classList.add('r-moving');
      e.preventDefault();                          // no text selection while dragging
    });
    bar.addEventListener('pointermove', function (e) {
      if (!from) return;
      moved = true;
      place(was.x + e.clientX - from.x, was.y + e.clientY - from.y);
    });
    var end = function () { from = null; menu.classList.remove('r-moving'); };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  function build() {
    document.body.insertAdjacentHTML('beforeend', MENU);
    menu = document.getElementById('r-menu');
    el = {
      head: menu.querySelector('.r-menu-head'),
      now: menu.querySelector('.r-now'),
      seek: menu.querySelector('.r-seek'),
      played: menu.querySelector('.r-played'),
      play: menu.querySelector('.r-play'),
      time: menu.querySelector('.r-time'),
      repeat: menu.querySelector('.r-repeat'),
      repeatValue: menu.querySelector('.r-repeat-value'),
      voice: menu.querySelector('.r-voice'),
      dockRepeat: menu.querySelector('.r-dock-repeat'),
      dockVoice: menu.querySelector('.r-dock-voice'),
      voiceValue: menu.querySelector('.r-voice-value'),
      voices: menu.querySelector('.r-voices'),
      min: menu.querySelector('.r-menu-min'),
      bubble: menu.querySelector('.r-bubble'),
      ring: menu.querySelector('.r-ring-line'),
      panel: menu.querySelector('.r-panel:not(.r-voices)'),
      from: menu.querySelector('.r-from'),
      to: menu.querySelector('.r-to'),
      note: menu.querySelector('.r-note'),
    };

    menu.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) {
        if (b.dataset.act) act(b.dataset.act);
        else if (b.dataset.scope) setScope(b.dataset.scope);
        else if (b.dataset.times) setTimes(b.dataset.times);
        else if (b.dataset.voice) setVoice(b.dataset.voice);
      }
      /* Never let a click inside the menu reach the document, which would take
         it straight back down again — the end of a drag included. */
      e.stopPropagation();
    });

    function bound(input, key) {
      input.addEventListener('change', function () {
        var v = Math.max(1, Math.min(timing ? timing.ayah.length : 1, +input.value || 1));
        repeat[key] = v;
        if (repeat.to < repeat.from) repeat.to = repeat.from;
        repeat.left = repeat.times;
        sync();
      });
    }
    bound(el.from, 'from');
    bound(el.to, 'to');

    fillVoices();
    draggable(menu.querySelector('.r-menu-bar'));
  }

  /* Escaped, because a name comes out of a data file and goes into markup.
     Nothing in the file is hostile today; that is not a reason to build the
     one place where it would matter if it ever were. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* The recitations on offer, as chips: each says the reciter and, under it,
     what tells this recording apart from another by the same voice. */
  var TICK = '<svg class="r-voice-tick" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2.6" stroke-linecap="round" '
    + 'stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  /**
   * The recitations on offer, one to a line.
   *
   * A line, not a chip: two recordings fitted on chips, ten would not, and a
   * wrapped field of pills is a shape you read rather than scan. A column is
   * the same shape at two entries and at twenty. Each line is the reciter and,
   * at the far end, what tells this recording apart from another by that voice.
   */
  function fillVoices() {
    if (!el || !el.voices || !voices) return;
    var rows = voices.recitations.map(function (v) {
      return '<button class="r-voice-row" data-voice="' + esc(v.id) + '">' +
        TICK +
        '<span class="r-voice-name">' +
          '<span class="lang-ar">' + esc(v.nameAr || v.name) + '</span>' +
          '<span class="lang-en">' + esc(v.name) + '</span>' +
        '</span>' +
        ((v.note || v.noteAr)
          ? '<span class="r-voice-note">' +
              '<span class="lang-ar">' + esc(v.noteAr || v.note) + '</span>' +
              '<span class="lang-en">' + esc(v.note || v.noteAr) + '</span>' +
            '</span>'
          : '') +
      '</button>';
    }).join('');

    el.voices.innerHTML =
      '<span class="r-legend"><span class="lang-ar">القارئ</span>' +
                             '<span class="lang-en">Reciter</span></span>' +
      '<div class="r-voice-list">' + rows + '</div>';
  }

  /* Hear the same place in another recording. The place carries over, not the
     clock — two recordings agree on nothing about time. And if it was playing
     it keeps playing, because the answer to "how does this one sound" is the
     sound. */
  function setVoice(id) {
    if (!known(id) || id === chosen()) { el.voices.hidden = true; sync(); return; }

    /* Paused, "here" is the word the menu was opened on. Playing, it is where
       the recitation has got to, which may be ayahs further on. */
    var was = playing, v, k;
    if (was && timing) {
      v = at || menuAt.v || 1;
      k = wordAt(v, audio ? audio.currentTime * 1000 : 0);
    } else {
      v = menuAt.v || at || 1;
      k = menuAt.w;
    }
    /* A word asked for on its own does not survive the switch: its end was a
       moment in the recording being left behind. */
    stopAt = stopWord = null;
    pause();
    voice = id;
    try { localStorage.setItem(REMEMBERED, id); } catch (e) { /* denied */ }

    var s = surah;
    note('');
    fetchTiming(timingUrl(s.id, id)).then(function (t) {
      /* The reader moved on, or asked for a different recording again, while
         this was in the air. */
      if (!surah || surah.id !== s.id || voice !== id) return;
      if (!t) {
        note(lang() === 'ar' ? 'لا تتوفّر هذه التلاوة لهذه السورة'
                             : 'That recitation is not available for this surah');
        return;
      }

      release();
      timing = t;
      attach(t);
      el.from.max = el.to.max = t.ayah.length;
      repeat.from = Math.min(repeat.from, t.ayah.length);
      repeat.to = Math.min(repeat.to, t.ayah.length);

      at = Math.min(v, t.ayah.length);
      var span = (k !== null && k !== undefined) ? wordTime(at, k) : timing.ayah[at - 1];
      audio.currentTime = span[0] / 1000;
      progress(span[0]);
      light(s.id + ':' + at, k === undefined ? null : k);
      el.voices.hidden = true;
      sync();
      if (was) play();
    });
  }

  function setScope(scope) {
    repeat.on = true;               // choosing a kind is asking for it
    repeat.scope = scope;
    /* Repeating "the ayah" means the one in hand — read once, when it is asked
       for, so that carrying on to the next does not silently move the loop. */
    if (scope === 'ayah') repeat.from = repeat.to = menuAt.v || at || 1;
    if (scope === 'range' && repeat.to < repeat.from) repeat.to = repeat.from;
    repeat.left = repeat.times;
    sync();
  }

  function setTimes(times) {
    repeat.on = true;
    repeat.times = times === 'inf' ? Infinity : +times;
    repeat.left = repeat.times;
    sync();
  }

  /** Everything on the menu, against what is actually true right now. */
  function sync() {
    if (!menu) return;

    menu.classList.toggle('r-playing', playing);

    /* Folded away, the menu is its bar and its transport: where the recitation
       is, and the means to stop it. Everything that is only there to be
       pressed goes, panels included — leaving one open under a collapsed menu
       would mean reopening it to find a setting that was never closed. */
    menu.classList.toggle('r-min', minimized);
    if (minimized) { el.panel.hidden = true; el.voices.hidden = true; }
    el.min.setAttribute('aria-label', lang() === 'ar' ? 'تصغير' : 'Minimise');
    el.bubble.setAttribute('aria-label',
      lang() === 'ar' ? 'فتح المشغّل' : 'Open the player');

    /* The transport is there whenever there is a recitation to drive, before
       anything is played as well as after: waiting until playback started grew
       the menu by a row under the reader's hand as they pressed it. */
    el.now.hidden = !timing;
    el.play.setAttribute('aria-label',
      lang() === 'ar' ? (playing ? 'إيقاف' : 'تشغيل') : (playing ? 'Pause' : 'Play'));

    /* The two entries about a single word go away on an ayah's closing number,
       which is printed but never recited. */
    menu.querySelectorAll('[data-act="word"]').forEach(function (b) {
      b.hidden = menuAt.w === null;
    });

    el.repeat.classList.toggle('on', repeat.on);
    el.dockRepeat.classList.toggle('on', repeat.on);
    el.repeat.classList.toggle('open', !el.panel.hidden);
    el.repeatValue.textContent = repeatLabel();

    /* The reciter row appears only where there is more than one recording to
       choose between, and says which one is being heard rather than only that
       a choice exists. */
    var many = !!(voices && voices.recitations.length > 1);
    el.voice.hidden = !many;
    el.dockVoice.hidden = !many;
    if (many) {
      /* The list arrives with the first timing file, which may be after the
         menu was built. Fill it the first time there is something to fill. */
      if (!el.voices.children.length) fillVoices();
      var v = voiceOf(chosen());
      el.voice.classList.toggle('open', !el.voices.hidden);
      el.voiceValue.textContent = v
        ? (lang() === 'ar' ? (v.noteAr || v.nameAr || v.name) : (v.note || v.name))
        : '';
      menu.querySelectorAll('[data-voice]').forEach(function (b) {
        b.classList.toggle('on', b.dataset.voice === voice);
      });
    }

    menu.querySelectorAll('[data-scope]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.scope === repeat.scope);
    });
    menu.querySelectorAll('[data-times]').forEach(function (b) {
      var t = b.dataset.times === 'inf' ? Infinity : +b.dataset.times;
      b.classList.toggle('on', t === repeat.times);
    });
    el.panel.classList.toggle('r-ranged', repeat.scope === 'range');
    el.from.value = repeat.from;
    el.to.value = repeat.to;

    head();
    told();
  }

  /* Say that something changed, for anything outside the player drawing the
     same state. Announced rather than watched: the audio is made with
     new Audio() and never put in the document, so its events reach nothing. */
  function told() {
    document.dispatchEvent(new CustomEvent('recite:state', {
      detail: { playing: playing, surah: surah && surah.id },
    }));
  }

  /** What the repeat is set to, in a few characters, beside its own button. */
  function repeatLabel() {
    if (!repeat.on) return '';
    var what = lang() === 'ar'
      ? { ayah: 'الآية', range: 'مقطع', surah: 'السورة' }[repeat.scope]
      : { ayah: 'ayah', range: 'range', surah: 'surah' }[repeat.scope];
    return what + ' ' + (repeat.times === Infinity ? '∞' : num(repeat.times) + '×');
  }

  /**
   * The title bar says what the menu is about, and that changes: before
   * anything plays it is the word that was clicked, and once a recitation is
   * running it is where the recitation has got to.
   */
  function head() {
    if (!el.head) return;
    if (playing && timing) {
      el.head.textContent = lang() === 'ar'
        ? 'الآية ' + ar(at) + ' من ' + ar(timing.ayah.length)
        : 'Ayah ' + at + ' of ' + timing.ayah.length;
      return;
    }
    var v = menuAt.v, k = menuAt.w;
    el.head.textContent = lang() === 'ar'
      ? (k === null ? 'نهاية الآية ' + ar(v) : 'الآية ' + ar(v) + ' — الكلمة ' + ar(k + 1))
      : (k === null ? 'End of ayah ' + v : 'Ayah ' + v + ', word ' + (k + 1));
  }

  function progress(t) {
    if (!el.played || !timing) return;
    var whole = timing.duration * 1000;
    var through = whole > 0 ? Math.max(0, Math.min(1, t / whole)) : 0;
    el.played.style.width = (through * 100) + '%';
    el.time.textContent = clock(t) + ' / ' + clock(whole);
    /* The same figure the bar draws, drawn round instead — it is the only
       thing the minimised circle has to say that anything is happening. */
    if (el.ring) el.ring.style.strokeDashoffset = String(RING * (1 - through));
    if (playing) head();
  }

  /**
   * Open the menu on a word. `k` is null for an ayah's closing number, which
   * belongs to the ayah but is not something anyone recites.
   */
  function openMenu(target, v, k) {
    if (!menu) build();
    menuAt = { v: v, w: k };
    fresh = true;
    note('');
    sync();

    /* Mark what the menu is about, and leave it marked: the page used to show
       the word only while the pointer was on it. The same band and ink the
       recitation uses, since it means the same thing. */
    light(surah.id + ':' + v, k);

    menu.hidden = false;
    // On a phone the player shows only with the page's chrome, so opening it asks for the chrome too
    document.dispatchEvent(new CustomEvent('recite:opened'));

    /* Folded away, a word being clicked is a request for the window back.
       Everything the click is asking about — play this ayah, this word, set a
       repeat, change reciter — lives in the panel, and the circle offers none
       of it; leaving it folded would answer a question with nothing. It comes
       back where it was minimised from, because that is what restoring means. */
    if (minimized) { setMinimized(false); return; }

    /* Carried somewhere by the reader: it is where it was put, and opening on
       the next word must not snatch it back across the page. */
    if (moved) return;

    /* Shown before it is placed: a hidden element measures as nothing, and
       where it goes depends on how big it is. */
    menu.style.left = menu.style.top = '';
    var r = target.getBoundingClientRect();
    var m = menu.getBoundingClientRect();
    var pad = 8;

    /* Below the word, so it opens over the lines already read rather than the
       ones coming next, and so the hand reaching for it is not covering the
       word it was just pointing at. Above only where there is no room below. */
    var top = r.bottom + 6;
    if (top + m.height > window.innerHeight - pad && r.top - m.height - 6 >= pad) {
      top = r.top - m.height - 6;
    }
    place(r.left + r.width / 2 - m.width / 2, top);
  }

  function closeMenu() {
    if (!menu || menu.hidden) return;
    /* The menu is the player, so shutting it stops the recitation. Leaving it
       running with nothing on screen to stop it would be worse. */
    pause();
    clear();
    menu.hidden = true;
    el.panel.hidden = true;
    el.voices.hidden = true;
    moved = false;
    minimized = false;
    menu.style.left = menu.style.top = '';
  }

  /**
   * Send the menu to the corner, or bring it back.
   *
   * Minimised it is parked, not shortened — and its position goes with it and
   * comes back, because a window that reappears somewhere else was opened
   * again, not restored. The corner is set in CSS, so the inline position has
   * to be lifted for the fold and put back for the unfold.
   */
  function setMinimized(on) {
    if (!menu || on === minimized) return;

    /* Any fold still in the air is abandoned first: a second press is a new
       journey, not a correction to the last one. */
    if (motion) { motion.cancel(); motion = null; }

    /* The panel carries a broad transition, and it has to be off before either
       shape is measured. Left on, the browser would still be sliding `left`
       and the padding towards their new values, so asking where the new shape
       is would answer with where the old one still happens to be — and the
       fold would be measured against a position nothing is ever at. */
    menu.classList.add('r-folding');

    /* Where the shape being replaced stood, measured before anything moves. */
    var from = menu.getBoundingClientRect();
    minimized = on;

    if (on) {
      parked = { left: menu.style.left, top: menu.style.top };
      menu.style.left = menu.style.top = '';
    } else if (parked) {
      menu.style.left = parked.left;
      menu.style.top = parked.top;
      parked = null;
    }

    /* sync() puts the shape on, so the new geometry exists to animate from. */
    sync();
    travel(from);
  }

  /**
   * Carry the player between its two shapes.
   *
   * Swapping one for the other is a flicker: something goes here and something
   * else appears there, and nothing tells the eye they were the same object.
   * The movement does. So the new shape is laid out first, then played back
   * from where the old one stood — measured, so it stays true wherever the
   * reader dragged the menu to.
   */
  function travel(from) {
    /* Measuring forces the new shape to lay out while transitions are off, so
       putting them back starts nothing. Hence the class comes off here: tied
       to the animation, a fold that never finishes disables them for good. */
    var to = menu.getBoundingClientRect();
    menu.classList.remove('r-folding');

    if (!menu.animate) return;                     // no Web Animations: just swap
    if (!from.width || !to.width) return;

    /* Asked for less motion, the journey goes and the fade stays. That setting
       is about being moved at, not about being told something changed. */
    if (window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      motion = menu.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 120, easing: 'ease-out' });
      return;
    }

    var dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    var dy = (from.top + from.height / 2) - (to.top + to.height / 2);

    /* One scale for both axes, or the circle arrives as an oval. And a gentle
       one: starting at the window's full width is a balloon deflating, not a
       window folding away. */
    var scale = Math.max(0.72, Math.min(1.55, from.width / to.width));

    motion = menu.animate([
      { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(' + scale + ')',
        opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }

  function act(what) {
    if (what === 'close') { closeMenu(); return; }
    /* Folding the menu away is about the menu, not about the recitation, so it
       works whether or not this surah has one. */
    if (what === 'minimize') { setMinimized(!minimized); return; }
    if (!timing) return;

    if (what === 'toggle') { toggle(); return; }
    if (what === 'play') {
      if (playing || !fresh) { toggle(); return; }
      fresh = false;
      act('ayah');
      return;
    }
    if (what === 'follow') {
      turning = 0;
      follow(at || menuAt.v);
      return;
    }
    if (what === 'prev' || what === 'next') {
      /* Always plays, whether or not it was playing before: these buttons say
         "the ayah before" and "the ayah after" to someone working through a
         surah, and asking for one is asking to hear it. */
      seek(at + (what === 'next' ? 1 : -1));
      play();
      return;
    }
    if (what === 'repeat') {
      /* One control, and it reads the way it looks: pressed means repeating.
         Turning it on opens the panel so the kind can be chosen; turning it
         off puts the panel away and stops the repeating, whatever is chosen
         inside it. Without this there was no way back to plain reading short
         of setting the count to one and the scope to the whole surah. */
      repeat.on = !repeat.on;
      repeat.left = repeat.times;
      if (repeat.on && repeat.scope === 'ayah') repeat.from = repeat.to = menuAt.v || at || 1;
      el.panel.hidden = !repeat.on;
      if (!el.panel.hidden) el.voices.hidden = true;   // one panel open at a time
      sync();
      return;
    }
    if (what === 'voice') {
      el.voices.hidden = !el.voices.hidden;
      if (!el.voices.hidden) el.panel.hidden = true;
      sync();
      return;
    }

    var v = menuAt.v, k = menuAt.w;

    if (what === 'ayah') {
      /* Starts at this ayah and lets the repeat setting say what happens at
         the end of it. It used to force the scope to this one ayah, which made
         "play" mean "play this and stop" no matter what had been chosen. */
      seek(v);
      play();

    } else if (what === 'word' && k !== null) {
      var span = wordTime(v, k);
      at = v;
      audio.currentTime = span[0] / 1000;
      /* This word and no further: it stops itself where the word ends. */
      stopAt = span[1];
      stopWord = k;
      light(surah.id + ':' + v, k);
      progress(span[0]);
      sync();
      play();
    }
  }

  /* ---------- the page ------------------------------------------------------ */

  /** Let go of whatever the pointer was on. */
  function clearHover() {
    if (overWord) { overWord.classList.remove('r-hover-word'); overWord = null; }
  }

  function hover() {
    document.addEventListener('mouseover', function (e) {
      /* A finger does not hover over anything. A tap sends one of these on its
         way past, so the word under it was marked as though the pointer were
         resting there — and on a touch screen a tap means "show me the
         chrome", not "this word". The mark then sat on the page with nothing
         to explain it. */
      if (touch()) return;

      var t = e.target;
      if (!t || !t.closest) return;
      /* Only words that belong to an ayah. The Basmalah heading each surah is
         drawn from the same word spans but carries no ayah — there is nothing
         to play from it and clicking it did nothing, so marking it and putting
         a hand cursor on it promised something that could not happen. The
         ornamental surah name is not a word span at all and never reacted. */
      var w = t.closest('.m-word[data-a]');

      /* Off the words entirely — the margin, the running head, a surah
         heading, the menu — so let the mark go. The gaps a justified line
         opens between its words are the exception: the pointer crosses them
         constantly on its way from one word to the next, and releasing there
         would make the mark flicker on every word moved over. */
      if (!w) {
        if (!t.closest('.m-line.m-ayah')) clearHover();
        return;
      }

      if (w !== overWord) {
        if (overWord) overWord.classList.remove('r-hover-word');
        overWord = w;
        overWord.classList.add('r-hover-word');
      }
    });

    /* The scroller, rather than a sheet: sheets are rebuilt as the reader
       moves through the surah, and a listener on one would go with it. */
    var area = document.getElementById('content-area');
    if (area) area.addEventListener('mouseleave', clearHover);

    /* Opening the menu on a word, however that was asked for. */
    function pick(w, retried) {
      if (!w || !surah) return;
      var parts = String(w.dataset.a).split(':');

      /* A word from the neighbouring surah: a spread's facing page, or a page
         two surahs share. The recitation belongs to one surah at a time, so it
         moves to that one first and then opens on the word. */
      if (+parts[0] !== surah.id) {
        if (!retried && host && host.switchSurah) {
          host.switchSurah(+parts[0]).then(function (has) { if (has) pick(w, true); });
        }
        return;
      }
      if (!timing) return;
      var v = +parts[1];

      /* Move first, mark second: seek() lights the ayah's opening word, so
         marking last leaves the clicked word marked. */

      /* Once a recitation is under way, clicking another ayah moves to it and
         the page itself becomes the way about.

         Under way, not merely playing: pausing on one ayah and clicking
         another used to leave the transport pointed at the paused one. Paused,
         this moves without starting the sound. Before anything has played
         there is nothing to move, and never for the ayah already held —
         clicking inside it is pointing at a word. */
      if (at >= 1 && v !== at) seek(v);
      openMenu(w, v, w.dataset.w === undefined ? null : +w.dataset.w);
    }

    /* A pointer has a pointer's answer: a click is a click, and it opens the
       menu on the word under it. */
    document.addEventListener('click', function (e) {
      if (touch()) return;
      var w = e.target.closest && e.target.closest('.m-word');
      if (!w) return;
      pick(w);
      e.stopPropagation();
    });

    /* A finger does not. On a touch screen a word is under it constantly, so
       a tap that opened the player made turning a page a coin toss. Held, a
       finger means that one and nothing else. */
    var HELD = 450;
    var timer = null, held = null, from = null, opened = false, swallowUntil = 0;

    function letGo() {
      clearTimeout(timer);
      timer = null;
      held = null;
      from = null;
    }

    document.addEventListener('pointerdown', function (e) {
      if (!touch()) return;
      var w = e.target.closest && e.target.closest('.m-word[data-a]');
      if (!w) return;
      held = w;
      from = { x: e.clientX, y: e.clientY };
      opened = false;
      clearTimeout(timer);
      timer = setTimeout(function () {
        opened = true;
        pick(held);
        letGo();
      }, HELD);
    });

    /* A finger that has travelled is turning the page, not holding a word. */
    document.addEventListener('pointermove', function (e) {
      if (!from) return;
      if (Math.abs(e.clientX - from.x) > 10 || Math.abs(e.clientY - from.y) > 10) letGo();
    });

    // Android sends no click after a long press, so only a click right after the lift is the press's own
    document.addEventListener('pointerup', function () {
      if (opened) swallowUntil = Date.now() + 400;
      opened = false;
      letGo();
    });
    document.addEventListener('pointercancel', letGo);

    /* The click that follows the finger coming up belongs to the press that
       already opened the menu. Caught on the way down, before the page can
       read it as a tap and put its chrome away again. */
    document.addEventListener('click', function (e) {
      if (Date.now() > swallowUntil) return;
      swallowUntil = 0;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  /** Read with a finger rather than a pointer. */
  function touch() {
    return window.matchMedia('(pointer: coarse)').matches;
  }

  /* ---------- opening and closing ------------------------------------------- */

  /** Point a fresh audio element at the recording a timing file describes. */
  function attach(t) {
    audio = new Audio();
    /* Metadata rather than nothing: the menu asks to start partway into a
       two-hour file, and a seek before the browser knows how long the file
       is has nowhere to land. */
    audio.preload = 'metadata';
    /* The timing file says where its own recording lives, so the layout of
       the bucket is decided in one place rather than assembled here from a
       surah number that only happens to match it. */
    audio.src = AUDIO_BASE + '/' + (t.audioPath || (t.surah + '/' + t.audio));
    /* The file has run out — the only notice a repeat gets at the end of the
       surah. done() spots the end of a stretch by watching the clock pass it,
       but the last ayah ends where playback stops and the clock never
       arrives. So the same decision is made here. */
    audio.addEventListener('ended', function () {
      if (repeat.on && timing && !done(timing.ayah[timing.ayah.length - 1][1])) {
        /* done() sent us back to the start; the element is finished, so it
           needs telling to run again. */
        play();
        return;
      }
      pause();
    });
    audio.addEventListener('timeupdate', update);
    audio.addEventListener('error', function () {
      playing = false;
      sync();
      note(lang() === 'ar' ? 'تعذّر تحميل ملف التلاوة'
                           : 'The recitation file could not be loaded');
    });

    /* Timings belong to a recording, not to a reciter. There are three
       recitations of Al-Baqarah by this one alone — 99, 108 and 135 minutes
       long — and the wrong pairing fails silently: the audio plays, the
       highlight moves, and it is simply never on the right word. The lengths
       are the one thing that gives it away, so they are checked out loud. */
    audio.addEventListener('loadedmetadata', function () {
      if (!isFinite(audio.duration)) return;
      var off = Math.abs(audio.duration - t.duration);
      if (off < 2) return;
      console.warn('[recite] surah ' + t.surah + ': the audio is '
        + audio.duration.toFixed(0) + 's but its timings describe a '
        + t.duration.toFixed(0) + 's recording — ' + off.toFixed(0)
        + 's apart. The highlight will not follow.'
        + (t.sourceAudio ? ' Expected: ' + t.sourceAudio : ''));
    });
  }

  /* Let go of the audio element. Not src = '': an empty string resolves
     against the document, so the element fetches the page and sits decoding
     HTML as audio, holding one of six connections. Remove and reload. */
  function release() {
    if (!audio) return;
    audio.pause();
    playing = false;
    told();
    audio.removeAttribute('src');
    audio.load();
    audio = null;
  }

  /**
   * A surah has been opened. Find out whether it has a recitation, and make it
   * available if it does — quietly: nothing appears until a word is clicked.
   */
  function open(s, hooks) {
    var was = surah && surah.id;
    surah = s;
    host = hooks;
    if (was === s.id) return Promise.resolve(!!timing);

    stop();
    return load(s.id).then(function (t) {
      /* Another surah was opened while this was loading. */
      if (!surah || surah.id !== s.id) return false;
      timing = t;
      if (!t) return false;

      attach(t);

      at = 0;
      repeat = { on: false, scope: 'surah', times: Infinity, left: Infinity, from: 1, to: 1 };
      if (!menu) build();
      el.from.max = el.to.max = t.ayah.length;
      return true;
    });
  }

  /** Give up the audio and put the menu away. */
  function stop() {
    pause();
    clear();
    if (menu) {
      menu.hidden = true;
      if (el.panel) el.panel.hidden = true;
      if (el.voices) el.voices.hidden = true;
      moved = false;
      minimized = false;
      menu.style.left = menu.style.top = '';
    }
    release();
    timing = null;
    at = 0;
  }

  function close() {
    stop();
    document.body.classList.remove('is-reciting');
  }

  /* The reader's language can change under a menu that is already up. */
  function relabel() { if (menu && !menu.hidden) sync(); }

  hover();

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });

  /* Frames stop in a hidden tab and start again on return; the loop has to be
     restarted with them, or the highlight would be left to timeupdate alone. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !playing) return;
    update();
    if (!frame) frame = requestAnimationFrame(tick);
  });

  global.Recite = {
    open: open,
    close: close,
    stop: stop,
    repaint: repaint,
    relabel: relabel,

    /* Choose the recitation from outside the menu. Only records it: open()
       asks which one to load anyway, so nothing is loaded twice. */
    use: function (id) {
      try { localStorage.setItem(REMEMBERED, id); } catch (e) { /* denied */ }
      if (known(id)) { voice = id; return true; }
      /* The list may not have been fetched yet, in which case the stored
         choice will be honoured the moment it is. */
      voice = null;
      return false;
    },

    /* Start this surah from its first ayah, with the player up: for being sent
       here with no word to anchor the menu to, so it opens near the foot. */
    listen: function (id) {
      if (!surah) return false;

      /* Asked for in a recording other than the one on hand — the reciter was
         changed from outside while this surah was already open. The timings
         here belong to the other recitation and would be played against this
         one's audio, which is the silent failure this whole thing is built to
         avoid, so fetch the matching pair first and start when it is in. */
      if (id && known(id) && (id !== chosen() || !timing)) {
        var s = surah;
        pause();
        voice = id;
        try { localStorage.setItem(REMEMBERED, id); } catch (e) { /* denied */ }
        if (!menu) build();
        note('');
        return load(s.id).then(function (t) {
          /* The reader moved on, or asked for another recording again, while
             this was in the air. */
          if (!surah || surah.id !== s.id || voice !== id) return false;
          if (!t) {
            note(lang() === 'ar' ? 'لا تتوفّر هذه التلاوة لهذه السورة'
                                 : 'That recitation is not available for this surah');
            return false;
          }
          release();
          timing = t;
          attach(t);
          at = 0;
          el.from.max = el.to.max = t.ayah.length;
          repeat.from = Math.min(repeat.from, t.ayah.length);
          repeat.to = Math.min(repeat.to, t.ayah.length);
          return begin();
        });
      }

      return begin();
    },

    /** Which recording is loaded, for anything outside drawing its own controls. */
    using: function () { return chosen(); },

    /* Change the recording without leaving the place in it, for the download
       panel's own list: "this ayah, in that voice". */
    voice: function (id) { if (menu && timing) setVoice(id); },

    /* Space only means play or pause while the player is actually up. */
    toggle: function () { if (menu && !menu.hidden) toggle(); },
    playing: function () { return playing; },
    available: function () { return !!timing && !!menu && !menu.hidden; },
  };

}(window));
