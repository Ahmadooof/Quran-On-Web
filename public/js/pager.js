/**
 * Turning the leaf on a phone: the browser scrolls, and only three pages exist.
 *
 * Scrolling has to be the browser's — it runs on the compositor, and every
 * version that moved the pages from script put the main thread in the way of
 * each frame. Three pages, so the furthest a gesture can reach is one page.
 */
(function (global) {
  'use strict';

  var app = null;
  var go2 = function () {};
  var forget = function () {};

  /** phone(), mode(), setPage(), crossTo() */
  function init(host) { app = host; }

  /** Pages laid side by side and turned, rather than stacked and scrolled. */
  function paging() {
    return app.phone() && app.mode() !== 'spread';
  }
  /* Once the scroll settles on a neighbour the window is rebuilt around it and
     the scroller put back in the middle, in the same frame: a carousel. */
  function pager() {
    var area = document.getElementById('content-area');
    var row = document.getElementById('ayahs-container');
    if (!area || !row) return;

    var at = 0;              /* the page being read, as an index into the row */
    var settleTimer = null;
    var telling = null;

    /* Rebuilding the window with a finger down pulls the page out from under
       it, and at a surah's edge the gesture is the only evidence of a turn. */
    var touching = false, held = 0, heldY = 0, waiting = false;
    var SWIPE = 40;

    function pages() { return row.children; }

    // Which of the three is on screen: 0 before, 1 being read, 2 after
    function showing() {
      var w = area.clientWidth;
      return w ? Math.round(Math.abs(area.scrollLeft) / w) : 0;
    }

    /* The page being read in the middle, its neighbours either side. The rest
       leave the layout, so the scroller is three screens wide, never more. */
    function window3() {
      var els = pages();
      var first = Math.max(0, at - 1);

      for (var j = 0; j < els.length; j++) {
        var near = Math.abs(j - at) <= 1;
        els[j].classList.toggle('pg-off', !near);
      }

      // The reader put back where they already are: it must not be visible
      var w = area.clientWidth;
      area.scrollLeft = -(at - first) * w;
    }

    // After the turn, never during: this writes to storage and warms fonts
    function told() {
      var el = pages()[at];
      if (el && el.dataset.page) app.setPage(+el.dataset.page);
      build();
    }

    /* Five pages built, the rest let go. Not the observers' job: a page out of
       the layout looks far away to them, so they drop the next neighbour. */
    function build() {
      var els = pages();
      for (var j = 0; j < els.length; j++) {
        var d = Math.abs(j - at);
        if (d <= 2) Leaves.hydrate(els[j]);
        else if (d > 3) Leaves.dehydrate(els[j]);
      }
    }

    function go(i, quietly) {
      var els = pages();
      at = Math.max(0, Math.min(els.length - 1, i));
      window3();
      clearTimeout(telling);
      if (quietly) told();
      else telling = setTimeout(told, 60);
    }

    /* Where the scroll came to rest, and what that means. */
    function settled() {
      /* Never while the reader is still holding the page. */
      if (touching) { waiting = true; return; }
      waiting = false;

      var was = at;
      var seen = showing();
      var first = Math.max(0, was - 1);
      var now = first + seen;

      if (now === was) {
        /* Came back to where it started, or never left. */
        window3();
        return;
      }

      /* One page either way — the window makes anything else impossible. */
      if (now > was && was === pages().length - 1) { app.crossTo(1); return; }
      if (now < was && was === 0) { app.crossTo(-1); return; }

      go(now, false);
    }

    area.addEventListener('scroll', function () {
      if (!paging()) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settled, 90);
    }, { passive: true });

    // --- swipe: the leaf follows the finger up to one page, then finishes the turn or springs back ---
    // The scroller is moved, not the row: a transform on the row is cancelled out by the browser clamping scrollLeft
    var SLIDE_MS = 240;
    var dragging = null, base = 0, heldAt = 0, settling = null;

    // Right to left: the next leaf sits at a lower scrollLeft, so a finger moving right pulls it in
    function hasNeighbour(dir) {
      return dir > 0 ? at < pages().length - 1 : at > 0;
    }

    row.addEventListener('touchstart', function (e) {
      if (!paging() || !e.touches[0]) return;
      if (settling) settling.land();
      touching = true;
      dragging = null;
      held = e.touches[0].clientX;
      heldY = e.touches[0].clientY;
      heldAt = performance.now();
      base = area.scrollLeft;
    }, { passive: true });

    row.addEventListener('touchmove', function (e) {
      if (!touching || !e.touches[0]) return;
      var dx = e.touches[0].clientX - held;
      var dy = e.touches[0].clientY - heldY;
      if (dragging === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        dragging = Math.abs(dx) > Math.abs(dy);
      }
      if (!dragging) return;
      var w = area.clientWidth;
      var dir = dx > 0 ? 1 : -1;
      // Past the last leaf the page only gives a little, then the lift moves to the next surah
      var room = hasNeighbour(dir) ? dx : dx * 0.25;
      area.scrollLeft = base - Math.max(-w, Math.min(w, room));
    }, { passive: true });

    function lifted(e) {
      if (!touching) return;
      touching = false;
      var wasDragging = dragging;
      dragging = null;

      if (!wasDragging) {
        /* Anything the scroll wanted to settle while the finger was down. */
        if (waiting) {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(settled, 60);
        }
        return;
      }

      var t = e.changedTouches && e.changedTouches[0];
      var dx = t ? t.clientX - held : 0;
      var speed = Math.abs(dx) / Math.max(1, performance.now() - heldAt);
      var w = area.clientWidth;
      var dir = dx > 0 ? 1 : -1;
      // A turn is a drag past a quarter of the page, or a quick flick
      var wanted = Math.abs(dx) > w * 0.25 || (Math.abs(dx) >= SWIPE && speed > 0.35);

      if (wanted && !hasNeighbour(dir)) {
        slide(base, null);
        app.crossTo(dir);
        return;
      }
      slide(wanted ? base - dir * w : base, wanted ? dir : null);
    }

    // Eases the scroller the rest of the way, then the window is rebuilt around the leaf it landed on
    function slide(to, dir) {
      if (settling) settling.land();
      var from = area.scrollLeft;
      var w = area.clientWidth || 1;
      var ms = Math.max(120, SLIDE_MS * Math.abs(to - from) / w);
      var started = performance.now();
      var was = at;
      var landed = false;

      function land() {
        if (landed) return;
        landed = true;
        settling = null;
        area.scrollLeft = to;
        if (dir) go(was + dir, false);
      }

      function step(now) {
        if (landed) return;
        var k = Math.min(1, (now - started) / ms);
        // Ease out: fast where the finger left off, gentle at the leaf
        area.scrollLeft = from + (to - from) * (1 - Math.pow(1 - k, 3));
        if (k < 1) requestAnimationFrame(step); else land();
      }

      settling = { land: land };
      requestAnimationFrame(step);
    }

    row.addEventListener('touchend', lifted, { passive: true });
    row.addEventListener('touchcancel', lifted, { passive: true });

    area.addEventListener('scrollend', function () {
      if (!paging()) return;
      clearTimeout(settleTimer);
      settled();
    });

    go2 = function (page) {
      if (!paging()) return false;
      var els = pages();
      for (var j = 0; j < els.length; j++) {
        if (+els[j].dataset.page === page) { go(j, true); return true; }
      }
      return false;
    };

    forget = function () { if (paging()) go(0, true); };

    window.addEventListener('resize', function () {
      if (paging()) window3();
      else {
        var els = pages();
        for (var j = 0; j < els.length; j++) els[j].classList.remove('pg-off');
      }
    });
  }

  global.Pager = {
    init   : init,
    start  : pager,
    paging : paging,
    go     : function (p) { return go2(p); },
    forget : function () { return forget(); },
  };

}(window));
