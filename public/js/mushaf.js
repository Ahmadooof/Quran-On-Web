/**
 * Mushaf page rendering.
 *
 * Each page has its own QCF font holding one glyph per printed word, so a
 * page's glyph codes only mean anything in that page's own font. Lines and
 * fonts are built as the reader reaches them and dropped afterwards.
 *
 * The type size is decided in CSS; here we settle only the two ends — a line
 * drawn wider than the rest, and one short enough to be centred.
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

  /* The word and the name together, as the mushaf heads a surah: two spans so
     CSS can set the gap. Not a space — this font has none to set it with. */
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

  /* Register a page's font and resolve once it is usable. The family carries
     the version, so switching version re-fits against the right metrics. */
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
    // Glyph codes read as gibberish; reading modes and screen readers take the page's text block
    box.setAttribute('aria-hidden', 'true');
    return box;
  }

  /* How many lines a page draws. Where only one free line was left above a
     surah the Basmalah shares it, but the reader always gives it its own. */
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
   * `at` is which ayah the first word belongs to and how far into it —
   * { s, v, w }. The page data gives glyphs and end-of-ayah marks but no
   * numbers, so the caller counts them once and this carries them forward.
   */
  function fillBox(box, lines, version, basmalah, marks, at) {
    var frag = document.createDocumentFragment();
    var seenText = false;
    // w numbers the words, g the glyph slots holding them; they part only at a pair
    var s = at ? at.s : 0, v = at ? at.v : 0, w = at ? at.w : 0, g = at ? (at.g || 0) : 0;

    lines.forEach(function (line) {
      if (line.t === 'ayah') seenText = true;
      var el = document.createElement('div');
      el.className = 'm-line m-' + line.t;

      /* A surah beginning partway down the page starts its own numbering, and
         every word after it on this page belongs to the new surah. */
      if (line.t === 'surah') { s = line.s; v = 1; w = 0; g = 0; }

      if (line.t === 'ayah') {
        if (line.c) el.classList.add('m-close');
        line[version].split(SEP).forEach(function (word) {
          /* An ayah's closing number, so it can be set apart from the words.
             A marker is a single glyph and no page uses that same code for a
             word, so testing the code is enough to know one. */
          var end = marks && marks.indexOf(word) >= 0;
          var key = s + ':' + v;

          if (!end && PAIRS[key] === g) {
            el.appendChild(pairSpan(word, key, w));
            w += 2; g++;
            return;
          }

          var span = wordSpan(word);
          if (end) span.classList.add('m-end');

          span.dataset.a = key;
          /* The closing number is drawn, not recited, so it is part of its
             ayah but is never the word being said. */
          if (!end) { span.dataset.w = w++; g++; }

          el.appendChild(span);
          if (end) { v++; w = 0; g = 0; }
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

  /* One printed word. A couple of hundred are drawn as two glyphs with a gap,
     written as a space — V2 has no space glyph, so the gap is drawn. */
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

  /* Two words the mushaf draws as one slot of two glyphs, each marked as it is
     recited: ayah -> slot, zero-based. scripts/joined-words.js keeps the same list. */
  var PAIRS = { '2:181': 2, '8:6': 3, '13:37': 7 };

  /* One slot to the line, which measures and spaces it as a word; two words to
     the recitation, each half carrying its own number. */
  function pairSpan(word, key, w) {
    var slot = document.createElement('span');
    slot.className = 'm-word m-pair';
    var gap = word.indexOf(' ') >= 0;
    var parts = gap ? word.split(' ') : [word.charAt(0), word.slice(1)];
    parts.forEach(function (part, i) {
      if (i && gap) {
        var g = document.createElement('i');
        g.className = 'm-gap';
        g.style.width = WORD_GAP;
        slot.appendChild(g);
      }
      var half = document.createElement('span');
      half.className = 'm-word';
      half.textContent = part;
      half.dataset.a = key;
      half.dataset.w = w + i;
      slot.appendChild(half);
    });
    return slot;
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

  /* ---------- which ayah each word belongs to ----------
     The page data names no ayah: it gives words as glyphs and, apart, the
     glyphs that close one. So the numbering is recovered by counting markers
     from where a surah begins. It agrees with surahs.json for all 114. */

  /* Where each page's numbering stands as it opens, and which page each ayah
     begins on. One pass over 604 pages, when the first surah is opened. */
  function ayahIndex(pages, marks) {
    var enter = {};                 // page -> { s, v, w, g } as the page opens
    var began = {};                 // "surah:ayah" -> the page it starts on
    var s = 0, v = 0, w = 0, g = 0;

    for (var p = 1; p <= 604; p++) {
      enter[p] = { s: s, v: v, w: w, g: g };
      var lines = pages[p] || [], mk = marks[p] || '';

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.t === 'surah') { s = line.s; v = 1; w = 0; g = 0; }
        if (line.t !== 'ayah') continue;

        var words = line.v2.split(SEP);
        for (var k = 0; k < words.length; k++) {
          var end = mk.indexOf(words[k]) >= 0;
          if (!end) {
            /* An ayah is credited to the page its first word is printed on,
               which is what the reader must turn to when it is recited. */
            if (w === 0 && !began[s + ':' + v]) began[s + ':' + v] = p;
            w += PAIRS[s + ':' + v] === g ? 2 : 1;   // counted as fillBox numbers them
            g++;
          } else { v++; w = 0; g = 0; }
        }
      }
    }
    return { enter: enter, began: began };
  }

  /* ---------- settling lines against the measure -------------------------- */

  /**
   * Width a line wants, at the size the sheet is currently set in.
   *
   * Measured once and kept as a fraction of the sheet's measure, so the fit
   * never reads back anything it wrote. A line already shrunk measures shrunk,
   * and setting a font size does not re-measure in the same task — so it lost
   * its shrink and overflowed, then got it back, flickering on every frame.
   * Dividing by the factor just applied feeds the fit its own rounding.
   */
  function naturalWidth(line, avail) {
    var kept = +line.dataset.nat;
    if (kept > 0 && avail > 0) return kept * avail;

    var words = line.children;
    var w = 0;
    for (var i = 0; i < words.length; i++) w += words[i].getBoundingClientRect().width;

    /* An inline font-size is only ever a percentage written by the fit below,
       so undoing it gives the width this line would have had unshrunk. Lines
       are built unshrunk, so this is the exact measurement nearly every time. */
    var shrunk = parseFloat(line.style.fontSize);
    if (shrunk > 0) w = w * 100 / shrunk;

    return w;
  }

  /** Remember what a line measured, once every line has been read. */
  function keepWidth(line, w, avail) {
    if (w > 0 && avail > 0 && !line.dataset.nat) line.dataset.nat = w / avail;
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

    var i, j;

    /* The vertical settings can be cleared before measuring: they move nothing
       sideways. The font size cannot, and that is the whole trick here — see
       naturalWidth below. */
    for (i = 0; i < lines.length; i++) {
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
      var w = naturalWidth(lines[i], avail);
      /* A page whose font has not painted yet measures as nothing — leave it
         for the caller to retry rather than locking in a bogus layout. */
      if (w <= 0) return false;
      widths.push(w);
    }

    /* Only now are the measurements written down: a write between every pair
       of reads is a reflow a line, and it showed as a 70x build time. */
    for (i = 0; i < lines.length; i++) keepWidth(lines[i], widths[i], avail);

    for (j = 0; j < lines.length; j++) {
      var line = lines[j], width = widths[j];

      if (width > avail) {
        /* A hair under, so rounding cannot put it back over the edge. */
        line.style.fontSize = (avail / width * 99.5) + '%';
        line.style.height = lineHeight + 'px';
        line.style.lineHeight = lineHeight + 'px';
        line.classList.remove('m-short');
        continue;
      }

      line.style.fontSize = '';

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

  /* ---------- page words ----------------------------------------------- */

  var words = {};

  /** A page's words, one per glyph span on its ayah lines; built by scripts/page-words.js. */
  function loadWords(p) {
    if (!words[p]) {
      words[p] = fetch('/data/words/p' + p + '.json')
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .catch(function (err) { delete words[p]; throw err; });
    }
    return words[p];
  }

  /** Put each word's text on its span; a count that disagrees is left alone rather than misplaced. */
  function setWords(box, list) {
    // Only spans that name a word: a pair's own slot is the frame round its two halves
    var spans = box.querySelectorAll('.m-ayah .m-word[data-a]');
    if (spans.length !== list.length) return false;
    for (var i = 0; i < spans.length; i++) spans[i].dataset.t = list[i];
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
    loadWords   : loadWords,
    setWords    : setWords,
  };

}(window));
