$(function () {
  var quran = null, mushaf = null;
  var surah = null, page = null;
  var io = null, hydrateIO = null, keepIO = null, surahPages = [];
  /* Which ayah every word belongs to, and which page each ayah opens on.
     Built once from the page data — see Mushaf.ayahIndex. */
  var ayahs = null;

  var lang  = localStorage.getItem('quran-lang')  || 'ar';
  /* The device has the last word every visit: a tap on the theme row holds for
     this tab only, so null here means the device is still in charge. */
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
  var PAGES = 604;
  var weight = localStorage.getItem('quran-weight') || '400';
  var bright = parseInt(localStorage.getItem('quran-bright')) || 100;
  var MODES = ['pages', 'spread'];
  /* Shown unless turned off. No width test: CSS takes the arrows away where
     they do not belong, and a window read once at load latches. */
  var turners = localStorage.getItem('quran-turners') !== 'off';
  /* Two facing pages need room. --spread-min states how much; querying its
     complement rather than a second breakpoint means there is no width where
     both this and the phone layout apply, and none where neither does. */
  var phoneLayout = window.matchMedia('(max-width: ' +
    (parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--spread-min')) || 900) + 'px)');

  /* What the reader chose, and what the screen can show: they part company on
     a narrow screen, and the choice is what survives. */
  var wantMode = localStorage.getItem('quran-mode') ||
                 (phoneLayout.matches ? 'pages' : 'spread');
  var mode = 'pages';

  var saved = loadSaved();
  /* Open where there is room, shut on a phone where it would cover the page.
     Not remembered: restoring it open on a reader who shut it is rude. */
  var sideOpen = !phoneLayout.matches;
  var narrow = phoneLayout.matches;


  /* ---------- helpers ---------- */

  /* Analytics, if any is loaded. Every surah has its own url, so only the
     reading mode needs an event. All of it goes through here. */
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

  /* The name the running head carries: the surah the page opens in. A page
     that opens with a surah's own title needs no name above it, and where
     several start there is no one surah to name. */
  function headOfPage(p) {
    var lines = (mushaf && mushaf.pages[p]) || [];
    var titles = [], first = null;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].t === 'surah') titles.push(lines[i]);
      if (!first && (lines[i].t === 'surah' || lines[i].t === 'ayah')) first = lines[i];
    }
    if (titles.length > 1) return null;
    if (!titles.length) return surahOfPage(p);
    if (first === titles[0]) return null;
    return quran[titles[0].s - 2] || null;   // the surah the title interrupts
  }

  /**
   * Turn to a page and put it at the top of the screen. A page already built
   * is scrolled to; one in another surah opens that surah at it.
   */
  function goToPage(p) {
    p = Math.min(PAGES, Math.max(1, parseInt(p) || 0));
    if (!p) return;
    // The page asked for, and the one after it, before anything is laid out
    Leaves.warm(mode === 'spread' ? [] : [p, p + 1]);
    var el = document.querySelector('.page-section[data-page="' + p + '"]');
    if (mode === 'spread') {
      var facing = document.querySelector('.page-section[data-page="' + (Leaves.spreadStart(p) + 1) + '"]');
      if (el && facing) { Leaves.showSpread(p); return; }
    } else if (el) {
      /* Across the page on a phone, down it everywhere else. */
      if (!Pager.go(p)) el.scrollIntoView({ block: 'start' });
      setPage(p);
      return;
    }
    var s = surahOfPage(p);
    if (s) open(s, p);
  }

  /** One page at a time, or one spread. */
  /* Turning counts from the page asked for, not the one the observer last
     reported: mid-animation it writes whatever section is passing. */
  var wanted = null;
  var wantedTimer = null;

  /* Held only while a turn is in flight. If the page asked for never arrives,
     holding on would silence every later report, so it lets go by itself. */
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
  /* The url alone, with no need for the surah index — which is still being
     fetched when the reader is first laid out, so surahFromPath() answers null
     there whatever the address says. */
  function pathHasSurah() {
    return /^\/surah\/\d+\/?$/.test(location.pathname);
  }

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
    /* Which shell this is, where CSS can see it: app-only styling belongs in
       the one stylesheet under body[data-shell="android"]. */
    if (Offline.native()) $('body').attr('data-shell', 'android');

    applyLang(lang);
    applyTheme(themeChoice);
    applyScale(scale);
    applyWeight(weight);
    applyBrightness(bright);
    applyTurners(turners);
    Offline.apply(Offline.on());
    applyMode(wantMode, true);   // the choice, not the fallback derived from it

    /* A phone opens on the index, since one screen should ask which surah —
       unless a surah was asked for, which is a request to read it. */
    if (narrow) sideOpen = !pathHasSurah();
    setSidebar(sideOpen);

    /* Only two files: the 8 KB surah index and the page layout. quran.json is
       not loaded — its verse text is Unicode, which the mushaf fonts cannot
       render, so 1.6 MB of it would be parsed and never used. */
    $.when($.getJSON('/data/surahs.json'), $.getJSON('/data/mushaf.json'))
      .done(function (q, m) {
        quran  = q[0];
        mushaf = m[0];
        ayahs  = Mushaf.ayahIndex(mushaf.pages, mushaf.marks || {});
        /* Worked out from where the surah starts, not from a table: the one
           that used to live here had At-Tur in the wrong juz. */
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
  /* A spread turns sideways, a single page scrolls, so the key differs. Built
     from the same rule the keyboard handler uses, so it says the right one. */
  function turnKey(dir) {
    if (mode === 'spread') return dir > 0 ? '\u2190' : '\u2192';
    return dir > 0 ? '\u2193' : '\u2191';
  }

  /* Built as a node rather than an attribute so the key can be drawn as a key.
     Refilled, not rebuilt: a new node would throw away the fade. */
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
      /* aria-label, not title: title draws the browser's own tooltip as well,
         so hovering gave two labels one on top of the other. */
      $b.removeAttr('title')
        .attr('aria-label', key ? text + ' (' + key + ')' : text);
    });
    showValues();
  }

  /* The label opens away from the page, turned round where that would put it
     off screen. Checked as the pointer arrives, since all three inputs move. */
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
      /* The arrows are shown or hidden; offline reading is switched on or off.
         One pair of words cannot honestly do both. */
      onState: { ar: { on: 'مفعّلة', off: 'متوقفة' },
                 en: { on: 'On', off: 'Off' } },
      theme:   { ar: { light: 'نهاري', dark: 'ليلي' },
                 en: { light: 'Light', dark: 'Dark' } }
    };
    $('#v-theme').text(t.theme[lang][theme]);
    $('#v-mode').text(t.mode[lang][mode]);
    $('#v-weight').text(t.weight[lang][weight]);
    $('#v-turners').text(t.onOff[lang][turners ? 'on' : 'off']);
    $('#v-offline').text(t.onState[lang][Offline.on() ? 'on' : 'off']);
    $('#v-lang').text(lang === 'ar' ? 'العربية' : 'English');
  }

  function applyLang(l) {
    lang = l;
    localStorage.setItem('quran-lang', l);
    $('body').attr('data-lang', l);
    $('html').attr({ lang: l, dir: l === 'ar' ? 'rtl' : 'ltr' });
    syncTips();

    /* The download list is built as a string, so its names and its labels are
       in whichever language it was built in. Open, it has to be built again. */
    if (Listen.showing()) Listen.render();
  }

  /** choice is null to follow the device, or the theme the reader picked. */
  function applyTheme(choice) {
    themeChoice = choice;
    theme = choice || (systemDark.matches ? 'dark' : 'light');
    $('body').toggleClass('dark-mode', theme === 'dark')
             .toggleClass('light-mode', theme !== 'dark');

    /* The strip above the page takes the paper's colour, so the screen reads
       as one sheet. The Android shell uses the same pair of values. */
    var paper = theme === 'dark' ? '#1a1f25' : '#fffdf7';
    $('meta[name="theme-color"]').attr('content', paper);

    /* And the phone's own bars, which follow the reader's theme rather than
       the system's — someone reading in dark on a phone set to light was
       given a white strip along the top of a dark page. */
    if (window.QuranShell && QuranShell.theme) {
      try { QuranShell.theme(paper, theme === 'dark'); } catch (e) { /* older shell */ }
    }

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

  /* Off by default on one page: the wheel, a drag and the arrow keys already
     move it. A spread is not offered the choice — it turns as a leaf. */
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

  /* The way back to where the reading stopped: opening on the index made
     carrying on the one hard thing, so it is offered at the head of it. */
  function showResume() {
    var id = +localStorage.getItem('quran-last-surah');
    var page = +localStorage.getItem('quran-last-page');
    var s = id && quran && quran.find(function (x) { return x.id === id; });

    if (!s || !page) { $('#btn-resume').prop('hidden', true); return; }

    $('#btn-resume').prop('hidden', false)
      .find('.resume-where')
      .text((lang === 'ar' ? s.full : s.en)
        + ' · ' + (lang === 'ar' ? 'صفحة ' + ar(page) : 'page ' + page));
  }

  /* ---------- surah index ---------- */

  /** A surah as the index writes it, wherever it is listed. */
  function surahRow(s) {
    return '<a class="surah-item" href="/surah/' + s.id + '/" data-id="' + s.id + '">' +
      '<span class="surah-num">' + s.id + '</span>' +
      '<span class="surah-names">' +
        '<span class="surah-name-ar" role="img" aria-label="' +
          esc(s.full) + '">' + Mushaf.surahTitle(s.id) + '</span>' +
        '<span class="surah-name-en">' + s.en + '</span>' +
      '</span>' +
      '<span class="surah-ayahs-count">' + s.v + '</span>' +
    '</a>';
  }

  /** A heading over a run of results. */
  function section(ar, en) {
    return '<div class="juz-label"><span class="lang-ar">' + ar + '</span>' +
      '<span class="lang-en">' + en + '</span></div>';
  }

  function buildIndex() {
    var groups = {};
    quran.forEach(function (s) { (groups[s.juz] = groups[s.juz] || []).push(s); });

    $('#surah-list').html(Object.keys(groups).sort(function (a, b) { return a - b; }).map(function (j) {
      var items = groups[j].map(surahRow).join('');

      return '<div class="juz-group">' +
        '<div class="juz-label">' +
          '<span class="lang-ar">الجزء ' + j + '</span>' +
          '<span class="lang-en">Juz ' + j + '</span>' +
        '</div>' +
        '<div class="juz-surahs">' + items + '</div>' +
      '</div>';
    }).join(''));
  }

  /* The thirty juz, each opening at its own first page. The row's own title is
     the juz, so it is plain text; the surah it starts in is a quiet meta line,
     which the mushaf's hand is not for. */
  function buildJuz() {
    var starts = mushaf.juzPages;
    $('#juz-list').html(starts.map(function (page, i) {
      var j = i + 1;
      var s = surahOfPage(page);
      return '<a class="surah-item juz-item" href="#" data-page="' + page + '">' +
        '<span class="surah-num">' + j + '</span>' +
        '<span class="surah-names">' +
          '<span class="juz-head">' +
            '<span class="juz-title">' +
              '<span class="lang-ar">الجزء ' + ar(j) + '</span>' +
              '<span class="lang-en">Juz ' + j + '</span></span>' +
            (s ? '<span class="juz-surah" role="img" aria-label="' + esc(s.full) +
                 '">' + Mushaf.surahTitle(s.id) + '</span>' : '') +
          '</span>' +
          '<span class="juz-where">' +
            '<span class="lang-ar">صفحة ' + ar(page) + '</span>' +
            '<span class="lang-en">Page ' + page + '</span></span>' +
        '</span>' +
      '</a>';
    }).join(''));
  }

  /** Which list the index is showing. */
  function showList(which) {
    $('.list-tab').removeClass('on').filter('[data-list="' + which + '"]').addClass('on');
    $('#surah-list').prop('hidden', which !== 'surahs');
    $('#juz-list').prop('hidden', which !== 'juz');
    if (which === 'juz') buildJuz();
  }

  function setSidebar(on) {
    sideOpen = on;
    $('#sidebar').toggleClass('hidden', !on);
    $('#overlay').prop('hidden', !on);
    if (on) showResume();
    /* Opening the index is leaving the page, so the page's chrome goes with
       it rather than waiting underneath to be found again on the way back. */
    if (on) showChrome(false);
    shellBars();
  }

  /* Not the same question as the page's own chrome: the index is a screen of
     things to press, and only the page being read wants the bars gone. */
  /* Back means the index, not history: a reader who arrived by a link has
     nothing behind them. Returns whether it dealt with the press. */
  window.QuranBack = function () {
    if (!phoneLayout.matches || sideOpen || !surah) return false;
    setSidebar(true);
    return true;
  };

  function shellBars() {
    var on = $('body').hasClass('chrome-on') || sideOpen;
    if (window.QuranShell && QuranShell.chrome) {
      try { QuranShell.chrome(on); } catch (e) { /* older shell */ }
    }
  }

  /* The top bar on a phone: the way back, and what is being read. Not there
     until asked for, since anything permanent is taken from the page. */
  function showChrome(on) {
    $('body').toggleClass('chrome-on', !!on);
    $('#page-bar').attr('aria-hidden', on ? 'false' : 'true');

    /* The phone's own bars belong to the same moment as ours: away while the
       page is being read, back when it is tapped — and back for the index too,
       which shellBars() is the one to decide. */
    shellBars();
  }

  function nameChrome() {
    $('#page-bar-name').text(surah ? (lang === 'ar' ? surah.full : surah.en) : '');
  }

  /* ---------- rendering ---------- */

  /* Hand the recitation a surah, with what it needs to follow the reader. Also
     used when a word from a neighbouring surah is clicked on a shared page or a
     spread's facing page: the recitation moves to that surah, the pages stay. */
  function recite(s) {
    return Recite.open(s, {
      currentPage: function () { return page; },
      goToPage: goToPage,
      /* Where an ayah is printed. An ayah that opens a page is what the
         reader must be turned to when it is reached. */
      ayahPage: function (v) { return ayahs && ayahs.began[s.id + ':' + v]; },
      switchSurah: function (id) {
        var other = quran && quran.filter(function (x) { return x.id === id; })[0];
        return other ? recite(other) : Promise.resolve(false);
      }
    }).then(function (has) {
      $('body').toggleClass('is-reciting', !!has);
      return !!has;
    });
  }

  /* `startAt` rather than `goToPage`: that name shadowed the goToPage()
     function for this whole body, and the recitation threw on the first turn. */
  function open(s, startAt) {
    surah = s;
    localStorage.setItem('quran-last-surah', s.id);
    $('body').addClass('is-reading');

    $('.surah-item').removeClass('active')
      .filter('[data-id="' + s.id + '"]').addClass('active')
      .each(function () { this.scrollIntoView({ block: 'nearest' }); });

    nameChrome();

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
      var ps = headOfPage(p);
      var j = juzOfPage(p);
      var head = document.createElement('div');
      head.className = 'page-head';
      head.innerHTML =
        '<span class="page-label ph-juz">' +
          (lang === 'ar' ? 'الجزء ' + ar(j) : 'Juz ' + j) + '</span>' +
        /* The name in the mushaf's own ornamental face. Named for a screen
           reader, since the glyphs are private-use and read as nothing. */
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

      /* The shell only; the lines are built when the page comes into reach.
         Building all 6400 words of Al-Baqarah up front is what made it crawl. */
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

    /* The whole surah, not only the pages that happen to be looked at:
       someone who opens Al-Baqarah before a flight means all forty-eight
       pages of it. Quiet, and only when offline reading is switched on. */
    if (Offline.on()) Offline.keep(pagesOf(s));

    /* Offer this surah's recitation, if there is one. The bar appears only
       where a recording exists, and nothing plays until it is asked for. */
    var reciting = window.Recite ? recite(s) : null;

    if (mode === 'spread') {
      onShow = [];
      Leaves.showSpread(startAt || surahPages[0]);
      document.getElementById('content-area').scrollTo({ top: 0, behavior: 'auto' });
    } else {
      watchPages();
      watchFonts();

      var area = document.getElementById('content-area');
      var start = startAt && document.querySelector('.page-section[data-page="' + startAt + '"]');

      /* On a phone the pages are a row moved by a transform, so both of these
         are the pager's business; elsewhere they are the scroller's. */
      if (!(startAt ? Pager.go(startAt) : Pager.go(surahPages[0]))) {
        if (start) start.scrollIntoView({ block: 'start' });
        else area.scrollTo({ top: 0, behavior: 'auto' });
      }
      /* The page being opened is hydrated outright rather than waiting on the
         observer, so the reader never lands on a blank sheet. */
      Leaves.hydrate(start || container.firstElementChild);
    }

    /* The sheets have their width the moment they are in the document — it
       comes from CSS, not from the words in them — so measure now rather than
       waiting on a frame that a backgrounded tab may never run. */
    publishSheetWidth();

    /* Resolves true once the timings are in and false where this surah has no
       recording, for callers that mean to start it playing straight away. */
    return reciting;
  }

  /* Only the pages near the reader are built. Two margins rather than one, so
     scrolling back and forth does not thrash: built early, dropped late. */
  var BUILD_MARGIN = '150% 0px';
  var KEEP_MARGIN  = '400% 0px';

  /* The same two margins, turned on their side: a phone lays the pages across
     rather than down, so top-bottom would build nothing ahead of the swipe. */
  var BUILD_MARGIN_X = '0px 150%';
  var KEEP_MARGIN_X  = '0px 400%';



  function watchFonts() {
    if (hydrateIO) hydrateIO.disconnect();
    if (keepIO) keepIO.disconnect();

    /* On a phone the pager owns this. It has to: only three pages are in the
       layout at a time, so what a page is doing in the viewport says nothing
       about whether the reader is about to want it. */
    if (Pager.paging()) return;

    var root = document.getElementById('content-area');
    var sections = document.querySelectorAll('#ayahs-container .page-section');

    if (!window.IntersectionObserver) {
      sections.forEach(function (el) { Leaves.hydrate(el); });
      return;
    }

    var across = Pager.paging();

    hydrateIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) Leaves.hydrate(e.target); });
    }, { root: root, rootMargin: across ? BUILD_MARGIN_X : BUILD_MARGIN });

    keepIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (!e.isIntersecting) Leaves.dehydrate(e.target); });
    }, { root: root, rootMargin: across ? KEEP_MARGIN_X : KEEP_MARGIN });

    sections.forEach(function (el) { hydrateIO.observe(el); keepIO.observe(el); });
  }


  /** Re-measure the pages that are currently built — after a resize or zoom. */
  /* The turners flank the page, so CSS needs the sheet's width: --m-size
     resolves against a container query only inside #ayahs-container. */
  function publishSheetWidth() {
    /* Asked first and outside everything below: a run that bailed early used
       to take the recheck with it, and the bailed verdict stood. */
    scheduleFit();

    var want = mode === 'spread' ? 2 : 1, w = 0, n = 0;
    document.querySelectorAll('.page-section').forEach(function (s) {
      if (n >= want) return;
      var r = s.getBoundingClientRect();
      if (r.width > 1) { w += r.width; n++; }
    });
    if (w < 1) return;

    /* Written every time. Remembering the last value and skipping the write
       lets the two disagree, and then it is never corrected. */
    document.documentElement.style.setProperty('--sheet-w', Math.round(w) + 'px');
  }

  /* Once the page has stopped moving: a turner measured against a half-placed
     spread latches a wrong answer. Once next frame, once a moment later. */
  var fitFrame = null, fitLater = null;

  function scheduleFit() {
    if (fitFrame === null) {
      fitFrame = requestAnimationFrame(function () { fitFrame = null; fitTurners(); });
    }
    clearTimeout(fitLater);
    fitLater = setTimeout(fitTurners, 250);
  }

  /**
   * Take the turners away when they would sit on the page.
   *
   * Asked of the pixels, not the layout: do the button and the sheet share any
   * horizontal space? Hidden with visibility, not display — one taken out of
   * the flow has no box, so the two would swap places for ever.
   */
  function fitTurners() {
    var nav = document.getElementById('page-nav');
    if (!nav) return;

    /* Every sheet on screen, not the first one found. A spread has two, and
       the turner that would sit on the second is the left one — exactly the
       case a single measurement misses. */
    var sheets = [];
    document.querySelectorAll('.page-section').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width > 1 && r.bottom > 0 && r.top < window.innerHeight) sheets.push(r);
    });

    /* Nothing measurable: an absence of evidence, not evidence of an overlap.
       Returning here left one transient overlap hiding the turners for good. */
    if (!sheets.length) {
      document.body.classList.remove('turners-noroom');
      return;
    }

    var over = false;
    nav.querySelectorAll('button').forEach(function (b) {
      var r = b.getBoundingClientRect();
      if (r.width < 1) return;
      sheets.forEach(function (s) {
        if (r.right > s.left && r.left < s.right) over = true;
      });
    });
    document.body.classList.toggle('turners-noroom', over);
  }

  /* Keep --sheet-w true by watching the sheet rather than by being told: the
     three places that used to republish it each had a gap. */
  function watchSheetWidth() {
    if (!window.ResizeObserver) return;
    var area = document.getElementById('content-area');
    if (!area) return;
    new ResizeObserver(function () { publishSheetWidth(); }).observe(area);
  }

  /* Settle the built pages against the room they now have, once a frame: a
     debounce is reset by every drag event, so the fit never ran at all. */
  function refitPages() {
    /* In the handler, not next frame: a resize can arrive after that frame's
       callbacks, and the line springs past the sheet and snaps back. */
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
        /* A turn is in flight: the pages sliding past are not where the reader
           is going, and the observer's reports undid the click. */
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
    var first = mode === 'spread' ? Leaves.spreadStart(page) : page;
    $('#btn-page-prev').toggleClass('gone', first <= 1);
    $('#btn-page-next').toggleClass('gone', first + step > 604);
    Leaves.warmNeighbours();
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
    $('#feedback-panel').prop('hidden', which !== 'feedback');
    $('#btn-bookmarks').toggleClass('on', which === 'saved');
    $('#btn-help').toggleClass('on', which === 'help');
    $('#btn-feedback').toggleClass('on', which === 'feedback');
    if (which === 'feedback') sayFeedback();
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
    /* 114 rows and the list of reciters, built the first time they are asked
       for rather than on every load. */
    if (pane === 'listen') Listen.render();
  });
  $('#btn-bookmarks').on('click', function () {
    showPanel($('#bookmarks-panel').prop('hidden') ? 'saved' : null);
  });
  $('#btn-help').on('click', function () {
    showPanel($('#help-panel').prop('hidden') ? 'help' : null);
  });
  $('#btn-feedback').on('click', function () {
    showPanel($('#feedback-panel').prop('hidden') ? 'feedback' : null);
  });
  $('#btn-close-bookmarks, #btn-close-help, #btn-close-feedback').on('click', function () { showPanel(null); });

  /* ---------- reporting an issue or suggesting something --------------------

     The same form as the Android app's, posted to the same endpoint. What is
     sent beside the message is listed on the form itself. */
  var feedback = { kind: 'bug', severity: null, sending: false };

  var FEEDBACK_SAYS = {
    sending:  { ar: 'جارٍ الإرسال…', en: 'Sending…' },
    sent:     { ar: 'شكرًا لك، وصلت رسالتك.', en: 'Thank you, your message was sent.' },
    short:    { ar: 'اكتب رسالة أطول قليلًا.', en: 'Please write a little more.' },
    email:    { ar: 'البريد الإلكتروني غير صحيح.', en: 'That email address is not valid.' },
    tooMany:  { ar: 'أرسلت رسائل كثيرة، حاول لاحقًا.', en: 'Too many messages sent, please try later.' },
    failed:   { ar: 'تعذّر الإرسال الآن. حاول مرة أخرى بعد قليل.', en: 'Could not send right now. Please try again shortly.' }
  };

  function sayFeedbackStatus(key, bad) {
    $('#fb-status').text(key ? FEEDBACK_SAYS[key][lang === 'ar' ? 'ar' : 'en'] : '')
                   .toggleClass('bad', !!bad);
  }

  function sayFeedback() {
    $('#feedback-panel .fb-chip[data-kind]').each(function () {
      $(this).attr('aria-pressed', String($(this).data('kind') === feedback.kind));
    });
    $('#feedback-panel .fb-chip[data-severity]').each(function () {
      $(this).attr('aria-pressed', String(($(this).attr('data-severity') || null) === feedback.severity));
    });
    $('#fb-severity').prop('hidden', feedback.kind !== 'bug');
    var box = $('#fb-message');
    box.attr('placeholder', box.data(lang === 'ar' ? 'ph-ar' : 'ph-en'));
    $('#fb-send').prop('disabled', feedback.sending);
  }

  /* "Chrome 138 on Windows": enough to tell browsers apart, nothing more. */
  function browserName() {
    var ua = navigator.userAgent;
    var name = /Edg\/(\d+)/.test(ua) ? 'Edge ' + RegExp.$1
      : /OPR\/(\d+)/.test(ua) ? 'Opera ' + RegExp.$1
      : /Firefox\/(\d+)/.test(ua) ? 'Firefox ' + RegExp.$1
      : /(?:Chrome|CriOS)\/(\d+)/.test(ua) ? 'Chrome ' + RegExp.$1
      : /Version\/(\d+).*Safari/.test(ua) ? 'Safari ' + RegExp.$1
      : 'Other browser';
    var os = /Android/.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Windows/.test(ua) ? 'Windows'
      : /Mac OS X/.test(ua) ? 'macOS'
      : /Linux/.test(ua) ? 'Linux'
      : 'unknown OS';
    return name + ' on ' + os;
  }

  /* The window as the reader sees it; a hidden or unmeasured window falls back to the screen. */
  function screenSize() {
    var w = window.innerWidth || screen.width, h = window.innerHeight || screen.height;
    return (w > h ? 'landscape ' : 'portrait ') + w + 'x' + h;
  }

  function feedbackContext() {
    var context = {
      language: lang,
      theme: themeChoice || 'system',
      themeShown: theme === 'dark' ? 'dark' : 'light',
      screen: screenSize(),
      browser: browserName()
    };
    var last = +localStorage.getItem('quran-last-page');
    if (last >= 1 && last <= 604) context.page = last;
    var voice = null;
    try { voice = localStorage.getItem('quran-recitation'); } catch (e) { /* denied */ }
    if (voice) context.reciter = voice.slice(0, 80);
    return context;
  }

  $('#feedback-panel').on('click', '.fb-chip[data-kind]', function () {
    feedback.kind = $(this).data('kind');
    if (feedback.kind !== 'bug') feedback.severity = null;
    sayFeedback();
  });

  $('#feedback-panel').on('click', '.fb-chip[data-severity]', function () {
    feedback.severity = $(this).attr('data-severity') || null;
    sayFeedback();
  });

  $('#feedback-form').on('submit', function (e) {
    e.preventDefault();
    if (feedback.sending) return;

    var message = $.trim($('#fb-message').val());
    var email = $.trim($('#fb-email').val());
    if (message.length < 5) return sayFeedbackStatus('short', true);
    if (email && !$('#fb-email')[0].checkValidity()) return sayFeedbackStatus('email', true);

    var body = { source: 'web', kind: feedback.kind, message: message, app: feedbackContext() };
    if (feedback.kind === 'bug' && feedback.severity) body.severity = feedback.severity;
    if (email) body.email = email;

    feedback.sending = true;
    sayFeedback();
    sayFeedbackStatus('sending');

    $.ajax({
      url: '/api/feedback',
      method: 'POST',
      contentType: 'application/json',
      data: JSON.stringify(body),
      timeout: 15000
    }).done(function () {
      $('#fb-message').val('');
      sayFeedbackStatus('sent');
    }).fail(function (xhr) {
      sayFeedbackStatus(xhr.status === 429 ? 'tooMany' : 'failed', true);
    }).always(function () {
      feedback.sending = false;
      sayFeedback();
    });
  });


  /* A tap on the page shows the bar or takes it away. Only where there is no
     chrome already, and not on a word: a word belongs to the recitation. */
  $('#ayahs-container').on('click', function (e) {
    if (!phoneLayout.matches) return;
    /* Words included: on a touch screen a tap no longer opens the player
       — holding does — so a word is simply part of the page. */
    if ($(e.target).closest('.page-ribbon, .page-label').length) return;
    showChrome(!$('body').hasClass('chrome-on'));
  });

  $('.list-switch').on('click', '.list-tab', function () {
    showList($(this).data('list'));
  });

  /* The same three things opening a surah does: go there, say so in the url,
     and give the page the room back. */
  $('#juz-list').on('click', '.juz-item', function (e) {
    e.preventDefault();
    var page = +$(this).data('page');
    var s = surahOfPage(page);
    goToPage(page);
    if (s) history.pushState({ surah: s.id }, '', '/surah/' + s.id + '/');
    setSidebar(false);
  });

  /* Searching is asking for a surah, so the search box brings that list back. */
  $('#surah-search').on('input', function () { showList('surahs'); });

  $('#btn-to-index').on('click', function () { setSidebar(true); });

  document.addEventListener('recite:opened', function () {
    if (phoneLayout.matches) showChrome(true);
  });





  $('#btn-mode').on('click', function () {
    applyMode(MODES[(MODES.indexOf(wantMode) + 1) % MODES.length]);
  });

  $('#btn-turners').on('click', function () { applyTurners(!turners, true); });

  $('#btn-offline').on('click', function () { Offline.apply(!Offline.on(), true); });

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


  $('#overlay').on('click', function () {
    showPanel(null);
    if (sideOpen) setSidebar(false);
  });

  $('#btn-resume').on('click', function () {
    var id = +localStorage.getItem('quran-last-surah');
    var page = +localStorage.getItem('quran-last-page');
    var s = id && quran.find(function (x) { return x.id === id; });
    if (!s) return;

    open(s, page || null);
    history.pushState({ surah: s.id }, '', '/surah/' + s.id + '/');
    setSidebar(false);
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
    if (s) { open(s); return; }

    /* Back out of a surah on a phone is the index, which is the whole screen
       here. The shell's back button walks this same history. */
    if (phoneLayout.matches) setSidebar(true);
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

  /* Into the next surah, or back onto the last page of the one before — the
     leaf the reader would have turned back onto, not a jump over the surah. */
  function crossTo(d) {
    var i = quran.indexOf(surah) + d;
    var s = quran[i];
    if (!s) return;

    Pager.forget();
    open(s, d < 0 ? s.to : null);
    history.pushState({ surah: s.id }, '', '/surah/' + s.id + '/');
  }

  /* A name with nothing on it: no vowel marks, one shape for the alef. The
     list names surahs as the mushaf does, and nobody types that, so both
     sides of the comparison are stripped to their letters. */
  var MARKS = /[ً-ٰٕۖ-ۭـ]/g;
  var ALEFS = /[آأإٱ]/g;

  function bare(t) {
    return t.replace(MARKS, '').replace(ALEFS, 'ا')
            .replace(/ؤ/g, 'و')
            .replace(/[ئى]/g, 'ي')
            .replace(/ة/g, 'ه');
  }

  /* Both sets of Arabic digits, so ٤٨ and ۴۸ read as 48. */
  function figures(t) {
    return t.replace(/[٠-٩۰-۹]/g, function (d) {
      var c = d.charCodeAt(0);
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    });
  }

  /* Folding drops marks, so a place in the folded text is not the same place in
     the printed one. Walked per row rather than mapped for all 6236, because
     only the sixty on screen are ever marked. */
  function spanIn(text, at, len) {
    var seen = 0, from = -1;
    for (var i = 0; i <= text.length; i++) {
      if (seen === at && from < 0) from = i;
      if (from >= 0 && seen === at + len) return [from, i];
      if (i < text.length && bare(text.charAt(i))) seen++;
    }
    return from < 0 ? null : [from, text.length];
  }

  /** Show the index again, or the answer to what was typed. */
  function searching(on) {
    $('.list-switch').prop('hidden', on);
    $('#search-results').prop('hidden', !on);
    $('#surah-list').prop('hidden', on || !$('.list-tab[data-list="surahs"]').hasClass('on'));
    $('#juz-list').prop('hidden', on || !$('.list-tab[data-list="juz"]').hasClass('on'));
  }

  /* Enough of the ayah to see the match in its own words, rather than the whole
     of a verse that can run to a screenful. */
  function around(text, at, len) {
    var ROOM = 34;
    var from = Math.max(0, at - ROOM);
    var to = Math.min(text.length, at + len + ROOM);
    return (from ? '\u2026' : '') + text.slice(from, at) +
      '<mark>' + text.slice(at, at + len) + '</mark>' +
      text.slice(at + len, to) + (to < text.length ? '\u2026' : '');
  }

  /** The ayahs carrying the words typed, as their own run of rows. */
  function ayahRows(q) {
    var hits = Ayahs.find(q);
    if (!hits.length) return '';

    return section('الآيات', 'Ayahs') +
      hits.map(function (h) {
        var a = h.ayah;
        var page = ayahs && ayahs.began[a.s + ':' + a.v];
        var span = spanIn(a.text, h.at, q.length);
        var body = span ? around(a.text, span[0], span[1] - span[0])
                        : esc(a.text.slice(0, 90));
        var name = quran[a.s - 1];
        return '<button class="surah-item ayah-hit" data-page="' + (page || 1) +
          '" data-a="' + a.s + ':' + a.v + '">' +
          '<span class="surah-names">' +
            '<span class="ayah-text">' + body + '</span>' +
            '<span class="ayah-ref">' +
              '<span class="lang-ar">\u0633\u0648\u0631\u0629 ' + esc(name ? name.name : '') +
                ' \u00b7 \u0622\u064a\u0629 ' + ar(a.v) + '</span>' +
              '<span class="lang-en">' + esc(name ? name.en : '') + ' \u00b7 ayah ' + a.v + '</span>' +
            '</span>' +
          '</span></button>';
      }).join('');
  }

  /* A number is the finer place and the one a copied reference uses, so the
     page it names comes before any surah that happens to carry the figure. */
  function jumpRows(n) {
    if (!(n >= 1 && n <= PAGES)) return '';
    return section('الانتقال', 'Go to') +
      '<button class="surah-item jump-row" data-page="' + n + '">' +
        '<span class="surah-num">' + n + '</span>' +
        '<span class="surah-names"><span class="juz-title">' +
          '<span class="lang-ar">صفحة ' + ar(n) + '</span>' +
          '<span class="lang-en">Page ' + n + '</span></span></span></button>';
  }

  /* Matched against the data, not the rows: a name on a row is calligraphy,
     and those glyphs spell nothing. */
  function nameRows(q) {
    var found = quran.filter(function (s) {
      return bare(s.name).indexOf(q) >= 0
          || s.en.toLowerCase().indexOf(q) >= 0
          || String(s.id) === q;
    });
    if (!found.length) return '';
    return section('السور', 'Surahs') + found.map(surahRow).join('');
  }

  function answer() {
    var raw = figures($('#surah-search').val().trim());
    var q = bare(raw.toLowerCase());

    if (!q) { searching(false); $('#search-results').empty(); return; }
    searching(true);

    var html = jumpRows(parseInt(raw, 10)) + nameRows(q);

    /* The words are only fetched for a query that could be among them, so a
       reader looking a surah up by name never pays for them. */
    if (q.length >= 2 && !/^\d+$/.test(raw)) {
      $('#search-results').html(html || section('لا نتائج', 'Searching'));
      Ayahs.load().then(function () {
        if (bare(figures($('#surah-search').val().trim()).toLowerCase()) !== q) return;
        var rows = html + ayahRows(q);
        $('#search-results').html(rows || section('لا نتائج', 'No results'));
      });
      return;
    }

    $('#search-results').html(html || section('لا نتائج', 'No results'));
  }

  $('#surah-search').on('input', answer);

  $('#search-results').on('click', '.ayah-hit', function () {
    goToPage(+$(this).data('page'));
    flashAyah($(this).data('a'));
    setSidebar(false);
  });

  /* The ayah asked for, marked on the page it was found on, briefly, as the app
     flashes it rather than leaving it marked.

     Drawn as one band a line, behind the words, rather than as a wash on each:
     the mushaf justifies a line by spacing its words, so the gaps are not text
     and cannot be painted — per-word washes leave the spaces empty and double
     in colour wherever two of them meet.

     Waits for a sheet that is ready, not merely built: a page's lines are held
     invisible until its font has arrived and the fit has run, and a flash spent
     behind that is one the reader never sees. */
  function flashAyah(key) {
    if (!key) return;
    var until = performance.now() + 15000;

    (function look() {
      var words = [].slice.call(document.querySelectorAll('.m-word[data-a="' + key + '"]'))
        .filter(function (w) {
          var box = w.closest('.mushaf');
          return box && box.classList.contains('ready');
        });

      if (!words.length) {
        if (performance.now() < until) requestAnimationFrame(look);
        return;
      }

      /* Brought into view only if it is not already: `nearest` moves the least
         it can, where `center` hauled a page that was perfectly readable.
         Never in the phone's pager, whose position is its own. */
      if (!Pager.paging()) words[0].scrollIntoView({ block: 'nearest' });

      bandAyah(words);
    }());
  }

  /** One band a line, spanning the words of the ayah that sit on it. */
  function bandAyah(words) {
    var lines = [];

    words.forEach(function (w) {
      var box = w.closest('.mushaf');
      var r = w.getBoundingClientRect();
      /* A line is a row of words sharing a top, within one sheet. */
      var line = lines.filter(function (l) {
        return l.box === box && Math.abs(l.top - r.top) < 4;
      })[0];
      if (!line) { lines.push({ box: box, top: r.top, bottom: r.bottom, left: r.left, right: r.right }); return; }
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    });

    lines.forEach(function (l) {
      var at = l.box.getBoundingClientRect();
      var band = document.createElement('div');
      band.className = 'r-flash-band';
      band.style.left = (l.left - at.left) + 'px';
      band.style.top = (l.top - at.top) + 'px';
      band.style.width = (l.right - l.left) + 'px';
      band.style.height = (l.bottom - l.top) + 'px';
      l.box.appendChild(band);
      setTimeout(function () { band.remove(); }, 3200);
    });
  }

  $('#search-results').on('click', '.jump-row', function () {
    goToPage(+$(this).data('page'));
    setSidebar(false);
  });

  $(document).on('keydown', function (e) {
    if ($(e.target).is('input, textarea, select, [contenteditable]')) return;
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
     Grab the sheet and pull, and let it glide on. Mouse only: a touch screen
     scrolls this way already, and fighting it breaks the momentum. */

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

  /* Scrolling is the reader getting on with it, so the index steps aside.
     Watches the gesture, not the scroll: opening a surah scrolls too. */
  (function () {
    var area = document.getElementById('content-area');
    function dismiss() { if (sideOpen) setSidebar(false); }
    area.addEventListener('wheel', dismiss, { passive: true });
    area.addEventListener('touchmove', dismiss, { passive: true });
  }());

  $(window).on('resize', function () {
    var was = narrow;
    narrow = phoneLayout.matches;
    if (was !== narrow) {
      setSidebar(false);
      /* Crossing the threshold takes the room a spread needs, or hands it
         back. Recomputed quietly — the reader did not ask for this. */
      applyMode(wantMode, true);
      /* Reopened either way: crossing this line swaps the axis the pages are
         laid on, and the observers are told the axis when they are made. */
      if (surah) open(surah, page);
    }
    refitPages();
  });

  Ayahs.init({ fold: bare });

  Listen.init({
    lang : function () { return lang; },
    ar   : ar,
    num  : num,
    esc  : esc,
    title: title,
    quran: function () { return quran; },
    surah: function () { return surah; },
    open : open,
  });

  Pager.init({
    phone  : function () { return phoneLayout.matches; },
    mode   : function () { return mode; },
    setPage: setPage,
    crossTo: crossTo,
  });

  Offline.init({
    lang      : function () { return lang; },
    ar        : ar,
    surah     : function () { return surah; },
    pagesOf   : pagesOf,
    showValues: showValues,
    syncTips  : syncTips,
  });

  Leaves.init({
    version : VERSION,
    data    : function () { return mushaf; },
    ayahs   : function () { return ayahs; },
    mode    : function () { return mode; },
    page    : function () { return page; },
    fitted  : publishSheetWidth,
    settled : settled,
    setPage : setPage,
  });

  watchSheetWidth();
  Pager.start();
  init();
});
