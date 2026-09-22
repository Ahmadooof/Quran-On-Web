/**
 * Every page the site says it has, and whether it answers.
 *
 * The list is the sitemap rather than anything written here, so a page that is
 * generated is a page that appears — and one that does not answer is exactly
 * the thing worth seeing.
 */
(function () {
  'use strict';

  var AT_ONCE = 8;   // quick, without looking like an attack on our own server
  var PAGE = 40;     // rows before "show more"; 229 at once is the long list

  var said = document.getElementById('status');
  var tbody = document.getElementById('rows');
  var tabsEl = document.getElementById('tabs');
  var findEl = document.getElementById('find');
  var onlyEl = document.getElementById('only');
  var moreEl = document.getElementById('more');
  var noneEl = document.getElementById('none');
  var button = document.getElementById('check');
  var rowTemplate = document.getElementById('row');

  var links = [];        // { url, kind, status, ms, el }
  var kind = 'All';
  var shown = PAGE;

  /* What a url is, by its shape rather than by where it sits. */
  function kindOf(url) {
    if (/^\/surah\/\d+\/text\/$/.test(url)) return 'Surah text';
    if (/^\/surah\/\d+\/$/.test(url)) return 'Reader';
    return 'Other';
  }

  function make(url) {
    var el = rowTemplate.content.cloneNode(true).firstElementChild;
    var a = el.querySelector('.c-url a');
    a.href = url;
    a.textContent = url;
    el.querySelector('.c-kind').textContent = kindOf(url);
    return { url: url, kind: kindOf(url), status: null, ms: 0, el: el };
  }

  /* An unchecked link is neither accessible nor not, so it says neither. */
  function fill(link) {
    var open = link.el.querySelector('.c-open');
    var code = link.el.querySelector('.c-code');
    var ok = link.status === 200;
    open.textContent = ok ? 'Accessible' : 'Not accessible';
    open.className = 'c-open ' + (ok ? 'ok' : 'bad');
    code.textContent = link.status || 'no answer';
    code.className = 'c-code ' + (ok ? '' : 'bad');
    link.el.querySelector('.c-ms').textContent = link.ms + ' ms';
  }

  // ---- what is on screen ----

  function matches(link) {
    if (kind !== 'All' && link.kind !== kind) return false;
    if (onlyEl.checked && (link.status === null || link.status === 200)) return false;
    var q = findEl.value.trim().toLowerCase();
    return !q || link.url.toLowerCase().indexOf(q) !== -1;
  }

  function render() {
    var seen = links.filter(matches);
    tbody.textContent = '';
    seen.slice(0, shown).forEach(function (l) { tbody.appendChild(l.el); });

    noneEl.hidden = seen.length > 0;
    moreEl.hidden = seen.length <= shown;
    moreEl.textContent = 'Show ' + Math.min(PAGE, seen.length - shown) + ' more of '
      + (seen.length - shown);
  }

  function tally() {
    var done = links.filter(function (l) { return l.status !== null; });
    var ok = done.filter(function (l) { return l.status === 200; }).length;
    document.getElementById('t-all').textContent = links.length;
    document.getElementById('t-done').textContent = done.length;
    document.getElementById('t-ok').textContent = ok;
    document.getElementById('t-bad').textContent = done.length - ok;
  }

  function tabs() {
    var names = ['All', 'Reader', 'Surah text', 'Other'];
    names.forEach(function (name) {
      var n = name === 'All' ? links.length
        : links.filter(function (l) { return l.kind === name; }).length;
      if (!n) return;

      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (name === kind ? ' on' : '');
      b.innerHTML = name + ' <span>' + n + '</span>';
      b.addEventListener('click', function () {
        kind = name;
        shown = PAGE;
        [].forEach.call(tabsEl.children, function (c) { c.classList.remove('on'); });
        b.classList.add('on');
        render();
      });
      tabsEl.appendChild(b);
    });
  }

  // ---- asking the server ----

  /* A HEAD asks the one thing being asked here, and carries no body back. */
  function check(link) {
    var began = performance.now();
    return fetch(link.url, { method: 'HEAD', cache: 'no-store' })
      .then(function (res) { return res.status; })
      .catch(function () { return 0; })
      .then(function (status) {
        link.status = status;
        link.ms = Math.round(performance.now() - began);
        fill(link);
        return status;
      });
  }

  function checkAll() {
    button.disabled = true;
    var done = 0, bad = 0, next = 0;

    function take() {
      if (next >= links.length) return Promise.resolve();
      var link = links[next++];
      return check(link).then(function (status) {
        done++;
        if (status !== 200) bad++;
        said.textContent = done + ' of ' + links.length + ' checked'
          + (bad ? ' — ' + bad + ' not accessible' : '');
        tally();
        if (onlyEl.checked) render();   // the failures are what is on screen
        return take();
      });
    }

    var runners = [];
    for (var i = 0; i < AT_ONCE; i++) runners.push(take());

    Promise.all(runners).then(function () {
      said.textContent = links.length + ' checked, '
        + (bad ? bad + ' not accessible' : 'every one accessible');
      said.className = 'status ' + (bad ? 'bad' : 'ok');
      button.disabled = false;
      render();
    });
  }

  // ---- boot ----

  findEl.addEventListener('input', function () { shown = PAGE; render(); });
  onlyEl.addEventListener('change', function () { shown = PAGE; render(); });
  moreEl.addEventListener('click', function () { shown += PAGE; render(); });

  fetch('/sitemap.xml', { cache: 'no-store' })
    .then(function (r) { return r.text(); })
    .then(function (xml) {
      /* The paths, not the urls the sitemap writes: those name the live host,
         and asking for them from anywhere else is a cross-origin request the
         browser will not answer. A path is the same page on whichever host
         this page is being read from. */
      var urls = (xml.match(/<loc>([^<]+)<\/loc>/g) || [])
        .map(function (m) { return new URL(m.slice(5, -6)).pathname; });
      if (!urls.length) throw new Error('the sitemap names no urls');

      links = urls.map(make);
      tabs();
      tally();
      render();
      said.textContent = links.length + ' urls in the sitemap. Nothing checked yet.';
      button.addEventListener('click', checkAll);
    })
    .catch(function (e) {
      said.textContent = 'Could not read the sitemap: ' + e.message;
      said.className = 'status bad';
    });
}());
