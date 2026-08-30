/**
 * Recitation: play a surah, and light the words as they are read.
 *
 * The audio is one file for the whole surah, so where each ayah and each word
 * falls in it is worked out ahead of time and shipped beside it as
 * <nnn>.timing.json — see scripts/fetch-audio-timing.js. This module is the
 * other half: it follows the clock and moves the highlight.
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
       the tag — a test harness, mainly — still can. */
    return (global.QURAN_AUDIO_BASE || v || '/surah').trim() || '/surah';
  }

  var AUDIO_BASE = configured().replace(/\/$/, '');

  var audio = null;
  var timing = null;          // the loaded timing file, or null
  var surah = null;
  var host = null;            // { goToPage, currentPage, ayahPage }

  var playing = false;
  var frame = null;
  var lit = { ayah: null, word: null, el: null };

  /* What the pointer is on. The ayah and the word are tracked apart, because
     moving along an ayah changes one and not the other. */
  var overAyah = null;
  var overWord = null;

  /* What the reader asked to hear again, and how often. `left` counts down;
     Infinity is the loop that does not stop. */
  var repeat = { scope: 'off', times: Infinity, left: Infinity, from: 1, to: 1 };

  /* The ayah playback is currently inside, 1-based. */
  var at = 0;

  /* Where to stop, when the reader asked for one word rather than a stretch of
     recitation, and which word that was. Null the rest of the time. */
  var stopAt = null;
  var stopWord = null;

  /* ---------- the timing file --------------------------------------------- */

  function pad(n) { return String(n).padStart(3, '0'); }

  function load(id) {
    return fetch('/surah/' + id + '/' + pad(id) + '.timing.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
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

  function words(key) {
    return document.querySelectorAll('.m-word[data-a="' + key + '"]');
  }

  /**
   * Close the band up across the spaces inside an ayah.
   *
   * The mushaf justifies a line by pushing its words apart, so the gap between
   * two of them is different on every line and changes again at every zoom.
   * Each word is therefore told how far it is to the next one, and the CSS
   * bridges exactly that far — the last word of a line, and the last of the
   * ayah, are told nothing, so the band stops where the ayah does.
   *
   * Every rectangle is read before any style is written. Interleaving them
   * would make the browser re-lay out the page between each pair, which on an
   * ayah of thirty words is thirty reflows.
   */
  function band(els) {
    var gaps = [], i;
    for (i = 0; i < els.length; i++) {
      var a = els[i].getBoundingClientRect();
      var b = i + 1 < els.length ? els[i + 1].getBoundingClientRect() : null;
      /* Words on different lines — or on different pages — share no band. A
         line is a couple of ems tall, so agreeing tops is a safe test. */
      var same = b && Math.abs(a.top - b.top) < 2;
      /* The mushaf reads right to left, so the next word sits to the left. */
      gaps.push(same ? Math.max(0, a.left - b.right) : 0);
    }
    for (i = 0; i < els.length; i++) {
      els[i].style.setProperty('--r-gap', gaps[i].toFixed(1) + 'px');
      els[i].classList.add('r-band');
      /* Which sides are joined, so the CSS can square off the corners there:
         a rounded end against a square bridge notches the band at every gap. */
      els[i].classList.toggle('r-join-next', gaps[i] > 0);
      els[i].classList.toggle('r-join-prev', i > 0 && gaps[i - 1] > 0);
    }
  }

  function unband(els) {
    els.forEach(function (el) {
      el.classList.remove('r-band', 'r-join-next', 'r-join-prev');
      el.style.removeProperty('--r-gap');
    });
  }

  /**
   * Move the band and the ink. Every call reaches the DOM only where something
   * actually changed: this runs on an animation frame, and at sixty a second a
   * blind rewrite of a whole ayah's spans is the one thing here that could
   * cost a frame.
   */
  function light(key, w) {
    if (key !== lit.ayah) {
      if (lit.ayah) {
        var off = words(lit.ayah);
        off.forEach(function (x) { x.classList.remove('r-ayah'); });
        /* Only where the pointer is not also holding it banded. */
        if (lit.ayah !== overAyah) unband(off);
      }
      if (key) {
        var on = words(key);
        on.forEach(function (x) { x.classList.add('r-ayah'); });
        band(on);
      }
      lit.ayah = key;
    }

    var id = key === null || w === null ? null : key + '/' + w;
    /* The element is held, not just its name. Clearing the highlight asks for
       "no word", and comparing names alone made that a no-op whenever the name
       was already null — which it was, every time the ayah had just changed —
       so the last word of the previous ayah stayed lit for good. Holding the
       element means letting go of it is always possible. */
    if (id === lit.word && lit.el && lit.el.isConnected) return;

    var next = id
      ? document.querySelector('.m-word[data-a="' + key + '"][data-w="' + w + '"]')
      : null;

    /* A timing that names a word this page does not print. It happens: the
       mushaf sets إِل ياسين at 37:130 as one word and the segmentation counts
       two, so its last index belongs to nothing. Rather than put the highlight
       out — which reads as the recitation having stopped — the word already
       lit is left alone until a timing arrives that does match something. */
    if (id && !next) return;

    if (lit.el) lit.el.classList.remove('r-word');
    lit.el = next;
    if (next) next.classList.add('r-word');
    lit.word = id;
  }

  function clear() { light(null, null); }

  /**
   * Put the highlight back after a page has been built.
   *
   * Pages are built as the reader reaches them and dropped again behind, so
   * the spans carrying the highlight are made and destroyed under it. What is
   * lit is remembered by ayah and word rather than by element, so restoring it
   * is only a matter of asking for those names again on the new spans — and of
   * measuring again, because the band's gaps are in pixels.
   */
  function repaint() {
    var a = lit.ayah, w = lit.word;
    lit.ayah = lit.word = null;
    lit.el = null;
    if (a) light(a, w ? +w.split('/')[1] : null);

    if (overAyah) {
      var els = words(overAyah);
      els.forEach(function (x) { x.classList.add('r-hover'); });
      band(els);
    }
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
    var end = repeat.scope === 'ayah'  ? timing.ayah[repeat.from - 1][1]
            : repeat.scope === 'range' ? timing.ayah[repeat.to - 1][1]
            : repeat.scope === 'surah' ? timing.ayah[timing.ayah.length - 1][1]
            : null;
    if (end === null || t < end) return false;

    if (repeat.left !== Infinity && --repeat.left <= 0) {
      /* The last time through. Stop where the reader asked it to stop rather
         than running on into whatever follows. */
      pause();
      repeat.scope = 'off';
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

  function toggle() { playing ? pause() : play(); }

  /** Jump to an ayah and carry the highlight there at once, playing or not. */
  function seek(v) {
    if (!timing || !audio) return;
    stopAt = stopWord = null;
    v = Math.max(1, Math.min(timing.ayah.length, v));
    at = v;
    audio.currentTime = timing.ayah[v - 1][0] / 1000;
    light(surah.id + ':' + v, 0);
    progress(timing.ayah[v - 1][0]);
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
      '</div>' +

      /* Folded into the same menu rather than opening a second panel of its
         own: one surface to learn, and nothing that grows the page. */
      '<div class="r-panel" hidden>' +
        '<div class="r-group">' +
          '<span class="r-legend"><span class="lang-ar">ما يُعاد</span>' +
                                 '<span class="lang-en">Repeat</span></span>' +
          '<button class="r-chip" data-scope="off"><span class="lang-ar">بلا تكرار</span><span class="lang-en">Off</span></button>' +
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
    '</div>';

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
      panel: menu.querySelector('.r-panel'),
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

    /* Dragging the line seeks by time; the ayah follows from wherever that
       lands rather than the other way round. */
    function scrub(e) {
      if (!timing || !audio) return;
      var r = el.seek.getBoundingClientRect();
      /* The mushaf reads right to left and so does this. */
      var f = Math.max(0, Math.min(1, (r.right - e.clientX) / r.width));
      audio.currentTime = f * timing.duration;
      var t = audio.currentTime * 1000;
      at = ayahAt(t);
      stopAt = stopWord = null;
      light(surah.id + ':' + at, wordAt(at, t));
      progress(t);
      sync();
      follow(at);
    }
    el.seek.addEventListener('pointerdown', function (e) {
      try { el.seek.setPointerCapture(e.pointerId); } catch (err) { /* gone */ }
      el.seek.dataset.down = '1';
      scrub(e);
    });
    el.seek.addEventListener('pointermove', function (e) {
      if (el.seek.dataset.down) scrub(e);
    });
    var up = function () { delete el.seek.dataset.down; };
    el.seek.addEventListener('pointerup', up);
    el.seek.addEventListener('pointercancel', up);

    draggable(menu.querySelector('.r-menu-bar'));
  }

  function setScope(scope) {
    repeat.scope = scope;
    /* Repeating "the ayah" means the one in hand — read once, when it is asked
       for, so that carrying on to the next does not silently move the loop. */
    if (scope === 'ayah') repeat.from = repeat.to = menuAt.v || at || 1;
    if (scope === 'range' && repeat.to < repeat.from) repeat.to = repeat.from;
    repeat.left = repeat.times;
    sync();
  }

  function setTimes(times) {
    repeat.times = times === 'inf' ? Infinity : +times;
    repeat.left = repeat.times;
    /* Asking for a count with nothing chosen to repeat plainly means this
       ayah — the alternative is a control that does nothing. */
    if (repeat.scope === 'off') setScope('ayah'); else sync();
  }

  /** Everything on the menu, against what is actually true right now. */
  function sync() {
    if (!menu) return;

    menu.classList.toggle('r-playing', playing);
    /* The transport appears as soon as there is a position to be at, and stays
       while it is paused — pausing is not the same as being finished. */
    el.now.hidden = !(timing && at >= 1);
    el.play.setAttribute('aria-label',
      lang() === 'ar' ? (playing ? 'إيقاف' : 'تشغيل') : (playing ? 'Pause' : 'Play'));

    /* The two entries about a single word go away on an ayah's closing number,
       which is printed but never recited. */
    menu.querySelectorAll('[data-act="word"], [data-act="from"]').forEach(function (b) {
      b.hidden = menuAt.w === null;
    });

    el.repeat.classList.toggle('on', repeat.scope !== 'off');
    el.repeat.classList.toggle('open', !el.panel.hidden);
    el.repeatValue.textContent = repeatLabel();

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
    if (repeat.scope === 'off') return '';
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
    el.played.style.width = (t / whole * 100) + '%';
    el.time.textContent = clock(t) + ' / ' + clock(whole);
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

    menu.hidden = false;
    if (moved) return;              // the reader put it somewhere; leave it there

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
    moved = false;
    menu.style.left = menu.style.top = '';
  }

  function act(what) {
    if (what === 'close') { closeMenu(); return; }
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
      el.panel.hidden = !el.panel.hidden;
      sync();
      return;
    }

    var v = menuAt.v, k = menuAt.w;

    if (what === 'ayah') {
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
    if (overAyah) {
      var off = words(overAyah);
      off.forEach(function (x) { x.classList.remove('r-hover'); });
      /* Unless the recitation is holding the same ayah banded. */
      if (overAyah !== lit.ayah) unband(off);
      overAyah = null;
    }
    if (overWord) { overWord.classList.remove('r-hover-word'); overWord = null; }
  }

  function hover() {
    document.addEventListener('mouseover', function (e) {
      var w = e.target.closest && e.target.closest('.m-word');

      /* Between two words is not "no ayah". The mushaf justifies its lines by
         opening space between the words, and the pointer crosses that space on
         its way from one to the next — so treating it as leaving made the band
         drop and come straight back on every word the reader moved over. */
      if (!w) return;

      var key = w.dataset.a;
      if (key !== overAyah) {
        if (overAyah) {
          var off = words(overAyah);
          off.forEach(function (x) { x.classList.remove('r-hover'); });
          if (overAyah !== lit.ayah) unband(off);
        }
        overAyah = key;
        var on = words(key);
        on.forEach(function (x) { x.classList.add('r-hover'); });
        band(on);
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
      openMenu(w, v, w.dataset.w === undefined ? null : +w.dataset.w);

      /* With a recitation already running, clicking another ayah is asking to
         hear that one — the page itself becomes the way to move about, and the
         menu need not be gone through at all.

         Only while it is running. Clicking with nothing playing opens the menu
         and no more, so the ayah can still be looked at, or set to repeat,
         without the sound starting; and only for another ayah, since clicking
         inside the one being recited is pointing at a word, not asking to go
         back to the start of it. */
      if (playing && v !== at) seek(v);
      e.stopPropagation();
    });
  }

  /* ---------- opening and closing ------------------------------------------- */

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

      audio = new Audio();
      /* Metadata rather than nothing: the menu asks to start partway into a
         two-hour file, and a seek before the browser knows how long the file
         is has nowhere to land. */
      audio.preload = 'metadata';
      /* The timing file says where its own recording lives, so the layout of
         the bucket is decided in one place rather than assembled here from a
         surah number that only happens to match it. */
      audio.src = AUDIO_BASE + '/' + (t.audioPath || (s.id + '/' + t.audio));
      audio.addEventListener('ended', function () { pause(); });
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
        console.warn('[recite] surah ' + s.id + ': the audio is '
          + audio.duration.toFixed(0) + 's but its timings describe a '
          + t.duration.toFixed(0) + 's recording — ' + off.toFixed(0)
          + 's apart. The highlight will not follow.'
          + (t.sourceAudio ? ' Expected: ' + t.sourceAudio : ''));
      });

      at = 0;
      repeat = { scope: 'off', times: Infinity, left: Infinity, from: 1, to: 1 };
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
      moved = false;
      menu.style.left = menu.style.top = '';
    }
    if (audio) {
      /* Not `src = ''`. An empty string is resolved against the document, so
         the element goes off and fetches the page itself and sits there trying
         to decode HTML as audio — holding one of the six connections the
         browser allows this host while it fails. Open four or five surahs in a
         row and the next recitation has nothing left to load through: it never
         errors, it simply never starts. Removing the attribute and reloading is
         the one teardown that actually lets the element go. */
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio = null;
    }
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
