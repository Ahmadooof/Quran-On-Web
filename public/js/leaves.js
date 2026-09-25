/**
 * Which pages are built, which wait staged beside them, and which are let go.
 * A page can only be fitted while the browser lays it out, so the spread on
 * either side is laid out off screen: a turn is a swap, not a build.
 */
(function (global) {
  'use strict';

  var app = null;

  /** version, data(), ayahs(), mode(), page(), fitted(), settled(), setPage() */
  function init(host) { app = host; }

  function hydrate(section) {
    var box = section.querySelector('.mushaf');
    if (!box) return;

    var version = app.version;
    /* A box drawn with a since-evicted face shows its glyph codes as text, so
       it counts as built only while its own face is still registered. */
    if (box.dataset.version === version && !Mushaf.hasFont(version, section.getAttribute('data-page'))) {
      Mushaf.empty(box);
    }
    if (box.dataset.version === version || box.dataset.pending === version) return;

    var p = section.getAttribute('data-page');
    box.dataset.pending = version;
    box.classList.remove('font-missing', 'failed');
    var data = app.data(), ayahs = app.ayahs();
    Mushaf.fill(box, data.pages[p], version, data.basmalah,
                data.marks && data.marks[p], ayahs && ayahs.enter[p]);

    // Text beside the glyphs; the page draws without it, so a failed fetch costs nothing
    Mushaf.loadWords(p).then(function (list) {
      if (section.isConnected && (box.dataset.pending === version || box.dataset.version === version)) Mushaf.setWords(box, list);
    }, function () {});

    Mushaf.loadPageFont(version, p).then(function (family) {
      if (!section.isConnected || box.dataset.pending !== version) return;
      box.style.fontFamily = '"' + family + '"';
      // Not document.fonts.ready: it waits on the neighbours being fetched too
      start();
    }, function () {
      /* Two-argument `then`, so only the font load lands here: a fault in the
         fit below is not mistaken for a missing file. */
      if (box.dataset.pending === version) box.classList.add('font-missing');
    });

    function start() {
      if (!section.isConnected || box.dataset.pending !== version) return;

      /* A page just shown measures as nothing until it is laid out, so a failed
         fit retries — on a frame, or a timer where frames have stopped. */
      var nextTry = function (fn) {
        var ran = false;
        var once = function () { if (!ran) { ran = true; fn(); } };
        requestAnimationFrame(once);
        setTimeout(once, 32);
      };

      var settle = function (retries) {
        if (!section.isConnected || box.dataset.pending !== version) return;
        if (Mushaf.layout(box, app.data().fit.centreBelow[version])) {
          box.dataset.version = version;
          box.classList.add('ready');
          /* The turners are placed from --sheet-w, and a sheet just built is
             the first honest measurement of one. */
          app.fitted();
          // New elements, so whatever is being recited is lit again
          if (window.Recite) Recite.repaint();
        } else if (retries > 0) {
          nextTry(function () { settle(retries - 1); });
        } else {
          // Say so rather than leave a blank sheet
          delete box.dataset.pending;
          box.classList.add('failed');
        }
      };
      // A wasted retry costs a frame; a false failure costs the page
      settle(20);
    }
  }

  /* Dropping a page's lines keeps its fitted font size, so the shell still
     reserves exactly the height it had and the scroll position holds. */
  function dehydrate(section) {
    var box = section.querySelector('.mushaf');
    if (box && box.firstChild) Mushaf.empty(box);
  }
  /* A page font is its own ~170 KB file and is the slow part of a turn, so the
     neighbours are fetched while the reader is still here. Idempotent. */
  var warmTimer = null;

  function warmPages(list) {
    list.forEach(function (n) {
      if (n >= 1 && n <= 604) Mushaf.loadPageFont(app.version, n);
    });
  }

  /* The next page is warmed at once — one fetch, and a debounce here meant
     fast clicking warmed nothing. The rest wait for the reader to settle. */
  function warmNeighbours() {
    var page = app.page(), start = spreadStart(page);
    warmPages(app.mode() === 'spread' ? [start + 2, start + 3] : [page + 1]);

    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(function () {
      warmPages(app.mode() === 'spread'
        ? [start - 2, start - 1, start + 4, start + 5]
        : [page + 2, page - 1]);
    }, 200);
  }

  function sectionFor(n) {
    return document.querySelector('.page-section[data-page="' + n + '"]');
  }

  /* Both sides, because a reader turns back as readily as on: letting the
     leaves just left go only to build them again is the slow turn. */
  var staged = [];

  /** Keep the neighbouring spreads built, and let go of everything further. */
  function restage(start) {
    if (app.mode() !== 'spread') return;
    var near = [start - 2, start - 1, start + 2, start + 3].filter(sectionFor);

    // A page nobody is near holds a font for nothing; the registry is 24 deep
    staged.forEach(function (n) {
      if (near.indexOf(n) >= 0) return;
      var el = sectionFor(n);
      if (!el || el.classList.contains('in-spread')) return;
      el.classList.remove('staged', 'spread-right', 'spread-left');
      dehydrate(el);
    });
    staged = near;

    var later = window.requestIdleCallback || function (fn) { return setTimeout(fn, 150); };
    near.forEach(function (n) {
      var el = sectionFor(n);
      /* Staged as the leaf it will be: the head's bookmark lane depends on the
         side, and swapping it at the turn moved the juz and the folio across. */
      el.classList.add('staged', n % 2 ? 'spread-right' : 'spread-left');
      later(function () { if (el.classList.contains('staged')) hydrate(el); });
    });
  }

  /** A spread is an odd page and the even one facing it: 1|2, 3|4, ... */
  function spreadStart(p) { return p % 2 ? p : p - 1; }

  /* Kept so a turn touches four sheets, not all fifty of a surah: writing to
     each invalidated its container query, which was the cost of a turn. */
  var onShow = [];

  /** Show only the spread holding this page, and remember where we are. */
  function showSpread(p) {
    var start = spreadStart(p);
    // A page this surah has not got: open at its first rather than show nothing
    if (!sectionFor(start) && !sectionFor(start + 1)) {
      var first = document.querySelector('.page-section');
      if (!first) return;
      start = spreadStart(+first.getAttribute('data-page'));
    }

    // The fonts before the fitting, for the turn that finds its leaves cold
    warmPages([start, start + 1]);

    onShow.forEach(function (n) {
      var el = sectionFor(n);
      if (el) el.classList.remove('in-spread', 'spread-right', 'spread-left');
    });

    /* The odd page is the right leaf, as the mushaf falls open. */
    var right = sectionFor(start), left = sectionFor(start + 1);
    if (right) { right.classList.remove('staged'); right.classList.add('in-spread', 'spread-right'); }
    if (left) { left.classList.remove('staged'); left.classList.add('in-spread', 'spread-left'); }

    /* This frame turns the leaf and nothing else, so the paper is on screen
       before a word is fitted; building here would hold the paint and blink. */
    requestAnimationFrame(function () {
      if (right) hydrate(right);
      if (left) hydrate(left);
      restage(start);
    });

    onShow = [start, start + 1];
    document.getElementById('content-area').scrollTop = 0;
    app.settled();                 // a spread turn lands at once; nothing in flight
    app.setPage(start);
  }

  global.Leaves = {
    init          : init,
    hydrate       : hydrate,
    dehydrate     : dehydrate,
    warm          : warmPages,
    warmNeighbours: warmNeighbours,
    spreadStart   : spreadStart,
    showSpread    : showSpread,
  };

}(window));
