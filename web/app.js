// DOM helpers
const $ = id => document.getElementById(id);
const show = el => el.classList.remove('d-none');
const hide = el => el.classList.add('d-none');

// Escape HTML for safe innerHTML insertion
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Escape HTML attribute values (escapeHtml + quotes)
const escapeAttr = s => escapeHtml(s).replaceAll('"', '&quot;');

// Generic JSON fetch — throws on non-ok with parsed error code
async function fetchJSON(url, { method = 'GET', body, headers = {} } = {}) {
  const options = { method, headers: { ...headers } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error('Request failed'), { code: data.err });
  return data;
}

// State
const state = {
  matches: [],
  scores: {},       // { index: [scoreA, scoreB] } — set only when both inputs are valid ints
  submitted: new Set(),
  pendingIndices() {
    return Object.keys(this.scores).map(Number).filter(i => !this.submitted.has(i));
  },
};

// Auth
const getToken = () => localStorage.getItem('ups_token');
const saveToken = token => localStorage.setItem('ups_token', token);

// Validation
const isValidScore = value => /^\d+$/.test(value.trim());

// Submit-all button visibility
function updateSubmitAll() {
  const count = state.pendingIndices().length;
  $('submit-all-count').textContent = count;
  const visible = count > 0;
  $('submit-all-container').classList.toggle('d-none', !visible);
  $('main').classList.toggle('pb-5', visible);
}

// Per-card score validation and state sync
function updateCardState(card, index) {
  const [a, b] = card.querySelectorAll('.score-input');
  const valid = isValidScore(a.value) && isValidScore(b.value);
  if (valid) {
    state.scores[index] = [parseInt(a.value, 10), parseInt(b.value, 10)];
  } else {
    delete state.scores[index];
  }
  updateSubmitAll();
}

// Prediction row template
const predictionRowHTML = p =>
  `<div class="d-flex justify-content-between align-items-baseline gap-3 py-1">
    <span class="small text-truncate">${escapeHtml(p.name)}</span>
    <span class="small fw-semibold text-secondary text-nowrap flex-shrink-0">${p.score_a} : ${p.score_b}</span>
  </div>`;

// Predictions panel toggle
async function togglePredictions(matchId, panel, btn) {
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    btn.classList.remove('open');
    return;
  }

  btn.classList.add('open');
  panel.classList.add('open');
  const inner = panel.querySelector('.predictions-inner');
  inner.innerHTML = '<p class="text-secondary small text-center my-2">Loading…</p>';

  try {
    const predictions = await fetchJSON(`/api/predictions/${matchId}`);
    inner.innerHTML = predictions.length
      ? predictions.map(predictionRowHTML).join('')
      : '<p class="text-secondary small text-center my-2">No predictions yet.</p>';
  } catch {
    inner.innerHTML = '<p class="text-danger small text-center my-2">Failed to load.</p>';
  }
}

// Card creation
function createCard(match, index) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.index = index;

  card.innerHTML = `
    <div class="card-body">
      <div class="team-row">
        ${match.logo_a ? `<img src="${escapeAttr(match.logo_a)}" class="team-logo" alt="">` : ''}
        <span class="team-name fw-semibold small">${escapeHtml(match.team_a)}</span>
        <input type="text" class="form-control score-input" data-side="0" inputmode="numeric" placeholder="0">
      </div>
      <div class="team-row mt-1">
        ${match.logo_b ? `<img src="${escapeAttr(match.logo_b)}" class="team-logo" alt="">` : ''}
        <span class="team-name fw-semibold small">${escapeHtml(match.team_b)}</span>
        <input type="text" class="form-control score-input" data-side="1" inputmode="numeric" placeholder="0">
      </div>
      <button class="toggle-btn" aria-label="Show predictions"></button>
      <div class="predictions-panel"><div class="predictions-inner"></div></div>
    </div>
  `;

  const toggleBtn = card.querySelector('.toggle-btn');
  const panel = card.querySelector('.predictions-panel');
  toggleBtn.addEventListener('click', () => togglePredictions(match.id, panel, toggleBtn));
  card.querySelectorAll('.score-input').forEach(input =>
    input.addEventListener('input', () => updateCardState(card, index))
  );

  return card;
}

function sectionOrder(a, b) {
  const pa = a.split('/'), pb = b.split('/');

  // Last segment: higher numbers first
  const lastA = pa.at(-1) ?? '', lastB = pb.at(-1) ?? '';
  const numA = parseInt(lastA.match(/\d+/)?.[0], 10);
  const numB = parseInt(lastB.match(/\d+/)?.[0], 10);
  const lastCmp = (!isNaN(numA) && !isNaN(numB)) ? numB - numA : lastB.localeCompare(lastA);
  if (lastCmp !== 0) return lastCmp;

  // First segment: Erste < Zweite < Dritte
  const ligaRank = s => ({ Erste: 0, Zweite: 1, Dritte: 2 }[s.split(' ')[0]] ?? 99);
  const firstCmp = ligaRank(pa[0] ?? '') - ligaRank(pb[0] ?? '');
  if (firstCmp !== 0) return firstCmp;

  // Second segment: alphabetical
  return (pa[1] ?? '').localeCompare(pb[1] ?? '');
}

function renderGrid(matches) {
  state.matches = matches;
  const grid = $('grid');
  grid.innerHTML = '';

  const groups = new Map();
  matches.forEach((match, i) => {
    const sec = match.section ?? '';
    if (!groups.has(sec)) groups.set(sec, []);
    groups.get(sec).push([match, i]);
  });

  [...groups.keys()].sort(sectionOrder).forEach((sec, si) => {
    if (si > 0) {
      const hr = document.createElement('div');
      hr.className = 'section-divider';
      grid.appendChild(hr);
    }
    if (sec) {
      const h = document.createElement('div');
      h.className = 'section-header';
      h.textContent = sec;
      grid.appendChild(h);
    }
    groups.get(sec).forEach(([match, i]) => grid.appendChild(createCard(match, i)));
  });
}

// Mark a card as submitted: lock inputs, show checkmark
function markSubmitted(index) {
  state.submitted.add(index);
  delete state.scores[index];

  const card = document.querySelector(`.card[data-index="${index}"]`);
  if (!card) return;

  card.querySelectorAll('.score-input').forEach(input => { input.disabled = true; });
  if (!card.querySelector('.submitted-badge')) {
    card.querySelector('.toggle-btn').insertAdjacentElement('afterend',
      Object.assign(document.createElement('span'), {
        className: 'submitted-badge text-success small',
        textContent: '✓',
      })
    );
  }

  updateSubmitAll();
}

// Name modal
const nameModal = {
  _resolve: null,

  prompt(errorMsg = null) {
    return new Promise(resolve => {
      this._resolve = resolve;
      const input = $('name-input');
      const error = $('modal-error');
      input.value = '';
      error.textContent = errorMsg ?? '';
      error.classList.toggle('d-none', !errorMsg);
      show($('name-modal'));
      if (errorMsg) {
        input.classList.remove('shake');
        void input.offsetWidth;
        input.classList.add('shake');
      }
      input.focus();
    });
  },

  resolve(result) {
    this._resolve?.(result);
    this._resolve = null;
  },

  close(result) {
    hide($('name-modal'));
    this.resolve(result);
  },
};

// API
async function submitPredictions(predictions, name) {
  const token = getToken();
  const body = token ? { predictions } : { predictions, name };
  const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
  const data = await fetchJSON('/api/submit', { method: 'POST', body, headers });
  if (data.token) { saveToken(data.token); loadCurrentUser(); }
}

// Core submission
async function doSubmit(indices) {
  const predictions = indices.map(i => ({
    id: state.matches[i].id,
    score_a: state.scores[i][0],
    score_b: state.scores[i][1],
  }));

  if (getToken()) {
    try {
      await submitPredictions(predictions, null);
      indices.forEach(markSubmitted);
    } catch {
      alert('Submission failed. Please try again.');
    }
    return;
  }

  let name = await nameModal.prompt();
  if (!name) return;

  while (true) {
    try {
      await submitPredictions(predictions, name);
      nameModal.close(null);
      indices.forEach(markSubmitted);
      return;
    } catch (e) {
      if (e.code === 'AccountExists') {
        name = await nameModal.prompt('That name is already taken. Please choose another.');
        if (!name) return;
      } else {
        nameModal.close(null);
        alert('Submission failed. Please try again.');
        return;
      }
    }
  }
}

async function loadPastPredictions() {
  const token = getToken();
  if (!token) return;
  try {
    const predictions = await fetchJSON('/api/predictions/me', { headers: { 'Authorization': `Bearer ${token}` } });
    predictions.forEach(p => {
      const index = state.matches.findIndex(m => m.id === p.id);
      if (index === -1) return;
      const card = document.querySelector(`.card[data-index="${index}"]`);
      if (!card) return;
      const [a, b] = card.querySelectorAll('.score-input');
      a.value = p.score_a;
      b.value = p.score_b;
      markSubmitted(index);
    });
  } catch {
    // past predictions are non-critical — fail silently
  }
}

async function loadCurrentUser() {
  const token = getToken();
  if (!token) return;
  try {
    const data = await fetchJSON('/api/me', { headers: { 'Authorization': `Bearer ${token}` } });
    $('user-name').textContent = data.name;
    $('user-menu').classList.remove('d-none');
  } catch {
    // non-critical — fail silently
  }
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
  $('save-image-btn').addEventListener('click', async () => {
    // Collect elements belonging to sections with no submitted predictions
    const toHide = [];
    let sectionEls = [], hasSubmitted = false;
    const flush = () => {
      if (sectionEls.length && !hasSubmitted) toHide.push(...sectionEls);
      sectionEls = []; hasSubmitted = false;
    };
    for (const el of $('grid').children) {
      if (el.classList.contains('section-divider')) { flush(); sectionEls.push(el); }
      else if (el.classList.contains('section-header')) { sectionEls.push(el); }
      else { sectionEls.push(el); const i = +el.dataset.index; if (i in state.scores || state.submitted.has(i)) hasSubmitted = true; }
    }
    flush();

    toHide.forEach(el => { el.style.display = 'none'; });
    try {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bs-body-bg').trim();
      const canvas = await html2canvas($('grid'), { backgroundColor: bg, scale: window.devicePixelRatio, proxy: '/api/proxy', useCORS: false });
      const pad = 16 * window.devicePixelRatio;
      const padded = document.createElement('canvas');
      padded.width = canvas.width + pad * 2;
      padded.height = canvas.height + pad * 2;
      const ctx = padded.getContext('2d');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, padded.width, padded.height);
      ctx.drawImage(canvas, pad, pad);
      try {
        const wm = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = '/pulow.png';
        });
        const wmH = 32 * window.devicePixelRatio;
        const wmW = (wm.naturalWidth / wm.naturalHeight) * wmH;
        ctx.globalAlpha = 0.5;
        ctx.drawImage(wm, padded.width - wmW - pad / 2, padded.height - wmH - pad / 2, wmW, wmH);
        ctx.globalAlpha = 1;
      } catch { /* watermark is non-critical */ }
      Object.assign(document.createElement('a'), {
        download: 'predictions.png',
        href: padded.toDataURL('image/png'),
      }).click();
    } finally {
      toHide.forEach(el => { el.style.display = ''; });
    }
  });

  $('submit-all-btn').addEventListener('click', () => doSubmit(state.pendingIndices()));
  $('modal-submit').addEventListener('click', () => {
    const name = $('name-input').value.trim();
    if (name) nameModal.resolve(name);
  });
  $('modal-cancel').addEventListener('click', () => nameModal.close(null));
  $('name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const name = $('name-input').value.trim();
      if (name) nameModal.resolve(name);
    }
  });

  $('user-btn').addEventListener('click', e => {
    e.stopPropagation();
    $('user-dropdown').classList.toggle('d-none');
  });
  $('logout-btn').addEventListener('click', () => {
    $('user-dropdown').classList.add('d-none');
    show($('logout-modal'));
  });
  $('logout-cancel').addEventListener('click', () => hide($('logout-modal')));
  $('logout-confirm').addEventListener('click', () => {
    localStorage.removeItem('ups_token');
    hide($('logout-modal'));
    $('user-menu').classList.add('d-none');
  });
  document.addEventListener('click', () => $('user-dropdown').classList.add('d-none'));

  try {
    const matches = await fetchJSON('/api/matches');
    renderGrid(matches);
    await loadPastPredictions();
  } catch {
    $('grid').innerHTML = '<p class="text-secondary text-center py-5">Failed to load matches. Please refresh.</p>';
  }
  loadCurrentUser();
});
