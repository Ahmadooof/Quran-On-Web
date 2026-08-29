/* The three views, and nothing that decides anything.
 *
 * Every judgement about the type lives in Python; this file asks for pictures
 * and shows them. The one thing it works out for itself is where a click
 * landed, and even that is only arithmetic on numbers the server sent with the
 * picture — the scale it was drawn at and where each line sits on it.
 */
'use strict';

const $ = s => document.querySelector(s);
const show = (el, on) => { el.hidden = !on; };
const pct = v => `${(100 * v).toFixed(1)}%`;

/* Where a view's controls belong.
 *
 * `side` for the two views whose content is a mushaf page standing on end:
 * they want every pixel of window height, and a row of controls above them
 * costs two inches of it. `top` for everything else, because a list or a grid
 * scrolls anyway and squeezing its settings into a 250px column is what left
 * the column crammed and the middle of the screen empty.
 */
const VIEWS = {
  labels: {
    title: 'Labels',
    sub: 'Click any ink that is the wrong colour.',
    /* Side when the content is a page standing on end, across the top when it
       is a grid -- the rule was always about the content, so it follows the
       mode rather than the view. */
    bar: '#bar-labels', body: '#labels', where: () =>
      ($('#lwhat').value === 'page' ? 'side' : 'top'),
  },
  train: {
    title: 'Train a new model on the labels',
    sub: 'Nothing is overwritten; each model keeps its own name.',
    bar: '#bar-train', body: '#train', where: 'top',
  },
  models: {
    title: 'Every model, what it was taught, and how it has done',
    sub: 'What went into each, and how it has done.',
    bar: '#bar-models', body: '#models', where: 'top',
  },
  compare: {
    title: 'Set models against each other',
    sub: 'Digital is scored in words, a photograph in pixels.',
    bar: '#bar-compare', body: '#compare', where: 'top',
  },
  finetune: {
    title: 'Confirm real lines, then nudge a model onto them',
    sub: 'Click any ink to cycle it: letter, mark, skip.',
    bar: '#bar-finetune', body: '#finetune', where: 'side',
  },
};

const get = async url => (await fetch(url)).json();
const post = async (url, body) => (await fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
})).json();
const fail = (el, e) => { el.innerHTML = `<pre>${e}</pre>`; };

function drawKey() {
  $('#key').innerHTML =
    `<span><i style="background:${$('#cink').value}"></i>letter</span>` +
    `<span><i style="background:${$('#cmark').value}"></i>mark</span>`;
}

/* ---- which models exist ------------------------------------------------ */
let MODELS = [];

async function loadModels() {
  const j = await get('/models');
  MODELS = j.models || [];
  const badge = m => (m.best || []).map(j => j === 'real' ? '★photo' : '★digital').join(' ');
  const opts = MODELS.map(m =>
    `<option value="${m.name}">${m.name}${badge(m) ? ' ' + badge(m) : ''} — ` +
    `${m.words} words${m.real_lines ? `, ${m.real_lines} real lines` : ''}, ${m.trained}</option>`)
    .join('');
  const paint = $('#lpaint');
  const wasPaint = paint.value;
  paint.innerHTML = '<option value="">your labels</option>' + opts;
  paint.value = wasPaint;
  $('#fm').innerHTML = opts || '<option value="">none trained yet</option>';
  $('#fbase').innerHTML = opts || '<option value="">none trained yet</option>';
  // Compare picks from chips rather than two dropdowns, because "two" was
  // never the question -- it was just the shape the code happened to have.
  if (typeof drawPicker === 'function') {
    if (!PICKED.length && MODELS.length) {
      PICKED = MODELS.slice(0, Math.min(2, MODELS.length)).map(m => m.name);
    }
    PICKED = PICKED.filter(n => MODELS.some(m => m.name === n));
    drawPicker();
  }
  return MODELS;
}

/* ---- read and correct --------------------------------------------------- */
function scoreOf(p) {
  const cls = p.agreement >= 0.9 ? 'good' : p.agreement >= 0.75 ? 'fair' : 'poor';
  return `<b class=${cls}>${pct(p.agreement)}</b> of ${p.words} words agree
    <span class=note>· ${p.found} marks found, ${p.spelled} spelled
    · doubt ${p.doubt}</span>`;
}

/* Each finding sits in the margin, level with the line it is about.
 *
 * A list to one side means reading "line 9" and then counting nine rows down
 * to find it. Set against the row itself there is nothing to count: the note
 * is already where the eye has to go, and it names the word so the right ink
 * is looked at rather than the whole line.
 */
function gutterNotes(p) {
  const byLine = {};
  for (const d of p.disagreements || []) (byLine[d.line] = byLine[d.line] || []).push(d);
  if (!p.tall) return '';
  return Object.keys(byLine).map(line => {
    const w = (p.where || []).find(x => x.line === +line);
    if (!w) return '';
    const words = byLine[line].map(d =>
      `<span class=one><span class=ar>${d.text}</span>
       <span class=vs>${d.found} v ${d.spelled}</span></span>`).join('');
    return `<div class=mark style="top:${100 * (w.top + w.height / 2) / p.tall}%"
                 data-line="${line}">
      <span class=ln>${line}</span>${words}</div>`;
  }).join('');
}

/* The page alone in the middle; everything said about it goes in the rail.
 * A heading and a score line above the sheet cost it an eighth of the window,
 * and a mushaf page is the one thing here that wants all the height it can
 * get. */
function railFor(p, model) {
  const count = (p.disagreements || []).length;
  $('#pagebox').innerHTML = `
    <div class=pagehead>
      <b>page ${p.page}</b>
      ${p.checked ? `<span class=done-tag title="last gone over ${p.checked.when}">checked</span>` : ''}
    </div>
    ${model ? `<div class=score>${scoreOf(p)}</div>` : ''}
    ${model ? `<div class=note>${count ? `${count} to check, marked in the margin`
                                       : 'nothing asks to be looked at'}</div>` : ''}
    <span class=staged>${p.staged ? `${p.staged} change${p.staged > 1 ? 's' : ''} not saved` : ''}</span>
    <div class=row>
      <button class="save quiet" ${p.staged ? '' : 'disabled'}>Save</button>
      <button class="revert quiet" ${p.staged ? '' : 'disabled'}>Undo</button>
    </div>`;
}

function pageCard(p, model) {
  const notes = model ? gutterNotes(p) : '';
  return `<section class=page data-page="${p.page}" data-scale="${p.scale}"
                   data-tall="${p.tall || 1}"
                   data-where='${JSON.stringify(p.where || [])}'>
    <div class=stage>
      <div class=sheet><img src="${p.img}">${notes}</div>
    </div>
  </section>`;
}

function wireClicks() {
  document.querySelectorAll('#labels .page').forEach(sec => {
    if (sec.dataset.wired) return;
    sec.dataset.wired = '1';
    const page = +sec.dataset.page;
    const im = sec.querySelector('img');
    const staged = $('#pagebox .staged');
    const saveBtn = $('#pagebox .save');
    const undoBtn = $('#pagebox .revert');
    if (!saveBtn) return;

    const setStaged = n => {
      staged.textContent = n ? `${n} change${n > 1 ? 's' : ''} not saved` : '';
      saveBtn.disabled = undoBtn.disabled = !n;
    };

    const flip = async ev => {
      const where = JSON.parse(sec.dataset.where || '[]');
      const box = im.getBoundingClientRect();
      /* screen -> the picture's own pixels -> the page's own pixels.
       *
       * Measured against the rectangle on screen, not the layout width. A
       * transformed element reports its transformed rectangle here and its
       * untransformed width there, and mixing the two means every click is
       * out by the zoom factor -- which is why zooming in to click precisely
       * flipped whatever ink happened to be at 1x. */
      const toPage = (im.naturalWidth / box.width) / +sec.dataset.scale;
      const px = (ev.clientX - box.left) * toPage;
      const py = (ev.clientY - box.top) * toPage;
      const hit = where.find(w => py >= w.top && py < w.top + w.height);
      if (!hit) return;
      im.classList.add('busy');
      const j = await post('/fix', {
        page, model: $('#lpaint').value || null, line: hit.line,
        x: px - hit.left, y: py - hit.top,
        ink: $('#cink').value, mark: $('#cmark').value,
      });
      im.classList.remove('busy');
      if (j.error) { $('#lst').textContent = 'that click failed'; return; }
      if (!j.hit) return;
      im.src = j.img;
      sec.dataset.where = JSON.stringify(j.where);
      sec.dataset.scale = j.scale;
      setStaged(j.staged);
      $('#lst').textContent = `${j.word || 'that piece'} is now ${j.now}`;
    };
    im.onclick = flip;
    sec._flip = flip;

    /* A badge and its entry point at each other: clicking either lays a band
       over that line for a moment, which is quicker than counting rows. */
    const flash = line => {
      const where = JSON.parse(sec.dataset.where || '[]');
      const w = where.find(x => x.line === +line);
      const tall = +sec.dataset.tall || 1;
      if (!w) return;
      const box = sec.querySelector('.sheet');
      const old = box.querySelector('.band');
      if (old) old.remove();
      const band = document.createElement('div');
      band.className = 'band';
      band.style.top = `${100 * w.top / tall}%`;
      band.style.height = `${100 * w.height / tall}%`;
      box.appendChild(band);
      setTimeout(() => band.remove(), 2200);
    };
    sec.querySelectorAll('.mark').forEach(m => { m.onclick = () => flash(m.dataset.line); });

    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      const j = await post('/save', {
        page, model: $('#lpaint').value || null, agreed: $('#rharvest').checked,
      });
      setStaged(0);
      const tag = $('#pagebox .done-tag');
      if (!tag) $('#pagebox .pagehead').insertAdjacentHTML('beforeend',
        '<span class=done-tag>checked</span>');
      // say plainly that this page is finished with, and offer the next one:
      // the work is a sweep through the mushaf, not one page examined forever
      $('#pagebox').insertAdjacentHTML('beforeend',
        `<div class=finished>
           <b>Page ${page} is checked and corrected.</b>
           <span class=note>${j.checked.fixes} correction${j.checked.fixes === 1 ? '' : 's'}
           in all${j.harvested ? `, ${j.harvested} more kept because the spelling
           agreed` : ''} · ${j.words} words labelled</span>
           <button class=onward>Go to page ${j.next} &rarr;</button>
         </div>`);
      const go = $('#pagebox .onward');
      if (go) go.onclick = () => { $('#lpage').value = j.next; doReview(true); };
      $('#lst').textContent = `page ${page} checked — ${j.saved} written` +
        `${j.harvested ? ` (${j.harvested} harvested)` : ''} · ${j.words} in all`;
      drawState();
    };

    undoBtn.onclick = async () => {
      await post('/revert', { page });
      setStaged(0);
      const j = await get(`/review?page=${page}&model=` +
        `${encodeURIComponent($('#lpaint').value || '')}` +
        `&ink=${encodeURIComponent($('#cink').value)}` +
        `&mark=${encodeURIComponent($('#cmark').value)}`);
      if (j.page) {
        im.src = j.page.img;
        sec.dataset.where = JSON.stringify(j.page.where);
        sec.dataset.scale = j.page.scale;
      }
      $('#lst').textContent = 'those changes were thrown away';
    };
  });
}

/* One page at a time, and small enough to see whole.
 *
 * A page of type is the unit the work is done in: everything on it is read by
 * the same model at the same moment, so its score means something, and the eye
 * can hold all fifteen lines at once to see where the colour is wrong. Five
 * pages at once meant three minutes of waiting and a column too long to look
 * at. The arrows step between them; the model's read of a page it has already
 * seen comes back at once.
 */
async function doReview(withModel = true) {
  const el = $('#labels');
  $('#lgo').disabled = true;
  const model = withModel ? ($('#lpaint').value || '') : '';
  const n = Math.min(604, Math.max(1, +$('#lpage').value || 3));
  const started = performance.now();
  el.innerHTML = `<section class=page>
    <div class=loading><span class=spin></span>
      ${withModel ? `reading page ${n} — about half a minute the first time,
        instant after that` : `drawing page ${n}`}
    </div></section>`;
  $('#lst').textContent = withModel ? 'reading…' : 'drawing…';
  try {
    const j = await get(`/review?page=${n}&model=${encodeURIComponent(model)}` +
                        `&ink=${encodeURIComponent($('#cink').value)}` +
                        `&mark=${encodeURIComponent($('#cmark').value)}`);
    if (j.error) { fail(el, j.error); }
    else {
      el.innerHTML = pageCard(j.page, model);
      railFor(j.page, model);
      wireClicks();
      const sheet = el.querySelector('.sheet');
      const sec = el.querySelector('.page');
      if (sheet) makeZoomable(sheet, {
        onClick: at => { if (sec && sec._flip) sec._flip(at); },
        onChange: z => { $('#lst').textContent = z > 1.01
          ? `${z.toFixed(1)}x — drag to move, double click to fit`
          : `${pct(j.page.agreement || 0)} of this page agrees`; },
      });
      const lab = await get('/labelled');
      const took = Math.round((performance.now() - started) / 1000);
      $('#lst').textContent =
        (j.page.agreement === undefined ? ''
          : `${pct(j.page.agreement)} of this page agrees · `) +
        `${lab.total} words labelled · ${took}s`;
    }
  } catch (e) { fail(el, e); }
  $('#lgo').disabled = false;
}

function step(by) {
  const pick = $('#lpage');
  const n = Math.min(604, Math.max(1, (+pick.value || 3) + by));
  if (![...pick.options].some(o => +o.value === n)) {
    pick.insertAdjacentHTML('beforeend', `<option value="${n}">page ${n}</option>`);
  }
  pick.value = n;
  doLabels();
}

/* ---- train -------------------------------------------------------------- */

/* The size of the training set, which is not the size of the labelled set.
 * A hundred and twenty words are labelled by hand; every step fuses, turns
 * and thickens sixteen fresh crops out of them, so nine hundred steps is
 * fourteen thousand four hundred examples of which none is seen twice. Both
 * numbers matter and they are three orders of magnitude apart, so say both. */
async function drawPlan() {
  try {
    const j = await get(`/trainplan?steps=${+$('#tsteps').value || 0}` +
                        `&batch=${+$('#tbatch').value || 16}`);
    if (j.crops) {
      $('#tplan').innerHTML = `<b>${j.crops.toLocaleString()}</b> synthetic crops
        — ${j.steps} steps of ${j.batch}, fused fresh from
        ${j.words} labelled words. None is drawn twice.`;
    }
  } catch (e) { /* the number is a nicety, not the feature */ }
}
async function doTrain() {
  if ($('#tmode').value === 'tune') return doTune();
  const el = $('#tout');          // below the form, which stays put
  $('#tgo').disabled = true;
  const lab = await get('/labelled');
  const plan = await get(`/trainplan?steps=${$('#tsteps').value}&batch=${$('#tbatch').value}`);
  el.innerHTML = `<p class=note>training on
    ${plan.crops.toLocaleString()} synthetic crops made from ${lab.total} words
    (${lab.marks} marks, ${lab.letters} letters), shaken by
    ±${(100 * $('#tscale').value).toFixed(0)}% in size,
    ±${$('#trot').value}°, ink spread ${$('#tspread').value}.</p>`;
  const started = performance.now();
  const tick = setInterval(() => {
    const s = Math.round((performance.now() - started) / 1000);
    $('#tst').textContent = `training — ${Math.floor(s / 60)}m ${s % 60}s`;
  }, 1000);
  el.insertAdjacentHTML('beforeend',
    '<div class=loading><span class=spin></span>training. A quarter of an hour ' +
    'or so for 900 steps, and the page will sit still until it is done.</div>');
  try {
    const j = await post(`/train?steps=${$('#tsteps').value}` +
                         `&scale=${$('#tscale').value}` +
                         `&rotate=${$('#trot').value}` +
                         `&spread=${$('#tspread').value}` +
                         `&batch=${$('#tbatch').value}` +
                         `&lr=${$('#tlr').value}` +
                         `&width=${$('#twidth').value}` +
                         `&decay=${$('#tdecay').value}` +
                         `&seed=${$('#tseed').value}` +
                         `&holdout=${$('#tholdout').value}`);
    clearInterval(tick);
    if (j.error) { fail(el, j.error); }
    else {
      el.innerHTML = `<div class=done><b>${j.model.name}</b> — ${j.model.note}.<br>
        <span class=note>Now go to <b>Compare</b> and set it against the one
        before it, on pages neither has seen.</span></div>`;
      $('#tst').textContent = `${j.model.name} saved`;
      await loadModels();
  try {
    const ph = await get('/photos');
    const o = (ph.photos || []).map(f => `<option value="${f}">${f}</option>`).join('');
    for (const id of ['#ff', '#cpf', '#mpf']) $(id).innerHTML = o ||
      '<option value="">nothing in PhysicalQuran/</option>';
  } catch (e) { /* no photographs is not a problem */ }
    }
  } catch (e) { clearInterval(tick); fail(el, e); }
  $('#tgo').disabled = false;
}

/* ---- compare ------------------------------------------------------------
 *
 * One surface, any number of models, on a page of type or on a photograph.
 *
 * "A real page" used to be its own tab, and it was this view with one model on
 * a photograph — which is why Compare could not judge a press at all: the two
 * halves of one idea had been given separate code and only the type half ever
 * learned to hold more than one model. Together, "read this with v3" and "set
 * v1, v2 and v3 against each other" are the same question with a different
 * number in it.
 *
 * The referee changes with the subject and cannot not: the spelling says how
 * many marks a word carries, and a photograph has no words anything here can
 * read. There, the lines confirmed by hand are the only ground truth there is.
 */
let PICKED = [];

function drawPicker() {
  $('#cpick').innerHTML = MODELS.map(m => {
    const star = (m.best || []).map(j => j === 'real' ? '★photo' : '★digital').join(' ');
    return `<button class="chip ${PICKED.includes(m.name) ? 'on' : ''}"
      data-name="${m.name}">${m.name}${star ? ` <span class=star>${star}</span>` : ''}</button>`;
  }).join('') || '<span class=note>nothing trained yet</span>';
  $('#cpick').querySelectorAll('.chip').forEach(c => {
    c.onclick = () => {
      const n = c.dataset.name;
      PICKED = PICKED.includes(n) ? PICKED.filter(x => x !== n) : [...PICKED, n];
      drawPicker();
    };
  });
  $('#cgo').disabled = !PICKED.length;
}

function sheetsFor(names, rows, extra) {
  return `<div class=pair style="grid-template-columns:repeat(${names.length},1fr)">
    ${names.map(who => `<div>
      <div class=who>${extra(who, rows[who])}</div>
      <div class=sheet><img src="${rows[who].img}"></div>
    </div>`).join('')}</div>`;
}

async function comparePages(names, into) {
  const el = $(into || '#compare');
  let first = Math.max(1, Math.min(604, +$('#cf').value));
  let last = Math.max(1, Math.min(604, +$('#ct').value));
  if (last < first) { const t = first; first = last; last = t; }
  const only = $('#conly').checked;
  const started = performance.now();
  const tally = {}; names.forEach(n => (tally[n] = [0, 0]));
  el.innerHTML = `<div class=verdict id="${into ? 'running-d' : 'running'}"></div>`;

  for (let n = first; n <= last; n++) {
    const secs = Math.round((performance.now() - started) / 1000);
    $(into ? '#running-d' : '#running').innerHTML = `<span class=spin></span> reading page ${n}
      (${n - first + 1} of ${last - first + 1}) with ${names.length}
      model${names.length > 1 ? 's' : ''} — ${secs}s so far`;
    const j = await get(`/compare?models=${names.join(',')}&page=${n}` +
      `&only=${only ? 1 : 0}` +
      `&ink=${encodeURIComponent($('#cink').value)}` +
      `&mark=${encodeURIComponent($('#cmark').value)}`);
    if (j.error) { el.insertAdjacentHTML('beforeend', `<pre>${j.error}</pre>`); break; }
    names.forEach(w => { tally[w][0] += j.rows[w].agree; tally[w][1] += j.rows[w].words; });

    /* The words they read differently are ringed on the page itself and the
       table sits under it. Listed beside the pages you read a word and then
       hunt the page for it, and an Arabic word you cannot find is one you
       cannot check. */
    const d = j.differs || [];
    const table = d.length ? `<table class="working under">
        <caption>${d.length} word${d.length > 1 ? 's' : ''} read differently${
          j.same ? `, ${j.same} the same` : ''}${only ? ' — ringed on the page' : ''}</caption>
        <tr><th>word</th>${names.map(w => `<td>${w}</td>`).join('')}<td>spelled</td></tr>
        ${d.map(x => `<tr><th class=ar>${x.text}</th>
          ${names.map(w => `<td class="${x.closer === w ? 'good' : ''}">${
            x.found[w] === undefined ? '—' : x.found[w]}</td>`).join('')}
          <td class=note>${x.spelled}</td></tr>`).join('')}
      </table>` : `<p class=note>all ${j.same} words read the same way</p>`;

    el.insertAdjacentHTML('beforeend', `<section class=page><h2>page ${j.page}</h2>
      ${sheetsFor(names, j.rows, (w, r) =>
        `<b>${w}</b> — ${pct(r.agreement)} agree
         <span class=note>(${r.found} found, ${r.spelled} spelled)</span>`)}
      ${table}</section>`);
    el.querySelectorAll('.sheet').forEach(sh => makeZoomable(sh));
  }

  const rate = w => (tally[w][1] ? tally[w][0] / tally[w][1] : 0);
  const rank = [...names].sort((x, y) => rate(y) - rate(x));
  const gap = rate(rank[0]) - rate(rank[rank.length - 1]);
  $(into ? '#running-d' : '#running').innerHTML =
    `${gap < 0.005 ? '<b class=fair>too close to call</b>'
                   : `<b class=good>${rank[0]} is closest to the spelling</b>`}
     <br><span class=note>${rank.map(w => `${w} ${pct(rate(w))}`).join(' · ')}
     over ${tally[names[0]][1]} words</span>`;
  $('#cst').textContent = rank.map(w => `${w} ${pct(rate(w))}`).join(' · ');
  const rates = Object.fromEntries(names.map(w => [w, rate(w)]));
  keepScores(names.map(w => [w, `page:${first}`,
    { words: tally[w][1], agreement: +rate(w).toFixed(4) }]));
  return rates;
}

/* What Compare measured goes on the model's card. Otherwise the card is a
   list of settings and the only way to know how a model did is to run it
   again, which is how two people end up with different numbers for the same
   model on the same afternoon. */
function keepScores(rows) {
  for (const [name, what, result] of rows) {
    post(`/model/note?name=${encodeURIComponent(name)}&what=${encodeURIComponent(what)}`,
         result).catch(() => {});
  }
}

async function comparePhoto(names, into) {
  const el = $(into || '#compare');
  el.innerHTML = `<div class=loading><span class=spin></span>
    reading ${$('#cpf').value} with ${names.join(', ')} —
    a photograph is bigger than a page of type, so this takes longer</div>`;
  const j = await get(`/comparereal?models=${names.join(',')}` +
    `&file=${encodeURIComponent($('#cpf').value)}&detail=${+$('#cpdetail').value}` +
    `&mark=${encodeURIComponent($('#cmark').value)}`);
  if (j.error) { fail(el, j.error); return; }
  const scored = j.lines_confirmed > 0;
  const head = !scored
    ? `<b class=fair>nothing confirmed in this photograph</b><br>
       <span class=note>go to <b>Fine-tune</b>, confirm a few of its lines, and
       they become the referee here — there is no other ground truth a
       photograph can have</span>`
    : names.length === 1
      ? `<b>${names[0]}</b> on ${j.file}<br><span class=note>scored on
         ${j.lines_confirmed} confirmed line${j.lines_confirmed === 1 ? '' : 's'}</span>`
      : `${j.better ? `<b class=good>${j.better} is best</b>`
                    : '<b class=fair>too close to call</b>'}<br>
         <span class=note>scored on ${j.lines_confirmed} line${
           j.lines_confirmed === 1 ? '' : 's'} you confirmed by hand</span>`;

  el.innerHTML = `<div class=verdict>${head}</div>
    ${sheetsFor(names, j.rows, (w, r) =>
      `<b>${w}</b> — ${r.found} marks found
       ${r.scored ? `· <b class="${r.agreement >= 0.9 ? 'good' : 'fair'}">${pct(r.agreement)}</b>
         of confirmed ink right · IoU ${r['mark pixels found (IoU)']}` : ''}
       ${r.taught_on ? `<span class=warn>marked on its own homework —
         ${r.taught_on} of these lines trained it</span>` : ''}`)}
    <table class="working under"><caption>the working</caption>
      <tr><th></th>${names.map(w => `<td>${w}</td>`).join('')}</tr>
      ${Object.keys(j.rows[names[0]].working || {}).map(k =>
        `<tr><th>${k}</th>${names.map(w => `<td>${j.rows[w].working[k]}</td>`).join('')}</tr>`
      ).join('')}</table>`;
  el.querySelectorAll('.sheet').forEach(sh => makeZoomable(sh));
  $('#cst').textContent = scored
    ? names.map(w => `${w} ${pct(j.rows[w].agreement)}`).join(' · ')
    : names.map(w => `${w} ${j.rows[w].found}`).join(' · ');
  if (!scored) return null;
  keepScores(names.map(w => [w, `photo:${j.file}`, {
    lines: j.lines_confirmed,
    agreement: j.rows[w].agreement,
    'mark pixels found (IoU)': j.rows[w]['mark pixels found (IoU)'],
  }]));
  return Object.fromEntries(names.map(w => [w, j.rows[w].agreement]));
}

/* The two subjects together, which is the question actually worth asking of a
   set of models: a net shaken hard enough to read a press can read clean type
   slightly worse, so "which is best" has two answers and they are not always
   the same model. Run apart they are two errands and the numbers end up in
   different places on different afternoons; run together they sit in one
   table, each in its own unit, and the trade is visible in a glance. */
async function compareBoth(names) {
  const el = $('#compare');
  el.innerHTML = `<div id=cboth></div>
    <h2>on a digital page</h2><div id=cdigital></div>
    <h2>on a photograph</h2><div id=cphoto></div>`;
  const digital = await comparePages(names, '#cdigital');
  const photo = await comparePhoto(names, '#cphoto');
  const bestD = digital && [...names].sort((a, b) => digital[b] - digital[a])[0];
  const bestP = photo && [...names].sort((a, b) => photo[b] - photo[a])[0];
  $('#cboth').innerHTML = `<div class=verdict>
    ${bestD === bestP && bestD
      ? `<b class=good>${bestD} is best at both</b>`
      : `<b class=good>${bestD || '—'}</b> reads digital best,
         <b class=good>${bestP || '—'}</b> reads the photograph best`}
    <table class="working under">
      <tr><th>model</th><td>digital — of words</td><td>photograph — of confirmed ink</td></tr>
      ${names.map(w => `<tr><th>${w}</th>
        <td class="${w === bestD ? 'good' : ''}">${digital ? pct(digital[w]) : '—'}</td>
        <td class="${w === bestP ? 'good' : ''}">${photo ? pct(photo[w]) : 'nothing confirmed'}</td>
      </tr>`).join('')}
    </table></div>`;
  $('#cst').textContent = names.map(w =>
    `${w} ${digital ? pct(digital[w]) : '—'}/${photo ? pct(photo[w]) : '—'}`).join(' · ');
}

async function doCompare() {
  const el = $('#compare');
  if (!PICKED.length) { idle('#compare', 'Pick at least one model.'); return; }
  $('#cgo').disabled = true;
  try {
    const what = $('#cwhat').value;
    if (what === 'both') await compareBoth(PICKED);
    else if (what === 'photo') await comparePhoto(PICKED);
    else await comparePages(PICKED);
  } catch (e) { fail(el, e); }
  $('#cgo').disabled = false;
}

/* ---- fine-tune ----------------------------------------------------------
 *
 * Labelling a photograph, one line at a time.
 *
 * A line rather than a page: a page of a photograph is six thousand pieces of
 * ink and nobody looks honestly at six thousand of anything in one sitting,
 * and a label given without looking is worse than no label at all.
 *
 * Three verdicts rather than two. A mark drawn touching the letter under it is
 * one piece of ink that is genuinely both, and the third verdict is how you
 * say so — skipped ink is left out of the training entirely rather than being
 * forced into a class it does not belong to.
 */
const VERDICTS = ['letter', 'mark', 'skip'];
const SKIP_COLOUR = '#9a9a9a';

function fineKey() {
  return { file: $('#ff').value, detail: +$('#fdetail').value, line: +$('#fline').value };
}

function drawFineKey() {
  $('#fkey').innerHTML =
    `<span><i style="background:${$('#cmark').value}"></i>mark</span>` +
    `<span><i style="background:${SKIP_COLOUR}"></i>skip</span>` +
    `<span><i style="background:#8884"></i>letter</span>`;
}

function fineBox(j) {
  const t = j.tally || {};
  $('#fbox').innerHTML = `
    <div class=pagehead><b>line ${j.line + 1} of ${j.lines}</b>
      ${j.confirmed ? '<span class=done-tag>confirmed</span>' : ''}</div>
    <div class=note>${j.pieces} pieces · ${t.mark} mark, ${t.letter} letter,
      ${t.skip} skip</div>
    <span class=staged>${j.staged ? `${j.staged} change${j.staged > 1 ? 's' : ''} not saved` : ''}</span>
    <div class=row>
      <button class="fsave quiet">Confirm this line</button>
      <button class="fundo quiet" ${j.staged ? '' : 'disabled'}>Undo</button>
    </div>`;
  $('#fbox .fsave').onclick = saveBand;
  $('#fbox .fundo').onclick = async () => {
    await post('/bandrevert', fineKey());
    doBand();
  };
}

async function doBand() {
  const el = $('#finetune');
  const k = fineKey();
  if (!k.file) { idle('#finetune', 'There is nothing in <b>PhysicalQuran/</b>.'); return; }
  $('#fgo').disabled = true;
  el.innerHTML = `<div class=loading><span class=spin></span>
    cutting line ${k.line + 1} out of ${k.file} and reading it</div>`;
  try {
    const j = await get(`/band?file=${encodeURIComponent(k.file)}` +
      `&detail=${k.detail}&line=${k.line}` +
      `&model=${encodeURIComponent($('#fm').value || '')}` +
      `&mark=${encodeURIComponent($('#cmark').value)}` +
      `&skip=${encodeURIComponent(SKIP_COLOUR)}`);
    if (j.error) { fail(el, j.error); }
    else {
      el.innerHTML = `<section class=page><div class=stage>
        <div class="sheet wide"><img src="${j.img}"></div></div></section>`;
      fineBox(j);
      const sheet = el.querySelector('.sheet');
      makeZoomable(sheet, {
        onClick: at => cycleBlob(at, sheet.querySelector('img')),
        onChange: z => { $('#fst').textContent = z > 1.01
          ? `${z.toFixed(1)}x — drag to move, double click to fit`
          : `${j.pieces} pieces of ink`; },
      });
      $('#fst').textContent = `${j.pieces} pieces of ink`;
    }
  } catch (e) { fail(el, e); }
  $('#fgo').disabled = false;
}

async function cycleBlob(at, im) {
  const box = im.getBoundingClientRect();
  // as a fraction of the picture, which survives every resize between the
  // strip the blobs were numbered in and the pixels on screen
  const j = await post('/bandfix', Object.assign(fineKey(), {
    model: $('#fm').value || null,
    fx: (at.clientX - box.left) / box.width,
    fy: (at.clientY - box.top) / box.height,
    mark: $('#cmark').value, skip: SKIP_COLOUR,
  }));
  if (j.error) { $('#fst').textContent = 'that click failed'; return; }
  if (!j.hit) return;
  im.src = j.img;
  const t = j.tally;
  $('#fbox .staged').textContent = `${j.staged} change${j.staged > 1 ? 's' : ''} not saved`;
  $('#fbox .fundo').disabled = false;
  $('#fbox .note').textContent =
    `${t.mark + t.letter + t.skip} pieces · ${t.mark} mark, ${t.letter} letter, ${t.skip} skip`;
  $('#fst').textContent = `that piece is now ${j.now}`;
}

async function saveBand() {
  const k = fineKey();
  const j = await post('/bandsave', Object.assign(k, { model: $('#fm').value || null }));
  if (j.error) { $('#fst').textContent = 'that did not save'; return; }
  await drawReal();
  $('#fbox').insertAdjacentHTML('beforeend',
    `<div class=finished><b>Line ${k.line + 1} is confirmed.</b>
       <span class=note>${j.saved} pieces recorded</span>
       ${j.next === null ? '' : `<button class=onward>Line ${j.next + 1} &darr;</button>`}
     </div>`);
  const go = $('#fbox .onward');
  if (go) go.onclick = () => { $('#fline').value = j.next; doBand(); };
  $('#fst').textContent = `line ${k.line + 1} confirmed`;
}

/* How much there is to fine-tune on. Said in the Train bar, because that is
   where the decision to fine-tune is now taken. */
async function drawReal() {
  const r = await get('/real/list');
  const n = (r.lines || []).length;
  $('#tst').textContent = n
    ? `${n} real line${n === 1 ? '' : 's'} confirmed — ${r.marks} marks, ${r.skipped} left out`
    : 'no real lines confirmed yet — Fine-tune is where they are made';
}

async function doTune() {
  const el = $('#tout');
  const base = $('#fbase').value;
  if (!base) { $('#tst').textContent = 'choose a model to start from'; return; }
  $('#tgo').disabled = true;
  const started = performance.now();
  const tick = setInterval(() => {
    const s = Math.round((performance.now() - started) / 1000);
    $('#tst').textContent = `fine-tuning — ${Math.floor(s / 60)}m ${s % 60}s`;
  }, 1000);
  el.innerHTML = `<div class=loading><span class=spin></span>
    fine-tuning ${base} on the confirmed lines. Shorter than training from
    nothing — it is adjusting a model, not building one.</div>`;
  try {
    const j = await post(`/tune?base=${encodeURIComponent(base)}` +
      `&steps=${$('#fsteps').value}&lr=${$('#flr').value}&share=${$('#fshare').value}` +
      `&batch=${$('#fbatch').value}&rotate=${$('#frot').value}` +
      `&scale=${$('#fscale').value}&seed=${$('#fseed').value}` +
      `&freeze=${$('#ffreeze').checked ? 1 : 0}`);
    clearInterval(tick);
    if (j.error) { fail(el, j.error); }
    else {
      el.innerHTML = `<div class=done><b>${j.model.name}</b> — ${j.model.note}.<br>
        <span class=note>Now go to <b>A real page</b> and read a photograph with
        it, or to <b>Compare</b> to check it has not lost its grip on the type.</span></div>`;
      $('#tst').textContent = `${j.model.name} saved`;
      await loadModels();
      drawState();
    }
  } catch (e) { clearInterval(tick); fail(el, e); }
  $('#tgo').disabled = false;
}

/* ---- labels -------------------------------------------------------------
 *
 * The labels are the only thing here that cannot be made again. Models are
 * fifteen minutes of arithmetic; a hundred and twenty words separated by hand
 * are an afternoon, and one of them separated wrongly is quietly taught to
 * every model that follows. So they get a page of their own where they can be
 * read back and thrown out — which is the only correction mechanism that
 * exists for a mistake already written down.
 */
function wordCard(w) {
  const off = w.marks !== w.spelled;
  return `<figure class="word ${off ? 'off' : ''}" data-key="${w.key}"
           data-page="${w.page}" data-code="${escape(w.code)}">
    <input type=checkbox class="lpick tick" title="tick to delete">
    <img loading=lazy src="/word?page=${w.page}&code=${encodeURIComponent(w.code)}"
         alt="${w.text || w.code}" title="click a piece of ink to flip it">
    <figcaption>
      <span class=ar>${w.text || ''}</span>
      <span class="count ${off ? 'fair' : 'good'}">${w.marks}/${w.spelled}</span>
      <span class=why>page ${w.page} · <span class=lets>${w.letters}</span> letters${
        w.auto ? ' · <span class=auto>harvested</span>' : ''}${
        off ? ` · <b>the spelling says ${w.spelled}</b>` : ''}</span>
    </figcaption>
  </figure>`;
}

/* Seeing a label is wrong and being able only to delete it is half a tool:
   deleting throws away every other blob in the word that was right, to
   correct one dot. Clicking lands on the piece that is wrong and changes only
   that, and a flip is its own undo. */
function wireWords(el) {
  el.querySelectorAll('.word img').forEach(im => {
    im.onclick = async ev => {
      const fig = im.closest('.word');
      const b = im.getBoundingClientRect();
      im.style.opacity = 0.5;
      const j = await post('/wordfix', {
        page: +fig.dataset.page, code: unescape(fig.dataset.code),
        fx: (ev.clientX - b.left) / b.width,
        fy: (ev.clientY - b.top) / b.height,
      });
      im.style.opacity = '';
      if (j.error) { $('#lst').textContent = 'that click failed'; return; }
      if (!j.hit) { $('#lst').textContent = 'no ink there'; return; }
      // the picture is drawn by the server, so it has to be asked again
      im.src = `/word?page=${fig.dataset.page}` +
        `&code=${encodeURIComponent(unescape(fig.dataset.code))}&t=${Date.now()}`;
      const off = j.marks !== j.spelled;
      fig.classList.toggle('off', off);
      const c = fig.querySelector('.count');
      c.textContent = `${j.marks}/${j.spelled}`;
      c.className = `count ${off ? 'fair' : 'good'}`;
      fig.querySelector('.lets').textContent = j.letters;
      $('#lst').textContent = `that piece is now ${j.now} · ${j.marks} marks`;
      drawState();
    };
  });
}

/* Every label as a row. The cards show you whether a label is right; a table
   shows you what there is -- which pages, how many, which were harvested --
   and lets you take a scythe to it. Two ways of looking at the same thing,
   and each is bad at the other's job. */
function labelTable(words, j) {
  const rows = words.map(w => `<tr data-key="${w.key}"
      class="${w.marks === w.spelled ? '' : 'off'}">
    <td><input type=checkbox class=lpick></td>
    <td>${w.page}</td>
    <th class=ar>${w.text || w.code}</th>
    <td>${w.marks}</td>
    <td class="${w.marks === w.spelled ? 'good' : 'fair'}">${w.spelled}</td>
    <td>${w.letters}</td>
    <td class=note>${w.auto ? 'harvested' : 'by hand'}</td>
  </tr>`).join('');
  return `<table class="working under sticky">
    <tr><th></th><th>page</th><th>word</th><th>marks</th><th>spelled</th>
        <th>letters</th><th>from</th></tr>
    ${rows}</table>`;
}

function realRows(j) {
  const rows = j.lines.map(l => `<tr data-key="${l.key}">
    <td><input type=checkbox class=lpick></td>
    <th>${l.file}</th>
    <td>${l.line + 1}</td>
    <td>${l.pieces}</td>
    <td>${l.marks}</td>
    <td>${l.letters}</td>
    <td>${l.skipped}</td>
  </tr>`).join('');
  return `<table class="working under"><caption>${j.lines.length} confirmed lines
      across ${j.photos} photograph${j.photos === 1 ? '' : 's'} —
      ${j.marks} marks, ${j.letters} letters, ${j.skipped} left out</caption>
    <tr><th></th><th>photograph</th><th>line</th><th>pieces</th>
        <th>marks</th><th>letters</th><th>skip</th></tr>
    ${rows}</table>`;
}

/* The labels, drawn rather than counted.
 *
 * They are the only thing here that cannot be made again — a model is fifteen
 * minutes of arithmetic, a word separated by hand is a minute of yours — and
 * one separated wrongly is taught as fact to every model afterwards with
 * nothing in the training that will ever argue back. So: see them.
 *
 * The count beside each word is what was marked against what the word is
 * spelled with. They should agree. Where they do not, the card is ringed,
 * and it is either a label to fix or a word whose spelling is unusual — which
 * is worth knowing either way, and is the whole of the answer to "how do I
 * know if my marks are good".
 */
/* The pages that have labels on them, with how many -- typing a page number
   into a box means knowing the answer before you ask the question. */
let PAGES = null;
function fillPages(j) {
  PAGES = j;
  const pick = $('#lpage');
  const was = pick.value;
  const every = $('#lwhat').value === 'page'
    ? ''                            // a page view needs one page, not all of them
    : `<option value="">all pages</option>`;
  pick.innerHTML = every +
    j.pages.map(n => `<option value="${n}">${n} (${j.per_page[n]})</option>`).join('');
  pick.value = j.pages.includes(+was) ? was : (every ? '' : j.pages[0] || '');
}

/* Two of these can be in the air at once -- changing the mode and the page in
   quick succession starts a second before the first is back -- and the slower
   one used to paint over the newer. Each run takes a ticket and the stale ones
   go quietly. */
let LABELRUN = 0;

const tally = (shown, j) =>
  `${shown.length} of ${j.total} · ${j.total - j.agree} off the spelling` +
  `${j.harvested ? ` · ${j.harvested} harvested` : ''}`;

function wireTicks(el) {
  el.querySelectorAll('.lpick').forEach(c => {
    c.onchange = () => { $('#ldel').disabled = !el.querySelector('.lpick:checked'); };
  });
}

async function doLabels() {
  const el = $('#labels');
  const kind = $('#lwhat').value;
  const mine = ++LABELRUN;
  $('#lgo').disabled = true;
  el.innerHTML = '<div class=loading><span class=spin></span>drawing the labels</div>';
  try {
    if (kind === 'page') {
      if (!PAGES) fillPages(await get('/labelled'));
      /* Painted by a model, this is the old Read & correct: its reading of the
         page, yours to click at and then Save. Painted by the labels, it is
         what has already been decided. Same page, same clicking, different
         thing on it. */
      if (mine !== LABELRUN) return;
      if ($('#lpaint').value) { $('#lgo').disabled = false; return doReview(true); }
      /* A page at a time, painted by the labels. The gallery is right for
         judging one label and cannot show what is missing; this is the other
         half of the same question -- everything unlabelled stays pale, so
         coverage and correctness are one picture. */
      const n = +$('#lpage').value || 3;
      const j = await get(`/labelpage?page=${n}` +
        `&ink=${encodeURIComponent($('#cink').value)}` +
        `&mark=${encodeURIComponent($('#cmark').value)}`);
      if (mine !== LABELRUN) return;
      if (j.error) { fail(el, j.error); $('#lgo').disabled = false; return; }
      el.innerHTML = `<section class=page>
        <div class=score><b>${j.labelled}</b> labelled
          <span class=note>· ${j.unlabelled} not
          ${j.disagreeing ? `· <span class=fair>${j.disagreeing} off the spelling</span>`
            : ''} · pale = unlabelled, grey ring = harvested</span></div>
        <div class=stage><div class=sheet><img src="${j.img}"></div></div>
      </section>`;
      const sh = el.querySelector('.sheet');
      if (sh) makeZoomable(sh);
      $('#lst').textContent =
        `page ${j.page}: ${j.labelled} labelled, ${j.unlabelled} not`;
      $('#lgo').disabled = false;
      return;
    }
    if (kind === 'real') {
      const j = await get('/real/list');
      el.innerHTML = j.error ? `<pre>${j.error}</pre>` : realRows(j);
      $('#lst').textContent = `${j.lines.length} lines`;
    } else {
      const j = await get('/labelled');
      if (j.error) { fail(el, j.error); $('#lgo').disabled = false; return; }
      /* The page filter names the pages there are, with how many words each
         holds -- typing a number into a box means knowing the answer before
         you ask the question. */
      fillPages(j);

      let words = j.words;
      const page = +$('#lpage').value;
      if (page) words = words.filter(w => w.page === page);
      if ($('#lodd').checked) words = words.filter(w => w.marks !== w.spelled);

      /* Grouped by page, because that is the unit the labelling was done in
         and the unit it gets thrown away in. Each heading carries its own
         delete: a page whose labels went wrong is a page you want rid of
         whole, and hunting the same page number through a flat grid of a
         hundred cards is not a way to do it. */
      const byPage = {};
      for (const w of words) (byPage[w.page] = byPage[w.page] || []).push(w);
      const pages = Object.keys(byPage).map(Number).sort((a, b) => a - b);
      if (kind === 'table') {
        el.innerHTML = words.length ? labelTable(words, j)
          : '<div class=idle>Nothing matches.</div>';
        wireTicks(el);
        $('#lst').textContent = tally(words, j);
        $('#lgo').disabled = false;
        return;
      }
      el.innerHTML = pages.length ? pages.map(n => {
        const ws = byPage[n];
        const off = ws.filter(w => w.marks !== w.spelled).length;
        return `<section class=pagegroup data-page="${n}">
          <div class=grouphead>
            <b>page ${n}</b>
            <span class=note>${ws.length} word${ws.length === 1 ? '' : 's'}${
              off ? ` · <span class=fair>${off} disagree with the spelling</span>` : ''}</span>
            <button class="quiet dropall" data-page="${n}"
              data-all="${j.per_page[n]}">Delete this page</button>
          </div>
          <div class=gallery>${ws.map(wordCard).join('')}</div>
        </section>`;
      }).join('') : '<div class=idle>Nothing matches.</div>';
      wireWords(el);
      wireGroups(el);
      $('#lst').textContent = tally(words, j);
    }
    wireTicks(el);
  } catch (e) { fail(el, e); }
  $('#lgo').disabled = false;
}

/* Deleting a page is not a click, it is two: the first says what is about to
   go and the second means it. No dialog -- a confirm box is a different thing
   to read in a different place, and the number that matters is already on the
   button. */
function wireGroups(el) {
  el.querySelectorAll('.dropall').forEach(b => {
    b.onclick = () => {
      if (b.dataset.armed) { deleteLabels({ page: +b.dataset.page }); return; }
      el.querySelectorAll('.dropall').forEach(o => {
        delete o.dataset.armed; o.textContent = 'Delete this page'; o.classList.remove('arm');
      });
      b.dataset.armed = '1';
      b.classList.add('arm');
      b.textContent = `Delete all ${b.dataset.all} words of page ${b.dataset.page}?`;
      setTimeout(() => {
        if (!b.dataset.armed) return;
        delete b.dataset.armed;
        b.classList.remove('arm');
        b.textContent = 'Delete this page';
      }, 5000);
    };
  });
}

async function deleteLabels(body) {
  const kind = $('#lwhat').value;
  const j = await post(kind === 'real' ? '/real/delete' : '/labelled/delete', body);
  if (j.error) { $('#lst').textContent = 'that did not delete'; return; }
  $('#lst').textContent = `${j.deleted} deleted`;
  drawState();
  doLabels();
}

/* ---- models -------------------------------------------------------------
 *
 * One card each, saying what went into it and how it has done since. The two
 * marks are separate because the two jobs are: a model shaken hard enough to
 * read a press can read clean type slightly worse, and one champion for both
 * would hide exactly that.
 */
function testRows(tests) {
  const keys = Object.keys(tests || {});
  if (!keys.length) return '<div class=note>not tested yet</div>';
  return keys.map(k => {
    const t = tests[k];
    /* The two are different measurements and are labelled as such. Digital is
       whole words counted against the spelling; a photograph is pixels
       counted against what a person confirmed by eye. 91% of one is not 91%
       of the other, and putting the unit on each is the only thing stopping
       them being read side by side as if it were. */
    if (k.startsWith('page:')) {
      return `<div class=note><b>digital page ${k.slice(5)}</b> —
        <b class="${t.agreement >= 0.9 ? 'good' : t.agreement >= 0.75 ? 'fair' : 'poor'}">
        ${pct(t.agreement)}</b> of words
        <span class=note>match the spelling (${t.found} found, ${t.spelled}
        spelled, doubt ${t.doubt})</span></div>`;
    }
    return `<div class=note><b>photograph ${k.slice(6)}</b> —
      <b class="${t.agreement >= 0.9 ? 'good' : 'fair'}">${pct(t.agreement)}</b>
      of confirmed ink
      <span class=note>matches what you confirmed (IoU ${t['mark pixels found (IoU)']}
      over ${t.lines} line${t.lines === 1 ? '' : 's'})</span></div>`;
  }).join('');
}

function modelCard(m) {
  const from = m.tuned_from
    ? `fine-tuned from <b>${m.tuned_from}</b> on ${m.real_lines} real lines`
    : `trained from nothing on ${m.words} labelled words`;
  const shake = Object.keys(m.jitter || {}).filter(k => m.jitter[k])
    .map(k => `${k} ${m.jitter[k]}`).join(', ');
  const held = m.held_out;
  return `<section class="page card" data-model="${m.name}">
    <div class=pagehead>
      <b>${m.name}</b>
      ${(m.best || []).map(j => `<span class=done-tag>best for ${j === 'real' ? 'photographs' : 'digital'}</span>`).join('')}
      <span class=note>${m.trained}</span>
    </div>
    <div class=note>${from}${shake ? `, shaken by ${shake}` : ''}</div>
    <table class=working><caption>what went into it</caption>
      <tr><th>steps</th><td>${m.steps ?? '—'}</td></tr>
      <tr><th>crops</th><td>${m.crops ? m.crops.toLocaleString() : '—'}</td></tr>
      <tr><th>batch</th><td>${m.batch ?? '—'}</td></tr>
      <tr><th>learning rate</th><td>${m.lr ?? '—'}</td></tr>
      ${m.width ? `<tr><th>width</th><td>${m.width}</td></tr>` : ''}
      ${m.real_share ? `<tr><th>real share</th><td>${m.real_share}</td></tr>` : ''}
      ${m.seed !== undefined && m.seed !== null ? `<tr><th>seed</th><td>${m.seed}</td></tr>` : ''}
      <tr><th>size</th><td>${m['size kb']} KB</td></tr>
    </table>
    ${held ? `<div class=note>held out ${held.words} words —
      ${pct(held['ink labelled right'])} of their ink labelled right,
      IoU ${held['mark pixels found (IoU)']}</div>` : ''}
    <div class=tests>${testRows(m.tests)}</div>
    <div class=row>
      <button class="quiet mbest" data-job=type>${(m.best || []).includes('digital') ? 'unmark' : 'best for digital'}</button>
      <button class="quiet mbest" data-job=real>${(m.best || []).includes('real') ? 'unmark' : 'best for photographs'}</button>
    </div>
  </section>`;
}

async function doModels() {
  const el = $('#models');
  el.innerHTML = '<div class=loading><span class=spin></span>reading the cards</div>';
  try {
    const j = await get('/models');
    // in a grid, not one card per screen-width: a card is a short list of
     // facts and giving each the full window makes four models unreadable
     // together, which is the only way they are worth reading at all
    el.innerHTML = (j.models || []).length
      ? `<div class=cards>${j.models.map(modelCard).join('')}</div>`
      : '<div class=idle>Nothing trained yet.</div>';
    el.querySelectorAll('.mbest').forEach(b => {
      b.onclick = async () => {
        const name = b.closest('.card').dataset.model;
        const job = b.dataset.job === 'type' ? 'digital' : 'real';
        const on = !b.textContent.startsWith('unmark');
        b.disabled = true;
        const r = await post(`/model/best?name=${encodeURIComponent(name)}` +
                             `&job=${job}&on=${on ? 1 : 0}`);
        if (r.error) { $('#mst').textContent = 'that did not stick'; b.disabled = false; return; }
        MODELS = r.models;
        doModels();
        loadModels();
      };
    });
    $('#mst').textContent = `${(j.models || []).length} models`;
  } catch (e) { fail(el, e); }
}

/* ---- which line to label next -------------------------------------------
 *
 * Labelling in file order spends the afternoon on lines the model already
 * reads correctly. Ranked by how unsure it is, the first line you look at is
 * the one your answer changes the most.
 */
async function rankLines() {
  const el = $('#franks');
  el.innerHTML = '<div class=note>ranking…</div>';
  try {
    const j = await get(`/bandrank?file=${encodeURIComponent($('#ff').value)}` +
      `&detail=${+$('#fdetail').value}&model=${encodeURIComponent($('#fm').value || '')}`);
    if (j.error) { el.innerHTML = `<pre>${j.error}</pre>`; return; }
    el.innerHTML = `<div class=note>${j.confirmed} of ${j.lines} confirmed —
        least sure first</div>
      <div class=ranks>${j.rows.map(r => `<button class="rank ${r.confirmed ? 'done' : ''}"
          data-line="${r.line}">line ${r.line + 1}
          <span class=note>${r.confirmed ? 'confirmed'
            : r.doubt === undefined ? '' : `doubt ${r.doubt}`}</span>
        </button>`).join('')}</div>`;
    el.querySelectorAll('.rank').forEach(b => {
      b.onclick = () => { $('#fline').value = b.dataset.line; doBand(); };
    });
  } catch (e) { el.innerHTML = `<pre>${e}</pre>`; }
}

/* ---- looking closer ---------------------------------------------------
 *
 * A mark is a few pixels across on a page fitted to the window, which is fine
 * for spotting that something is the wrong colour and useless for deciding
 * whether it should be. The wheel zooms about the pointer, dragging moves the
 * page under it, and a double click puts it back.
 */
function makeZoomable(sheet, opts) {
  const im = sheet.querySelector('img');
  if (!im || sheet.dataset.zoom) return;
  sheet.dataset.zoom = '1';

  let z = 1, x = 0, y = 0;
  let down = null, moved = false;

  /* Zooming changes the layout as well as the transform: the margin notes go
   * away and the frame widens, which slides the picture sideways underneath
   * the pointer. The slide is measured and taken back out, or the ink under
   * the cursor drifts away from it -- 176 pixels at 3x, which is several
   * words. */
  const apply = () => {
    const wasX = im.offsetLeft, wasY = im.offsetTop;
    sheet.classList.toggle('zoomed', z > 1.01);
    const nowX = im.offsetLeft, nowY = im.offsetTop;   // forces the reflow
    x -= nowX - wasX;
    y -= nowY - wasY;

    const box = sheet.getBoundingClientRect();
    const w = im.clientWidth * z, h = im.clientHeight * z;
    x = Math.min(-nowX, Math.max(box.width - w - nowX, x));
    y = Math.min(-nowY, Math.max(box.height - h - nowY, y));
    if (w <= box.width) x = 0;
    if (h <= box.height) y = 0;

    im.style.transformOrigin = '0 0';
    im.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    if (opts && opts.onChange) opts.onChange(z);
  };

  sheet.addEventListener('wheel', ev => {
    ev.preventDefault();
    const box = im.getBoundingClientRect();
    const px = ev.clientX - box.left, py = ev.clientY - box.top;
    const was = z;
    z = Math.min(8, Math.max(1, z * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
    // hold the point under the pointer still while the scale changes
    x -= px * (z / was - 1);
    y -= py * (z / was - 1);
    if (z <= 1.01) { z = 1; x = 0; y = 0; }
    apply();
  }, { passive: false });

  /* The move and release are watched on the window, because a drag that
     leaves the picture still has to finish -- but only while a button is
     actually down, or every page ever drawn leaves a pair of listeners
     behind holding on to an element no longer on screen. */
  const onMove = ev => {
    if (!down) return;
    const dx = ev.clientX - down.x, dy = ev.clientY - down.y;
    if (!moved && Math.hypot(dx, dy) > 4) moved = true;
    if (!moved || z <= 1.01) return;
    x = down.ox + dx;
    y = down.oy + dy;
    apply();
  };
  const onUp = () => {
    down = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  im.addEventListener('mousedown', ev => {
    if (ev.button !== 0) return;
    down = { x: ev.clientX, y: ev.clientY, ox: x, oy: y };
    moved = false;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  /* A drag must not also count as a click on the ink underneath, and neither
     must the two clicks a double click is made of -- a click here flips a
     piece of ink, so double clicking to fit the page used to flip something
     twice on the way. Every click is held for a moment and dropped if a
     second one follows it. */
  let waiting = null;
  im.addEventListener('click', ev => {
    if (moved) { moved = false; ev.stopPropagation(); ev.preventDefault(); return; }
    if (!opts || !opts.onClick) return;
    ev.stopPropagation(); ev.preventDefault();
    clearTimeout(waiting);
    const at = { clientX: ev.clientX, clientY: ev.clientY };
    waiting = setTimeout(() => opts.onClick(at), 220);
  }, true);

  im.addEventListener('dblclick', ev => {
    ev.preventDefault();
    clearTimeout(waiting);
    z = 1; x = 0; y = 0;
    apply();
  });
}

/* ---- switching ----------------------------------------------------------
 *
 * A view's controls are one element, moved into whichever slot that view
 * wants them in -- the rail for the two views whose content is a page
 * standing on end, the top of the main area for the lists and grids. One
 * copy of each bar, so nothing can drift out of step with its twin.
 */
function choose(name) {
  const view = VIEWS[name];
  document.querySelectorAll('.tab')
    .forEach(t => t.classList.toggle('on', t.dataset.v === name));
  for (const [key, v] of Object.entries(VIEWS)) show($(v.body), key === name);
  /* One copy of each bar, moved to wherever this view wants it -- and the
     bar that was there is put back in the holder rather than dropped.
     Emptying a slot removes what was in it from the document altogether, so
     the first time you left a view its controls ceased to exist and every
     later visit found nothing to wire up. */
  $('#bars').append(...$('#railslot').children, ...$('#topslot').children);
  const where = typeof view.where === 'function' ? view.where() : view.where;
  $(view.bar).classList.toggle('side', where === 'side');
  $(view.bar).classList.toggle('top', where !== 'side');
  (where === 'side' ? $('#railslot') : $('#topslot')).append($(view.bar));
  $('#title').textContent = view.title;
  $('#sub').innerHTML = view.sub;
}


document.querySelectorAll('.tab').forEach(t => { t.onclick = () => choose(t.dataset.v); });
$('#lpaint').onchange = () => {
  show($('#lharvestwrap'), !!$('#lpaint').value);
  doLabels();
};
document.addEventListener('keydown', ev => {
  // the arrow keys turn the page, so long as nothing is being typed into
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
  if ($('#lwhat').value !== 'page') return;
  if (ev.key === 'ArrowLeft') step(-1);
  if (ev.key === 'ArrowRight') step(1);
});
$('#tgo').onclick = doTrain;
$('#tsteps').oninput = drawPlan;
$('#tbatch').oninput = drawPlan;

$('#lgo').onclick = doLabels;
$('#lwhat').onchange = () => {
  // a page number and a spelling to disagree with are both things only the
  // type has; a photograph's lines have neither
  const kind = $('#lwhat').value;
  const list = kind === 'type' || kind === 'table';
  // a list starts with everything in it; a page view has to start on a page
  if (list) $('#lpage').value = '';
  show($('#lpagewrap'), kind !== 'real');   // a photograph has no page number
  show($('#loddwrap'), list);               // nor a spelling to disagree with
  show($('#ldel'), kind !== 'page');
  show($('#lpaintwrap'), kind === 'page');
  show($('#lharvestwrap'), kind === 'page' && !!$('#lpaint').value);
  show($('#lcolours'), kind === 'page');
  show($('#key'), kind === 'page');
  show($('#pagebox'), kind === 'page');
  choose('labels');                          // the bar may want the other slot
  if (PAGES) fillPages(PAGES);
  doLabels();
};
$('#lodd').onchange = doLabels;
$('#lpage').onchange = doLabels;
$('#ldel').onclick = () => {
  const keys = [...$('#labels').querySelectorAll('.lpick:checked')]
    .map(c => c.closest('tr').dataset.key);
  if (keys.length) deleteLabels({ keys });
};

$('#mgo').onclick = doModels;

$('#frank').onclick = rankLines;
$('#tmode').onchange = () => {
  const fresh = $('#tmode').value === 'fresh';
  show($('#t-fresh'), fresh);
  show($('#t-tune'), !fresh);
  $('#tgo').textContent = fresh ? 'Train a new model' : 'Fine-tune on the real lines';
  if (fresh) drawPlan(); else drawReal();
};
$('#cwhat').onchange = () => {
  const w = $('#cwhat').value;
  show($('#c-type'), w !== 'photo');    // "both" needs the page controls too
  show($('#c-photo'), w !== 'type');
};
$('#cgo').onclick = doCompare;
$('#conly').onchange = () => { if ($('#cwhat').value === 'type') doCompare(); };

/* A line in the rail saying what there is, so the numbers that matter are on
   screen without opening the view that owns them. */
async function drawState() {
  try {
    const [l, r, m] = await Promise.all([get('/labelled'), get('/real/list'), get('/models')]);
    /* The page list is filled from this, at startup. Filled lazily instead it
       was empty at the moment it was first looked at -- you switch to the page
       view and the list of pages has nothing in it, which is the one moment it
       has to be right. */
    if (l.pages) fillPages(l);
    $('#state').innerHTML =
      `<b>${l.total}</b> words labelled · <b>${l.agree}</b> match the spelling<br>` +
      `<b>${r.lines.length}</b> real lines confirmed<br>` +
      `<b>${(m.models || []).length}</b> models`;
  } catch (e) { /* the tally is a nicety */ }
}
$('#fgo').onclick = doBand;
$('#ff').onchange = () => { $('#fline').value = 0; doBand(); };
$('#fline').onchange = doBand;
$('#fprev').onclick = () => { $('#fline').value = Math.max(0, +$('#fline').value - 1); doBand(); };
$('#fnext').onclick = () => { $('#fline').value = +$('#fline').value + 1; doBand(); };
for (const id of ['#cink', '#cmark']) {
  $(id).oninput = () => { drawKey(); drawFineKey(); };
  $(id).onchange = () => { drawKey(); drawFineKey(); doLabels(); };
}

/* Nothing is read until it is asked for. Opening the page used to start a
 * half-minute of convolution before anyone had chosen a page or a model, which
 * is a poor way to greet someone who only wanted to change the settings. */
function idle(where, what) {
  $(where).innerHTML = `<div class=idle>${what}</div>`;
}

(async () => {
  drawKey();
  choose('labels');
  idle('#compare', 'Choose two models and press <b>Set them against each other</b>.');
  idle('#finetune', 'Choose a line and press <b>Show this line</b>.');
  idle('#labels', 'Choose a page and press <b>Show them</b>.');
  idle('#models', 'Press <b>Show the models</b>.');
  await loadModels();
  try {
    const ph = await get('/photos');
    const opts = (ph.photos || []).map(f => `<option value="${f}">${f}</option>`).join('');
    for (const id of ['#ff', '#cpf', '#mpf']) {
      $(id).innerHTML = opts || '<option value="">nothing in PhysicalQuran/</option>';
    }
  } catch (e) { /* no photographs is not a problem */ }
  drawFineKey();
  await drawPlan();
  await drawReal();
  drawState();
  try {
    const c = await get('/checked');
    if (c.count) {
      $('#lst').textContent = `${c.count} pages checked · next unchecked is ${c.resume}`;
    }
  } catch (e) { /* no record yet is not a problem */ }
})();
