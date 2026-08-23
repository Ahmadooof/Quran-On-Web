/**
 * Renders every mushaf page in both QCF versions inside a frame the size of a
 * real screen, measures it, and lists whatever looks wrong — so the pages do
 * not have to be opened one surah at a time.
 *
 * Open http://localhost:3000/tests/audit.html with the app server running.
 */
(function () {
  'use strict';

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
        if (data) {
          ctx.win.Mushaf.loadPageFont('v1', data.basmalah.page, true);
          ctx.win.Mushaf.loadPageFont('v2', data.basmalah.page, true);
        }
        done(ctx);
      };
    });
  }

  /** Build one page into the frame, exactly as the reader does. */
  function renderPage(version, p) {
    var doc = ctx.doc, lines = data.pages[p];
    ctx.container.innerHTML = '';

    var section = doc.createElement('section');
    section.className = 'page-section';
    section.style.setProperty('--m-base', data.fit.body[version]);
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

    ctx.win.Mushaf.fill(box, lines, version, data.basmalah);

    return ctx.win.Mushaf.loadPageFont(version, p).then(function (family) {
      box.style.fontFamily = '"' + family + '"';
      // yield once so the new lines are laid out before they are measured
      return new Promise(function (done) { setTimeout(done, 0); }).then(function () {
        ctx.win.Mushaf.layout(box, data.fit.centreBelow[version]);
        return { section: section, box: box };
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
    };

    if (built.missing) {
      issues.push('font file missing');
      return rec;
    }

    var avail = box.clientWidth;
    var ayahs = box.querySelectorAll('.m-line.m-ayah');
    var widths = [], over = 0;

    var pulled = 0;
    for (var i = 0; i < ayahs.length; i++) {
      widths.push(lineWidth(ayahs[i]));
      /* A line the fitter pulled in is a handled case, counted under "tight".
         Only the lines it left alone say anything about the sizing model, and
         scrollWidth is what actually sticks out — it counts centring gaps. */
      if (ayahs[i].style.fontSize) {
        rec.tight++;
        pulled = Math.max(pulled, 100 - parseFloat(ayahs[i].style.fontSize));
      } else {
        over = Math.max(over, ayahs[i].scrollWidth - ayahs[i].clientWidth);
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

    var versions = $('#f-version').value.split(',');
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

  /** The type size is meant to be one size per version — flag anything off it. */
  function flagOutliers() {
    ['v1', 'v2'].forEach(function (v) {
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
        var h = rows.map(function (r) { return r.height; }).filter(Boolean);
        return h.length ? card(Math.min.apply(null, h) + '-' + Math.max.apply(null, h) + 'px',
                               'sheet height, by line count') : '';
      }()) +
      ['v1', 'v2'].map(function (v) {
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
