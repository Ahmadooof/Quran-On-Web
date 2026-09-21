/**
 * The listen-and-download pane: pick a reciter, hear a surah, or keep it.
 *
 * Links rather than fetched bytes — ?dl=1 makes the bucket send
 * Content-Disposition, so the browser streams to disk with its own progress
 * and resume. A blob would have to hold 110 MB of Al-Baqarah in memory.
 */
(function (global) {
  'use strict';

  var app = null;

  /** lang(), ar(), num(), esc(), title(), quran(), surah(), open() */
  function init(host) { app = host; }

  /** Is the listen-and-download tab the one on show? */
  function dlOpen() { return $('.drawer-pane[data-pane="listen"]').hasClass('on'); }

  /* ---------- taking a recitation away with you ----------
     Links rather than fetched bytes: ?dl=1 makes the bucket send
     Content-Disposition, so the browser streams to disk with its own progress
     and resume. A blob would have to hold 110 MB of Al-Baqarah in memory. */

  var dlVoices = null, dlPick = null;

  function audioBase() {
    var el = document.querySelector('meta[name="quran-audio-base"]');
    return ((el && el.getAttribute('content')) || '/surah').replace(/\/$/, '');
  }

  function linksFor(id) {
    return app.quran().map(function (s) {
      var stem = String(s.id).padStart(3, '0');
      return audioBase() + '/' + id + '/' + stem + '.mp3?dl=1';
    });
  }

  function renderDownloads() {
    if (!dlVoices) {
      fetch('/data/recitations.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          dlVoices = (d && d.recitations) || [];
          dlPick = dlPick || (dlVoices[0] && dlVoices[0].id);
          renderDownloads();
        })
        .catch(function () { $('#dl-list').text(app.lang() === 'ar' ? 'تعذّر' : 'unavailable'); });
      return;
    }

    $('#dl-voices').html(dlVoices.map(function (v) {
      return '<button class="dl-voice' + (v.id === dlPick ? ' on' : '') + '" data-id="' + v.id + '">'
        + '<span class="lang-ar">' + v.nameAr + '</span><span class="lang-en">' + v.name + '</span>'
        + ' <small>' + (app.lang() === 'ar' ? v.noteAr : v.note) + '</small></button>';
    }).join(''));

    var links = linksFor(dlPick);
    /* Rebuilt from a string, so the list is new elements: a change of reciter
       would otherwise throw away the scroll and the ticks. */
    var list = document.getElementById('dl-list');
    var was = list ? list.scrollTop : 0;
    var ticked = $('#dl-list .dl-pick:checked').map(function () { return this.dataset.i; }).get();
    $('#dl-list').html(app.quran().map(function (s, i) {
      /* The tick and the link are separate targets on purpose: choosing for a
         batch and fetching one now are different intentions. */
      /* The one the reader is on, which after a listen is the one playing.
         Marked from state rather than remembered, so it cannot go stale. */
      return '<label class="dl-row' + (app.surah() && app.surah().id === s.id ? ' open' : '') + '">'
        + '<input type="checkbox" class="dl-pick" data-i="' + i + '" />'
        + '<span class="dl-num">' + (app.lang() === 'ar' ? app.ar(s.id) : s.id) + '</span>'
        /* The same ornamental face the running head wears when this surah is
           being read, so the list names them the way the mushaf does. Glyphs
           from a private-use area read as nothing, hence the spoken label. */
        + (app.lang() === 'ar'
            ? '<span class="dl-name ph-surah" role="img" aria-label="' + app.esc(s.full) + '">'
              + Mushaf.surahTitle(s.id) + '</span>'
            : '<span class="dl-name">' + s.en + '</span>')
        + '<span class="dl-acts">'
        + '<button type="button" class="dl-act dl-listen" data-i="' + i + '" title="'
        + (app.lang() === 'ar' ? 'استماع' : 'Listen') + '">'
        + '<svg class="ic" viewBox="0 0 24 24"><use href="#i-play"/></svg></button>'
        + '<a class="dl-act dl-one" href="' + links[i] + '" download title="'
        + (app.lang() === 'ar' ? 'تنزيل' : 'Download') + '">'
        + '<svg class="ic" viewBox="0 0 24 24"><use href="#i-offline"/></svg></a>'
        + '</span>'
        + '</label>';
    }).join(''));
    if (list) list.scrollTop = was;
    ticked.forEach(function (i) { $('#dl-list .dl-pick[data-i="' + i + '"]').prop('checked', true); });
    dlCount();
    syncListen();
  }

  /** How many are ticked, said on the button that would fetch them. */
  function dlCount() {
    var n = $('.dl-pick:checked').length;
    var all = $('.dl-pick').length;
    $('#dl-all').prop('checked', n > 0 && n === all);
    $('#v-dl-count').text(n ? (app.lang() === 'ar' ? app.ar(n) : n) : '');
    $('#btn-dl-selected').prop('disabled', !n);
  }

  /* Fetch every ticked surah, one after another: a browser will not take 114
     downloads at once, it blocks the rest silently. */
  /**
   * Start one file downloading, in a frame of its own.
   *
   * Not a link click: a tab has one navigation at a time, so clicking the next
   * link while the last waited for its first byte threw that one away. A frame
   * is its own browsing context, so each download waits on nothing.
   */
  function grab(url) {
    var f = document.createElement('iframe');
    f.hidden = true;
    f.src = url;
    document.body.appendChild(f);
    setTimeout(function () { f.remove(); }, 30000);
  }

  function downloadTicked() {
    var picked = $('.dl-pick:checked').map(function () { return +$(this).data('i'); }).get();
    if (!picked.length) return;

    var links = linksFor(dlPick);
    var $b = $('#btn-dl-selected');
    var i = 0;

    $b.prop('disabled', true);

    (function next() {
      if (i >= picked.length) { $b.prop('disabled', false); dlCount(); return; }
      grab(links[picked[i]]);
      i++;
      $b.find('.dl-progress').text(' ' + (app.lang() === 'ar' ? app.ar(i) : i)
        + '/' + (app.lang() === 'ar' ? app.ar(picked.length) : picked.length));
      setTimeout(next, 700);
    }());
  }

  $('#dl-voices').on('click', '.dl-voice', function () {
    dlPick = $(this).data('id');

    /* Picked while something is playing: change the voice there and then,
       holding the place. Told before the list is redrawn, or the rule that
       keeps the two agreeing puts the old chip back. */
    if (window.Recite && Recite.available() && Recite.using() !== dlPick) {
      Recite.voice(dlPick);
    }

    renderDownloads();
  });

  $('#dl-list').on('change', '.dl-pick', dlCount);
  $('#dl-all').on('change', function () {
    $('.dl-pick').prop('checked', $(this).prop('checked'));
    dlCount();
  });

  $('#btn-dl-selected').on('click', downloadTicked);

  /* Listening is not a download with a different verb: it takes the reader to
     the surah, with the reciter they picked here, and starts it. The panel has
     done its job by then and gets out of the way. */
  $('#dl-list').on('click', '.dl-listen', function (e) {
    e.preventDefault();
    e.stopPropagation();          /* the row is a label — do not tick it */
    var s = app.quran()[+$(this).data('i')];
    if (!s) return;

    /* Pressing the row already going stops it, and again carries on, which is
       what the player does. Only a different surah starts something new. */
    var here = app.surah() && app.surah().id === s.id;
    if (here && window.Recite && Recite.available() && Recite.using() === dlPick) {
      Recite.toggle();
      syncListen();
      return;
    }

    /* On the way to another surah the choice is made before the timings are
       fetched. Staying put, listen() does the swap itself. */
    if (!here && window.Recite) Recite.use(dlPick);
    var ready = app.open(s);
    history.pushState({ surah: s.id }, '', '/surah/' + s.id + '/');

    /* The panel stays where it is: someone sampling reciters wants a few in a
       row, and closing it is the reader's call. */
    $('#dl-list .dl-row').removeClass('open');
    $(this).closest('.dl-row').addClass('open');

    if (ready && ready.then) {
      ready.then(function (has) {
        if (!has || !window.Recite) { syncListen(); return; }
        return Promise.resolve(Recite.listen(dlPick)).then(syncListen);
      });
    }
  });

  /* Read off the player rather than remembered here: the menu behind the
     panel, a surah ending and a failed file all stop it too. */
  function syncListen() {
    /* One choice of reciter wherever it was made, or the chips would name one
       recording while another was heard. */
    if (window.Recite && Recite.available() && dlVoices) {
      var now = Recite.using();
      if (now && now !== dlPick) { dlPick = now; renderDownloads(); return; }
    }

    var on = !!(window.Recite && Recite.playing() && Recite.using() === dlPick);
    $('#dl-list .dl-row').each(function () {
      var going = on && $(this).hasClass('open');
      $(this).find('.dl-listen')
        .attr('title', going ? (app.lang() === 'ar' ? 'إيقاف' : 'Pause')
                             : (app.lang() === 'ar' ? 'استماع' : 'Listen'))
        .find('use').attr('href', going ? '#i-pause' : '#i-play');
    });
  }

  /* The player says so whenever its state moves; its audio element is not in
     the document, so there is nothing else to listen to. */
  document.addEventListener('recite:state', syncListen);

  global.Listen = {
    init  : init,
    render: renderDownloads,
    sync  : syncListen,
    showing: dlOpen,
  };

}(window));
