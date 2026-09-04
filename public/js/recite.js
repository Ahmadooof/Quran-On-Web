/**
 * Recitation: play a surah, and light the words as they are read.
 *
 * The audio is one file for the whole surah, so where each ayah and each word
 * falls in it is worked out ahead of time and shipped beside it as
 * <nnn>.<recitation>.timing.json — see scripts/fetch-audio-timing.js and
 * scripts/import-qul-timing.js. This module is the other half: it follows the
 * clock and moves the highlight.
 *
 * More than one recitation can be shipped, and the reader picks. Which ones
 * exist is public/data/recitations.json; the choice is remembered in this
 * browser and is otherwise that file's default.
 *
 * There is no player along the foot of the screen. A bar would stand there
 * through every reading, taking a strip of the page from people who are not
 * listening to anything, to offer controls that mean nothing until a
 * recitation is running. So the menu a word opens is the player: it is where
 * you ask for the ayah, where you stop it, and where the repeat is set. It can
 * be dragged anywhere and shut when it is done with.
 *
 * One highlight, whatever the reason for it. A band is an ayah, coloured ink
 * is the word inside it — and pointing at a word and hearing it recited put
 * the same marks in the same places. Starting a recitation used to change the
 * band's colour and box the word, which made beginning to listen look like a
 * change of subject rather than the same page carrying on.
 *
 * Nothing here reads the mushaf data. Every word carries the ayah it belongs
 * to and its position in that ayah, written on it when the page was built.
 */
(function (global) {
  'use strict';

  /* Where the recordings live. They are tens of megabytes a surah and do not
     belong on the app's own server, so the base is settable — point it at a
     CDN bucket and nothing else changes. The timings are small and ship with
     the app, so they are always local.

     Read from a meta tag, not from a global a script set. The site is served
     under script-src 'self' with no 'unsafe-inline', so an inline script
     naming the bucket never runs: the value would be quietly undefined, the
     base would fall back to the path below, and every recitation would 404
     against our own server. A meta tag needs no exception in the policy. */
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

  /* What the reader asked to hear again, and how often. `left` counts down;
     Infinity is the loop that does not stop.

     There is always a scope; the count is what decides whether anything is
     actually heard twice. "Once" is a number, not a separate mode, so there is
     no "no repeat" to pick and nothing to leave switched off by mistake.

     `on` is the switch, and it is off to begin with: a recitation starts where
     it was asked to and carries on through the ayahs that follow, because that
     is what reciting is. The scope and the count describe what a repeat would
     be *if* one is wanted, and they keep saying so while it is switched off —
     turning it back on should give what was chosen before, not a blank.

     The scope it starts at is the surah. Asking for a repeat almost always
     means "again, from the top" — someone reading a surah through wants to
     hear it through again, and the reader who wants one ayah over and over is
     already in the panel choosing. */
  var repeat = { on: false, scope: 'surah', times: Infinity, left: Infinity, from: 1, to: 1 };

  /* The ayah playback is currently inside, 1-based. */
  var at = 0;

  /* Where to stop, when the reader asked for one word rather than a stretch of
     recitation, and which word that was. Null the rest of the time. */
  var stopAt = null;
  var stopWord = null;

  /* ---------- which recitation ---------------------------------------------

     More than one recording of the Quran can be shipped, and which one a
     reader hears is theirs to choose. A recording is named by an id that is at
     once the folder it occupies on the audio bucket and the name its timing
     files carry, so the whole of "where is it" is that one string.

     The list is data rather than something written here, because the two
     things that would have to agree — what the picker offers and what is
     actually on disk — are then one thing. */

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

  /**
   * The recitation to use: what this reader chose last, if it is still one of
   * the ones on offer, and otherwise the default.
   *
   * A remembered id is checked against the list rather than trusted, so a
   * recording that is withdrawn does not leave anyone with a reader that
   * silently plays nothing.
   */
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

  /**
   * This surah's timings for the chosen recitation.
   *
   * Falls back to the default recording where the chosen one has nothing for
   * this surah. A part-finished recitation is a thing that happens — the
   * timings are added a surah at a time — and the reader losing the ability to
   * listen at all, on a page where a perfectly good recording exists, would be
   * a poor way to report it.
   */
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

  /**
   * Which word of an ayah is being said.
   *
   * The timings are a flat run of pairs — how far into the ayah, and which
   * word starts being said then. The word is named rather than implied by its
   * position because a reciter does not only go forwards: in twenty-six ayahs
   * of Al-Baqarah this one doubles back over a phrase and says it again, and a
   * list of one time per word could not describe that.
   */
  function wordAt(v, t) {
    var w = timing.word[v - 1];
    if (!w || !w.length) return 0;
    var d = t - timing.ayah[v - 1][0];
    for (var i = w.length - 2; i >= 0; i -= 2) if (d >= w[i]) return w[i + 1];
    return w[1];
  }

  /**
   * Where one word sits in the recitation. Its end is where the next word
   * begins, and the last word of an ayah runs to the end of the ayah — which
   * hands it the pause the reciter takes there, and that pause is part of how
   * the word sounds.
   */
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

  /**
   * Put the mark back after a page has been built. Pages are built as the
   * reader reaches them and dropped again behind, so the span carrying the
   * mark is made and destroyed under it. What is marked is remembered by ayah
   * and word rather than by element, so restoring it is only a matter of
   * asking for those names again on the new spans.
   */
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

  /**
   * Put everything where the clock says it should be.
   *
   * Driven from two places on purpose. An animation frame is what makes the
   * word move smoothly, but frames stop arriving in a tab nobody is looking
   * at — and the recitation carries on, so a reader who switches away and
   * comes back would find the highlight where they left it, minutes behind.
   * The audio's own timeupdate keeps coming regardless, four times a second:
   * too coarse to follow words with, exactly right for not losing the place.
   */
  function update() {
    if (!playing || !timing || !audio) return;

    var t = audio.currentTime * 1000;
    var v = ayahAt(t);

    if (v !== at) { at = v; follow(v); }
    light(surah.id + ':' + v, wordAt(v, t));
    progress(t);

    /* Playing one word, and it is over. Checked before the repeat, which is
       about whole ayahs and has nothing to say about this.

       A word ends where the next one starts, so by this moment the highlight
       has already stepped on. It is put back: what the reader asked to hear
       was this word, and this word is what should be left lit. */
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

  /**
   * Play or stop — and, the first time, decide where "play" means.
   *
   * The menu is open on a word, so that word's ayah is where the reader is;
   * starting at the top of the surah instead would be the player answering a
   * question nobody asked. This only ever fires while nothing has been
   * positioned yet: once there is a place in the recitation, pausing and
   * playing return to it.
   */
  function toggle() {
    if (playing) { pause(); return; }
    if (at < 1 && timing) seek(menuAt.v || 1);
    play();
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

    /* Where the timing file says this ayah begins, and nothing else. No case
       is special and nothing is worked out here: asking for an ayah plays it
       from its own mark.

       Ayah 1 was special-cased once, to open at the top of the file so the
       Basmalah was not cut off. That was written to explain a recording which
       seemed to begin three seconds late — and the real cause turned out to be
       that the recording was the wrong cut, with its timings belonging to a
       different master. Correcting the audio removed the symptom, and the
       special case with it: it had only been standing in front of the fault. */
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
        '<button data-act="from">' +
          '<svg class="ic" viewBox="0 0 24 24"><path d="M4 5.5v13l9-6.5zm9 0v13l9-6.5z"/></svg>' +
          '<span class="lang-ar">المتابعة من هنا</span><span class="lang-en">Continue from here</span>' +
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

      /* Minimised, the whole player is this and nothing else: a circle in the
         corner with the reciter's mark on it, and a ring around it saying how
         far through the surah the recitation has got. Pressing it brings the
         window back. It is inside the menu rather than beside it so that one
         element carries the player in both of its shapes — there is no second
         thing to place, to hide, or to forget to remove. */
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

  /**
   * The recitations on offer, as chips.
   *
   * Each says the reciter and, under it, what tells this recording apart from
   * the other by the same voice — which is the whole of the choice when a
   * reader has two recordings of one reciter in front of them. Both scripts
   * are written and the page's own language rules pick one, the way every
   * other pair of labels in this menu does.
   */
  var TICK = '<svg class="r-voice-tick" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2.6" stroke-linecap="round" '
    + 'stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  /**
   * The recitations on offer, one to a line.
   *
   * A line, not a chip. Two recordings fitted on chips; ten would not, and a
   * wrapped field of pills is a shape you have to read rather than scan. A
   * column of lines is the same shape at two entries and at twenty, scrolls
   * when there are more than fit, and puts every name at the same starting
   * edge so the eye runs straight down them.
   *
   * Each line is the reciter and then, held to the far end, what tells this
   * recording apart from another by the same voice — which is the whole of the
   * choice when a reader has two recordings of one reciter in front of them.
   * Both scripts are written and the page's own language rules pick one, as
   * every other pair of labels in this menu does.
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

  /**
   * Hear the same place in another recording.
   *
   * The reader is somewhere — an ayah, often a word — and that place is what
   * carries over, not the clock: two recordings of one surah agree on nothing
   * about time, so keeping the second count would land the switch at a
   * different point in the recitation every time. And if it was playing it
   * keeps playing, because the answer to "what does this one sound like" is
   * the sound.
   */
  function setVoice(id) {
    if (!known(id) || id === chosen()) { el.voices.hidden = true; sync(); return; }

    /* Where "here" is depends on whether anything is being read aloud. Paused,
       it is the word the menu was opened on, because that is the word the
       reader is looking at and pointing to. Playing, it is wherever the
       recitation has got to since — which may be ayahs away from where the
       menu was opened, and taking the menu's word then would answer "what does
       this one sound like" by jumping somewhere the reader had left behind. */
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
       anything has been played as well as after.

       It used to wait until playback had actually started, on the reasoning
       that three buttons with nowhere to be are not worth showing. What that
       produced was a menu which grew by a row the instant the first word was
       played: the reader pressed something, the whole panel jumped under their
       hand, and a control they had not asked for appeared where they were
       about to click. A player that changes shape the first time it is used is
       worse than one that shows a play button it is ready to honour. */
    el.now.hidden = !timing;
    el.play.setAttribute('aria-label',
      lang() === 'ar' ? (playing ? 'إيقاف' : 'تشغيل') : (playing ? 'Pause' : 'Play'));

    /* The two entries about a single word go away on an ayah's closing number,
       which is printed but never recited. */
    menu.querySelectorAll('[data-act="word"], [data-act="from"]').forEach(function (b) {
      b.hidden = menuAt.w === null;
    });

    el.repeat.classList.toggle('on', repeat.on);
    el.repeat.classList.toggle('open', !el.panel.hidden);
    el.repeatValue.textContent = repeatLabel();

    /* The reciter row appears only where there is more than one recording to
       choose between, and says which one is being heard rather than only that
       a choice exists. */
    var many = !!(voices && voices.recitations.length > 1);
    el.voice.hidden = !many;
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
    note('');
    sync();

    /* Mark what the menu is about, and leave it marked. The heading names the
       word — "ayah 7, word 2" — but the page showed it only while the pointer
       was still on it, so by the time the reader had moved across to the menu
       there was nothing to say which word they had picked.

       The same band and the same ink the recitation uses, not a third kind of
       mark: it means the same thing, "this one", and it is about to become the
       recited one anyway the moment anything is played. */
    light(surah.id + ':' + v, k);

    menu.hidden = false;

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
   * Minimised, it is not a shorter menu standing where the long one stood — it
   * is parked, out at the edge of the screen where nothing is being read, the
   * way a minimised window leaves the desk and waits on the bar. Its position
   * goes with it and comes back with it: restoring returns it to the spot it
   * was dragged or opened at, because a window that reappears somewhere else
   * was never restored, only opened again.
   *
   * The corner is set in the stylesheet, so the inline position has to be
   * lifted out of the way for the fold and put back for the unfold.
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
   * The window and the circle are in different places and are wildly different
   * sizes, so swapping one for the other is a flicker: something disappears
   * here and something else appears over there, and nothing tells the eye they
   * were the same object. What does tell it is the movement between them.
   *
   * So the new shape is laid out first and then played backwards from where
   * the old one stood — starting scaled and offset so that it exactly covers
   * the shape being replaced, and settling into its own place. Folding, the
   * circle starts window-sized and collapses to the corner; unfolding, the
   * window starts circle-sized in the corner and opens out. Measuring rather
   * than guessing means it stays true wherever the reader has dragged the
   * menu to.
   */
  function travel(from) {
    /* Measuring forces the new shape to be laid out while the transitions are
       still off, which both gives a true answer and settles the new values as
       the ones a later recalculation will start from. Putting the transitions
       back straight afterwards therefore starts nothing: the change they would
       have animated has already happened.

       This is why the class comes off here rather than when the fold ends. Tie
       it to the animation finishing and a fold that never finishes — a tab
       sent to the background mid-flight, a compositor that drops it — leaves
       the panel with its transitions switched off for good. */
    var to = menu.getBoundingClientRect();
    menu.classList.remove('r-folding');

    if (!menu.animate) return;                     // no Web Animations: just swap
    if (!from.width || !to.width) return;

    /* Asked for less motion, the journey is dropped and a plain fade is kept.
       What that setting is about is being moved at — things flying across the
       screen, growing, sliding past one another — not about being told that
       something changed. Removing the fold as well leaves the player vanishing
       from one place and appearing in another with nothing in between, which
       is the one thing a reader is least likely to follow. */
    if (window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      motion = menu.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 120, easing: 'ease-out' });
      return;
    }

    var dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    var dy = (from.top + from.height / 2) - (to.top + to.height / 2);

    /* One scale for both axes: the two shapes are not the same proportion, and
       stretching to match would have the circle arrive as an oval.

       And a gentle one. Starting the circle at the window's full width means
       beginning with a blue disc the size of the panel and a giant pair of
       bars inside it, which is not a window folding away — it is a balloon
       deflating. Held near its own size, the movement does the describing and
       the fade covers the rest, which is what the eye was following anyway. */
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
    if (what === 'prev' || what === 'next') {
      /* Always plays, whether or not it was playing before. A music player
         stepping tracks while paused stays paused, because there the list is
         being browsed; here the buttons say "the ayah before" and "the ayah
         after" to someone who is working through a surah, and asking for one
         is asking to hear it. Staying silent would make it two presses for one
         intention every time the reciter had been stopped to think. */
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

    } else if ((what === 'word' || what === 'from') && k !== null) {
      var span = wordTime(v, k);
      at = v;
      audio.currentTime = span[0] / 1000;
      /* One word stops itself at the end of that word; continuing from here
         carries on into the rest of the surah. */
      stopAt = what === 'word' ? span[1] : null;
      stopWord = what === 'word' ? k : null;
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

    /* A click opens the menu on that word. Only where there is a recitation to
       play: elsewhere a word is text, and clicking it should do nothing. */
    document.addEventListener('click', function (e) {
      var w = e.target.closest && e.target.closest('.m-word');
      if (!w || !timing || !surah) return;
      var parts = String(w.dataset.a).split(':');
      if (+parts[0] !== surah.id) return;
      var v = +parts[1];

      /* Move first, mark second. seek() lights the ayah's opening word, being
         where playback will start from — so doing it after the menu opened
         wiped out the mark on the word actually clicked and put it back on the
         first word of the ayah. Marking last leaves the clicked word marked,
         while the audio still sits at the start of the ayah, which is where
         "play this ayah" means to begin. */

      /* Once a recitation is under way, clicking another ayah moves to it —
         the page itself becomes the way to get about, and the menu need not be
         gone through at all.

         Under way, not merely playing. Pausing on one ayah and clicking
         another used to leave the player still pointed at the paused one: the
         menu opened on the ayah that was clicked, but the transport, the
         counter and the next press of play all belonged to the ayah before it,
         which is two places at once and neither of them the one asked for.
         Paused, this moves the position without starting the sound; playing,
         it carries straight on from there.

         Before anything has played at all there is nothing to move, so a click
         opens the menu and no more — an ayah can still be looked at, or set to
         repeat, without the sound starting. And never for the ayah already
         held: clicking inside it is pointing at a word, not asking to go back
         to the beginning of it. */
      if (at >= 1 && v !== at) seek(v);
      openMenu(w, v, w.dataset.w === undefined ? null : +w.dataset.w);
      e.stopPropagation();
    });
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
    /* The file has run out.
     *
     * For a repeat that reaches the end of the surah, this is the only notice
     * there is. done() spots the end of a stretch by watching the clock pass
     * it, which works while there is recitation on the other side — but the
     * end of the last ayah is the end of the file, and playback stops there.
     * The clock never arrives, the check never fires, and "repeat the surah"
     * quietly did nothing at all. So the same decision is put here, with the
     * clock held at the end it never quite reached. */
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

  /**
   * Let go of the audio element.
   *
   * Not `src = ''`. An empty string is resolved against the document, so the
   * element goes off and fetches the page itself and sits there trying to
   * decode HTML as audio — holding one of the six connections the browser
   * allows this host while it fails. Open four or five surahs in a row and the
   * next recitation has nothing left to load through: it never errors, it
   * simply never starts. Removing the attribute and reloading is the one
   * teardown that actually lets the element go.
   */
  function release() {
    if (!audio) return;
    audio.pause();
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
    /* Space only means play or pause while the player is actually up. */
    toggle: function () { if (menu && !menu.hidden) toggle(); },
    playing: function () { return playing; },
    available: function () { return !!timing && !!menu && !menu.hidden; },
  };

}(window));
