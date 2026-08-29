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
    bar: '#bar-labels', body: '#labels', where: 'top',
    // a page is half a minute of convolution; a list is one request
    open: () => { if ($('#lwhat').value !== 'page') doLabels(); },
  },
  train: {
    title: 'Train',
    sub: 'Nothing is overwritten; each model keeps its own name.',
    bar: '#bar-train', body: '#train', where: 'top',
    open: () => drawAuto(),
  },
  models: {
    title: 'Models',
    sub: 'What went into each, and how it has done.',
    bar: '#bar-models', body: '#models', where: 'top',
    open: () => doModels(),
  },
  compare: {
    title: 'Compare',
    sub: 'Digital is scored in words, a photograph in pixels.',
    bar: '#bar-compare', body: '#compare', where: 'top',
  },
  finetune: {
    title: 'Fine-tune',
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

/* Which model to ask for help. Whoever is marked best at digital; failing
   that the newest, said plainly rather than pretending there was a choice. */
function helper() {
  return MODELS.find(m => (m.best || []).includes('digital')) || MODELS[0] || null;
}

/* Whether a model is lending a hand, and which. Not a control with four
   options -- the page is yours and the only question about a model here is
   whether you want one, which is a button. */
let HELPER = '';

function drawHelp() {
  const b = $('#lbest');
  const m = helper();
  const page = $('#lwhat').value === 'page';
  show(b, page && !!m);
  if (!m) return;
  if (HELPER) {
    b.textContent = 'Just my labels';
    b.title = `${HELPER} is filling the gaps; your own labels are shown as they are`;
  } else {
    b.textContent = `Let ${m.name} help`;
    b.title = (m.best || []).includes('digital')
      ? `${m.name} is marked best for digital`
      : `${m.name} is the newest — none is marked best for digital`;
  }
}

function drawKey() {
  // the key lives with the page it explains, so there is none until one is
  // drawn -- and at startup there is not
  if (!$('#key')) return;
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
    ${p.unlabelled ? `<div class=note><b>${p.unlabelled}</b> words on this page
      are not labelled yet</div>` : '<div class=note>every word is labelled</div>'}
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
  /* The page's own facts sit above the page. In the bar they made it tall
     enough to need a column of its own, which is why the controls kept moving
     between the side and the top depending on the mode. */
  return `<section class=page data-page="${p.page}" data-scale="${p.scale}"
                   data-tall="${p.tall || 1}"
                   data-where='${JSON.stringify(p.where || [])}'>
    <div class=pagetop><div id=pagebox></div><div class=key id=key></div></div>
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
        page, model: HELPER || null, line: hit.line, mine: 1,
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
        page, model: HELPER || null, agreed: $('#rharvest').checked,
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
      if (go) go.onclick = () => { $('#lpage').value = j.next; doLabels(); };
      $('#lst').textContent = `page ${page} checked — ${j.saved} written` +
        `${j.harvested ? ` (${j.harvested} harvested)` : ''} · ${j.words} in all`;
      drawState();
      /* Draw it again. What was just written is yours now, so the page should
         show it as yours -- left as it was, a save changes nothing on screen
         and looks exactly like a save that did not happen. */
      PAGES = null;
      const again = await get(`/review?page=${page}&mine=1&model=` +
        `${encodeURIComponent(HELPER || '')}` +
        `&ink=${encodeURIComponent($('#cink').value)}` +
        `&mark=${encodeURIComponent($('#cmark').value)}`);
      if (again.page) {
        im.src = again.page.img;
        sec.dataset.where = JSON.stringify(again.page.where);
        sec.dataset.scale = again.page.scale;
        const left = $('#pagebox .note');
        if (left) left.innerHTML = again.page.unlabelled
          ? `<b>${again.page.unlabelled}</b> words on this page are not labelled yet`
          : 'every word is labelled';
      }
    };

    undoBtn.onclick = async () => {
      await post('/revert', { page });
      setStaged(0);
      const j = await get(`/review?page=${page}&mine=1&model=` +
        `${encodeURIComponent(HELPER || '')}` +
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
  const model = withModel ? (HELPER || '') : '';
  const n = pageWanted();
  const started = performance.now();
  el.innerHTML = `<section class=page>
    <div class=loading><span class=spin></span>
      ${withModel ? `reading page ${n} — about half a minute the first time,
        instant after that` : `drawing page ${n}`}
    </div></section>`;
  $('#lst').textContent = withModel ? 'reading…' : 'drawing…';
  try {
    const j = await get(`/review?page=${n}&model=${encodeURIComponent(model)}&mine=1` +
                        `&ink=${encodeURIComponent($('#cink').value)}` +
                        `&mark=${encodeURIComponent($('#cmark').value)}`);
    if (j.error) { fail(el, j.error); }
    else {
      el.innerHTML = pageCard(j.page, model);
      railFor(j.page, model);
      drawKey();
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
  $('#lpage').value = Math.min(604, Math.max(1, pageWanted() + by));
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
/* What each training setting is. Plain words and a number you can picture,
   because the names are the ones the papers use and none of them says what it
   does to your model. Shown on the question mark beside each field rather
   than under it -- an explanation you cannot put away is clutter the second
   time you read it. */
const EXPLAIN = {
  tsteps: ['How many times it looks at a batch of words and adjusts itself.',
    'More steps means more learning and more time. 900 takes about a quarter '
    + 'of an hour; 1800 takes half of one.'],
  tbatch: ['How many crops it looks at before each adjustment.',
    'Bigger is steadier and slower per step. 16 is a good middle; 4 makes '
    + 'every step jumpy, 48 makes each one crawl.'],
  tlr: ['How big a step it takes each time it adjusts.',
    'Too big and it never settles, too small and it never arrives. 0.002 is '
    + 'the usual starting point here.'],
  twidth: ['How much the model can hold — the channels in its first layer.',
    '16 is 488,000 numbers. Larger is not obviously better with a hundred-odd '
    + 'labelled words: past some size it starts memorising them.'],
  tdecay: ['A pull back towards simpler answers, to stop it memorising.',
    'Small on purpose. 0.0001 is a light touch; 0.01 is a firm one.'],
  tseed: ['The number the randomness starts from.',
    'Same seed, same model. Change it to see how much of a difference between '
    + 'two models was luck rather than settings.'],
  tholdout: ['A share of the labelled words kept out of the training, to score on.',
    '0.15 keeps back about one word in seven. It costs you those words, and '
    + 'buys a score on words the model was never shown.'],
  tscale: ['How much each word is resized before it is shown.',
    '0.15 means anywhere from 15% smaller to 15% bigger. The type is always '
    + 'one size; a photograph never is.'],
  trot: ['How far each word is turned.',
    '3 means up to three degrees either way. A page is never quite square to '
    + 'the lens.'],
  tspread: ['How often the strokes are thickened, the way a press lays ink on.',
    '0.4 means about two words in five. It thickens the ink and not the '
    + 'answer, so a mark that grows is still exactly that mark.'],
  fsteps: ['How many times the fine-tuning adjusts the model.',
    'Far fewer than training: this is meant to nudge a model, not build one. '
    + '300 is about twelve minutes.'],
  fbatch: ['How many crops per adjustment, real and synthetic together.', ''],
  flr: ['How big a step the fine-tuning takes.',
    'A hundredth of the trainer\'s. 0.00001 moves the model a little; 0.001 '
    + 'would overwrite what it knows with a few lines\' worth of opinion.'],
  fshare: ['How much of each batch comes from your confirmed photograph lines.',
    '0.7 means seven crops in ten are real and three are synthetic. The '
    + 'synthetic ones are what stop it forgetting the type.'],
  frot: ['How far each real line is turned.',
    'Small — 2 degrees. The photograph already has the real variation in it.'],
  fscale: ['How much each real line is resized.', 'Small, for the same reason.'],
  ffreeze: ['Keep the normalisation statistics as they were learned.',
    'On is right nearly always: sixteen crops of one page should not rewrite '
    + 'what was measured over fourteen thousand.'],
  tarounds: ['How many candidates the search will try at most.', ''],
  tapat: ['Give up after this many rounds in a row with no winner.', ''],
};

/* One mark per field, and one panel shown at a time. */
function addHelpMarks() {
  for (const id of Object.keys(EXPLAIN)) {
    const input = $('#' + id);
    const label = input && input.closest('label');
    if (!label || label.querySelector('.why')) continue;
    label.insertAdjacentHTML('beforeend',
      `<button class=why type=button data-for="${id}" title="what is this?">?</button>`);
  }
  document.querySelectorAll('.why').forEach(b => {
    b.onclick = ev => {
      ev.preventDefault();
      const open = document.querySelector('.whybox');
      const same = open && open.dataset.for === b.dataset.for;
      if (open) open.remove();
      if (same) return;
      const [what, eg] = EXPLAIN[b.dataset.for];
      b.insertAdjacentHTML('afterend',
        `<span class=whybox data-for="${b.dataset.for}">${what}
         ${eg ? `<span class=note>${eg}</span>` : ''}</span>`);
    };
  });
}

const isSearch = () => $('#tmode').value === 'auto';

/* What the one selector means: which form is on show, what the button says,
   and what pressing it will do. Anything the current choice does not use is
   not dimmed or ignored, it is gone -- a setting on screen that has no effect
   is a question about how the thing works. */
function nameTrainButton(busy) {
  $('#tgo').textContent = busy ? 'Stop'
    : isSearch() ? 'Search' : $('#tmode').value === 'tune' ? 'Fine-tune' : 'Train';
  $('#tgo').classList.toggle('arm', !!busy);
}

function drawTrainMode() {
  const mode = $('#tmode').value;
  show($('#t-fresh'), mode === 'fresh');
  show($('#t-tune'), mode === 'tune');
  show($('#t-auto'), isSearch());
  show($('#ta-opts'), isSearch());
  show($('#tajudgewrap'), isSearch() && $('#tatune').checked);
  nameTrainButton(false);
  if (mode === 'fresh') drawPlan();
  else if (mode === 'tune') drawTunePlan();
  else { drawSearchPlan(); drawSearchSettings(); }
}

/* What fine-tuning has to work with, said where the crop count is said for
   training from nothing -- the same slot answering the same question. */
async function drawTunePlan() {
  const r = await get('/real/list');
  const n = (r.lines || []).length;
  const photos = r.photos || 0;
  $('#tplan').innerHTML = n
    ? `<b>${n}</b> confirmed line${n === 1 ? '' : 's'} from ${photos}
       photograph${photos === 1 ? '' : 's'} — ${r.marks} marks, ${r.skipped} left out`
    : 'no confirmed lines yet — Fine-tune is where they are made';
}

/* A search has no settings of its own worth showing -- it takes them from the
   model it starts from -- so say which model that is and what will judge it. */
async function drawSearchPlan() {
  /* Asked of the server, not worked out here: which model a search starts from
     depends on what is being judged, and a page that guesses describes a search
     other than the one about to run.

     Shown as lines rather than a sentence. The sentence had four clauses, two
     model names and a filename repeated three times, and reading it took
     longer than the thing it described. */
  const tune = $('#tatune').checked;
  const p = await get(`/autotrain/plan?tune=${tune ? 1 : 0}` +
                      `&judge=${$('#tajudge').value}`);
  const el = $('#tplan');
  if (!p.base) { el.textContent = 'nothing to start from yet'; return; }
  const say = rows => `<table class=plan>${rows.map(([k, v]) =>
    `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`;

  if (!tune) {
    el.innerHTML = say([
      ['varies', `<b>${p.base}</b>'s settings <span class=note>${p.why}</span>`],
      ['judged on', `pages ${p.pages.join(', ')} <span class=note>nothing is
        labelled on them</span>`],
    ]);
    return;
  }
  /* One entry a photograph, with its line numbers -- the filename once
     instead of once per line. */
  const by = {};
  for (const l of p.judge_lines || []) (by[l.photo] = by[l.photo] || []).push(l.line);
  const where = Object.keys(by).map(f =>
    `${f.replace(/\.[^.]+$/, '')} <span class=note>line${
      by[f].length > 1 ? 's' : ''} ${by[f].join(', ')}</span>`).join('<br>')
    || 'nothing confirmed';
  el.innerHTML = say([
    ['varies', `<b>${p.base}</b>'s settings <span class=note>${p.why}</span>`],
    ['fine-tunes', `with <b>${p.tune_base || '—'}</b>'s, on ${p.trains_on}
      confirmed line${p.trains_on === 1 ? '' : 's'}`],
    ['judged on', `${p.judges_on} held back<br>${where}`],
  ]);
}

/* What the first round will actually run with, read-only. A search picks these
   up from the model it starts from and then moves them itself, so a box you
   could type into would be a box that gets overwritten a minute later -- which
   is worse than no box. Shown, not offered. */
const SETTING_NAMES = {
  steps: 'steps', batch: 'crops per step', lr: 'learning rate',
  width: 'width', decay: 'weight decay',
  scale: 'scale ±', rotate: 'rotate °', spread: 'ink spread',
  t_steps: 'steps', t_batch: 'crops per step', t_lr: 'learning rate',
  t_share: 'real share', t_rotate: 'rotate °', t_scale: 'scale ±',
};

async function drawSearchSettings() {
  const tune = $('#tatune').checked;
  const p = await get(`/autotrain/plan?tune=${tune ? 1 : 0}` +
                      `&judge=${$('#tajudge').value}`);
  const st = p.settings || {};
  if (!Object.keys(st).length) { $('#t-auto').innerHTML = ''; return; }
  const group = (title, keys) => `<section class=group><h3>${title}</h3>
    <table class=plan>${keys.filter(k => st[k] !== undefined).map(k =>
      `<tr><th>${SETTING_NAMES[k]}</th><td>${st[k]}</td></tr>`).join('')}</table>
    </section>`;
  $('#t-auto').innerHTML =
    group(`training, from ${p.base}`,
          ['steps', 'batch', 'lr', 'width', 'decay']) +
    group('shaking each word', ['scale', 'rotate', 'spread']) +
    (tune ? group(`fine-tuning, from ${p.tune_base || '—'}`,
                  ['t_steps', 't_lr', 't_share', 't_rotate', 't_scale']) : '');
}

/* Training, fine-tuning and searching all start something and come back at
   once; the panel says how it is going, and the same button stops it.
   Stopping keeps whatever has been trained so far. */
async function doTrain() {
  const [j, sr] = await Promise.all([get('/train/status'), get('/autotrain')]);
  if (j.going) { await post('/train/stop'); drawAuto(); return; }
  if (sr.going) { await post('/autotrain/stop'); drawAuto(); return; }
  if (isSearch()) return doAuto();
  const tune = $('#tmode').value === 'tune';
  const q = tune
    ? `/tune?base=${encodeURIComponent($('#fbase').value)}` +
      `&steps=${$('#fsteps').value}&lr=${$('#flr').value}&share=${$('#fshare').value}` +
      `&batch=${$('#fbatch').value}&rotate=${$('#frot').value}` +
      `&scale=${$('#fscale').value}&seed=${$('#fseed').value}` +
      `&freeze=${$('#ffreeze').checked ? 1 : 0}`
    : `/train?steps=${$('#tsteps').value}&scale=${$('#tscale').value}` +
      `&rotate=${$('#trot').value}&spread=${$('#tspread').value}` +
      `&batch=${$('#tbatch').value}&lr=${$('#tlr').value}` +
      `&width=${$('#twidth').value}&decay=${$('#tdecay').value}` +
      `&seed=${$('#tseed').value}&holdout=${$('#tholdout').value}`;
  if (tune && !$('#fbase').value) { $('#tst').textContent = 'choose a model to start from'; return; }
  const r = await post(q);
  if (r.error) { $('#tst').textContent = 'that did not start'; fail($('#tout'), r.error); return; }
  drawAuto();
}

/* ---- training on its own -------------------------------------------------
 *
 * Take the best model's settings, nudge two of them, train, score on pages it
 * has never seen, keep it only if it wins by more than the difference between
 * two runs of the same settings. Losers are deleted -- a checkpoint is two
 * megabytes and a search makes dozens of them.
 */
/* How often to ask how a run is getting on. Thirty seconds, not two: a step
   takes about a second and a run takes a quarter of an hour, so asking every
   two seconds was four hundred requests to watch a number climb. The button
   counts down to the next one and refreshes immediately if pressed, so
   nothing is ever more than a click away from up to date. */
const POLL_EVERY = 30;
let AUTOWATCH = null;      // the once-a-second ticker, only while something runs
let NEXT_POLL = 0;         // seconds left until the next ask

/* What a run in progress looks like. The same shape whether it is one model
   being trained or a search working through candidates, because from here
   they are the same thing: something is happening and it can be stopped. */
function jobPanel(j) {
  if (!j.going && !j.note) return '';
  const bar = j.steps
    ? `<div class=meter><i style="width:${100 * j.step / j.steps}%"></i></div>` : '';
  return `<div class=verdict>
    ${j.going ? '<span class=spin></span> ' : ''}<b>${j.what || ''}</b>
    <span class=note>${j.note || ''}${j.loss !== null && j.loss !== undefined
      ? ` · loss ${j.loss}` : ''}${j.seconds ? ` · ${j.seconds}s` : ''}</span>
    ${bar}</div>`;
}

function autoPanel(s) {
  if (!s.started) return '';
  const two = s.with_tune;
  const cell = (v, on) => v === undefined || v === null ? '<td>—</td>'
    : `<td class="${on ? 'good' : ''}">${pct(v)}</td>`;
  const rows = (s.log || []).map(r => `<tr>
    <td>${r.round}</td>
    <th>${r.digital || ''}${r.physical ? ` → ${r.physical}` : ''}</th>
    ${cell(r.score_digital, r.kept && s.judge_by === 'digital')}
    ${two ? cell(r.score_physical, r.kept && s.judge_by === 'physical') : ''}
    <td class=note>${r.changed}</td>
    <td>${r.kept ? 'best so far' : 'kept, beaten'}</td></tr>`).join('');
  return `<div class=verdict>
      ${s.going ? '<span class=spin></span> ' : ''}
      <b>${s.best ? `${s.best.digital}${s.best.physical ? ` → ${s.best.physical}` : ''}
        — ${pct(s.best.score)}` : '…'}</b>
      <span class=note>· round ${s.round} of ${s.rounds}
        · ${s.since} since a win, gives up at ${s.patience}
        · judged by ${s.judge_by === 'physical' ? 'the photograph' : 'digital'}
        ${s.why ? `· from ${s.baseline}, because ${s.why}` : ''}</span>
      <div class=note>${s.note || ''}</div>
    </div>
    <table class="working under"><caption>every candidate — all of them kept,
      because a score is a thing we built and could have built wrong</caption>
      <tr><td></td><th>model</th><td>digital</td>${two ? '<td>photo</td>' : ''}
        <td>changed</td><td></td></tr>
      ${rows}</table>`;
}

/* The search as arithmetic. A picture tells you what a model did to a page;
   whether a search meant anything is numbers -- how far apart the scores were,
   whether the gaps beat the noise between two seeds, whether the two judges
   agreed, how small the sample the winner was picked on. The things that would
   make the answer not mean what it looks like are said outright at the top
   rather than left to be noticed. */
async function drawReport() {
  const r = await get('/autotrain/report');
  if (r.error) return '';
  const n = v => v === null || v === undefined ? '—' : v;
  const g = v => v === null || v === undefined ? '—' : pct(v);
  const rows = r.rows.map(x => `<tr class="${x.kept ? '' : 'beaten'}">
    <td>${x.round || '—'}</td>
    <th>${x.digital_model || ''}${x.physical_model ? ` → ${x.physical_model}` : ''}</th>
    <td>${g(x.digital)}</td><td>${g(x.physical)}</td>
    <td>${x.vs_baseline === null ? '—'
      : (x.vs_baseline >= 0 ? '+' : '') + (100 * x.vs_baseline).toFixed(2) + '%'}</td>
    <td class=note>${x.changed || ''}</td>
    <td>${x.kept ? 'best so far' : ''}</td></tr>`).join('');
  return `<h2>the numbers</h2>
    ${r.concerns.length ? `<div class="verdict warnbox">
      <b>what would make this mean less than it looks</b>
      <ul>${r.concerns.map(c => `<li>${c}</li>`).join('')}</ul></div>` : ''}
    <table class="working under"><caption>summary</caption>
      <tr><th>judged by</th><td>${r.judge_by}</td></tr>
      <tr><th>started from</th><td>${n(r.baseline)}${r.why ? ` — ${r.why}` : ''}</td></tr>
      <tr><th>rounds</th><td>${r.rounds}, of which ${r.wins} won</td></tr>
      <tr><th>baseline → best</th><td>${g(r.baseline_score)} → ${g(r.best_score)}
        ${r.gained === null ? '' : `(${r.gained >= 0 ? '+' : ''}${(100 * r.gained).toFixed(2)}%)`}</td></tr>
      <tr><th>spread of all scores</th><td>${(100 * r.spread).toFixed(2)}%
        <span class=note>a win must beat 0.50%</span></td></tr>
      <tr><th>winning margins</th><td>${r.win_margins.length
        ? r.win_margins.map(m => (100 * m).toFixed(2) + '%').join(', ') : '—'}</td></tr>
      <tr><th>do the two judges agree</th><td>${r.agreement === null
        ? 'too few to say' : `tau ${r.agreement} `
          + (r.agreement > 0.5 ? '(they rank alike)'
             : r.agreement < 0 ? '(they disagree)' : '(little relation)')}</td></tr>
      ${r.judged_on_lines ? `<tr><th>judged on</th><td>${r.judged_on_lines} confirmed
        lines from ${r.judged_on_photos.join(', ') || '—'}</td></tr>` : ''}
      ${r.pages ? `<tr><th>digital pages</th><td>${r.pages.join(', ')}</td></tr>` : ''}
    </table>
    <table class="working under"><caption>every round</caption>
      <tr><td>#</td><th>model</th><td>digital</td><td>photo</td><td>vs start</td>
          <td>changed</td><td></td></tr>${rows}</table>`;
}

async function drawAuto() {
  const [s, j] = await Promise.all([get('/autotrain'), get('/train/status')]);
  $('#tout').innerHTML = jobPanel(j) + autoPanel(s);
  const busy = s.going || j.going;
  nameTrainButton(busy);
  show($('#tpoll'), busy);
  if (!busy && AUTOWATCH) {
    clearInterval(AUTOWATCH); AUTOWATCH = null; loadModels(); drawState();
    // a search that has finished is worth reading as numbers
    if ((s.log || []).length) $('#tout').innerHTML += await drawReport();
  }
  if (busy && !AUTOWATCH) startPolling();
  return { search: s, job: j };
}

function startPolling() {
  NEXT_POLL = POLL_EVERY;
  $('#tpoll').textContent = `Refresh (${NEXT_POLL}s)`;
  AUTOWATCH = setInterval(() => {
    NEXT_POLL -= 1;
    if (NEXT_POLL <= 0) { NEXT_POLL = POLL_EVERY; drawAuto(); }
    $('#tpoll').textContent = `Refresh (${NEXT_POLL}s)`;
  }, 1000);
}

async function doAuto() {
  const r = await post(`/autotrain?rounds=${$('#tarounds').value}` +
                       `&patience=${$('#tapat').value}` +
                       `&tune=${$('#tatune').checked ? 1 : 0}` +
                       `&judge=${$('#tajudge').value}`);
  if (r.error) { $('#tst').textContent = r.error; fail($('#tout'), r.error); return; }
  $('#tst').textContent = 'searching…';
  drawAuto();
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
  if (!$('#fkey')) return;
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
  drawTunePlan();
  $('#fbox').insertAdjacentHTML('beforeend',
    `<div class=finished><b>Line ${k.line + 1} is confirmed.</b>
       <span class=note>${j.saved} pieces recorded</span>
       ${j.next === null ? '' : `<button class=onward>Line ${j.next + 1} &darr;</button>`}
     </div>`);
  const go = $('#fbox .onward');
  if (go) go.onclick = () => { $('#fline').value = j.next; doBand(); };
  $('#fst').textContent = `line ${k.line + 1} confirmed`;
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
    <tr><th><input type=checkbox id=lallbox title="all of them"></th>
        <th>page</th><th>word</th><th>marks</th><th>spelled</th>
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
/* Which pages have labels. Kept for the counts, not for a picker: the box
   takes any of the 604 and the table has a page column, so a second list of
   them was answering a question nobody had to ask. */
let PAGES = null;
function fillPages(j) { PAGES = j; }

/* Two of these can be in the air at once -- changing the mode and the page in
   quick succession starts a second before the first is back -- and the slower
   one used to paint over the newer. Each run takes a ticket; stale ones stop. */
let LABELRUN = 0;

const tally = (shown, j) =>
  `${shown.length} of ${j.total} · ${j.total - j.agree} off the spelling` +
  `${j.harvested ? ` · ${j.harvested} harvested` : ''}`;

/* Selecting all of what is shown, with the filters deciding what that is, is
   how a whole page gets deleted -- and a whole page of mismatches, and one
   photograph's worth. A button per case would have been three buttons and
   still not the case you wanted. */
function ticked(el) {
  return [...el.querySelectorAll('.lpick:checked')].map(c =>
    c.closest('[data-key]').dataset.key);
}

function countTicks(el) {
  const n = ticked(el).length;
  const b = $('#ldel');
  b.disabled = !n;
  b.textContent = n ? `Delete ${n}` : 'Delete';
  if (!b.dataset.armed) b.classList.remove('arm');
  delete b.dataset.armed;
  const box = $('#lallbox');
  if (box) box.checked = n > 0 && n === el.querySelectorAll('.lpick').length;
  return n;
}

function selectAll(el, on) {
  el.querySelectorAll('.lpick').forEach(c => { c.checked = on; });
  countTicks(el);
}

function wireTicks(el) {
  el.querySelectorAll('.lpick').forEach(c => { c.onchange = () => countTicks(el); });
  const box = $('#lallbox');
  if (box) box.onchange = () => selectAll(el, box.checked);
  countTicks(el);
}

/* Which page is being asked for. The page view reads its own number box, the
   lists read the select of pages that have labels -- and an empty selection
   there means every page, which is not a page at all. */
function pageWanted() {
  return $('#lwhat').value === 'page'
    ? Math.min(604, Math.max(1, +$('#lpage').value || 1))
    : (+$('#lpage').value || 0);
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
      if (HELPER) { $('#lgo').disabled = false; return doReview(true); }
      /* A page at a time, painted by the labels. The gallery is right for
         judging one label and cannot show what is missing; this is the other
         half of the same question -- everything unlabelled stays pale, so
         coverage and correctness are one picture. */
      const n = pageWanted();
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
      const page = pageWanted();
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
              data-all="${j.per_page[n]}">Delete page</button>
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
  $('#lst').textContent = `${j.deleted} deleted · the copy before this is in labels.json.last`;
  $('#ldel').textContent = 'Delete';
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
/* A table, not a stack of cards. Six models each given the full width of the
   window cannot be read against each other, and reading them against each
   other is the only reason to look at more than one.
 *
 * The column that matters most is where each came from. Every model here is
 * descended from another -- trained with a variation on its settings, or
 * fine-tuned out of it -- and a search makes that a real family tree. Without
 * it a list of names says nothing about which experiment any of them belongs
 * to. */
/* A score, and whether it was measured under the counting rule in force now.
   One measured under an older one is not wrong so much as answering a
   different question, and shown plainly next to a current one it would be
   read as comparable. */
function scoreOn(m, kind) {
  const t = m.tests || {};
  const k = Object.keys(t).find(x => x.startsWith(kind === 'photo' ? 'photo:' : 'page:'));
  if (!k) return null;
  return { value: t[k].agreement, stale: (m.stale_tests || []).includes(k) };
}

function modelRow(m) {
  const d = scoreOn(m, 'page'), p = scoreOn(m, 'photo');
  const marks = (m.best || []).map(j =>
    `<span class=done-tag>${j === 'real' ? 'photo' : 'digital'}</span>`).join(' ');
  /* The whole line of descent, nearest first: "v3 ← v2 ← v1" says this came
     out of v2, which came out of v1. Falls back to the immediate parent,
     which is all an older server sends. */
  const from = (m.ancestry || (m.parent ? [m.parent] : [])).join(' ← ');
  const j = m.jitter || {};
  const held = m.held_out;
  const n = v => (v === null || v === undefined) ? '—' : v;
  const g = v => !v ? '—' : v.stale
    ? `<span class=stalescore title="measured under an older way of counting">${pct(v.value)}</span>`
    : pct(v.value);
  return `<tr data-model="${m.name}" class="${m.beaten ? 'beaten' : ''}">
    <th><b>${m.name}</b> ${marks}</th>
    <td class=note>${m.tuned_from ? 'fine-tuned' : 'trained'}</td>
    <td class=note>${from || '—'}</td>
    <td>${n(m.steps)}${m.stopped ? `<span class=fair> of ${m.asked_for}</span>` : ''}</td>
    <td>${m.crops ? m.crops.toLocaleString() : '—'}</td>
    <td>${n(m.batch)}</td>
    <td>${n(m.lr)}</td>
    <td>${n(m.width)}</td>
    <td>${n(m.decay)}</td>
    <td>${n(m.seed)}</td>
    <td>${j.scale || '—'}</td>
    <td>${j.rotate || '—'}</td>
    <td>${j.spread || '—'}</td>
    <td>${n(m.words)}</td>
    <td>${n(m.real_lines)}</td>
    <td>${m.real_share === null || m.real_share === undefined ? '—' : m.real_share}</td>
    <td>${held ? pct(held['ink labelled right']) : '—'}</td>
    <td>${g(d)}</td>
    <td>${g(p)}</td>
    <td>${n(m['size kb'])}</td>
    <td class=note>${m.trained || ''}</td>
    <td><button class="quiet mbest" data-job=type>digital</button>
        <button class="quiet mbest" data-job=real>photo</button></td>
    <td><button class="quiet mdrop">Delete</button></td>
  </tr>`;
}

/* Ordered by descent: a model comes straight after whatever it came out of,
   so a search's family reads as one block. The order does the grouping and
   the "from" column says what the relation is. */
function inDescentOrder(list) {
  const byName = Object.fromEntries(list.map(m => [m.name, m]));
  const kids = {};
  for (const m of list) (kids[m.parent || ''] = kids[m.parent || ''] || []).push(m);
  const out = [];
  const walk = parent => {
    for (const m of kids[parent] || []) { out.push(m); walk(m.name); }
  };
  walk('');
  for (const m of list) if (!out.includes(m)) out.push(m);
  return out;
}

async function doModels() {
  const el = $('#models');
  el.innerHTML = '<div class=loading><span class=spin></span>reading the cards</div>';
  try {
    const j = await get('/models');
    // in a grid, not one card per screen-width: a card is a short list of
     // facts and giving each the full window makes four models unreadable
     // together, which is the only way they are worth reading at all
    const rows = inDescentOrder(j.models || []);
    el.innerHTML = rows.length
      ? `<div class=wide><table class="working sticky models">
          <tr><th>model</th><td>how</td><td>from</td><td>steps</td><td>crops</td>
              <td>batch</td><td>rate</td><td>width</td><td>decay</td><td>seed</td>
              <td title="how much each word is resized, give or take">scale&nbsp;±</td>
              <td title="how far each word is turned, in degrees">rotate&nbsp;°</td>
              <td title="how often the strokes are thickened, as a press does">spread</td>
              <td>words</td><td>lines</td><td>real&nbsp;share</td>
              <td title="of the words held back from training">held&nbsp;out</td>
              <td>digital</td><td>photo</td><td>KB</td><td>when</td>
              <td>best&nbsp;at</td><td></td></tr>
          ${rows.map(modelRow).join('')}</table></div>`
      : '<div class=idle>Nothing trained yet.</div>';
    /* Two clicks, because this one really does go: the checkpoint is deleted
       and no amount of re-running gets the same weights back. Everything else
       in the table can be worked out again; a model cannot. */
    el.querySelectorAll('.mdrop').forEach(b => {
      b.onclick = async () => {
        const name = b.closest('[data-model]').dataset.model;
        if (!b.dataset.armed) {
          el.querySelectorAll('.mdrop').forEach(o => {
            delete o.dataset.armed; o.textContent = 'Delete'; o.classList.remove('arm');
          });
          b.dataset.armed = '1';
          b.classList.add('arm');
          b.textContent = `Delete ${name}?`;
          setTimeout(() => {
            if (!b.dataset.armed) return;
            delete b.dataset.armed;
            b.classList.remove('arm');
            b.textContent = 'Delete';
          }, 5000);
          return;
        }
        b.disabled = true;
        const r = await post(`/model/forget?name=${encodeURIComponent(name)}`);
        if (r.error) { $('#mst').textContent = 'that did not delete'; b.disabled = false; return; }
        MODELS = r.models;
        $('#mst').textContent = `${name} deleted`;
        doModels(); loadModels(); drawState();
      };
    });
    el.querySelectorAll('.mbest').forEach(b => {
      b.onclick = async () => {
        const name = b.closest('[data-model]').dataset.model;
        const job = b.dataset.job === 'type' ? 'digital' : 'real';
        const row = MODELS.find(m => m.name === name);
        const on = !(row && (row.best || []).includes(job));
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
  /* Anything that costs a request and no arithmetic shows itself. Only the
     views that take half a minute of convolution wait to be asked. */
  if (view.open) view.open();
}


document.querySelectorAll('.tab').forEach(t => { t.onclick = () => choose(t.dataset.v); });
$('#lbest').onclick = () => {
  const m = helper();
  if (!m) return;
  HELPER = HELPER ? '' : m.name;
  show($('#lharvestwrap'), !!HELPER);
  drawHelp();
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
$('#tpoll').onclick = () => { NEXT_POLL = POLL_EVERY; drawAuto(); };
$('#tsteps').oninput = drawPlan;
$('#tbatch').oninput = drawPlan;

$('#lgo').onclick = doLabels;
$('#lwhat').onchange = () => {
  // a page number and a spelling to disagree with are both things only the
  // type has; a photograph's lines have neither
  const kind = $('#lwhat').value;
  const list = kind === 'type' || kind === 'table';
  const page = kind === 'page';
  if (page && !$('#lpage').value) $('#lpage').value = 1;   // a page must be one
  if (list) $('#lpage').value = '';                        // a list is all of them
  show($('#lpagewrap'), kind !== 'real');   // a photograph has no page number
  show($('#loddwrap'), list);               // nor a spelling to disagree with
  show($('#lall'), !page);                  // nothing to tick on a page
  show($('#ldel'), !page);
  show($('#lharvestwrap'), page && !!HELPER);
  show($('#lcolours'), page);
  drawHelp();
  doLabels();
};
$('#lodd').onchange = doLabels;
$('#lpage').onchange = doLabels;

$('#lprev').onclick = () => step(-1);
$('#lnext').onclick = () => step(1);
/* A handful goes at once; a bulk delete asks. The line is where a slip stops
   being a slip -- undoing five clicks is a minute, undoing a hundred labels is
   an afternoon and there is nothing here that can do it for you. */
const ASKS_ABOVE = 5;
$('#ldel').onclick = () => {
  const el = $('#labels');
  const keys = ticked(el);
  if (!keys.length) return;
  const b = $('#ldel');
  if (keys.length > ASKS_ABOVE && !b.dataset.armed) {
    b.dataset.armed = '1';
    b.classList.add('arm');
    b.textContent = `Delete ${keys.length}?`;
    setTimeout(() => {
      if (b.dataset.armed) { delete b.dataset.armed; countTicks(el); }
    }, 5000);
    return;
  }
  delete b.dataset.armed;
  deleteLabels({ keys });
};
$('#lall').onclick = () => {
  const el = $('#labels');
  const all = el.querySelectorAll('.lpick').length;
  selectAll(el, ticked(el).length < all);
};


$('#frank').onclick = rankLines;
$('#tmode').onchange = drawTrainMode;
$('#tatune').onchange = drawTrainMode;
$('#tajudge').onchange = drawTrainMode;
$('#cwhat').onchange = () => {
  const w = $('#cwhat').value;
  show($('#c-type'), w !== 'photo');    // "both" needs the page controls too
  show($('#c-photo'), w !== 'type');
};
$('#cgo').onclick = doCompare;
$('#conly').onchange = () => { if ($('#cwhat').value === 'type') doCompare(); };

/* A line in the rail saying what there is, so the numbers that matter are on
   screen without opening the view that owns them. */
/* Whether the running server is older than the code on disk. Python changes
   need a restart and static files do not, so the two drift apart quietly and
   the symptom is never "restart me" -- it is a column that went blank or a
   button that does nothing. Better to say it. */
async function checkStale() {
  try {
    const h = await get('/health');
    const bar = $('#stale');
    if (!h.stale) { if (bar) bar.remove(); return; }
    if (!bar) {
      document.querySelector('.viewhead').insertAdjacentHTML('afterbegin',
        `<div class=stale id=stale>The server is running code from before
         ${h.changed.join(', ')} changed. Restart it to pick them up.</div>`);
    }
  } catch (e) { /* an old server has no /health, which is itself the answer */
    if (!$('#stale')) document.querySelector('.viewhead').insertAdjacentHTML('afterbegin',
      '<div class=stale id=stale>The server is running older code. Restart it.</div>');
  }
}

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
  idle('#labels', 'Choose a page and press <b>Show</b>.');
  await loadModels();
  try {
    const ph = await get('/photos');
    const opts = (ph.photos || []).map(f => `<option value="${f}">${f}</option>`).join('');
    for (const id of ['#ff', '#cpf', '#mpf']) {
      $(id).innerHTML = opts || '<option value="">nothing in PhysicalQuran/</option>';
    }
  } catch (e) { /* no photographs is not a problem */ }
  drawFineKey();
  drawHelp();
  drawTrainMode();
  addHelpMarks();
  await drawPlan();
  drawState();
  checkStale();
  try {
    const c = await get('/checked');
    if (c.count) {
      $('#lpage').value = c.resume;
      $('#lst').textContent = `${c.count} pages checked · next is ${c.resume}`;
    }
  } catch (e) { /* no record yet is not a problem */ }
})();
