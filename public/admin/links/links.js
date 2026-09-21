/**
 * Every page the site says it has, and whether it answers.
 *
 * The list is the sitemap rather than anything written here, so a page that is
 * generated is a page that appears — and a page in the sitemap that does not
 * answer is exactly the thing worth seeing.
 */
(function () {
  'use strict';

  /* Enough at once to finish quickly, few enough not to look like an attack on
     our own server. */
  var AT_ONCE = 8;

  var said = document.getElementById('status');
  var groupsEl = document.getElementById('groups');
  var button = document.getElementById('check');
  var rowTemplate = document.getElementById('row');
  var rows = [];

  /** Which list a url belongs in, by what it is rather than by where it sits. */
  function group(url) {
    if (/^\/surah\/\d+\/text\/$/.test(url)) return 'Surah text';
    if (/^\/surah\/\d+\/$/.test(url)) return 'Reader';
    return 'Other';
  }

  function draw(urls) {
    var order = ['Other', 'Reader', 'Surah text'];
    var byGroup = {};
    urls.forEach(function (u) { (byGroup[group(u)] = byGroup[group(u)] || []).push(u); });

    order.forEach(function (name) {
      var list = byGroup[name];
      if (!list) return;

      var section = document.createElement('section');
      section.className = 'group';
      section.innerHTML = '<h2>' + name + ' <span class="count">' + list.length + '</span></h2>';

      var ul = document.createElement('ul');
      list.forEach(function (u) {
        var row = rowTemplate.content.cloneNode(true);
        var a = row.querySelector('.url');
        a.href = u;
        a.textContent = u;
        ul.appendChild(row);
        rows.push({ url: u, el: ul.lastElementChild });
      });

      section.appendChild(ul);
      groupsEl.appendChild(section);
    });
  }

  /** A HEAD asks the server the one thing being asked here. */
  function check(row) {
    var began = performance.now();
    return fetch(row.url, { method: 'HEAD', cache: 'no-store' })
      .then(function (res) { return res.status; })
      .catch(function () { return 0; })
      .then(function (status) {
        var ms = Math.round(performance.now() - began);
        var code = row.el.querySelector('.code');
        code.textContent = status || 'x';
        code.className = 'code ' + (status === 200 ? 'ok' : status ? 'warn' : 'bad');
        row.el.querySelector('.ms').textContent = ms + ' ms';
        return status;
      });
  }

  function checkAll() {
    button.disabled = true;
    var done = 0, bad = 0, next = 0;

    function take() {
      if (next >= rows.length) return Promise.resolve();
      var row = rows[next++];
      return check(row).then(function (status) {
        done++;
        if (status !== 200) bad++;
        said.textContent = done + ' of ' + rows.length + ' checked'
          + (bad ? ' — ' + bad + ' not answering 200' : '');
        return take();
      });
    }

    var runners = [];
    for (var i = 0; i < AT_ONCE; i++) runners.push(take());

    Promise.all(runners).then(function () {
      said.textContent = rows.length + ' checked, '
        + (bad ? bad + ' not answering 200' : 'all answering 200');
      said.className = 'status ' + (bad ? 'bad' : 'ok');
      button.disabled = false;
    });
  }

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

      draw(urls);
      said.textContent = urls.length + ' urls in the sitemap. Nothing checked yet.';
      button.addEventListener('click', checkAll);
    })
    .catch(function (e) {
      said.textContent = 'Could not read the sitemap: ' + e.message;
      said.className = 'status bad';
    });
}());
