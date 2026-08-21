$(function () {
  var quran = null, pageOf = {};
  var surah = null, page = null, io = null, surahPages = [];

  var lang  = localStorage.getItem('quran-lang')  || 'ar';
  var theme = localStorage.getItem('quran-theme') || 'light';
  var scale = parseFloat(localStorage.getItem('quran-scale')) || 1;
  var fontId = localStorage.getItem('quran-font') || 'amiri-quran';
  var weight = localStorage.getItem('quran-weight') || '400';

  // `pre: true` means the face already ships in the <head> link; the rest are
  // fetched in one request the first time they are actually needed.
  var FONTS = [
    { id:'amiri-quran',  ar:'أميري قرآن', en:'Amiri Quran',       stack:'"Amiri Quran"',       pre:true },
    { id:'amiri',        ar:'أميري',      en:'Amiri',             stack:'"Amiri"',             pre:true },
    { id:'scheherazade', ar:'شهرزاد',     en:'Scheherazade New',  stack:'"Scheherazade New"'   },
    { id:'naskh',        ar:'نسخ',        en:'Noto Naskh Arabic', stack:'"Noto Naskh Arabic"'  },
    { id:'lateef',       ar:'لطيف',       en:'Lateef',            stack:'"Lateef"'             },
    { id:'markazi',      ar:'مركزي',      en:'Markazi Text',      stack:'"Markazi Text"'       },
    { id:'harmattan',    ar:'هرمتان',     en:'Harmattan',         stack:'"Harmattan"'          },
    { id:'ruqaa',        ar:'عارف رقعة',  en:'Aref Ruqaa',        stack:'"Aref Ruqaa"'         },
    { id:'kufi',         ar:'كوفي',       en:'Noto Kufi Arabic',  stack:'"Noto Kufi Arabic"'   },
    { id:'cairo',        ar:'القاهرة',    en:'Cairo',             stack:'"Cairo"'              },
    { id:'tajawal',      ar:'تجوال',      en:'Tajawal',           stack:'"Tajawal"'            },
    { id:'almarai',      ar:'المراعي',    en:'Almarai',           stack:'"Almarai"'            }
  ];

  var SAMPLE = 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ';
  var saved = loadSaved();
  var sideOpen = localStorage.getItem('quran-side') !== 'closed';
  var narrow = window.innerWidth <= 900;

  var juzOf = {
    1:1,2:1,3:3,4:4,5:6,6:7,7:8,8:9,9:10,10:11,11:11,12:12,13:13,14:13,15:14,
    16:14,17:15,18:15,19:16,20:16,21:17,22:17,23:18,24:18,25:18,26:19,27:19,
    28:20,29:20,30:21,31:21,32:21,33:21,34:22,35:22,36:22,37:23,38:23,39:23,
    40:24,41:24,42:25,43:25,44:25,45:25,46:26,47:26,48:26,49:26,50:26,51:26,
    52:26,53:27,54:27,55:27,56:27,57:27,58:28,59:28,60:28,61:28,62:28,63:28,
    64:28,65:28,66:28,67:29,68:29,69:29,70:29,71:29,72:29,73:29,74:29,75:29,
    76:29,77:29,78:30,79:30,80:30,81:30,82:30,83:30,84:30,85:30,86:30,87:30,
    88:30,89:30,90:30,91:30,92:30,93:30,94:30,95:30,96:30,97:30,98:30,99:30,
    100:30,101:30,102:30,103:30,104:30,105:30,106:30,107:30,108:30,109:30,
    110:30,111:30,112:30,113:30,114:30
  };

  /* ---------- helpers ---------- */

  var icon = function (n) { return '<svg class="ic" viewBox="0 0 24 24"><use href="#i-' + n + '"/></svg>'; };
  var ar = function (n) { return String(n).replace(/\d/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'[d]; }); };
  var num = function (n) { return lang === 'ar' ? ar(n) : String(n); };
  var title = function (s) { return lang === 'ar' ? 'سورة ' + s.name : 'Surah ' + s.transliteration; };

  /* ---------- page index ---------- */

  function buildPageMap(pages) {
    pages.forEach(function (e) {
      var f = e.from.split(':'), t = e.to.split(':');
      var fs = +f[0], fa = +f[1], ts = +t[0], ta = +t[1];
      for (var s = fs; s <= ts; s++) {
        var src = quran.find(function (x) { return x.id === s; });
        if (!src) continue;
        var from = s === fs ? fa : 1;
        var to   = s === ts ? ta : src.total_verses;
        for (var a = from; a <= to; a++) pageOf[s + ':' + a] = e.page;
      }
    });
  }

  /* ---------- boot ---------- */

  function init() {
    applyLang(lang);
    applyTheme(theme);
    applyScale(scale);
    applyFont(fontId);
    applyWeight(weight);
    if (narrow) sideOpen = false;
    setSidebar(sideOpen);

    $.when($.getJSON('data/quran.json'), $.getJSON('data/quran_pages.json'))
      .done(function (q, p) {
        quran = q[0];
        quran.forEach(function (s) { s.juz = juzOf[s.id] || 1; });
        buildPageMap(p[0]);
        buildIndex();

        var last = +localStorage.getItem('quran-last-surah');
        var found = last && quran.find(function (s) { return s.id === last; });
        if (found) open(found, +localStorage.getItem('quran-last-page') || null);
      })
      .fail(function () {
        $('#surah-list').html('<div class="no-data-msg">ضع الملفات في public/data/<br/>Place the JSON files in public/data/</div>');
      });
  }

  function syncTips() {
    $('.rail-btn').each(function () {
      $(this).attr('data-tip', $(this).attr('data-tip-' + lang));
    });
  }

  function applyLang(l) {
    lang = l;
    localStorage.setItem('quran-lang', l);
    $('body').attr('data-lang', l);
    $('html').attr({ lang: l, dir: l === 'ar' ? 'rtl' : 'ltr' });
    syncTips();
  }

  function applyTheme(t) {
    theme = t;
    localStorage.setItem('quran-theme', t);
    $('body').toggleClass('dark-mode', t === 'dark').toggleClass('light-mode', t !== 'dark');
    $('#btn-theme')
      .attr('data-tip-ar', t === 'dark' ? 'الوضع النهاري' : 'الوضع الليلي')
      .attr('data-tip-en', t === 'dark' ? 'Light mode' : 'Dark mode');
    syncTips();
  }

  var fontsLoaded = false;
  function ensureFonts() {
    if (fontsLoaded) return;
    fontsLoaded = true;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2' +
      '?family=Scheherazade+New:wght@400;500;600;700' +
      '&family=Noto+Naskh+Arabic:wght@400..700' +
      '&family=Lateef:wght@400;600;700' +
      '&family=Markazi+Text:wght@400..700' +
      '&family=Harmattan:wght@400;700' +
      '&family=Aref+Ruqaa:wght@400;700' +
      '&family=Noto+Kufi+Arabic:wght@400..700' +
      '&family=Cairo:wght@400..700' +
      '&family=Tajawal:wght@400;500;700' +
      '&family=Almarai:wght@400;700' +
      '&display=swap';
    document.head.appendChild(l);
  }

  function fontById(id) {
    return FONTS.filter(function (f) { return f.id === id; })[0] || FONTS[0];
  }

  function applyFont(id) {
    var f = fontById(id);
    fontId = f.id;
    localStorage.setItem('quran-font', fontId);
    if (!f.pre) ensureFonts();
    document.documentElement.style.setProperty('--quran-font', f.stack + ', "Amiri", serif');
    $('.font-row').removeClass('on').filter('[data-font="' + fontId + '"]').addClass('on');
  }

  function applyWeight(w) {
    weight = String(w);
    localStorage.setItem('quran-weight', weight);
    // Amiri and most quran faces carry only 400 and 700, so 500 would render
    // identically to 400. A hairline stroke draws the missing middle step.
    document.documentElement.style.setProperty('--quran-weight', weight);
    document.documentElement.style.setProperty('--quran-stroke', weight === '500' ? '0.3px' : '0');
    $('#weight-seg button').removeClass('on').filter('[data-w="' + weight + '"]').addClass('on');
  }

  function renderFonts() {
    $('#font-list').html(FONTS.map(function (f) {
      return '<button class="font-row' + (f.id === fontId ? ' on' : '') + '" data-font="' + f.id + '">' +
        '<span class="fr-text">' +
          '<span class="fr-name">' + (lang === 'ar' ? f.ar : f.en) + '</span>' +
          '<span class="fr-sample" style="font-family:' + f.stack + ',serif">' + SAMPLE + '</span>' +
        '</span>' + icon('check') +
      '</button>';
    }).join(''));
  }

  function applyScale(s) {
    scale = Math.min(2, Math.max(0.7, Math.round(s * 100) / 100));
    localStorage.setItem('quran-scale', scale);
    document.documentElement.style.setProperty('--quran-scale', scale);
    $('#font-level').text(Math.round(scale * 100) + '%');
  }

  /* ---------- surah index ---------- */

  function buildIndex() {
    var groups = {};
    quran.forEach(function (s) { (groups[s.juz] = groups[s.juz] || []).push(s); });

    $('#surah-list').html(Object.keys(groups).sort(function (a, b) { return a - b; }).map(function (j) {
      var items = groups[j].map(function (s) {
        return '<div class="surah-item" data-id="' + s.id + '">' +
          '<span class="surah-num">' + s.id + '</span>' +
          '<span class="surah-names">' +
            '<span class="surah-name-ar">' + s.name + '</span>' +
            '<span class="surah-name-en">' + s.transliteration + '</span>' +
          '</span>' +
          '<span class="surah-ayahs-count">' + s.total_verses + '</span>' +
        '</div>';
      }).join('');

      return '<div class="juz-group">' +
        '<div class="juz-label">' +
          '<span class="lang-ar">الجزء ' + j + '</span>' +
          '<span class="lang-en">Juz ' + j + '</span>' +
        '</div>' +
        '<div class="juz-surahs">' + items + '</div>' +
      '</div>';
    }).join(''));
  }

  function setSidebar(on) {
    sideOpen = on;
    localStorage.setItem('quran-side', on ? 'open' : 'closed');
    $('#sidebar').toggleClass('hidden', !on);
    $('#btn-menu-toggle').toggleClass('on', on);
    if (narrow) $('#overlay').prop('hidden', !on);
  }

  /* ---------- rendering ---------- */

  function open(s, goToPage) {
    surah = s;
    localStorage.setItem('quran-last-surah', s.id);
    $('body').addClass('is-reading');

    $('.surah-item').removeClass('active')
      .filter('[data-id="' + s.id + '"]').addClass('active')
      .each(function () { this.scrollIntoView({ block: 'nearest' }); });

    var byPage = {}, order = [];
    (s.verses || []).forEach(function (v) {
      var p = pageOf[s.id + ':' + v.id] || 'x';
      if (!byPage[p]) { byPage[p] = []; order.push(p); }
      byPage[p].push(v);
    });

    var html = order.map(function (p, i) {
      var text = byPage[p].map(function (v) {
        return v.text + ' <span class="verse-num-inline">' + ar(v.id) + '</span>';
      }).join(' ');

      var head = '';
      if (i === 0) {
        head = '<div class="surah-band">' +
            '<span class="band-orn">&#10049;</span>' +
            '<span class="band-name">' + title(s) + '</span>' +
            '<span class="band-orn">&#10049;</span>' +
          '</div>' +
          (s.id !== 1 && s.id !== 9
            ? '<div class="page-bismillah">بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ</div>' : '');
      }

      var foot = p === 'x' ? '' :
        '<div class="page-footer">' +
          '<span class="footer-rule"></span>' +
          '<span class="page-label">' + num(p) + '</span>' +
          '<span class="footer-rule"></span>' +
        '</div>';

      var ribbon = p === 'x' ? '' :
        '<button class="page-ribbon" data-page="' + p + '" title="' +
        (lang === 'ar' ? 'حفظ الصفحة' : 'Bookmark this page') + '"></button>';

      return '<section class="page-section' + (isSaved(p) ? ' saved' : '') + '" data-page="' + p + '">' +
        ribbon + head + '<div class="verses-flow">' + text + '</div>' + foot +
      '</section>';
    }).join('') || '<div class="no-data-msg">نص هذه السورة غير متوفر</div>';

    $('#ayahs-container').html(html);
    $('#welcome-screen').prop('hidden', true);
    $('#reading-area').prop('hidden', false);

    var idx = quran.indexOf(s);
    $('#btn-prev-surah').prop('disabled', idx <= 0);
    $('#btn-next-surah').prop('disabled', idx >= quran.length - 1);

    surahPages = order.filter(function (p) { return p !== 'x'; });
    setPage(surahPages[0] || null);
    watchPages();

    var area = document.getElementById('content-area');
    if (goToPage) {
      var el = document.querySelector('.page-section[data-page="' + goToPage + '"]');
      if (el) el.scrollIntoView({ block: 'start' });
    } else {
      area.scrollTo({ top: 0, behavior: 'auto' });
    }

    if (narrow && sideOpen) setSidebar(false);
  }

  /* Which sheet is in view — handed to the browser instead of measured on
     every scroll event, so scrolling stays free of layout work. */
  function watchPages() {
    if (io) io.disconnect();
    if (!window.IntersectionObserver) return;

    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) setPage(e.target.getAttribute('data-page'));
      });
    }, { root: document.getElementById('content-area'), rootMargin: '-15% 0px -70% 0px' });

    document.querySelectorAll('#ayahs-container .page-section').forEach(function (el) {
      io.observe(el);
    });
  }

  function setPage(p) {
    p = parseInt(p);
    if (!p || p === page) { renderInfo(); return; }
    page = p;
    localStorage.setItem('quran-last-page', p);
    renderInfo();
  }

  function renderInfo() {
    if (!surah) return;
    $('#ri-surah').text(title(surah));

    var at = surahPages.indexOf(page) + 1;
    $('#ri-page').text(at && surahPages.length
      ? (lang === 'ar' ? 'صفحة ' + ar(at) + ' من ' + ar(surahPages.length)
                       : 'Page ' + at + ' of ' + surahPages.length)
      : '');
  }

  /* ---------- saved pages ---------- */

  function loadSaved() {
    try {
      return (JSON.parse(localStorage.getItem('quran-saved') || '[]') || [])
        .filter(function (b) { return b && typeof b.page === 'number'; });
    } catch (e) { return []; }
  }

  function isSaved(p) {
    return saved.some(function (b) { return b.page === parseInt(p); });
  }

  function toggleSaved(p) {
    p = parseInt(p);
    if (!p) return;
    var i = saved.findIndex(function (b) { return b.page === p; });
    if (i >= 0) saved.splice(i, 1);
    else saved.push({
      page: p, surahId: surah.id, surahName: surah.name,
      surahEn: surah.transliteration, date: Date.now()
    });
    localStorage.setItem('quran-saved', JSON.stringify(saved));
    $('.page-section[data-page="' + p + '"]').toggleClass('saved', i < 0);
  }

  function renderSaved() {
    if (!saved.length) {
      $('#bookmarks-list').html(
        '<div class="empty-state">' + icon('bookmark') +
        '<p class="lang-ar">لا توجد صفحات محفوظة</p>' +
        '<p class="lang-en">No saved pages yet</p></div>'
      );
      return;
    }
    $('#bookmarks-list').html(
      saved.slice().sort(function (a, b) { return a.page - b.page; }).map(function (b) {
        return '<div class="bookmark-card" data-page="' + b.page + '">' +
          '<span class="bpn">' +
            '<span class="bpn-value">' + num(b.page) + '</span>' +
            '<span class="bpn-label lang-ar">صفحة</span>' +
            '<span class="bpn-label lang-en">page</span>' +
          '</span>' +
          '<span class="bookmark-info">' +
            '<span class="bookmark-surah">' + (lang === 'ar' ? b.surahName : b.surahEn) + '</span>' +
            '<span class="bookmark-detail">' + new Date(b.date).toLocaleDateString() + '</span>' +
          '</span>' +
          '<button class="bookmark-delete" data-page="' + b.page + '">' + icon('trash') + '</button>' +
        '</div>';
      }).join('')
    );
  }

  function showPanel(which) {
    if (which === 'saved') renderSaved();
    if (which === 'fonts') { ensureFonts(); renderFonts(); }
    $('#bookmarks-panel').prop('hidden', which !== 'saved');
    $('#fonts-panel').prop('hidden', which !== 'fonts');
    $('#btn-bookmarks').toggleClass('on', which === 'saved');
    $('#btn-fonts').toggleClass('on', which === 'fonts');
    $('#overlay').prop('hidden', !(which || (narrow && sideOpen)))
                 .toggleClass('clear', which === 'fonts');
  }

  /* ---------- events ---------- */

  $('#btn-menu-toggle').on('click', function () { setSidebar(!sideOpen); });
  $('#btn-bookmarks').on('click', function () {
    showPanel($('#bookmarks-panel').prop('hidden') ? 'saved' : null);
  });
  $('#btn-fonts').on('click', function () {
    showPanel($('#fonts-panel').prop('hidden') ? 'fonts' : null);
  });
  $('#btn-close-bookmarks, #btn-close-fonts').on('click', function () { showPanel(null); });

  $(document).on('click', '.font-row', function () { applyFont($(this).data('font')); });
  $(document).on('click', '#weight-seg button', function () { applyWeight($(this).data('w')); });
  $('#btn-theme').on('click', function () { applyTheme(theme === 'dark' ? 'light' : 'dark'); });
  $('#btn-font-inc').on('click', function () { applyScale(scale + 0.1); });
  $('#btn-font-dec').on('click', function () { applyScale(scale - 0.1); });

  $('#btn-lang').on('click', function () {
    applyLang(lang === 'ar' ? 'en' : 'ar');
    if (!$('#fonts-panel').prop('hidden')) renderFonts();
    if (surah) open(surah, page);
  });

  $('#btn-fullscreen').on('click', function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });

  $('#overlay').on('click', function () {
    showPanel(null);
    if (narrow && sideOpen) setSidebar(false);
  });

  $(document).on('click', '.surah-item', function () {
    var id = +$(this).data('id');
    var s = quran.find(function (x) { return x.id === id; });
    if (s) open(s);
  });

  $(document).on('click', '.page-ribbon', function () { toggleSaved($(this).data('page')); });

  $(document).on('click', '.bookmark-card', function () {
    var p = +$(this).data('page');
    var b = saved.find(function (x) { return x.page === p; });
    var s = b && quran.find(function (x) { return x.id === b.surahId; });
    if (!s) return;
    showPanel(null);
    open(s, b.page);
  });

  $(document).on('click', '.bookmark-delete', function (e) {
    e.stopPropagation();
    toggleSaved($(this).data('page'));
    renderSaved();
  });

  $('#btn-clear-bookmarks').on('click', function () {
    saved = [];
    localStorage.setItem('quran-saved', '[]');
    $('.page-section').removeClass('saved');
    renderSaved();
  });

  $('#btn-prev-surah').on('click', function () { step(-1); });
  $('#btn-next-surah').on('click', function () { step(1); });

  function step(d) {
    var i = quran.indexOf(surah) + d;
    if (quran[i]) open(quran[i]);
  }

  $('#surah-search').on('input', function () {
    var q = $(this).val().trim().toLowerCase();
    if (!q) { $('.surah-item, .juz-group').show(); return; }
    $('.juz-group').each(function () {
      var hits = 0;
      $(this).find('.surah-item').each(function () {
        var ok = $(this).find('.surah-name-ar').text().includes(q)
              || $(this).find('.surah-name-en').text().toLowerCase().includes(q)
              || String($(this).data('id')).includes(q);
        $(this).toggle(ok);
        if (ok) hits++;
      });
      $(this).toggle(hits > 0);
    });
  });

  $(document).on('keydown', function (e) {
    if ($(e.target).is('input')) return;
    if (e.key === 'Escape') showPanel(null);
    else if (e.key === '+' || e.key === '=') applyScale(scale + 0.1);
    else if (e.key === '-') applyScale(scale - 0.1);
  });

  $(window).on('resize', function () {
    var was = narrow;
    narrow = window.innerWidth <= 900;
    if (was !== narrow) setSidebar(narrow ? false : localStorage.getItem('quran-side') !== 'closed');
  });

  init();
});
