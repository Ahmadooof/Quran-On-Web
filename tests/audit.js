/**
 * Renders every mushaf page in both QCF versions inside a frame the size of a
 * real screen, measures it, and lists whatever looks wrong — so the pages do
 * not have to be opened one surah at a time.
 *
 * Open http://localhost:3000/tests/audit.html with the app server running.
 */
(function () {
  'use strict';

  /* What building a page may cost us: filling its word spans and fitting its
     lines. Budgeted across the run rather than page by page — the first few
     pages of any sweep pay for the browser warming up, and flagging those says
     nothing about the code. A change that makes rendering slower moves the
     median; warm-up cannot. */
  var BUILD_MEDIAN_MS = 5;
  var BUILD_P95_MS = 30;

  /* The reader draws QCF V2 only, so that is what there is to audit. */
  var VERSION = 'v2';

  var $ = function (s) { return document.querySelector(s); };
  var data = null, surahs = null, opensOn = {}, closesOn = {};
  var rows = [], running = false, stopped = false;

  /* ---------- the frame under test ---------- */

  var frame = null, ctx = null;

  /** (Re)build the frame at a screen size, and resolve once it is loaded. */
  function makeFrame(w, h, scale) {
    if (frame) frame.remove();
    frame = document.createElement('iframe');
    frame.src = 'frame.html';
    frame.width = w;
    frame.height = h;
    $('#stage').appendChild(frame);

    /* Shown scaled down; measurements happen at the real size. */
    var k = Math.min(1, 520 / w);
    frame.style.transform = 'scale(' + k + ')';
    frame.style.transformOrigin = 'top left';
    frame.style.border = '0';
    $('#stage').style.width = Math.round(w * k) + 'px';
    $('#stage').style.height = Math.round(h * k) + 'px';

    return new Promise(function (done) {
      frame.onload = function () {
        var doc = frame.contentDocument;
        doc.documentElement.style.setProperty('--quran-scale', scale);
        ctx = {
          win: frame.contentWindow,
          doc: doc,
          container: doc.getElementById('ayahs-container'),
          h: h,
        };
        /* Page 1 carries the Basmalah every surah opening reuses. */
        if (data) ctx.win.Mushaf.loadPageFont(VERSION, data.basmalah.page, true);
        done(ctx);
      };
    });
  }

  /** Build one page into the frame, exactly as the reader does. */
  function renderPage(version, p) {
    var doc = ctx.doc, lines = data.pages[p];
    ctx.container.innerHTML = '';

    ctx.container.style.setProperty('--m-base', data.fit.body[version]);

    var section = doc.createElement('section');
    section.className = 'page-section';
    section.style.setProperty('--m-lines', ctx.win.Mushaf.lineCount(lines));

    /* The running head is part of the sheet's height and width, so it is
       built here too — same markup the reader uses. */
    var head = doc.createElement('div');
    head.className = 'page-head';
    head.innerHTML =
      '<span class="ph-juz">الجزء ' + juzOf(p) + '</span>' +
      '<span class="ph-surah">' + ctx.win.Mushaf.surahGlyph(headSurah(p)) + '</span>' +
      '<span class="ph-page">الصفحة ' + p + '</span>';
    section.appendChild(head);

    var box = ctx.win.Mushaf.createBox();
    section.appendChild(box);

    /* The folio counts towards the sheet's height too — without it the audit
       measured every sheet about 30px shorter than the reader gets. */
    var foot = doc.createElement('div');
    foot.className = 'page-footer';
    foot.innerHTML = '<span class="page-label">' + p + '</span>';
    section.appendChild(foot);

    ctx.container.appendChild(section);

    /* Timed the way the reader spends it: building the spans and fitting the
       lines is our own work and should stay cheap; fetching the font is the
       network's, and is reported apart from it. */
    var tFill = ctx.win.performance.now();
    ctx.win.Mushaf.fill(box, lines, version, data.basmalah);
    var fillMs = ctx.win.performance.now() - tFill;

    var tFont = ctx.win.performance.now();
    return ctx.win.Mushaf.loadPageFont(version, p).then(function (family) {
      var fontMs = ctx.win.performance.now() - tFont;
      box.style.fontFamily = '"' + family + '"';
      // yield once so the new lines are laid out before they are measured
      return new Promise(function (done) { setTimeout(done, 0); }).then(function () {
        var tLayout = ctx.win.performance.now();
        ctx.win.Mushaf.layout(box, data.fit.centreBelow[version]);
        var layoutMs = ctx.win.performance.now() - tLayout;
        /* And yield again before anyone measures. Setting a font size does not
           re-measure the text in the same task — the browser defers that to the
           next layout — so reading a line's width straight after fitting it
           gives the width it had before. Every shrunk line then looks as though
           it still overflows by exactly the amount it was shrunk by. */
        return { section: section, box: box,
                 fillMs: fillMs, fontMs: fontMs, layoutMs: layoutMs };
      });
    }, function () {
      return { section: section, box: box, missing: true };
    });
  }

  /** Same two rules the reader uses to head a page. */
  function juzOf(p) {
    for (var i = data.juzPages.length - 1; i >= 0; i--) if (p >= data.juzPages[i]) return i + 1;
    return 1;
  }

  /** Surahs opening below the first line of text — the ones that name themselves. */
  function midPageOpenings(p) {
    var n = 0, seenText = false;
    data.pages[p].forEach(function (l) {
      if (l.t === 'ayah') seenText = true;
      if (l.t === 'surah' && seenText) n++;
    });
    return n;
  }

  function headSurah(p) {
    for (var i = 0; i < surahs.length; i++) {
      if (surahs[i].from <= p && p <= surahs[i].to) return surahs[i].id;
    }
    return 1;
  }

  /* ---------- measuring ---------- */

  function lineWidth(line) {
    var w = 0;
    for (var i = 0; i < line.children.length; i++) {
      w += line.children[i].getBoundingClientRect().width;
    }
    return w;
  }

  function median(a) {
    var s = a.slice().sort(function (x, y) { return x - y; });
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  }

  function measure(version, p, built) {
    var box = built.box, section = built.section;
    var issues = [];
    var rec = {
      page: p, version: version,
      surahs: (opensOn[p] || []).join(', '),
      size: 0, fill: 0, tight: 0, height: 0, lines: 0, issues: issues,
      buildMs: 0, fontMs: 0,
    };

    if (built.missing) {
      issues.push('font file missing');
      return rec;
    }

    rec.buildMs = Math.round((built.fillMs + built.layoutMs) * 10) / 10;
    rec.fontMs = Math.round(built.fontMs * 10) / 10;

    var avail = box.clientWidth;
    var ayahs = box.querySelectorAll('.m-line.m-ayah');
    var widths = [], over = 0;

    var pulled = 0;
    for (var i = 0; i < ayahs.length; i++) {
      widths.push(lineWidth(ayahs[i]));
      if (ayahs[i].style.fontSize) {
        rec.tight++;
        pulled = Math.max(pulled, 100 - parseFloat(ayahs[i].style.fontSize));
      }
      /* Every line, shrunk or not. This used to measure only the ones the
         fitter left alone, on the reasoning that a line it pulled in was a
         handled case — which assumes the pulling worked. A line shrunk by the
         wrong amount is still a line past the edge, and skipping those is what
         let one hang over the margin on page 27 without this ever saying so.

         The two are measured differently, and they have to be. A line the
         fitter did not touch can be read straight off the page: scrollWidth is
         what actually sticks out, and it counts centring gaps. A line it did
         touch cannot — setting a font size does not re-measure the text in the
         same task, so its width still reads as it was before the shrink, and
         every fitted line would be reported as overflowing by exactly the
         amount it was fitted by. That one is checked against the fitter's own
         arithmetic instead: the width it recorded for the line, times the
         factor it applied. */
      var shrunk = parseFloat(ayahs[i].style.fontSize);
      var ratio = parseFloat(ayahs[i].dataset.nat);
      if (shrunk > 0 && ratio > 0) {
        over = Math.max(over, ratio * avail * shrunk / 100 - avail);
      } else if (!(shrunk > 0)) {
        over = Math.max(over, ayahs[i].scrollWidth - ayahs[i].clientWidth);
      }
    }

    /* Fit it again, twice, and nothing may move.
    
       A page is fitted once when it is built and again on every resize event,
       so the fit has to land on the same answer every time it is asked. It did
       not: clearing a line's font size and measuring in the same breath gave
       the size the line had *before* the clear, because the browser does not
       re-measure text until it next lays the page out. A shrunk line therefore
       measured as though it already fitted, lost its shrink, and hung over the
       margin — and the call after that put it back. Resizing a window flickered
       the line in and out on every frame.
    
       Building a page once, as this audit did, never sees it. Two more passes
       do, and they cost a millisecond. */
    var firstPass = [];
    for (i = 0; i < ayahs.length; i++) firstPass.push(ayahs[i].style.fontSize || '');

    for (var pass = 0; pass < 2; pass++) {
      ctx.win.Mushaf.layout(box, data.fit.centreBelow[version]);
    }

    /* Only the factors are compared, never the geometry: these two passes have
       just written font sizes, and reading a width now would report the size
       from before them. What the fit decided is enough — if it decides the same
       thing twice it will draw the same thing twice. */
    var moved = 0, movedAt = -1;
    for (i = 0; i < ayahs.length; i++) {
      if ((ayahs[i].style.fontSize || '') !== firstPass[i]) { moved++; if (movedAt < 0) movedAt = i + 1; }
    }
    if (moved) {
      issues.push('refitting moved ' + moved + ' line' + (moved === 1 ? '' : 's')
                  + ' (first at line ' + movedAt + ')');
    }

    /* The lane the turn buttons stand in.
    
       #content-area holds a lane of --turn-lane open on each side and the
       buttons sit inside it, so nothing has to know where a button is: if a
       sheet reaches into that lane, a button is over the words. Checking the
       lane rather than the buttons also means this holds for a page the reader
       has not turned to yet, and for screen sizes the buttons are hidden at.
    
       A sheet is centred in the area, so the narrower side is the one to
       measure — the other cannot be the first to close. */
    var area = ctx.doc.getElementById('content-area');
    var lane = parseFloat(ctx.win.getComputedStyle(ctx.doc.documentElement)
                 .getPropertyValue('--turn-lane')) || 0;
    if (area && lane > 0) {
      var ar = area.getBoundingClientRect(), sr = section.getBoundingClientRect();
      var clear = Math.min(sr.left - ar.left, ar.right - sr.right);
      /* A pixel of tolerance: the sheet's width is a fractional number of
         pixels and the lane is a whole one. */
      if (clear < lane - 1) {
        issues.push('only ' + Math.round(clear) + 'px beside the sheet for the '
                    + Math.round(lane) + 'px turn lane');
      }
    }

    rec.size = Math.round(parseFloat(ctx.win.getComputedStyle(box).fontSize) * 100) / 100;
    rec.fill = avail ? Math.round(median(widths) / avail * 100) : 0;
    rec.height = Math.round(section.getBoundingClientRect().height);

    // A line past the sheet edge is the bug this whole model exists to prevent.
    if (over > 1) issues.push('line overflows by ' + Math.round(over) + 'px');
    if (pulled > 20) issues.push('a line had to be pulled in ' + Math.round(pulled) + '%');

    var wantLines = ctx.win.Mushaf.lineCount(data.pages[p]);
    if (box.children.length !== wantLines) {
      issues.push('built ' + box.children.length + ' of ' + wantLines + ' lines');
    }
    rec.lines = wantLines;

    /* Only a surah opening partway down a page draws a break — one opening at
       the top is named by the running head instead. */
    var breaks = box.querySelectorAll('.m-line.m-surah');
    var wanted = midPageOpenings(p);
    if (breaks.length !== wanted) {
      issues.push('surah breaks: ' + breaks.length + ' of ' + wanted);
    }

    // A break names a surah, and that name has to fit the line it was given.
    for (var b = 0; b < breaks.length; b++) {
      var tag = breaks[b].firstElementChild;
      if (!tag || !tag.textContent) { issues.push('a surah break names nothing'); continue; }
      if (breaks[b].scrollHeight - breaks[b].clientHeight > 1 ||
          breaks[b].scrollWidth - breaks[b].clientWidth > 1) {
        issues.push('surah break overflows its line');
      }
    }

    // A surah ends on this page, so a closing line should be centred.
    if ((closesOn[p] || []).length && !box.querySelector('.m-close')) {
      issues.push('no closing line');
    }

    /* The head must not run past the sheet either — long juz and page numbers
       plus a wide surah glyph is the case that would. */
    var head = section.querySelector('.page-head');
    if (head && head.scrollWidth - head.clientWidth > 1) {
      issues.push('running head overflows by ' + (head.scrollWidth - head.clientWidth) + 'px');
    }

    // Every page is its slot count tall, so any page past the screen is a bug.
    if (rec.height > ctx.h) issues.push('taller than the screen by ' + (rec.height - ctx.h) + 'px');

    return rec;
  }

  /* ---------- the run ---------- */

  function screenSize() {
    var v = $('#f-screen').value.split('x');
    return { w: +v[0], h: +v[1] };
  }

  async function run() {
    if (running) return;
    running = true; stopped = false; rows = [];
    $('#btn-run').disabled = true;
    $('#btn-stop').disabled = false;
    $('#rows').innerHTML = '';

    var versions = [VERSION];
    var from = Math.max(1, +$('#f-from').value);
    var to = Math.min(604, +$('#f-to').value);
    var size = screenSize();

    await makeFrame(size.w, size.h, +$('#f-scale').value);

    var total = versions.length * (to - from + 1), done = 0;

    for (var vi = 0; vi < versions.length && !stopped; vi++) {
      for (var p = from; p <= to && !stopped; p++) {
        var built = await renderPage(versions[vi], p);
        rows.push(measure(versions[vi], p, built));
        done++;
        if (done % 10 === 0 || done === total) {
          $('#progress').textContent = done + ' / ' + total;
          await new Promise(function (r) { setTimeout(r, 0); });
        }
      }
    }

    flagOutliers();
    render();
    running = false;
    $('#btn-run').disabled = false;
    $('#btn-stop').disabled = true;
  }

  /** The type size is meant to be one size throughout — flag anything off it. */
  function flagOutliers() {
    [VERSION].forEach(function (v) {
      var mine = rows.filter(function (r) { return r.version === v && r.size; });
      if (!mine.length) return;
      var mid = median(mine.map(function (r) { return r.size; }));
      mine.forEach(function (r) {
        var off = Math.abs(r.size - mid) / mid;
        if (off > 0.02) {
          r.issues.push('size ' + r.size + 'px, ' + Math.round(off * 100) + '% off the ' + mid + 'px norm');
        }
      });
    });
  }

  /* ---------- output ---------- */

  function render() {
    var bad = rows.filter(function (r) { return r.issues.length; });
    var tight = rows.reduce(function (n, r) { return n + r.tight; }, 0);

    $('#summary').innerHTML =
      card(rows.length, 'pages measured') +
      card(bad.length, 'with issues', bad.length ? 'bad' : 'good') +
      card(tight, 'lines shrunk to fit') +
      (function () {
        var b = rows.map(function (r) { return r.buildMs; }).filter(function (x) { return x; });
        if (!b.length) return '';
        var sorted = b.slice().sort(function (x, y) { return x - y; });
        var mid = sorted[Math.floor(sorted.length / 2)];
        var p95 = sorted[Math.floor(sorted.length * 0.95)];
        var over = mid > BUILD_MEDIAN_MS || p95 > BUILD_P95_MS;
        return card(mid + 'ms', 'to build a page — p95 ' + p95 + 'ms, budget ' +
                    BUILD_MEDIAN_MS + '/' + BUILD_P95_MS + 'ms',
                    over ? 'bad' : 'good');
      }()) +
      (function () {
        var f = rows.map(function (r) { return r.fontMs; }).filter(function (x) { return x; });
        if (!f.length) return '';
        return card(median(f) + 'ms', 'to fetch a page font (network, not budgeted)');
      }()) +
      (function () {
        var h = rows.map(function (r) { return r.height; }).filter(Boolean);
        return h.length ? card(Math.min.apply(null, h) + '-' + Math.max.apply(null, h) + 'px',
                               'sheet height, by line count') : '';
      }()) +
      [VERSION].map(function (v) {
        var mine = rows.filter(function (r) { return r.version === v && r.size; });
        if (!mine.length) return '';
        return card(median(mine.map(function (r) { return r.size; })) + 'px',
                    v + ' type size, median ' +
                    median(mine.map(function (r) { return r.fill; })) + '% fill');
      }).join('');

    $('#rows').innerHTML = rows.map(function (r, i) {
      return '<tr data-i="' + i + '" class="' + (r.issues.length ? 'bad' : '') + '">' +
        '<td>' + r.page + '</td><td>' + r.version + '</td><td>' + r.surahs + '</td>' +
        '<td>' + r.size + '</td><td>' + r.fill + '%</td><td>' + (r.tight || '') + '</td>' +
        '<td>' + r.height + '</td>' +
        '<td>' + (r.buildMs || '') + '</td><td>' + (r.fontMs || '') + '</td>' +
        '<td class="issues">' + r.issues.join('; ') + '</td></tr>';
    }).join('');
  }

  function card(value, label, cls) {
    return '<div class="card ' + (cls || '') + '"><b>' + value + '</b>' + label + '</div>';
  }

  /* ---------- wiring ---------- */

  $('#btn-run').addEventListener('click', run);
  $('#btn-stop').addEventListener('click', function () { stopped = true; });

  $('#rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (!tr || running) return;
    var r = rows[+tr.dataset.i];
    document.querySelectorAll('#rows tr').forEach(function (x) { x.classList.remove('sel'); });
    tr.classList.add('sel');
    $('#preview-label').textContent = 'page ' + r.page + ' — ' + r.version +
      (r.issues.length ? ' — ' + r.issues.join('; ') : '');
    renderPage(r.version, r.page);
  });

  Promise.all([
    fetch('/data/mushaf.json').then(function (r) { return r.json(); }),
    fetch('/data/surahs.json').then(function (r) { return r.json(); }),
  ]).then(function (out) {
    data = out[0];
    surahs = out[1];
    surahs.forEach(function (s) {
      (opensOn[s.from] = opensOn[s.from] || []).push(s.en);
      (closesOn[s.to] = closesOn[s.to] || []).push(s.en);
    });
    makeFrame(1440, 900, 1).then(function () { $('#progress').textContent = 'ready'; });
  });
}());
