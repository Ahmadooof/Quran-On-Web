/* Sets the theme before the page is painted.
 *
 * app.js decides the same thing, but it runs after jQuery has loaded, which is
 * long enough for a reader whose system is dark to be shown a white screen
 * first. This is loaded at the top of <body> for that one reason: it has to be
 * early, not clever. It is a file rather than an inline script so the
 * Content-Security-Policy can keep script-src at 'self'.
 */
(function () {
  var saved = null;
  // Private mode can make localStorage throw on access rather than return null.
  try { saved = localStorage.getItem('quran-theme'); } catch (e) {}

  var dark = saved
    ? saved === 'dark'
    : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  document.body.className = dark ? 'dark-mode' : 'light-mode';
}());
