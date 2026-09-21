/**
 * Searchable Quran text.
 *
 * A page is drawn from glyph codes, so nothing on it can be matched against
 * typed letters. The words are fetched as text instead, once, the first time
 * anyone searches — 214 KB over the wire, and never for a reader who does not.
 *
 * Tanzil Simple Clean, the same file the app searches: surah|ayah|text.
 */
(function (global) {
  'use strict';

  var FILE = '/data/quran-simple.txt';

  /** How many hits are worth showing. Past this the list is a wall, not an answer. */
  var LIMIT = 60;

  /** The shortest query searched at all. One letter is in nearly every ayah. */
  var FLOOR = 2;

  /* Shorter queries must be whole words, or they match inside too many longer ones. */
  var LOOSE_FROM = 3;

  var app = null, all = null, pending = null;

  /** fold() */
  function init(host) { app = host; }

  /** Reads the file if it is there. One fetch, however often it is asked for. */
  function load() {
    if (all) return Promise.resolve(all);
    if (pending) return pending;

    pending = fetch(FILE)
      .then(function (r) { return r.ok ? r.text() : ''; })
      .catch(function () { return ''; })
      .then(function (text) {
        all = [];
        text.split('\n').forEach(function (line) {
          /* Tanzil's files carry their licence as # comments. */
          if (!line || line.charAt(0) === '#') return;
          var a = line.indexOf('|');
          if (a <= 0) return;
          var b = line.indexOf('|', a + 1);
          if (b <= a) return;
          var body = line.slice(b + 1).trim();
          if (!body) return;
          all.push({
            s: +line.slice(0, a),
            v: +line.slice(a + 1, b),
            text: body,
            /* Folded once, so a query is not matched against 6236 re-foldings. */
            folded: app.fold(body),
          });
        });
        return all;
      });
    return pending;
  }

  function opensWord(text, at) { return at === 0 || text.charAt(at - 1) === ' '; }
  function closesWord(text, end) { return end === text.length || text.charAt(end) === ' '; }

  /* Prefers a whole-word or word-opening match, so the row marks the word meant. */
  function firstMatch(text, q, whole) {
    var from = 0, buried = -1;
    for (;;) {
      var at = text.indexOf(q, from);
      if (at < 0) return whole ? -1 : buried;
      if (opensWord(text, at)) {
        if (!whole || closesWord(text, at + q.length)) return at;
      } else if (!whole && buried < 0) {
        buried = at;
      }
      from = at + 1;
    }
  }

  /** Matches that open a word come before ones buried inside a word. */
  function find(folded) {
    if (!all || folded.length < FLOOR) return [];
    var whole = folded.length < LOOSE_FROM;
    var opens = [], buried = [];

    for (var i = 0; i < all.length; i++) {
      var at = firstMatch(all[i].folded, folded, whole);
      if (at < 0) continue;
      (opensWord(all[i].folded, at) ? opens : buried).push({ ayah: all[i], at: at });
      if (opens.length >= LIMIT) break;
    }

    if (opens.length >= LIMIT) return opens;
    return opens.concat(buried.slice(0, LIMIT - opens.length));
  }

  global.Ayahs = {
    init: init,
    load: load,
    find: find,
  };

}(window));
