/* Sets the theme before the page is painted.
 *
 * app.js decides the same thing, but it runs after jQuery has loaded, which is
 * long enough for a reader whose device is dark to be shown a white screen
 * first. This is loaded at the top of <body> for that one reason: it has to be
 * early, not clever. It is a file rather than an inline script so the
 * Content-Security-Policy can keep script-src at 'self'.
 *
 * The device decides, every visit. A theme chosen in the app holds only while
 * that tab is open and is never stored, so there is nothing here to read.
 */
(function () {
  var dark = window.matchMedia &&
             window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.body.className = dark ? 'dark-mode' : 'light-mode';
}());
