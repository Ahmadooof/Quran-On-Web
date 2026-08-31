$(function () {
  var quran = null, mushaf = null;
  var surah = null, page = null;
  var io = null, hydrateIO = null, keepIO = null, surahPages = [];
  /* Which ayah every word belongs to, and which page each ayah opens on.
     Built once from the page data — see Mushaf.ayahIndex. */
  var ayahs = null;

  var lang  = localStorage.getItem('quran-lang')  || 'ar';
  /* The device has the last word, every visit. A tap on the theme row holds
     for as long as the tab is open — long enough to read a page in the other
     shade — and is deliberately not stored: come back tomorrow and the phone
     decides again. That is why themeChoice lives here and not in localStorage.
     null means the device is still in charge. */
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  var themeChoice = null;                       // null | 'light' | 'dark'
  var theme = systemDark.matches ? 'dark' : 'light';
  /* Older versions stored a theme. Clear it, or it would sit there for ever
     being ignored. */
  try { localStorage.removeItem('quran-theme'); } catch (e) {}
  var scale = parseFloat(localStorage.getItem('quran-scale')) || 1;
  /* The reader sets the Madinah Mushaf in QCF V2 throughout. The data carries
     V1 codes too, but nothing here reads them. */
  var VERSION = 'v2';
  var weight = localStorage.getItem('quran-weight') || '400';
  var bright = parseInt(localStorage.getItem('quran-bright')) || 100;
  var MODES = ['pages', 'spread'];
  var turners = localStorage.getItem('quran-turners') === 'on';
  /* Two facing pages need room. --spread-min states how much; querying its
     complement rather than a second breakpoint means there is no width where
     both this and the phone layout apply, and none where neither does. */
  var phoneLayout = window.matchMedia('(max-width: ' +
    (parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--spread-min')) || 900) + 'px)');

  /* What the reader chose, and what the screen can actually show — they part
     company on a narrow screen, and the choice is what survives. A first visit
     gets whatever the screen can hold: a mushaf falls open at two pages, so a
     screen with room for them should too. */
  var wantMode = localStorage.getItem('quran-mode') ||
                 (phoneLayout.matches ? 'pages' : 'spread');
  var mode = 'pages';

  var saved = loadSaved();
  /* Open to begin with, where there is room for it: the index is what most
     visits want first, and a reader who arrives at a shut drawer has to find
     the handle before they can find a surah. On a phone it stays shut -- there
     the drawer covers the page rather than sitting beside it, and opening onto
     a covered mushaf would be worse than opening onto a closed drawer.

     Not remembered between visits either way. The drawer lies over the page,
     and restoring it open on a reader who shut it is the opposite of what a
     drawer is for. */
  var sideOpen = !phoneLayout.matches;
  var narrow = phoneLayout.matches;


  /* ---------- helpers ---------- */

  /* Analytics, if any is loaded.
     Which surah is being read needs no event: every surah has its own url, and
     the tracker reports one on each history change, so the Pages report already
     carries it. Reading mode is the one thing left that no url can say.
     Everything goes through here so the reader behaves identically when nothing
     is loaded. */
  function track(name, data) {
    if (window.umami) try { window.umami.track(name, data); } catch (e) {}
  }

  /* Attribute-safe, for the few places a value from the data is written into
     one. The surah names carry no quotes today; this is so that stays true. */
  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

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
  /* Turning counts from the page that was asked for, not the one the observer
     last reported. In one-page mode the scroll is animated, and while it runs
     the observer sees every section that crosses its band and writes each one
     to `page` -- so a second click landing mid-animation used to compute its
     next page from whichever one happened to be passing, and the turn either
     repeated a page or went nowhere. `wanted` is only ever written by a click. */
  var wanted = null;
  var wantedTimer = null;

  /* Held only while a turn is in flight, and never for long. If the page asked
     for never arrives -- it was not in this surah, the scroll was interrupted,
     the observer simply did not fire -- then holding on would silence every
     later report and leave the reader stuck. So it lets go by itself. */
  function wantPage(p) {
    wanted = p;
    if (wantedTimer) clearTimeout(wantedTimer);
    wantedTimer = setTimeout(function () { wanted = null; }, 1200);
  }

  function settled() {
    wanted = null;
    if (wantedTimer) { clearTimeout(wantedTimer); wantedTimer = null; }
  }

  function turn(dir) {
    var from = wanted === null ? page : wanted;
    var step = dir * (mode === 'spread' ? 2 : 1);
    var to = Math.min(604, Math.max(1, from + step));
    if (to === from) return;
    wantPage(to);
    goToPage(to);
  }

  /** The surah a /surah/N/ url names, if the url names one. */
  function surahFromPath() {
    var m = /^\/surah\/(\d+)\/?$/.exec(location.pathname);
    if (!m || !quran) return null;
    var id = +m[1];
    return quran.find(function (s) { return s.id === id; }) || null;
  }

  /** The pages a surah runs over — always a contiguous run. */
  function pagesOf(s) {
    var out = [];
    for (var p = s.from; p <= s.to; p++) out.push(p);
    return out;
  }

  /* ---------- boot ---------- */

  function init() {
    applyLang(lang);
    applyTheme(themeChoice);
    applyScale(scale);
    applyWeight(weight);
    applyBrightness(bright);
    applyTurners(turners);
    applyMode(wantMode, true);   // the choice, not the fallback derived from it
    if (narrow) sideOpen = false;
    setSidebar(sideOpen);

    /* Only two files: the 8 KB surah index and the page layout. quran.json is
       not loaded — its verse text is Unicode, which the mushaf fonts cannot
       render, so 1.6 MB of it would be parsed and never used. */
    $.when($.getJSON('/data/surahs.json'), $.getJSON('/data/mushaf.json'))
      .done(function (q, m) {
        quran  = q[0];
        mushaf = m[0];
        ayahs  = Mushaf.ayahIndex(mushaf.pages, mushaf.marks || {});
        /* Which juz a surah opens in, worked out from where it starts rather
           than from a table repeating what the page data already knows. The
           table that used to live here had At-Tur in juz 26; it opens on page
           523 and juz 27 begins at 522. */
        quran.forEach(function (s) { s.juz = juzOfPage(s.from); });
        buildIndex();

        /* Page 1's font carries the Basmalah that every surah opening needs, so
           it is fetched up front and pinned against eviction. */
        Mushaf.loadPageFont(VERSION, mushaf.basmalah.page, true);

        /* A /surah/N/ page names the surah outright; otherwise pick up where
           the reader left off. A first visit has neither, so the index opens
           and waits — which surah to begin with is theirs to choose. */
        var last = +localStorage.getItem('quran-last-surah');
        var fromUrl = surahFromPath();
        var found = fromUrl ||
                    (last && quran.find(function (s) { return s.id === last; }));
        if (found) {
          /* The remembered page belongs to the remembered surah. Following a
             link to a different one and then asking for a page outside it
             leaves the reader looking at nothing. */
          open(found, fromUrl ? null : (+localStorage.getItem('quran-last-page') || null));
        } else {
          $('.welcome-dots').remove();
          $('.welcome-card p').html(
            '<span class="lang-ar">اختر سورة من الفهرس للبدء</span>' +
            '<span class="lang-en">Choose a surah from the index to begin</span>');
          setSidebar(true);
        }
      })
      .fail(function () {
        /* The splash would otherwise sit there loading for ever. */
        $('.welcome-dots').remove();
        $('.welcome-card p').html(
          '<span class="lang-ar">تعذّر تحميل المصحف. تحقّق من اتصالك ثم أعد المحاولة.</span>' +
          '<span class="lang-en">The mushaf could not be loaded. Check your connection and try again.</span>');
        $('<button class="welcome-retry">' +
          '<span class="lang-ar">إعادة المحاولة</span>' +
          '<span class="lang-en">Try again</span></button>')
          .on('click', function () { location.reload(); })
          .appendTo('.welcome-card');
        $('#surah-list').html('<div class="no-data-msg">' +
          '<span class="lang-ar">تعذّر تحميل الفهرس</span>' +
          '<span class="lang-en">The index could not be loaded</span></div>');
      });
  }

  /* Only the turn buttons still need a tooltip. Every setting is a row with
     its name and current value written on it, which is the point: a touch
     screen has no hover to reveal anything with. */
  /* The arrows follow the way the page moves, so the key that turns a page is
     not the same in both modes -- a spread turns sideways and reads right to
     left, a single page stacks and scrolls. The tooltip says which key it is
     rather than leaving the reader to guess, and it says the right one because
     it is built from the same rule the keyboard handler uses. */
  function turnKey(dir) {
    if (mode === 'spread') return dir > 0 ? '\u2190' : '\u2192';
    return dir > 0 ? '\u2193' : '\u2191';
  }

  /* The label is built rather than written into an attribute, so the key can
     be drawn as a key. Built once and then only refilled: the language and the
     reading mode both change it, and rebuilding the node each time would throw
     away the fade half way through. */
  function syncTips() {
    $('#page-nav button').each(function () {
      var $b = $(this);
      var text = $b.attr('data-tip-' + lang);
      var key = this.id === 'btn-page-next' ? turnKey(1)
              : this.id === 'btn-page-prev' ? turnKey(-1) : null;
      var $tip = $b.children('.tip');
      if (!$tip.length) {
        $tip = $('<span class="tip" aria-hidden="true"><span></span><kbd></kbd></span>')
          .appendTo($b);
      }
      $tip.children('span').text(text);
      $tip.children('kbd').text(key || '').toggle(!!key);
      /* Named for a screen reader, but not with title: that draws the
         browser's own tooltip as well, so hovering gave two labels one on
         top of the other. aria-label says the same thing and renders
         nothing. The bubble itself is aria-hidden, so this is the only
         name the button has. */
      $b.removeAttr('title')
        .attr('aria-label', key ? text + ' (' + key + ')' : text);
    });
    showValues();
  }

  /* The label opens outward, away from the page, and is turned round when
     that would put it off the screen. Checked as the pointer arrives rather
     than once at startup: which side has room depends on the drawer, the
     window and the width the sheet settled at, and all three move. */
  $('#page-nav').on('mouseenter', 'button', function () {
    var $t = $(this).children('.tip');
    if (!$t.length) return;
    $t.removeClass('tip-flip');
    var r = $t[0].getBoundingClientRect();
    if (r.left < 4 || r.right > window.innerWidth - 4) $t.addClass('tip-flip');
  });

  /* What each setting is currently set to, spelled out beside its name. */
  function showValues() {
    var t = {
      mode:    { ar: { pages: 'صفحة واحدة', spread: 'صفحتان' },
                 en: { pages: 'One page', spread: 'Two pages' } },
      weight:  { ar: { '400': 'عادي', '500': 'متوسط', '700': 'عريض' },
                 en: { '400': 'Regular', '500': 'Medium', '700': 'Bold' } },
      onOff:   { ar: { on: 'ظاهرة', off: 'مخفية' },
                 en: { on: 'Shown', off: 'Hidden' } },
      theme:   { ar: { light: 'نهاري', dark: 'ليلي' },
                 en: { light: 'Light', dark: 'Dark' } }
    };
    $('#v-theme').text(t.theme[lang][theme]);
    $('#v-mode').text(t.mode[lang][mode]);
    $('#v-weight').text(t.weight[lang][weight]);
    $('#v-turners').text(t.onOff[lang][turners ? 'on' : 'off']);
    $('#v-lang').text(lang === 'ar' ? 'العربية' : 'English');
  }

  function applyLang(l) {
    lang = l;
    localStorage.setItem('quran-lang', l);
    $('body').attr('data-lang', l);
    $('html').attr({ lang: l, dir: l === 'ar' ? 'rtl' : 'ltr' });
    syncTips();
  }

  /** choice is null to follow the device, or the theme the reader picked. */
  function applyTheme(choice) {
    themeChoice = choice;
    theme = choice || (systemDark.matches ? 'dark' : 'light');
    $('body').toggleClass('dark-mode', theme === 'dark')
             .toggleClass('light-mode', theme !== 'dark');
    showValues();
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

  /* Off by default on one page: it scrolls, and the wheel, a drag and the
     arrow keys all already move it, so buttons would be a fourth way to do
     what the reader is doing anyway. They are in the drawer for whoever wants
     them. A spread is not offered the choice — it turns as a leaf rather than
     scrolling, and nothing on screen would say how. */
  function applyTurners(on, remember) {
    turners = !!on;
    /* Only a choice is stored. Writing the default here would freeze it, so a
       later change to what the default is would never reach anyone who had
       merely opened the app. */
    if (remember) localStorage.setItem('quran-turners', turners ? 'on' : 'off');
    $('body').toggleClass('turners-off', !turners);
    $('#btn-turners').toggleClass('on', turners)
      .attr('data-tip-ar', turners ? 'إخفاء أزرار الصفحات' : 'إظهار أزرار الصفحات')
      .attr('data-tip-en', turners ? 'Hide the page arrows' : 'Show the page arrows');
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
        return '<a class="surah-item" href="/surah/' + s.id + '/" data-id="' + s.id + '">' +
          '<span class="surah-num">' + s.id + '</span>' +
          '<span class="surah-names">' +
            '<span class="surah-name-ar">' + s.name + '</span>' +
            '<span class="surah-name-en">' + s.en + '</span>' +
          '</span>' +
          '<span class="surah-ayahs-count">' + s.v + '</span>' +
        '</a>';
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
    $('#sidebar').toggleClass('hidden', !on);
    $('#overlay').prop('hidden', !on);
  }

  /* ---------- rendering ---------- */

  /* `startAt` rather than `goToPage`: this used to take the page to open at
     under that name, which shadowed the goToPage() function for the whole of
     this body — so the recitation was handed a page number where it expected
     something to call, and threw the moment it tried to turn a page. */
  function open(s, startAt) {
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
    container.style.setProperty('--m-base', mushaf.fit.body[VERSION]);

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
        /* The name in the mushaf's own ornamental face, once per page.
        
           Named for a screen reader, not with title: the head already shows the
           name, so the tooltip only repeated on hover what was written directly
           beneath the pointer. The label is still owed, though — the name is
           drawn from private-use glyphs that read as nothing at all, so without
           it the running head is silent. role="img" is what it is: a picture of
           a word. */
        '<span class="page-label ph-surah" role="img" aria-label="' +
          esc(ps ? ps.full : '') + '">' +
          (ps ? Mushaf.surahTitle(ps.id) : '') + '</span>' +
        '<span class="page-label ph-page">' +
          (lang === 'ar' ? 'الصفحة ' + ar(p) : 'Page ' + p) + '</span>';
      section.appendChild(head);

      /* Only the line count varies by page; how wide a line is drawn is the
         same throughout, so it is set once on the container the type size is
         worked out on. */
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

    /* Offer this surah's recitation, if there is one. The bar appears only
       where a recording exists, and nothing plays until it is asked for. */
    if (window.Recite) {
      Recite.open(s, {
        currentPage: function () { return page; },
        goToPage: goToPage,
        /* Where an ayah is printed. An ayah that opens a page is what the
           reader must be turned to when it is reached. */
        ayahPage: function (v) { return ayahs && ayahs.began[s.id + ':' + v]; },
      }).then(function (has) {
        $('body').toggleClass('is-reciting', !!has);
      });
    }

    if (mode === 'spread') {
      onShow = [];
      showSpread(startAt || surahPages[0]);
      document.getElementById('content-area').scrollTo({ top: 0, behavior: 'auto' });
    } else {
      watchPages();
      watchFonts();

      var area = document.getElementById('content-area');
      var start = startAt && document.querySelector('.page-section[data-page="' + startAt + '"]');
      if (start) {
        start.scrollIntoView({ block: 'start' });
      } else {
        area.scrollTo({ top: 0, behavior: 'auto' });
      }
      /* The page being opened is hydrated outright rather than waiting on the
         observer, so the reader never lands on a blank sheet. */
      hydrate(start || container.firstElementChild);
    }

    /* The sheets have their width the moment they are in the document — it
       comes from CSS, not from the words in them — so measure now rather than
       waiting on a frame that a backgrounded tab may never run. */
    publishSheetWidth();
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
    Mushaf.fill(box, mushaf.pages[p], version, mushaf.basmalah,
                mushaf.marks && mushaf.marks[p], ayahs && ayahs.enter[p]);

    Mushaf.loadPageFont(version, p).then(function (family) {
      if (!section.isConnected || box.dataset.pending !== version) return;
      box.style.fontFamily = '"' + family + '"';
      /* Not document.fonts.ready: that waits on every pending face, including
         the neighbours being fetched ahead, so it would hold this page back for
         pages nobody is looking at. The retry below is what covers glyphs that
         are parsed but not yet measurable. */
      start();
    }, function () {
      /* Only the font load lands here — a two-argument `then`, so a fault in
         the fit below is not mistaken for a missing file. The lines stay hidden
         rather than showing their glyph codes as tofu, and the sheet says why. */
      if (box.dataset.pending === version) box.classList.add('font-missing');
    });

    function start() {
      if (!section.isConnected || box.dataset.pending !== version) return;

      /* A page just made visible measures as nothing until the browser has laid
         it out, so a failed fit is retried next frame. Frames stop arriving in
         a tab that is not being drawn, though, and a page that waits forever on
         one never appears at all — so a timer races the frame. */
      var nextTry = function (fn) {
        var ran = false;
        var once = function () { if (!ran) { ran = true; fn(); } };
        requestAnimationFrame(once);
        setTimeout(once, 32);
      };

      var settle = function (retries) {
        if (!section.isConnected || box.dataset.pending !== version) return;
        if (Mushaf.layout(box, mushaf.fit.centreBelow[version])) {
          box.dataset.version = version;
          box.classList.add('ready');
          /* The turn buttons are placed from --sheet-w, and a sheet that has
             only just been built is the first honest measurement of one. Left
             at whatever the last layout published, the buttons sit at the width
             the page used to be — and when that is the narrower of the two,
             they come down on top of the words. */
          publishSheetWidth();
          /* This page's words are new elements; whatever is being recited has
             to be lit again on them. */
          if (window.Recite) Recite.repaint();
        } else if (retries > 0) {
          nextTry(function () { settle(retries - 1); });
        } else {
          /* Out of tries. Say so rather than leaving a blank sheet — a page
             that silently never appears is the worst of the options. */
          delete box.dataset.pending;
          box.classList.add('failed');
        }
      };
      /* Generous: a wasted retry costs a frame, a false failure costs the page.
         Twenty frames is a third of a second before giving up. */
      settle(20);
    }
  }

  /* Dropping a page's lines keeps its fitted font size, so the shell still
     reserves exactly the height it had and the scroll position holds. */
  function dehydrate(section) {
    var box = section.querySelector('.mushaf');
    if (box && box.firstChild) Mushaf.empty(box);
  }

  /** Re-measure the pages that are currently built — after a resize or zoom. */
  /* The turners flank the page, so CSS needs to know how wide the page came
     out. It cannot work that out for itself: --m-size resolves against a
     container query that only exists inside #ayahs-container. One read, after
     the fit, rather than anything per frame. */
  function publishSheetWidth() {
    var want = mode === 'spread' ? 2 : 1, w = 0, n = 0;
    document.querySelectorAll('.page-section').forEach(function (s) {
      if (n >= want) return;
      var r = s.getBoundingClientRect();
      if (r.width > 1) { w += r.width; n++; }
    });
    if (w < 1) return;

    /* Written every time, not only when the number changes. Remembering the
       last value and skipping the write looks free, but the memory and the
       property can then disagree — and once they do, the value never gets
       written again and the buttons stay wherever they were. A custom property
       set to what it already holds is cheap; being unable to correct it is not. */
    document.documentElement.style.setProperty('--sheet-w', Math.round(w) + 'px');
  }

  /**
   * Keep --sheet-w true by watching the sheet, not by being told.
   *
   * The turn buttons are placed from that number, and they sit only a few
   * pixels clear of the words, so a stale one puts them over the page. It used
   * to be republished from the resize event, from opening a surah and from a
   * page being built — three places that each had to remember, and a window
   * restored from small to full goes through paths where the sheet ends up a
   * different size without any of them landing on the right moment. Worst in
   * two-page mode, where the number is the width of two sheets and dropping
   * below the spread breakpoint leaves it holding one.
   *
   * An observer has no such gaps: the reading area changing size is exactly
   * when a sheet can change size, whatever caused it.
   */
  function watchSheetWidth() {
    if (!window.ResizeObserver) return;
    var area = document.getElementById('content-area');
    if (!area) return;
    new ResizeObserver(function () { publishSheetWidth(); }).observe(area);
  }

  /**
   * Settle the built pages against the room they now have.
   *
   * Once a frame, and never later than the next one. This used to wait on a
   * 60ms debounce, which a drag resets on every event — so through the whole
   * of a slow resize the fit never ran at all. A handful of lines are drawn
   * wider than the measure and are shrunk to fit by script; with the fit
   * suspended those lines sit at full width against a sheet that is no longer
   * that wide, and spill over its edge until the drag stops. Page 27's
   * fourteenth line is one of them, and it needs about 10% off.
   *
   * A frame is the right unit: it cannot draw twice between two of them, so
   * refitting more often than that would be work nobody can see.
   */
  function refitPages() {
    /* Straight away, in the handler, not on the next frame. A resize can be
       delivered after that frame's callbacks have run, so anything deferred by
       even one frame is a frame drawn at the new width with the old fit — and
       that is precisely what the eye catches: the line springs out past the
       sheet and snaps back, over and over, for as long as the drag lasts. */
    var vh = window.innerHeight;
    document.querySelectorAll('#ayahs-container .mushaf.ready').forEach(function (box) {
      /* Only the sheets on or near the screen. A long surah keeps several
         pages built at once, and measuring every one of them on every event is
         the cost that made deferring look necessary in the first place. */
      var r = box.getBoundingClientRect();
      if (r.bottom < -vh || r.top > vh * 2) return;
      Mushaf.layout(box, mushaf.fit.centreBelow[box.dataset.version] || 0.92);
    });
    publishSheetWidth();
    /* The word being recited is marked on a span a refit may have rebuilt. */
    if (window.Recite) Recite.repaint();
  }

  /* Which sheet is in view — handed to the browser instead of measured on
     every scroll event, so scrolling stays free of layout work. */
  function watchPages() {
    if (io) io.disconnect();
    if (!window.IntersectionObserver) return;

    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var seen = parseInt(e.target.getAttribute('data-page'));
        /* A turn is still in flight: the pages sliding past are not where the
           reader is going, so they are ignored until the one that was asked
           for arrives. Without this the observer's own reports undid the
           click that caused them. */
        if (wanted !== null && seen !== wanted) return;
        if (wanted === seen) settled();
        setPage(seen);
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
    warmNeighbours();
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
    wantMode = MODES.indexOf(m) >= 0 ? m : 'pages';
    /* quiet is the restore at boot and the recompute on resize. Storing then
       would freeze the screen-size default as though it were chosen, and a
       reader who moved to a bigger screen would never be offered the spread. */
    if (!quiet) localStorage.setItem('quran-mode', wantMode);

    /* A spread the screen cannot hold is dropped, not squeezed: the reader
       gets one whole page. The choice is kept, so widening the window — or
       turning the phone — brings the spread back without asking again. */
    mode = (wantMode === 'spread' && phoneLayout.matches) ? 'pages' : wantMode;
    /* Which key turns a page depends on the mode, and so does whether the text
       size can do anything -- both are said in the interface, so both are
       said again whenever the mode changes. */
    setTimeout(syncTips, 0);

    $('body').attr('data-mode', mode).toggleClass('no-spread', phoneLayout.matches);
    var name = { ar: { pages: 'صفحة واحدة', spread: 'صفحتان' },
                 en: { pages: 'One page', spread: 'Two pages' } };
    $('#btn-mode').attr('data-tip-ar', 'طريقة العرض — ' + name.ar[mode])
                  .attr('data-tip-en', 'Reading mode — ' + name.en[mode]);
    syncTips();
    /* quiet is the restore on boot; only a deliberate switch is worth an event. */
    if (!quiet) track('reading-mode', { mode: mode });
    /* The page list itself differs by mode — a spread needs its facing page,
       which may belong to the surah next door. */
    if (!quiet && surah) open(surah, page);
  }

  /**
   * Fetch the fonts for the pages the reader is about to reach.
   *
   * A page font is its own ~170 KB file, and fetching one is by far the slowest
   * part of turning a page — the rest is a millisecond of DOM and a layout. So
   * the neighbours are fetched while the reader is still on this page, and by
   * the time they turn the font is already registered. Idempotent, and each
   * call marks the face as recently used, so warm pages are not evicted.
   */
  var warmTimer = null;

  function warmPages(list) {
    list.forEach(function (n) {
      if (n >= 1 && n <= 604) Mushaf.loadPageFont(VERSION, n);
    });
  }

  /* The page about to be turned to is warmed at once; the ones after it can
     wait for the reader to settle.

     A single debounce did the opposite of what it was for. Every turn reset
     it, so clicking faster than once every 120ms meant it never fired at all
     and every page arrived cold -- the faster the reader went, the slower each
     page got. The one that matters is the next one, and it costs a single
     fetch, so it is asked for straight away. */
  function warmNeighbours() {
    var start = spreadStart(page);
    warmPages(mode === 'spread' ? [start + 2, start + 3] : [page + 1]);

    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(function () {
      warmPages(mode === 'spread'
        ? [start - 2, start - 1, start + 4, start + 5]
        : [page + 2, page - 1]);
    }, 200);
  }

  /** A spread is an odd page and the even one facing it: 1|2, 3|4, ... */
  function spreadStart(p) { return p % 2 ? p : p - 1; }

  /* Which pages the spread is showing. Kept so a turn touches four sheets
     rather than every sheet of the surah — Al-Baqarah has fifty, and writing
     to all of them invalidated a container query on each one, which was the
     whole cost of turning a page. */
  var onShow = [];

  /** Show only the spread holding this page, and remember where we are. */
  function showSpread(p) {
    var find = function (n) { return document.querySelector('.page-section[data-page="' + n + '"]'); };

    var start = spreadStart(p);
    /* Asked for a page this surah does not have — open at its first instead.
       Whatever the caller got wrong, a blank screen is never the right answer:
       every path through here has two leaves to show. */
    if (!find(start) && !find(start + 1)) {
      var first = document.querySelector('.page-section');
      if (!first) return;
      start = spreadStart(+first.getAttribute('data-page'));
    }
    var want = [start, start + 1];

    /* Drop what was showing and is not any more: a spread off screen has no
       business holding a page font open, and the cache is only 24 deep. */
    onShow.forEach(function (n) {
      var el = find(n);
      if (!el) return;
      el.classList.remove('in-spread', 'spread-right', 'spread-left');
      if (want.indexOf(n) < 0) dehydrate(el);
    });

    /* The odd page is the right leaf, as the mushaf falls open. */
    var right = find(start), left = find(start + 1);
    if (right) { right.classList.add('in-spread', 'spread-right'); hydrate(right); }
    if (left) { left.classList.add('in-spread', 'spread-left'); hydrate(left); }

    onShow = want;
    document.getElementById('content-area').scrollTop = 0;
    settled();                     // a spread turn lands at once; nothing in flight
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
    $('#overlay').prop('hidden', !(which || sideOpen));
  }

  /* ---------- events ---------- */

  $('#sidebar-handle').on('click', function () { setSidebar(!sideOpen); });

  /* Tabs inside the drawer. The index is what most visits want, so it opens
     there and the settings are one tap away rather than buried. */
  $('.drawer-tab').on('click', function () {
    var pane = $(this).data('pane');
    $('.drawer-tab').removeClass('on');
    $(this).addClass('on');
    $('.drawer-pane').removeClass('on').filter('[data-pane="' + pane + '"]').addClass('on');
  });
  $('#btn-bookmarks').on('click', function () {
    showPanel($('#bookmarks-panel').prop('hidden') ? 'saved' : null);
  });
  $('#btn-help').on('click', function () {
    showPanel($('#help-panel').prop('hidden') ? 'help' : null);
  });
  $('#btn-close-bookmarks, #btn-close-help').on('click', function () { showPanel(null); });

  $('#btn-mode').on('click', function () {
    applyMode(MODES[(MODES.indexOf(wantMode) + 1) % MODES.length]);
  });

  $('#btn-turners').on('click', function () { applyTurners(!turners, true); });

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
  /* Straight between the two. The tap holds until the tab is closed; the next
     visit starts from the device again. */
  $('#btn-theme').on('click', function () {
    applyTheme(theme === 'dark' ? 'light' : 'dark');
  });

  /* The device switching mid-visit is followed, unless this visit has already
     been overridden by hand. */
  systemDark.addEventListener('change', function () {
    if (themeChoice === null) applyTheme(null);
  });
  $('#btn-font-inc').on('click', function () { applyScale(scale + 0.05); });
  $('#btn-font-dec').on('click', function () { applyScale(scale - 0.05); });

  $('#btn-lang').on('click', function () {
    applyLang(lang === 'ar' ? 'en' : 'ar');
    if (window.Recite) Recite.relabel();
    if (surah) open(surah, page);
  });

  $('#btn-fullscreen').on('click', function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });

  $('#overlay').on('click', function () {
    showPanel(null);
    if (sideOpen) setSidebar(false);
  });

  $(document).on('click', '.surah-item', function (e) {
    var id = +$(this).data('id');
    var s = quran.find(function (x) { return x.id === id; });
    if (!s) return;
    /* Let the browser have it for a new tab or a middle click — those are the
       reader asking for a second copy, not for this one to change. */
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.which === 2) return;
    e.preventDefault();
    open(s);
    history.pushState({ surah: id }, '', '/surah/' + id + '/');
    setSidebar(false);      // the index has done its job — give the page the room
  });

  /* Back and forward move between surahs rather than out of the app. */
  window.addEventListener('popstate', function () {
    var s = surahFromPath();
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
    /* The arrows follow the way the page moves, as the turn buttons do: one
       page stacks and scrolls, so down is next; a spread turns sideways, and
       the mushaf reads right to left, so left is next. */
    var vertical = mode !== 'spread';
    var next = vertical ? 'ArrowDown' : 'ArrowLeft';
    var prev = vertical ? 'ArrowUp' : 'ArrowRight';
    if (e.key === next || e.key === 'PageDown') { e.preventDefault(); turn(1); }
    else if (e.key === prev || e.key === 'PageUp') { e.preventDefault(); turn(-1); }
    else if (e.key === ' ' && window.Recite && Recite.available()) {
      /* The page scrolls on space by default, which is the one thing a reader
         following a recitation does not want it to do. */
      e.preventDefault();
      Recite.toggle();
    }
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

  /* Scrolling the page is the reader getting on with it, so the index steps
     out of the way. This watches the gesture rather than the scroll event:
     opening a surah or switching mode scrolls the page too, and closing the
     drawer underneath someone who just tapped a setting is maddening. */
  (function () {
    var area = document.getElementById('content-area');
    function dismiss() { if (sideOpen) setSidebar(false); }
    area.addEventListener('wheel', dismiss, { passive: true });
    area.addEventListener('touchmove', dismiss, { passive: true });
  }());

  $(window).on('resize', function () {
    var was = narrow, shown = mode;
    narrow = phoneLayout.matches;
    if (was !== narrow) {
      setSidebar(false);
      /* Crossing the threshold takes the room a spread needs, or hands it
         back. Recompute quietly — the reader did not ask for this — and
         redraw only if what is on screen actually changed. */
      applyMode(wantMode, true);
      if (mode !== shown && surah) open(surah, page);
    }
    refitPages();
  });

  watchSheetWidth();
  init();
});
