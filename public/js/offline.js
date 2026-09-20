/**
 * Keeping the whole mushaf on the phone.
 *
 * One font per page, so losing the network loses the glyphs while the markup
 * arrives perfectly. sw.js holds the fonts and the mushaf data; this is the
 * switch that puts it in place and the two things that fill it.
 */
(function (global) {
  'use strict';

  var app = null;

  /** lang(), ar(), surah(), pagesOf(), showValues(), syncTips() */
  function init(host) { app = host; }

  // Off by default: 94 MB is not something to start writing to someone's disk

  var PAGES = 604;
  var offline = localStorage.getItem('quran-offline') === 'on';

  /** Say something to the worker, and hear back on a channel of our own. */
  function swSend(msg, onMessage) {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return false;
    var ch = new MessageChannel();
    if (onMessage) ch.port1.onmessage = function (e) { onMessage(e.data || {}); };
    navigator.serviceWorker.controller.postMessage(msg, [ch.port2]);
    return true;
  }

  /** Keep these pages' fonts, quietly. */
  function keepPages(pages) { swSend({ type: 'cache-pages', pages: pages }); }

  /* The worker is in charge now, so fill it — the whole mushaf, not just the
     pages opened. The surah on screen goes first, so reading stops waiting. */
  function whenControlled() {
    if (!offline) return;
    var surah = app.surah();
    if (surah) keepPages(app.pagesOf(surah));

    /* One question instead of six hundred: walking every page again finds
       nothing to do, but still counts 0-100 and reads as a fresh download. */
    swSend({ type: 'usage' }, function (u) {
      if (u.type !== 'usage') return;
      if (u.fonts >= PAGES) { app.showValues(); return; }
      fillMushaf();
    });
  }

  /** Fetch whatever pages are still missing, counting up as it goes. */
  function fillMushaf() {
    var pages = [];
    for (var p = 1; p <= PAGES; p++) pages.push(p);

    swSend({ type: 'cache-pages', pages: pages }, function (m) {
      if (!offline) return;
      if (m.type === 'progress') {
        var pct = Math.round(m.done / m.total * 100);
        $('#v-offline').text(app.lang() === 'ar' ? app.ar(pct) + '٪' : pct + '%');
      } else if (m.type === 'done') {
        // Say so rather than claim the mushaf is complete
        if (m.failed) {
          $('#v-offline').text(app.lang() === 'ar' ? 'ناقص ' + app.ar(m.failed) : m.failed + ' missing');
        } else {
          app.showValues();
        }
      }
    });
  }

  /* Running inside the app shell. Asked of the user agent the shell stamps,
     since in development the origin is whatever machine is serving it. */
  function native() {
    return navigator.userAgent.indexOf('QuranShell/') >= 0
      || location.hostname === 'appassets.androidplatform.net';
  }

  function applyOffline(on, remember) {
    offline = !!on;
    if (remember) localStorage.setItem('quran-offline', offline ? 'on' : 'off');

    $('#btn-offline').toggleClass('on', offline);
    app.showValues();
    app.syncTips();

    /* Nothing to do in the app: every page is already in the package, and a
       worker would only serve the last version's files after an update. */
    if (native()) {
      $('#v-offline').text(app.lang() === 'ar' ? 'جاهز' : 'ready');
      return;
    }

    if (!navigator.serviceWorker) {
      $('#v-offline').text(app.lang() === 'ar' ? 'غير مدعوم' : 'unsupported');
      return;
    }

    if (offline) {
      navigator.serviceWorker.register('/sw.js').then(function () {
        return navigator.serviceWorker.ready;
      }).then(function () {
        /* Registered is not in control: on the first switch there is no
           controller yet, so a message now reaches nothing. Wait for the claim. */
        if (navigator.serviceWorker.controller) return whenControlled();
        navigator.serviceWorker.addEventListener('controllerchange', whenControlled, { once: true });
      }).catch(function () {
        $('#v-offline').text(app.lang() === 'ar' ? 'تعذّر' : 'failed');
      });
    } else {
      // Off gives the space back; leaving 94 MB behind would be a liberty
      swSend({ type: 'clear' });
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        regs.forEach(function (r) { r.unregister(); });
      });
    }
  }

  global.Offline = {
    init  : init,
    apply : applyOffline,
    keep  : keepPages,
    native: native,
    on    : function () { return offline; },
  };

}(window));
