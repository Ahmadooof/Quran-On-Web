/**
 * Every link the site has, and whether it answers.
 *
 * The pages come from the sitemap rather than from anything written here, so a
 * page that is generated is a page that appears. The rest — the files a crawler
 * reads, the tools, the subdomain — are named below, because nothing generates
 * them and they are exactly what goes unnoticed when it breaks.
 */
(function () {
  'use strict';

  var AT_ONCE = 8;   // quick, without looking like an attack on our own server
  var PAGE = 40;     // rows before "show more"; 239 at once is the long list

  /* Not in the sitemap, and none of it should be: a crawler's files, the tools,
     and the hosts beside this one. */
  var BEYOND = [
    { url: '/robots.txt', kind: 'Site file' },
    { url: '/sitemap.xml', kind: 'Site file' },
    { url: '/site.webmanifest', kind: 'Site file' },
    { url: '/favicon.svg', kind: 'Site file' },
    { url: '/stats.js', kind: 'Site file' },
    // IndexNow refuses every submission if this stops answering
    { url: '/9f0578f5050c369da77670021f725393.txt', kind: 'Site file' },
    { url: '/admin/', kind: 'Tool' },
    { url: '/feedback/reports/', kind: 'Tool' },
    { url: 'https://analytics.readqurantoday.com/', kind: 'Subdomain' },
    { url: 'https://www.readqurantoday.com/', kind: 'Subdomain' }
  ];

  var said = document.getElementById('status');
  var tbody = document.getElementById('rows');
  var tabsEl = document.getElementById('tabs');
  var findEl = document.getElementById('find');
  var onlyEl = document.getElementById('only');
  var moreEl = document.getElementById('more');
  var noneEl = document.getElementById('none');
  var button = document.getElementById('check');
  var rowTemplate = document.getElementById('row');

  var links = [];        // { url, kind, away, status, ms, el }
  var kind = 'All';
  var shown = PAGE;

  /* What a sitemap url is, by its shape rather than by where it sits. */
  function kindOf(url) {
    if (/^\/surah\/\d+\/text\/$/.test(url)) return 'Surah text';
    if (/^\/surah\/\d+\/$/.test(url)) return 'Reader';
    return 'Other';
  }

  function make(url, kind) {
    var el = rowTemplate.content.cloneNode(true).firstElementChild;
    var a = el.querySelector('.c-url a');
    a.href = url;
    a.textContent = url;
    el.querySelector('.c-kind').textContent = kind;
    var link = {
      url: url,
      kind: kind,
      away: new URL(url, location.href).origin !== location.origin,
      status: null,
      ms: 0,
      el: el
    };

    // nothing will ever check these, so say so from the start
    if (link.away) { link.status = 'away'; fill(link); }
    return link;
  }

  /* More than two answers. A 401 is the password doing its job, and a link on
     another host cannot be asked at all: our own Content-Security-Policy says
     connect-src 'self', so the browser refuses before the request leaves. It is
     listed to be clicked, not judged. */
  function verdict(status) {
    if (status === 200) return { cls: 'ok', said: 'Accessible', code: '200' };
    if (status === 'away') return { cls: 'none', said: 'Open it to see', code: 'another host' };
    if (status === 401 || status === 403) return { cls: 'warn', said: 'Behind a password', code: String(status) };
    return { cls: 'bad', said: 'Not accessible', code: status ? String(status) : 'no answer' };
  }

  function fill(link) {
    var v = verdict(link.status);
    var open = link.el.querySelector('.c-open');
    var code = link.el.querySelector('.c-code');
    open.textContent = v.said;
    open.className = 'c-open ' + v.cls;
    code.textContent = v.code;
    code.className = 'c-code ' + (v.cls === 'bad' ? 'bad' : '');
    link.el.querySelector('.c-ms').textContent = link.away ? '' : link.ms + ' ms';
  }

  // ---- what is on screen ----

  function matches(link) {
    if (kind !== 'All' && link.kind !== kind) return false;
    if (onlyEl.checked && (link.status === null || verdict(link.status).cls !== 'bad')) return false;
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
    var done = links.filter(function (l) { return !l.away && l.status !== null; });
    var bad = done.filter(function (l) { return verdict(l.status).cls === 'bad'; }).length;
    document.getElementById('t-all').textContent = links.length;
    document.getElementById('t-done').textContent = done.length;
    document.getElementById('t-ok').textContent = done.length - bad;
    document.getElementById('t-bad').textContent = bad;
  }

  function tabs() {
    var names = ['All', 'Reader', 'Surah text', 'Site file', 'Tool', 'Subdomain', 'Other'];
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

  /* A HEAD asks the one thing being asked here. */
  function check(link) {
    var began = performance.now();
    return fetch(link.url, { method: 'HEAD', cache: 'no-store' })
      .then(function (r) { return r.status; })
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
    var ours = links.filter(function (l) { return !l.away; });
    var done = 0, bad = 0, next = 0;

    function take() {
      if (next >= ours.length) return Promise.resolve();
      var link = ours[next++];
      return check(link).then(function (status) {
        done++;
        if (verdict(status).cls === 'bad') bad++;
        said.textContent = done + ' of ' + ours.length + ' checked'
          + (bad ? ' — ' + bad + ' not accessible' : '');
        tally();
        if (onlyEl.checked) render();   // the failures are what is on screen
        return take();
      });
    }

    var runners = [];
    for (var i = 0; i < AT_ONCE; i++) runners.push(take());

    Promise.all(runners).then(function () {
      said.textContent = ours.length + ' checked, '
        + (bad ? bad + ' not accessible' : 'every one answering')
        + (links.length - ours.length
          ? ' — ' + (links.length - ours.length) + ' on other hosts, open those to see'
          : '');
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

      links = BEYOND.map(function (b) { return make(b.url, b.kind); })
        .concat(urls.map(function (u) { return make(u, kindOf(u)); }));

      tabs();
      tally();
      render();
      said.textContent = links.length + ' links — ' + urls.length
        + ' from the sitemap, ' + BEYOND.length + ' beside it. Nothing checked yet.';
      button.addEventListener('click', checkAll);
    })
    .catch(function (e) {
      said.textContent = 'Could not read the sitemap: ' + e.message;
      said.className = 'status bad';
    });
}());
