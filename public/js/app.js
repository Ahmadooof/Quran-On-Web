$(function () {
  var quran = null, mushaf = null;
  var surah = null, page = null;
  var io = null, hydrateIO = null, keepIO = null, surahPages = [];

  var lang  = localStorage.getItem('quran-lang')  || 'ar';
  var theme = localStorage.getItem('quran-theme') || 'light';
  var scale = parseFloat(localStorage.getItem('quran-scale')) || 1;
  /* The reader sets the Madinah Mushaf in QCF V2 throughout. The data carries
     V1 codes too, but nothing here reads them. */
  var VERSION = 'v2';
  var weight = localStorage.getItem('quran-weight') || '400';
  var bright = parseInt(localStorage.getItem('quran-bright')) || 100;
  var MODES = ['pages', 'spread'];
  var mode = localStorage.getItem('quran-mode') || 'pages';

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
  var title = function (s) { return lang === 'ar' ? 'سورة ' + s.name : 'Surah ' + s.en; };

  /** Which juz a page falls in. The boundaries are not evenly spaced — juz 7
      opens on page 121, juz 11 on 201 — so they come from the data. */
  function juzOfPage(p) {
    var starts = mushaf.juzPages;
    for (var j = starts.length - 1; j >= 0; j--) if (p >= starts[j]) return j + 1;
    return 1;
  }

  /** The surah a page is headed by: the one its first line belongs to. Where a
      second surah opens further down, the break itself is what names it — the
      head must not claim the whole page for a surah that starts halfway. */
  function surahOfPage(p) {
    for (var i = 0; i < quran.length; i++) {
      if (quran[i].from <= p && p <= quran[i].to) return quran[i];
    }
    return null;
  }

  /**
   * Turn to a page and put it at the top of the screen. A page already built
   * is scrolled to; one in another surah opens that surah at it.
   */
  function goToPage(p) {
    p = Math.min(604, Math.max(1, parseInt(p) || 0));
    if (!p) return;
    var el = document.querySelector('.page-section[data-page="' + p + '"]');
    if (mode === 'spread') {
      var facing = document.querySelector('.page-section[data-page="' + (spreadStart(p) + 1) + '"]');
      if (el && facing) { showSpread(p); return; }
    } else if (el) {
      el.scrollIntoView({ block: 'start' });
      setPage(p);
      return;
    }
    var s = surahOfPage(p);
    if (s) open(s, p);
  }

  /** One page at a time, or one spread. */
  function turn(dir) { goToPage(page + dir * (mode === 'spread' ? 2 : 1)); }

  /** The pages a surah runs over — always a contiguous run. */
  function pagesOf(s) {
    var out = [];
    for (var p = s.from; p <= s.to; p++) out.push(p);
    return out;
  }

  /* ---------- boot ---------- */

  function init() {
    applyLang(lang);
    applyTheme(theme);
    applyScale(scale);
    applyWeight(weight);
    applyBrightness(bright);
    applyMode(mode, true);
    if (narrow) sideOpen = false;
    setSidebar(sideOpen);

    /* Only two files: the 8 KB surah index and the page layout. quran.json is
       not loaded — its verse text is Unicode, which the mushaf fonts cannot
       render, so 1.6 MB of it would be parsed and never used. */
    $.when($.getJSON('data/surahs.json'), $.getJSON('data/mushaf.json'))
      .done(function (q, m) {
        quran  = q[0];
        mushaf = m[0];
        quran.forEach(function (s) { s.juz = juzOf[s.id] || 1; });
        buildIndex();

        /* Page 1's font carries the Basmalah that every surah opening needs, so
           it is fetched up front and pinned against eviction. */
        Mushaf.loadPageFont(VERSION, mushaf.basmalah.page, true);

        var last = +localStorage.getItem('quran-last-surah');
        var found = last && quran.find(function (s) { return s.id === last; });
        if (found) open(found, +localStorage.getItem('quran-last-page') || null);
      })
      .fail(function () {
        $('#surah-list').html('<div class="no-data-msg">' +
          'تعذّر تحميل البيانات — شغّل <code>npm run build:mushaf</code><br/>' +
          'Could not load the data — run <code>npm run build:mushaf</code></div>');
      });
  }

  function syncTips() {
    $('.rail-btn, #brightness-wrap, #page-nav button').each(function () {
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

  /* QCF page fonts ship a single weight, so a heavier setting is drawn as a
     hairline stroke rather than a font-weight the face does not have. */
  var WEIGHTS = ['400', '500', '700'];

  function applyWeight(w) {
    weight = WEIGHTS.indexOf(String(w)) >= 0 ? String(w) : '400';
    localStorage.setItem('quran-weight', weight);
    document.documentElement.style.setProperty('--quran-stroke',
      weight === '700' ? '0.6px' : weight === '500' ? '0.3px' : '0');
    $('#btn-weight').toggleClass('on', weight !== '400')
      .attr('data-tip-ar', 'سماكة الخط — ' + (weight === '700' ? 'عريض' : weight === '500' ? 'متوسط' : 'عادي'))
      .attr('data-tip-en', 'Text weight — ' + (weight === '700' ? 'bold' : weight === '500' ? 'medium' : 'regular'));
    syncTips();
  }

  /* Dims the sheets for night reading. A page cannot touch the device
     backlight, so this lightens or darkens what is drawn instead. */
  function applyBrightness(v) {
    bright = Math.min(100, Math.max(55, parseInt(v) || 100));
    localStorage.setItem('quran-bright', bright);
    document.documentElement.style.setProperty('--page-brightness', bright / 100);
    $('#brightness').val(bright);
  }

  /* 100% is one whole page on screen; above that the page runs taller and
     scrolls, up to whatever the sheet's width allows. */
  function applyScale(s) {
    scale = Math.min(2.5, Math.max(0.6, Math.round(s * 100) / 100));
    localStorage.setItem('quran-scale', scale);
    document.documentElement.style.setProperty('--quran-scale', scale);
    $('#font-level').text(Math.round(scale * 100) + '%');
    refitPages();
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
            '<span class="surah-name-en">' + s.en + '</span>' +
          '</span>' +
          '<span class="surah-ayahs-count">' + s.v + '</span>' +
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
    $('body').toggleClass('side-open', on);
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

    surahPages = pagesOf(s);
    if (mode === 'spread') {
      if (surahPages[0] % 2 === 0) surahPages.unshift(surahPages[0] - 1);
      if (surahPages[surahPages.length - 1] % 2 && surahPages[surahPages.length - 1] < 604) {
        surahPages.push(surahPages[surahPages.length - 1] + 1);
      }
    }

    var container = document.getElementById('ayahs-container');
    container.innerHTML = '';

    if (!surahPages.length) {
      container.innerHTML = '<div class="no-data-msg">نص هذه السورة غير متوفر</div>';
      return;
    }

    /* A mushaf page is shown whole, so a page shared with a neighbouring surah
       carries that surah's lines too — exactly as the printed page does. */
    surahPages.forEach(function (p) {
      var section = document.createElement('section');
      section.className = 'page-section' + (isSaved(p) ? ' saved' : '');
      section.setAttribute('data-page', p);

      /* Bookmark ribbon: hung off the top edge, above everything the sheet
         prints, so it can never crowd the type. */
      var ribbon = document.createElement('button');
      ribbon.className = 'page-ribbon';
      ribbon.setAttribute('data-page', p);
      ribbon.title = lang === 'ar' ? 'حفظ الصفحة' : 'Bookmark this page';
      section.appendChild(ribbon);

      /* The running head a printed mushaf carries: juz on the reading side,
         the surah in the middle, the folio on the other side. */
      var ps = surahOfPage(p);
      var j = juzOfPage(p);
      var head = document.createElement('div');
      head.className = 'page-head';
      head.innerHTML =
        '<span class="page-label ph-juz">' +
          (lang === 'ar' ? 'الجزء ' + ar(j) : 'Juz ' + j) + '</span>' +
        /* The name in the mushaf's own ornamental face, once per page. Its
           vocalised spelling rides along as the label. */
        '<span class="page-label ph-surah" title="' + (ps ? ps.full : '') + '">' +
          (ps ? Mushaf.surahGlyph(ps.id) : '') + '</span>' +
        '<span class="page-label ph-page">' +
          (lang === 'ar' ? 'الصفحة ' + ar(p) : 'Page ' + p) + '</span>';
      section.appendChild(head);

      /* The two numbers CSS sizes the sheet from: how wide this version draws
         a line, and how many lines the page has. */
      section.style.setProperty('--m-base', mushaf.fit.body[VERSION]);
      section.style.setProperty('--m-lines', Mushaf.lineCount(mushaf.pages[p]));

      /* The shell only: it reserves the height of its lines, and the lines
         themselves are built when the page comes into reach. Al-Baqarah is 48
         pages — building all 6400 words up front is what made opening a long
         surah crawl. */
      section.appendChild(Mushaf.createBox());

      var foot = document.createElement('div');
      foot.className = 'page-footer';
      foot.innerHTML = '<span class="page-label">' + num(p) + '</span>';
      section.appendChild(foot);

      container.appendChild(section);
    });

    $('#welcome-screen').prop('hidden', true);
    $('#reading-area').prop('hidden', false);

    var idx = quran.indexOf(s);
    $('#btn-prev-surah').prop('disabled', idx <= 0);
    $('#btn-next-surah').prop('disabled', idx >= quran.length - 1);

    setPage(surahPages[0] || null);

    if (mode === 'spread') {
      showSpread(goToPage || surahPages[0]);
      document.getElementById('content-area').scrollTo({ top: 0, behavior: 'auto' });
    } else {
      watchPages();
      watchFonts();

      var area = document.getElementById('content-area');
      var start = goToPage && document.querySelector('.page-section[data-page="' + goToPage + '"]');
      if (start) {
        start.scrollIntoView({ block: 'start' });
      } else {
        area.scrollTo({ top: 0, behavior: 'auto' });
      }
      /* The page being opened is hydrated outright rather than waiting on the
         observer, so the reader never lands on a blank sheet. */
      hydrate(start || container.firstElementChild);
    }

    if (narrow && sideOpen) setSidebar(false);
  }

  /**
   * Build and tear down pages around the viewport.
   *
   * A surah can run to dozens of pages, each with 15 lines of roughly ten word
   * spans and a font of its own, so only the pages near the reader are built.
   * Two margins rather than one give the swap some hysteresis: a page is built
   * well before it is seen, and only dropped once it is a good way past, so
   * scrolling back and forth does not thrash.
   */
  var BUILD_MARGIN = '150% 0px';
  var KEEP_MARGIN  = '400% 0px';

  function watchFonts() {
    if (hydrateIO) hydrateIO.disconnect();
    if (keepIO) keepIO.disconnect();

    var root = document.getElementById('content-area');
    var sections = document.querySelectorAll('#ayahs-container .page-section');

    if (!window.IntersectionObserver) {
      sections.forEach(function (el) { hydrate(el); });
      return;
    }

    hydrateIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) hydrate(e.target); });
    }, { root: root, rootMargin: BUILD_MARGIN });

    keepIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (!e.isIntersecting) dehydrate(e.target); });
    }, { root: root, rootMargin: KEEP_MARGIN });

    sections.forEach(function (el) { hydrateIO.observe(el); keepIO.observe(el); });
  }

  function hydrate(section) {
    var box = section.querySelector('.mushaf');
    if (!box) return;

    var version = VERSION;
    /* A face is evicted once it falls out of the cache, and a box drawn with a
       face that has since gone shows its glyph codes as raw text. So a built
       box counts as built only while its face is still registered. */
    if (box.dataset.version === version && !Mushaf.hasFont(version, section.getAttribute('data-page'))) {
      Mushaf.empty(box);
    }
    if (box.dataset.version === version || box.dataset.pending === version) return;

    var p = section.getAttribute('data-page');
    box.dataset.pending = version;
    box.classList.remove('font-missing', 'failed');
    Mushaf.fill(box, mushaf.pages[p], version, mushaf.basmalah);

    Mushaf.loadPageFont(version, p).then(function (family) {
      if (!section.isConnected || box.dataset.pending !== version) return;
      box.style.fontFamily = '"' + family + '"';

      /* A page that measures as nothing — not laid out yet — must not be
         marked done, or it would stay blank for good. Clearing `pending` puts
         it back in play, and a frame later it usually measures fine. */
      var settle = function (retries) {
        if (!section.isConnected || box.dataset.pending !== version) return;
        if (Mushaf.layout(box, mushaf.fit.centreBelow[version])) {
          box.dataset.version = version;
          box.classList.add('ready');
        } else if (retries > 0) {
          requestAnimationFrame(function () { settle(retries - 1); });
        } else {
          /* Out of tries. Say so rather than leaving a blank sheet — a page
             that silently never appears is the worst of the options. */
          delete box.dataset.pending;
          box.classList.add('failed');
        }
      };
      settle(8);
    }).catch(function () {
      /* Left un-ready on purpose: the lines stay hidden rather than showing
         the glyph codes as tofu, and the sheet explains itself instead. */
      if (box.dataset.pending === version) box.classList.add('font-missing');
    });
  }

  /* Dropping a page's lines keeps its fitted font size, so the shell still
     reserves exactly the height it had and the scroll position holds. */
  function dehydrate(section) {
    var box = section.querySelector('.mushaf');
    if (box && box.firstChild) Mushaf.empty(box);
  }

  /** Re-measure the pages that are currently built — after a resize or zoom. */
  var refitTimer = null;
  function refitPages() {
    if (refitTimer) clearTimeout(refitTimer);
    refitTimer = setTimeout(function () {
      requestAnimationFrame(function () {
        document.querySelectorAll('#ayahs-container .mushaf.ready').forEach(function (box) {
          Mushaf.layout(box, mushaf.fit.centreBelow[box.dataset.version] || 0.92);
        });
      });
    }, 60);
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
    if (!p) return;
    page = p;
    localStorage.setItem('quran-last-page', p);
    /* Nothing before page 1 or after 604, so the turner that would go nowhere
       is taken away rather than left to do nothing. */
    var step = mode === 'spread' ? 2 : 1;
    var first = mode === 'spread' ? spreadStart(page) : page;
    $('#btn-page-prev').toggleClass('gone', first <= 1);
    $('#btn-page-next').toggleClass('gone', first + step > 604);
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
      surahEn: surah.en, date: Date.now()
    });
    localStorage.setItem('quran-saved', JSON.stringify(saved));
    $('.page-section[data-page="' + p + '"]').toggleClass('saved', i < 0);
  }

  /**
   * How the pages are laid out.
   *   pages   one sheet after another, scrolled
   *   spread  two facing pages at a time, turned two at a time
   */
  function applyMode(m, quiet) {
    mode = MODES.indexOf(m) >= 0 ? m : 'pages';
    localStorage.setItem('quran-mode', mode);
    $('body').attr('data-mode', mode);
    /* Two facing pages need the room, and the index is a page-picker rather
       than something to read alongside. */
    if (mode === 'spread' && sideOpen) setSidebar(false);
    var name = { ar: { pages: 'صفحة واحدة', spread: 'صفحتان' },
                 en: { pages: 'One page', spread: 'Two pages' } };
    $('#btn-mode').attr('data-tip-ar', 'طريقة العرض — ' + name.ar[mode])
                  .attr('data-tip-en', 'Reading mode — ' + name.en[mode]);
    syncTips();
    /* The page list itself differs by mode — a spread needs its facing page,
       which may belong to the surah next door. */
    if (!quiet && surah) open(surah, page);
  }

  /** A spread is an odd page and the even one facing it: 1|2, 3|4, ... */
  function spreadStart(p) { return p % 2 ? p : p - 1; }

  /** Show only the spread holding this page, and remember where we are. */
  function showSpread(p) {
    var start = spreadStart(p);
    /* Everything else is dropped: a spread that is no longer on screen has no
       business holding a page font open, and the cache is only 24 deep. */
    $('.page-section').removeClass('in-spread spread-right spread-left').each(function () {
      var n = +this.getAttribute('data-page');
      if (n !== start && n !== start + 1) dehydrate(this);
    });
    /* The odd page is the right leaf, as the mushaf falls open. */
    $('.page-section[data-page="' + start + '"]').addClass('in-spread spread-right');
    $('.page-section[data-page="' + (start + 1) + '"]').addClass('in-spread spread-left');
    $('.in-spread').each(function () { hydrate(this); });
    document.getElementById('content-area').scrollTop = 0;
    setPage(start);
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
    $('#bookmarks-panel').prop('hidden', which !== 'saved');
    $('#help-panel').prop('hidden', which !== 'help');
    $('#btn-bookmarks').toggleClass('on', which === 'saved');
    $('#btn-help').toggleClass('on', which === 'help');
    $('#overlay').prop('hidden', !(which || (narrow && sideOpen)));
  }

  /* ---------- events ---------- */

  $('#btn-menu-toggle, #sidebar-handle').on('click', function () { setSidebar(!sideOpen); });
  $('#btn-bookmarks').on('click', function () {
    showPanel($('#bookmarks-panel').prop('hidden') ? 'saved' : null);
  });
  $('#btn-help').on('click', function () {
    showPanel($('#help-panel').prop('hidden') ? 'help' : null);
  });
  $('#btn-close-bookmarks, #btn-close-help').on('click', function () { showPanel(null); });

  $('#btn-mode').on('click', function () {
    applyMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  });

  $('#btn-weight').on('click', function () {
    applyWeight(WEIGHTS[(WEIGHTS.indexOf(weight) + 1) % WEIGHTS.length]);
  });
  $('#brightness').on('input', function () { applyBrightness($(this).val()); });

  $('#btn-clear-data').on('click', function () {
    var msg = lang === 'ar'
      ? 'سيُحذف كل ما هو محفوظ: الصفحات المحفوظة، آخر موضع قراءة، والإعدادات. متابعة؟'
      : 'This clears everything stored: saved pages, last position and settings. Continue?';
    if (!window.confirm(msg)) return;
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf('quran-') === 0) localStorage.removeItem(k);
    });
    location.reload();
  });
  $('#btn-theme').on('click', function () { applyTheme(theme === 'dark' ? 'light' : 'dark'); });
  $('#btn-font-inc').on('click', function () { applyScale(scale + 0.05); });
  $('#btn-font-dec').on('click', function () { applyScale(scale - 0.05); });

  $('#btn-lang').on('click', function () {
    applyLang(lang === 'ar' ? 'en' : 'ar');
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
    if (!s) return;
    open(s);
    setSidebar(false);      // the index has done its job — give the page the room
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

  $('#btn-page-prev').on('click', function () { turn(-1); });
  $('#btn-page-next').on('click', function () { turn(1); });

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
    /* The mushaf reads right to left, so the next page is the one to the left.
       Up and down are left alone — they still scroll. */
    if (e.key === 'ArrowLeft' || e.key === 'PageDown') { e.preventDefault(); turn(1); }
    else if (e.key === 'ArrowRight' || e.key === 'PageUp') { e.preventDefault(); turn(-1); }
    else if (e.key === 'Escape') showPanel(null);
    else if (e.key === '+' || e.key === '=') applyScale(scale + 0.05);
    else if (e.key === '-') applyScale(scale - 0.05);
    else if (e.key === '0') applyScale(1);          // back to a whole page
  });

  /* ---------- drag the page ----------
     Grab the sheet and pull, the way you would move a page on a desk, and let
     it glide on when you let go. Only for the mouse: a touch screen already
     scrolls this way, and fighting it would break the native momentum. */

  (function dragScroll() {
    var area = document.getElementById('content-area');
    var down = false, moved = false, onSheet = false, glide = null;
    var startY = 0, startTop = 0, lastY = 0, lastT = 0, speed = 0;

    function stopGlide() {
      if (glide) cancelAnimationFrame(glide);
      glide = null;
      area.classList.remove('free');
    }

    area.addEventListener('pointerdown', function (e) {
      /* Cleared first: a drag that ended without a click would otherwise
         leave this set and swallow the next press. */
      moved = false;
      if (e.pointerType === 'touch' || e.button !== 0) return;
      if (e.target.closest('button, input, a')) return;
      /* Dragging is for the margin beside the sheet. On the sheet itself the
         pointer belongs to the text — but the press is still tracked, so a
         plain click there still shuts the index. */
      onSheet = !!e.target.closest('.page-section');
      stopGlide();
      down = true; speed = 0;
      startY = lastY = e.clientY;
      startTop = area.scrollTop;
      lastT = e.timeStamp;
    });

    area.addEventListener('pointermove', function (e) {
      if (!down) return;
      /* A spread has nothing to scroll, and hiding the scrollbar does not stop
         scrollTop being written, so the drag stands down itself. */
      if (mode === 'spread' || onSheet) return;
      var dy = e.clientY - startY;
      /* A few pixels of slack, so a click on a bookmark ribbon is still a
         click and not a one-pixel drag. */
      if (!moved) {
        if (Math.abs(dy) < 6) return;
        moved = true;
        area.classList.add('dragging', 'free');
        /* Keeps the drag alive if the cursor leaves the pane. Throws if the
           pointer is already gone, which is harmless here. */
        try { area.setPointerCapture(e.pointerId); } catch (err) { /* gone */ }
      }
      area.scrollTop = startTop - dy;
      var dt = e.timeStamp - lastT;
      if (dt > 0) speed = (e.clientY - lastY) / dt;   // px per ms
      lastY = e.clientY;
      lastT = e.timeStamp;
    });

    function release() {
      if (!down) return;
      down = false;
      area.classList.remove('dragging');

      /* A click on the page, not a drag: the index has served its purpose. */
      if (!moved) {
        if (sideOpen && $('#bookmarks-panel').prop('hidden') &&
            $('#help-panel').prop('hidden')) setSidebar(false);
        return;
      }

      var v = speed * 16;               // px per frame at the moment of release
      (function step() {
        v *= 0.94;
        if (Math.abs(v) < 0.4) { stopGlide(); return; }
        area.scrollTop -= v;
        glide = requestAnimationFrame(step);
      }());
    }

    area.addEventListener('pointerup', release);
    area.addEventListener('pointercancel', release);
    /* A drag that ends over a ribbon must not also press it. */
    area.addEventListener('click', function (e) {
      if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
    }, true);
    area.addEventListener('wheel', stopGlide, { passive: true });
  }());

  $(window).on('resize', function () {
    var was = narrow;
    narrow = window.innerWidth <= 900;
    if (was !== narrow) setSidebar(narrow ? false : localStorage.getItem('quran-side') !== 'closed');
    refitPages();
  });

  init();
});
