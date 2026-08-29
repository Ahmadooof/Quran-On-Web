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

const VIEWS = {
  review: {
    title: 'Read a page, and correct what is wrong',
    sub: 'Click any ink that is the wrong colour. Nothing is written until Save.',
    bar: '#bar-review', body: '#review',
  },
  train: {
    title: 'Train a new model on the corrections',
    sub: 'Each one is kept under its own name; nothing is overwritten.',
    bar: '#bar-train', body: '#train',
  },
  compare: {
    title: 'Set two models against each other',
    sub: 'From one page to another, inclusive. Use pages neither model was ' +
         'taught on, or the answer means nothing. Green is whichever reading ' +
         'is closer to the spelling.',
    bar: '#bar-compare', body: '#compare',
  },
  finetune: {
    title: 'Confirm real lines, then nudge a model onto them',
    sub: 'The model knows the shape of a mark from type it was never ' +
         'photographed on. Confirm a few lines of a real page, and it is ' +
         'adjusted towards them without being retrained from scratch.',
    bar: '#bar-finetune', body: '#finetune',
  },
  physical: {
    title: 'A photograph of a printed page',
    sub: 'Shown as photographed; only the marks are coloured. The model has ' +
         'only ever seen type.',
    bar: '#bar-physical', body: '#physical',
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
    `<span><i style="background:${$('#cmark').value}"></i>mark — what the model found</span>` +
    `<span class=hint>click any ink to flip it</span>`;
}

/* ---- which models exist ------------------------------------------------ */
let MODELS = [];

async function loadModels() {
  const j = await get('/models');
  MODELS = j.models || [];
  const opts = MODELS.map(m =>
    `<option value="${m.name}">${m.name} — ${m.words} words, ${m.trained}</option>`).join('');
  $('#rm').innerHTML = opts || '<option value="">none trained yet</option>';
  $('#pm').innerHTML = opts || '<option value="">none trained yet</option>';
  $('#fm').innerHTML = opts || '<option value="">none trained yet</option>';
  $('#fbase').innerHTML = opts || '<option value="">none trained yet</option>';
  $('#ca').innerHTML = opts;
  $('#cb').innerHTML = opts;
  if (MODELS.length > 1) { $('#ca').value = MODELS[1].name; $('#cb').value = MODELS[0].name; }
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
  document.querySelectorAll('#review .page').forEach(sec => {
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
        page, model: $('#rm').value || null, line: hit.line,
        x: px - hit.left, y: py - hit.top,
        ink: $('#cink').value, mark: $('#cmark').value,
      });
      im.classList.remove('busy');
      if (j.error) { $('#rst').textContent = 'that click failed'; return; }
      if (!j.hit) return;
      im.src = j.img;
      sec.dataset.where = JSON.stringify(j.where);
      sec.dataset.scale = j.scale;
      setStaged(j.staged);
      $('#rst').textContent = `${j.word || 'that piece'} is now ${j.now}`;
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
      const j = await post('/save', { page });
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
           in all · ${j.words} words labelled</span>
           <button class=onward>Go to page ${j.next} &rarr;</button>
         </div>`);
      const go = $('#pagebox .onward');
      if (go) go.onclick = () => { $('#rf').value = j.next; doReview($('#rm').value !== ''); };
      $('#rst').textContent = `page ${page} checked — ${j.words} words labelled in all`;
    };

    undoBtn.onclick = async () => {
      await post('/revert', { page });
      setStaged(0);
      const j = await get(`/review?page=${page}&model=` +
        `${encodeURIComponent($('#rm').value || '')}` +
        `&ink=${encodeURIComponent($('#cink').value)}` +
        `&mark=${encodeURIComponent($('#cmark').value)}`);
      if (j.page) {
        im.src = j.page.img;
        sec.dataset.where = JSON.stringify(j.page.where);
        sec.dataset.scale = j.page.scale;
      }
      $('#rst').textContent = 'those changes were thrown away';
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
  const el = $('#review');
  $('#rgo').disabled = $('#rplain').disabled = true;
  const model = withModel ? ($('#rm').value || '') : '';
  const n = Math.min(604, Math.max(1, +$('#rf').value));
  $('#rf').value = n;
  const started = performance.now();
  el.innerHTML = `<section class=page>
    <div class=loading><span class=spin></span>
      ${withModel ? `reading page ${n} — about half a minute the first time,
        instant after that` : `drawing page ${n}`}
    </div></section>`;
  $('#rst').textContent = withModel ? 'reading…' : 'drawing…';
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
        onChange: z => { $('#rst').textContent = z > 1.01
          ? `${z.toFixed(1)}x — drag to move, double click to fit`
          : `${pct(j.page.agreement || 0)} of this page agrees`; },
      });
      const lab = await get('/labels');
      const took = Math.round((performance.now() - started) / 1000);
      $('#rst').textContent =
        (j.page.agreement === undefined ? ''
          : `${pct(j.page.agreement)} of this page agrees · `) +
        `${lab.words} words labelled · ${took}s`;
    }
  } catch (e) { fail(el, e); }
  $('#rgo').disabled = $('#rplain').disabled = false;
}

function step(by) {
  $('#rf').value = Math.min(604, Math.max(1, +$('#rf').value + by));
  doReview($('#rm').value !== '');
}

/* ---- train -------------------------------------------------------------- */

/* The size of the training set, which is not the size of the labelled set.
 * A hundred and twenty words are labelled by hand; every step fuses, turns
 * and thickens sixteen fresh crops out of them, so nine hundred steps is
 * fourteen thousand four hundred examples of which none is seen twice. Both
 * numbers matter and they are three orders of magnitude apart, so say both. */
async function drawPlan() {
  try {
    const j = await get(`/trainplan?steps=${+$('#tsteps').value || 0}`);
    if (j.crops) {
      $('#tplan').innerHTML = `<b>${j.crops.toLocaleString()}</b> synthetic crops
        — ${j.steps} steps of ${j.batch}, fused fresh from
        ${j.words} labelled words. None is drawn twice.`;
    }
  } catch (e) { /* the number is a nicety, not the feature */ }
}
async function doTrain() {
  const el = $('#train');
  $('#tgo').disabled = true;
  const lab = await get('/labels');
  const plan = await get(`/trainplan?steps=${$('#tsteps').value}`);
  el.innerHTML = `<p class=note>training on
    ${plan.crops.toLocaleString()} synthetic crops made from ${lab.words} words
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
                         `&spread=${$('#tspread').value}`);
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
    $('#pf').innerHTML = (ph.photos || []).map(f =>
      `<option value="${f}">${f}</option>`).join('') ||
      '<option value="">nothing in PhysicalQuran/</option>';
  } catch (e) { /* no photographs is not a problem */ }
    }
  } catch (e) { clearInterval(tick); fail(el, e); }
  $('#tgo').disabled = false;
}

/* ---- compare ------------------------------------------------------------ */
async function doCompare() {
  const el = $('#compare');
  const a = $('#ca').value, b = $('#cb').value;
  if (!a || !b) { el.innerHTML = '<p class=note>two models are needed.</p>'; return; }
  $('#cgo').disabled = true;
  el.innerHTML = '<div class=verdict id=running></div>';
  // from one page to another, inclusive: "5 to 10" is six pages, which is
  // what it says rather than what a count would have meant
  let first = Math.max(1, Math.min(604, +$('#cf').value));
  let last = Math.max(1, Math.min(604, +$('#ct').value));
  if (last < first) { const t = first; first = last; last = t; }
  const span = last - first + 1;
  const started = performance.now();
  const tally = { [a]: [0, 0], [b]: [0, 0] };
  try {
    for (let n = first; n <= last; n++) {
      const secs = Math.round((performance.now() - started) / 1000);
      $('#running').innerHTML = `<span class=spin></span> reading page ${n}
        (${n - first + 1} of ${span}) with both models — ${secs}s so far`;
      const j = await get(`/compare?a=${a}&b=${b}&page=${n}` +
                          `&ink=${encodeURIComponent($('#cink').value)}` +
                          `&mark=${encodeURIComponent($('#cmark').value)}`);
      if (j.error) { el.insertAdjacentHTML('beforeend', `<pre>${j.error}</pre>`); break; }
      const r = j.rows[0];
      for (const who of [a, b]) { tally[who][0] += r[who].agree; tally[who][1] += r[who].words; }
      const only = $('#conly').checked;
      const differs = r.differs || [];
      /* Only where they differ: the pages both models read the same way are
         not worth looking at, and saying so is quicker than drawing them. */
      if (only && !differs.length) {
        el.insertAdjacentHTML('beforeend',
          `<section class=page><h2>page ${r.page}</h2>
             <p class=note>both read this page the same way — ${r.same} words</p>
           </section>`);
      } else {
        const list = differs.length ? `<table class=working>
            <caption>${differs.length} word${differs.length > 1 ? 's' : ''} read
              differently${r.same ? `, ${r.same} the same` : ''}</caption>
            <tr><th>word</th><td>${a}</td><td>${b}</td><td>spelling</td></tr>
            ${differs.map(d => `<tr>
              <th class=ar>${d.text}</th>
              <td class="${d.closer === a ? 'good' : ''}">${d[a]}</td>
              <td class="${d.closer === b ? 'good' : ''}">${d[b]}</td>
              <td class=note>${d.spelled}</td></tr>`).join('')}
          </table>` : '';
        el.insertAdjacentHTML('beforeend', `<section class=page><h2>page ${r.page}</h2>
          ${list}
          ${only ? '' : `<div class=pair>
            ${[a, b].map(who => `<div>
              <div class=who>${who} — ${pct(r[who].agreement)} agree
                <span class=note>(${r[who].found} found, ${r[who].spelled} spelled)</span></div>
              <div class=sheet><img src="${r[who].img}"></div></div>`).join('')}
          </div>`}</section>`);
      }
    }
    const rate = who => tally[who][1] ? tally[who][0] / tally[who][1] : 0;
    const gap = Math.abs(rate(a) - rate(b));
    const win = gap < 0.005 ? '<b class=fair>too close to call</b>'
      : `<b class=good>${rate(a) > rate(b) ? a : b} is better</b>`;
    $('#running').innerHTML = `${win}<br><span class=note>${a} agrees with the
      spelling on ${pct(rate(a))} of words, ${b} on ${pct(rate(b))}, over
      ${tally[a][1]} words</span>`;
    $('#cst').textContent = `${pct(rate(a))} vs ${pct(rate(b))}`;
  } catch (e) { fail(el, e); }
  $('#cgo').disabled = false;
}

/* ---- a real page -------------------------------------------------------- */
async function doPhysical() {
  const el = $('#physical');
  $('#pgo').disabled = true;
  el.innerHTML = `<div class=loading><span class=spin></span>
    reading ${$('#pf').value} — a photograph is bigger than a page of type,
    so this takes longer</div>`;
  $('#pst').textContent = 'reading…';
  const started = performance.now();
  try {
    const j = await get(`/physical?file=${encodeURIComponent($('#pf').value)}` +
                        `&model=${encodeURIComponent($('#pm').value || '')}` +
                        `&mark=${encodeURIComponent($('#cmark').value)}`);
    if (j.error) { fail(el, j.error); }
    else {
      const took = Math.round((performance.now() - started) / 1000);
      const w = j.working || {};
      const rows = Object.keys(w).map(k =>
        `<tr><th>${k}</th><td>${w[k]}</td></tr>`).join('');
      el.innerHTML = `<div class=score>
          <b>${j.found}</b> marks found
          <span class=note>· ${j.lines} lines · printed line ${j.line_height}px,
          scaled ${j.scaled_by}x, read a line at a time</span>
        </div>
        <div class=withwork>
          <div class=sheet><img src="${j.img}"></div>
          <table class=working><caption>the working</caption>${rows}</table>
        </div>`;
      const psheet = el.querySelector('.sheet');
      if (psheet) makeZoomable(psheet, {
        onChange: z => { $('#pst').textContent = z > 1.01
          ? `${z.toFixed(1)}x — drag to move, double click to fit`
          : `${j.found} marks found`; },
      });
      $('#pst').textContent = `${j.found} marks · ${took}s`;
    }
  } catch (e) { fail(el, e); }
  $('#pgo').disabled = false;
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
    `<span><i style="background:${SKIP_COLOUR}"></i>skip — both at once, left out</span>` +
    `<span><i style="background:#8884"></i>letter — as photographed</span>` +
    `<span class=hint>click any ink to cycle it</span>`;
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

async function drawReal() {
  const r = await get('/real');
  $('#freal').innerHTML = r.lines
    ? `<b>${r.lines}</b> line${r.lines > 1 ? 's' : ''} confirmed across
       ${r.photos} photograph${r.photos > 1 ? 's' : ''} —
       ${r.marks} marks, ${r.letters} letters, ${r.skipped} left out`
    : 'nothing confirmed yet — show a line and confirm it first';
  $('#ftune').disabled = r.lines < 3;
}

async function doTune() {
  const el = $('#finetune');
  const base = $('#fbase').value;
  if (!base) { $('#fst').textContent = 'choose a model to start from'; return; }
  $('#ftune').disabled = true;
  const started = performance.now();
  const tick = setInterval(() => {
    const s = Math.round((performance.now() - started) / 1000);
    $('#fst').textContent = `fine-tuning — ${Math.floor(s / 60)}m ${s % 60}s`;
  }, 1000);
  el.innerHTML = `<div class=loading><span class=spin></span>
    fine-tuning ${base} on the confirmed lines. Shorter than training —
    it is adjusting a model, not building one.</div>`;
  try {
    const j = await post(`/tune?base=${encodeURIComponent(base)}` +
      `&steps=${$('#fsteps').value}&lr=${$('#flr').value}&share=${$('#fshare').value}`);
    clearInterval(tick);
    if (j.error) { fail(el, j.error); }
    else {
      el.innerHTML = `<div class=done><b>${j.model.name}</b> — ${j.model.note}.<br>
        <span class=note>Now go to <b>A real page</b> and read a photograph with
        it, or to <b>Compare</b> to check it has not lost its grip on the type.</span></div>`;
      $('#fst').textContent = `${j.model.name} saved`;
      await loadModels();
    }
  } catch (e) { clearInterval(tick); fail(el, e); }
  $('#ftune').disabled = false;
}

/* ---- looking closer ------------------------------------------------------
 *
 * A mark is a few pixels across on a page fitted to the window, which is fine
 * for spotting that something is the wrong colour and useless for deciding
 * whether it should be. So: the wheel zooms about the pointer, dragging moves
 * the page under it, and a double click puts it back.
 *
 * Dragging and clicking share the same button, and on the reading page a click
 * flips a piece of ink. They are told apart by distance -- a press that moves
 * more than a few pixels was a drag, and the click it would otherwise have
 * fired is swallowed.
 */
function makeZoomable(sheet, opts) {
  const im = sheet.querySelector('img');
  if (!im || sheet.dataset.zoom) return;
  sheet.dataset.zoom = '1';

  let z = 1, x = 0, y = 0;
  let down = null, moved = false;

  /* Zooming changes the layout as well as the transform: the margin notes go
   * away and the frame widens to take the room they were keeping, which slides
   * the picture sideways underneath the pointer. The slide is measured and
   * taken back out, or the ink under the cursor drifts away from it -- 176
   * pixels at 3x, which is several words.
   */
  const apply = () => {
    const wasX = im.offsetLeft, wasY = im.offsetTop;
    sheet.classList.toggle('zoomed', z > 1.01);
    const nowX = im.offsetLeft, nowY = im.offsetTop;   // forces the reflow
    x -= nowX - wasX;
    y -= nowY - wasY;

    // keep some of the page on screen, whatever the pointer was doing
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

/* ---- switching ---------------------------------------------------------- */
function choose(name) {
  const view = VIEWS[name];
  document.querySelectorAll('.tab')
    .forEach(t => t.classList.toggle('on', t.dataset.v === name));
  for (const [key, v] of Object.entries(VIEWS)) {
    show($(v.bar), key === name);
    show($(v.body), key === name);
  }
  $('#title').textContent = view.title;
  $('#sub').innerHTML = view.sub;
  show($('#key'), name === 'review');
}

document.querySelectorAll('.tab').forEach(t => { t.onclick = () => choose(t.dataset.v); });
$('#rgo').onclick = () => doReview(true);
$('#rplain').onclick = () => doReview(false);
$('#rprev').onclick = () => step(-1);
$('#rnext').onclick = () => step(1);
$('#rf').onchange = () => doReview($('#rm').value !== '');
document.addEventListener('keydown', ev => {
  // the arrow keys turn the page, so long as nothing is being typed into
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
  if (!$('#bar-review').hidden && ev.key === 'ArrowLeft') step(-1);
  if (!$('#bar-review').hidden && ev.key === 'ArrowRight') step(1);
});
$('#tgo').onclick = doTrain;
$('#cgo').onclick = doCompare;
$('#conly').onchange = doCompare;
$('#pgo').onclick = doPhysical;
$('#tsteps').oninput = drawPlan;
$('#fgo').onclick = doBand;
$('#ftune').onclick = doTune;
$('#ff').onchange = () => { $('#fline').value = 0; doBand(); };
$('#fline').onchange = doBand;
$('#fprev').onclick = () => { $('#fline').value = Math.max(0, +$('#fline').value - 1); doBand(); };
$('#fnext').onclick = () => { $('#fline').value = +$('#fline').value + 1; doBand(); };
for (const id of ['#cink', '#cmark']) {
  $(id).oninput = () => { drawKey(); drawFineKey(); };
  $(id).onchange = () => { drawKey(); drawFineKey(); if (!$('#review').hidden) doReview(true); };
}

/* Nothing is read until it is asked for. Opening the page used to start a
 * half-minute of convolution before anyone had chosen a page or a model, which
 * is a poor way to greet someone who only wanted to change the settings. */
function idle(where, what) {
  $(where).innerHTML = `<div class=idle>${what}</div>`;
}

(async () => {
  drawKey();
  choose('review');
  idle('#review', 'Choose a page and press <b>Evaluate with the model</b>.');
  idle('#compare', 'Choose two models and press <b>Set them against each other</b>.');
  idle('#physical', 'Choose a photograph and press <b>Read it</b>.');
  idle('#finetune', 'Choose a line and press <b>Show this line</b>.');
  await loadModels();
  try {
    const ph = await get('/photos');
    const opts = (ph.photos || []).map(f => `<option value="${f}">${f}</option>`).join('');
    $('#pf').innerHTML = opts || '<option value="">nothing in PhysicalQuran/</option>';
    $('#ff').innerHTML = opts || '<option value="">nothing in PhysicalQuran/</option>';
  } catch (e) { /* no photographs is not a problem */ }
  drawFineKey();
  await drawPlan();
  await drawReal();
  try {
    const c = await get('/checked');
    if (c.count) {
      $('#rf').value = c.resume;
      $('#rst').textContent = `${c.count} pages checked · resuming at ${c.resume}`;
    }
  } catch (e) { /* no record yet is not a problem */ }
})();
