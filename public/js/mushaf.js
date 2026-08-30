/**
 * Mushaf page rendering.
 *
 * Each page of the Madinah Mushaf has its own QCF font holding one glyph per
 * printed word, so a page's glyph codes only mean anything in that page's own
 * font. This module builds a page's lines from data/mushaf.json and loads the
 * matching font on demand.
 *
 * The type size is decided in CSS, from the version's line width in the data
 * (--m-base) against the room on screen. Here we only settle the two ends:
 * an outlier line drawn wider than the rest, and a line short enough to be
 * centred rather than pulled out to both margins.
 *
 * A long surah runs to dozens of pages, so lines and fonts are built as the
 * reader reaches them and dropped again afterwards.
 */
(function (global) {
  'use strict';

  var SEP = '|';

  /* Surah name glyphs live in sura-names.woff2, addressed by reading the
     surah's decimal number as if it were hexadecimal: 4 -> E004, 10 -> E010,
     114 -> E114. */
  function surahGlyph(n) {
    return String.fromCharCode(0xE000 + parseInt(String(n).padStart(3, '0'), 16));
  }

  /* The word سورة, drawn in the same hand as the names. It sits at U+E000,
     just below the 114 names, which is why the numbering starts at E001. */
  var SURAH_WORD = String.fromCharCode(0xE000);

  /**
   * The word and the name together, as the mushaf heads a surah — two spans
   * so the gap between them can be set in CSS.
   *
   * Not a space character: this font has no thin space at all, so the browser
   * would fetch a fallback font to set one character in the middle of the
   * title, and its plain space is zero width, which would set them touching.
   */
  function surahTitle(n) {
    return '<span class="sw">' + SURAH_WORD + '</span>' +
           '<span class="sn">' + surahGlyph(n) + '</span>';
  }

  /* ---------- font registry ----------------------------------------------
     Every registered face takes part in font matching on each style recalc,
     so reading a long surah must not leave hundreds behind. Faces are evicted
     oldest first; the pinned ones are the Basmalah's, which every page uses. */

  var MAX_FACES = 24;
  var faces  = {};    // family -> { face, promise }
  var order  = [];    // families, least recently used first
  var pinned = {};

  function touch(family) {
    var i = order.indexOf(family);
    if (i >= 0) order.splice(i, 1);
    order.push(family);
  }

  function evict() {
    while (order.length > MAX_FACES) {
      var family = null;
      for (var i = 0; i < order.length; i++) {
        if (!pinned[order[i]]) { family = order[i]; break; }
      }
      if (!family) return;
      order.splice(order.indexOf(family), 1);
      try { document.fonts.delete(faces[family].face); } catch (e) { /* already gone */ }
      delete faces[family];
    }
  }

  function familyFor(version, page) { return 'QCF-' + version + '-' + page; }

  /** Is this page's face still registered, or has it been evicted since? */
  function hasFont(version, page) {
    return !!faces[familyFor(version, page)];
  }

  /**
   * Register a page's font with the document and resolve once it is usable.
   * The family name carries the version, so switching version re-fits against
   * the right metrics instead of reusing the other version's.
   */
  function loadPageFont(version, page, pin) {
    var family = familyFor(version, page);
    if (pin) pinned[family] = true;

    if (!faces[family]) {
      var face = new FontFace(family, 'url(/fonts/' + version + '/p' + page + '.woff2)');
      document.fonts.add(face);
      faces[family] = {
        face: face,
        promise: face.load().then(function () { return family; }),
      };
    }
    touch(family);
    evict();
    return faces[family].promise;
  }

  /* ---------- page building ---------------------------------------------- */

  /** The empty shell for a page: no lines yet, but it reserves their height. */
  function createBox() {
    var box = document.createElement('div');
    box.className = 'mushaf';
    return box;
  }

  /**
   * How many lines a page draws. Where the mushaf left only one free line above
   * a surah it carries the Basmalah too (b:1); the reader gives it a line of
   * its own regardless, so every surah opens the same way. The page stays its
   * slot count tall — the two ornamental lines share one slot.
   */
  function lineCount(lines) {
    var n = 0, seenText = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.t === 'ayah') seenText = true;
      if (l.t === 'surah') {
        n++;                 // every heading is drawn, so every heading takes a line
        if (l.b) n++;        // the Basmalah the mushaf squeezed onto its line
      } else {
        n++;
      }
    }
    return n;
  }

  /**
   * Build a page's lines into its box.
   *
   * `at` is which ayah the page's first word belongs to and how far into it
   * that word is — { s, v, w }. The reader needs every word to know its ayah,
   * to light the one being recited and the whole of the one under the pointer,
   * and the page data does not say: it gives glyphs and the marks that close
   * an ayah, so the number is arrived at by counting the marks from the
   * surah's first page. The caller does that once; here it is only carried
   * forward, word by word, through the page.
   */
  function fillBox(box, lines, version, basmalah, marks, at) {
    var frag = document.createDocumentFragment();
    var seenText = false;
    var s = at ? at.s : 0, v = at ? at.v : 0, w = at ? at.w : 0;

    lines.forEach(function (line) {
      if (line.t === 'ayah') seenText = true;
      var el = document.createElement('div');
      el.className = 'm-line m-' + line.t;

      /* A surah beginning partway down the page starts its own numbering, and
         every word after it on this page belongs to the new surah. */
      if (line.t === 'surah') { s = line.s; v = 1; w = 0; }

      if (line.t === 'ayah') {
        if (line.c) el.classList.add('m-close');
        line[version].split(SEP).forEach(function (word) {
          var span = wordSpan(word);
          /* An ayah's closing number, so it can be set apart from the words.
             A marker is a single glyph and no page uses that same code for a
             word, so testing the code is enough to know one. */
          var end = marks && marks.indexOf(word) >= 0;
          if (end) span.classList.add('m-end');

          span.dataset.a = s + ':' + v;
          /* The closing number is drawn, not recited, so it is part of its
             ayah but is never the word being said. */
          if (!end) span.dataset.w = w++;

          el.appendChild(span);
          if (end) { v++; w = 0; }
        });

      } else if (line.t === 'basmalah') {
        el.appendChild(basmalahRun(basmalah, version));

      } else if (line.t === 'surah') {
        /* Every surah is named where it begins, whether that is partway down a
           page or at the top of one. The running head names the page, which is
           a different job: it labels, this announces. */
        {
          var name = document.createElement('span');
          name.className = 'page-label ph-surah';
          name.innerHTML = surahTitle(line.s);
          el.appendChild(name);
        }
      }

      if (el) frag.appendChild(el);

      /* b:1 means the mushaf squeezed the Basmalah onto the header's line. We
         give it the same line of its own that every other surah gets. */
      if (line.t === 'surah' && line.b) {
        var bas = document.createElement('div');
        bas.className = 'm-line m-basmalah';
        bas.appendChild(basmalahRun(basmalah, version));
        frag.appendChild(bas);
      }
    });

    box.textContent = '';
    box.appendChild(frag);
  }

  /**
   * One printed word. A couple of hundred words are drawn as two glyphs with a
   * gap between them, which the source writes as a space. V1 has a space glyph
   * of its own — a hair space, 0.04em — but V2 has none at all, so a plain
   * space would fall back to some other font and open a gap four times too
   * wide. The gap is drawn explicitly instead, at the width V1 designs it.
   */
  var WORD_GAP = '0.04em';

  function wordSpan(word) {
    var s = document.createElement('span');
    s.className = 'm-word';
    var parts = word.split(' ');
    s.textContent = parts[0];
    for (var i = 1; i < parts.length; i++) {
      var gap = document.createElement('i');
      gap.className = 'm-gap';
      gap.style.width = WORD_GAP;
      s.appendChild(gap);
      s.appendChild(document.createTextNode(parts[i]));
    }
    return s;
  }

  /** Drop a page's lines. The shell goes on reserving their height. */
  function emptyBox(box) {
    box.textContent = '';
    box.classList.remove('ready');
    delete box.dataset.version;
    delete box.dataset.pending;
  }

  /**
   * The Basmalah, drawn from page 1's font — Al-Fatihah 1:1 is the Basmalah,
   * so the glyphs already exist there in whichever version is selected.
   */
  function basmalahRun(basmalah, version) {
    var run = document.createElement('span');
    run.className = 'm-basmalah-run';
    run.style.fontFamily = '"' + familyFor(version, basmalah.page) + '"';
    basmalah[version].split(SEP).forEach(function (word, i) {
      var s = document.createElement('span');
      s.className = 'm-word';
      s.textContent = (i ? ' ' : '') + word;
      run.appendChild(s);
    });
    return run;
  }

  /* ---------- which ayah each word belongs to ------------------------------
     The page data names no ayah. It gives a page's words as glyphs and, apart
     from them, the glyphs that close an ayah — so the numbering is recovered
     by reading the mushaf the way it is read: from where a surah begins, count
     a marker as the end of one ayah and the start of the next.

     Checked against the ayah counts in surahs.json, this agrees for all 114
     surahs, which it would not do if a marker were ever missed or double
     counted. */

  /**
   * Where each page's numbering stands as the page opens, and which page each
   * ayah begins on. One pass over all 604 pages, about 78,000 words; it runs
   * once, when the first surah is opened.
   */
  function ayahIndex(pages, marks) {
    var enter = {};                 // page -> { s, v, w } as the page opens
    var began = {};                 // "surah:ayah" -> the page it starts on
    var s = 0, v = 0, w = 0;

    for (var p = 1; p <= 604; p++) {
      enter[p] = { s: s, v: v, w: w };
      var lines = pages[p] || [], mk = marks[p] || '';

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.t === 'surah') { s = line.s; v = 1; w = 0; }
        if (line.t !== 'ayah') continue;

        var words = line.v2.split(SEP);
        for (var k = 0; k < words.length; k++) {
          var end = mk.indexOf(words[k]) >= 0;
          if (!end) {
            /* An ayah is credited to the page its first word is printed on,
               which is what the reader must turn to when it is recited. */
            if (w === 0 && !began[s + ':' + v]) began[s + ':' + v] = p;
            w++;
          } else { v++; w = 0; }
        }
      }
    }
    return { enter: enter, began: began };
  }

  /* ---------- settling lines against the measure -------------------------- */

  /** Width a line wants: flex items keep their natural width under
      space-between — only the gaps grow — so the words simply add up. */
  function naturalWidth(line) {
    var words = line.children;
    var w = 0;
    for (var i = 0; i < words.length; i++) w += words[i].getBoundingClientRect().width;
    return w;
  }

  /* The gap a centred line opens between its words — must match .m-short. */
  var CENTRE_GAP = 0.32;

  /**
   * Settle a page's lines: shrink the few drawn wider than the measure, centre
   * the ones short enough. One read pass, writes only where needed.
   */
  function layoutLines(box, centreBelow) {
    var lines = box.querySelectorAll('.m-line.m-ayah');
    if (!lines.length) return false;

    var avail = box.clientWidth;
    if (avail < 10) return false;

    var i, w;

    /* Three passes, and in this order. Clearing a line's size invalidates the
       layout, so measuring one line at a time between clears makes the browser
       reflow the whole page on every line — fifteen reflows a page, and by far
       the slowest thing here. Every write happens first, then every read. */
    for (i = 0; i < lines.length; i++) {
      lines[i].style.fontSize = '';
      lines[i].style.height = '';
      lines[i].style.lineHeight = '';
    }

    /* A line's height is set in ems, so shrinking one would shorten it and
       pull the page off its fixed line grid. The height every line must keep
       is read once, before anything is shrunk. */
    var lineHeight = lines[0].getBoundingClientRect().height;

    /* The type size is only needed to size a centred line's gaps, and barely
       any line is centred — 22 of 8807 in V2. Resolving a computed style costs
       tens of milliseconds here, because every registered page font takes part
       in the match, so it is left until a line actually asks for it. */
    var em = -1;

    var widths = [];
    for (i = 0; i < lines.length; i++) {
      w = naturalWidth(lines[i]);
      /* A page whose font has not painted yet measures as nothing — leave it
         for the caller to retry rather than locking in a bogus layout. */
      if (w <= 0) return false;
      widths.push(w);
    }

    for (var j = 0; j < lines.length; j++) {
      var line = lines[j], width = widths[j];

      if (width > avail) {
        /* A hair under, so rounding cannot put it back over the edge. */
        line.style.fontSize = (avail / width * 99.5) + '%';
        line.style.height = lineHeight + 'px';
        line.style.lineHeight = lineHeight + 'px';
        line.classList.remove('m-short');
        continue;
      }

      /* Centre a line short of the measure — but only while the gaps centring
         opens still fit. Leaving them out is what used to push a line past the
         sheet: a line at 88% of the measure with ten words needs another 18%
         for its gaps. */
      if (width >= avail * centreBelow) { line.classList.remove('m-short'); continue; }
      if (em < 0) em = parseFloat(getComputedStyle(box).fontSize) || 0;
      var gaps = (line.children.length - 1) * CENTRE_GAP * em;
      line.classList.toggle('m-short', width + gaps <= avail);
    }
    return true;
  }

  global.Mushaf = {
    surahGlyph  : surahGlyph,
    surahTitle  : surahTitle,
    hasFont     : hasFont,
    ayahIndex   : ayahIndex,
    lineCount   : lineCount,
    createBox   : createBox,
    fill        : fillBox,
    empty       : emptyBox,
    loadPageFont: loadPageFont,
    layout      : layoutLines,
  };

}(window));
