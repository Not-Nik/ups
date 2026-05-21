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
async function fetchJSON(url, {method = 'GET', body, headers = {}} = {}) {
    const options = {method, headers: {...headers}};
    if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error('Request failed'), {code: data.err});
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
const predictionClass = (predicted, actual) =>
    predicted > actual ? 'prediction-high' : predicted < actual ? 'prediction-low' : 'prediction-exact';

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

    const hasFinal = match.score_a != null && match.score_b != null;
    const clrA = hasFinal ? (match.score_a > match.score_b ? 'text-success' : match.score_a < match.score_b ? 'text-danger' : '') : '';
    const clrB = hasFinal ? (match.score_b > match.score_a ? 'text-success' : match.score_b < match.score_a ? 'text-danger' : '') : '';

    card.innerHTML = `
    <div class="card-body">
      <div class="team-row">
        ${match.logo_a ? `<img src="${escapeAttr(match.logo_a)}" class="team-logo" alt="">` : ''}
        <span class="team-name fw-semibold small ${clrA}">${escapeHtml(match.team_a)}</span>
        <input type="text" class="form-control score-input" data-side="0" inputmode="numeric" placeholder="0">
        ${match.score_a != null ? `<span class="actual-score small ${clrA || 'text-secondary'}">${match.score_a}</span>` : ''}
      </div>
      <div class="team-row mt-1">
        ${match.logo_b ? `<img src="${escapeAttr(match.logo_b)}" class="team-logo" alt="">` : ''}
        <span class="team-name fw-semibold small ${clrB}">${escapeHtml(match.team_b)}</span>
        <input type="text" class="form-control score-input" data-side="1" inputmode="numeric" placeholder="0">
        ${match.score_b != null ? `<span class="actual-score small ${clrB || 'text-secondary'}">${match.score_b}</span>` : ''}
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
    const ligaRank = s => ({Erste: 0, Zweite: 1, Dritte: 2}[s.split(' ')[0]] ?? 99);
    const firstCmp = ligaRank(pa[0] ?? '') - ligaRank(pb[0] ?? '');
    if (firstCmp !== 0) return firstCmp;

    // Second segment: alphabetical
    return (pa[1] ?? '').localeCompare(pb[1] ?? '');
}

function activateTab(day) {
    $('tabs-bar').querySelectorAll('.tab-btn').forEach(btn => {
        const active = btn.dataset.day === day;
        btn.className = `tab-btn btn btn-sm ${active ? 'btn-secondary' : 'btn-outline-secondary'}`;
    });
    $('grid').querySelectorAll('[data-day]').forEach(el => {
        el.classList.toggle('d-none', el.dataset.day !== day);
    });
}

function renderTabs(days) {
    const bar = $('tabs-bar');
    bar.innerHTML = '';
    days.forEach(day => {
        const btn = document.createElement('button');
        btn.className = 'tab-btn btn btn-sm btn-outline-secondary';
        btn.textContent = day;
        btn.dataset.day = day;
        btn.addEventListener('click', () => activateTab(day));
        bar.appendChild(btn);
    });
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

    const sortedSections = [...groups.keys()].sort(sectionOrder);
    const dayOf = sec => sec.split('/').at(-1) ?? sec;

    const days = [...new Set(sortedSections.map(dayOf))].sort((a, b) => {
        const la = a.replace(/\d+/g, '').trim();
        const lb = b.replace(/\d+/g, '').trim();
        const lCmp = la.localeCompare(lb);
        if (lCmp !== 0) return lCmp;
        const na = parseInt(a.match(/\d+/)?.[0], 10);
        const nb = parseInt(b.match(/\d+/)?.[0], 10);
        return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
    });

    renderTabs(days);

    sortedSections.forEach((sec, si) => {
        const day = dayOf(sec);
        const prevDay = si > 0 ? dayOf(sortedSections[si - 1]) : null;

        if (si > 0 && prevDay === day) {
            const hr = document.createElement('div');
            hr.className = 'section-divider';
            hr.dataset.day = day;
            grid.appendChild(hr);
        }

        if (sec) {
            const h = document.createElement('div');
            h.className = 'section-header';
            h.textContent = sec;
            h.dataset.day = day;
            grid.appendChild(h);
        }

        groups.get(sec).forEach(([match, i]) => {
            const card = createCard(match, i);
            card.dataset.day = day;
            grid.appendChild(card);
        });
    });

    const defaultDay = days.find(day =>
        matches.some(m => dayOf(m.section ?? '') === day && (m.score_a == null || m.score_b == null))
    ) ?? days.at(-1);
    if (defaultDay) activateTab(defaultDay);
}

// Mark a card as submitted: lock inputs, show checkmark
function markSubmitted(index) {
    state.submitted.add(index);
    delete state.scores[index];

    const card = document.querySelector(`.card[data-index="${index}"]`);
    if (!card) return;

    card.querySelectorAll('.score-input').forEach(input => {
        input.disabled = true;
    });
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
    _loginMode: false,

    prompt(errorMsg = null) {
        this._loginMode = false;
        return new Promise(resolve => {
            this._resolve = resolve;
            const input = $('name-input');
            const error = $('modal-error');
            $('modal-title').textContent = 'Who are you?';
            $('modal-subtitle').textContent = 'Enter a name to save your prediction.';
            $('modal-submit').textContent = 'Submit';
            input.disabled = false;
            $('password-input').classList.add('d-none');
            $('modal-actions-1').classList.remove('d-none');
            $('modal-actions-2').classList.add('d-none');
            $('modal-cookie').classList.remove('d-none');
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

    promptLogin() {
        this._loginMode = true;
        return new Promise(resolve => {
            this._resolve = resolve;
            $('modal-title').textContent = 'Log in';
            $('modal-subtitle').textContent = 'Enter your name and password.';
            $('modal-submit').textContent = 'Log in';
            $('modal-error').classList.add('d-none');
            $('modal-submit').disabled = false;
            $('modal-cancel').disabled = false;
            $('name-input').value = '';
            $('name-input').disabled = false;
            $('password-input').value = '';
            $('password-input').classList.remove('d-none');
            $('modal-actions-1').classList.remove('d-none');
            $('modal-actions-2').classList.add('d-none');
            $('modal-cookie').classList.add('d-none');
            show($('name-modal'));
            $('name-input').focus();
        });
    },

    promptPassword(name) {
        return new Promise(resolve => {
            this._resolve = resolve;
            $('modal-title').textContent = 'Set a password?';
            $('modal-subtitle').textContent = 'Optionally protect your account with a password.';
            $('modal-error').classList.add('d-none');
            $('name-input').value = name;
            $('name-input').disabled = true;
            $('password-input').value = '';
            $('password-input').classList.remove('d-none');
            $('modal-actions-1').classList.add('d-none');
            $('modal-actions-2').classList.remove('d-none');
            $('password-submit').disabled = false;
            $('password-skip').disabled = false;
            $('modal-cookie').classList.add('d-none');
            $('password-input').focus();
        });
    },

    resolve(result) {
        this._resolve?.(result);
        this._resolve = null;
    },

    close(result) {
        this._loginMode = false;
        $('modal-submit').textContent = 'Submit';
        hide($('name-modal'));
        this.resolve(result);
    },
};

// API
async function submitPredictions(predictions, name) {
    const token = getToken();
    const body = token ? {predictions} : {predictions, name};
    const headers = token ? {'Authorization': `Bearer ${token}`} : {};
    const data = await fetchJSON('/api/submit', {method: 'POST', body, headers});
    if (data.token) {
        saveToken(data.token);
        loadCurrentUser();
    }
    return !!data.token;
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
            const isNew = await submitPredictions(predictions, name);
            if (isNew) await nameModal.promptPassword(name);
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
        const predictions = await fetchJSON('/api/predictions/me', {headers: {'Authorization': `Bearer ${token}`}});
        predictions.forEach(p => {
            const index = state.matches.findIndex(m => m.id === p.id);
            if (index === -1) return;
            const match = state.matches[index];
            const card = document.querySelector(`.card[data-index="${index}"]`);
            if (!card) return;
            const [a, b] = card.querySelectorAll('.score-input');
            a.value = p.score_a;
            b.value = p.score_b;
            if (match.score_a != null && match.score_b != null) {
                const clsA = predictionClass(p.score_a, match.score_a);
                const clsB = predictionClass(p.score_b, match.score_b);
                const sign = cls => cls === 'prediction-high' ? '>' : cls === 'prediction-low' ? '<' : '=';
                const mkSign = cls => Object.assign(document.createElement('span'), {
                    className: `pred-sign small ${cls}`,
                    textContent: sign(cls),
                });
                a.classList.add(clsA);
                b.classList.add(clsB);
                a.insertAdjacentElement('afterend', mkSign(clsA));
                b.insertAdjacentElement('afterend', mkSign(clsB));
            }
            markSubmitted(index);
        });
    } catch {
        // past predictions are non-critical — fail silently
    }
}

function applyFinalScoreStates() {
    state.matches.forEach((match, index) => {
        if (match.score_a == null || match.score_b == null) return;
        if (state.submitted.has(index)) return;
        const card = document.querySelector(`.card[data-index="${index}"]`);
        if (!card) return;
        card.querySelectorAll('.score-input').forEach(el => el.remove());
    });
}

async function loadCurrentUser() {
    const token = getToken();
    if (!token) return;
    try {
        const data = await fetchJSON('/api/me', {headers: {'Authorization': `Bearer ${token}`}});
        $('user-name').textContent = data.name;
        show($('user-menu'));
        hide($('login-btn'));
    } catch {
        // non-critical — fail silently
    }
}

// Build the list of grid elements to hide before rendering the screenshot.
// Skips tab-hidden elements (d-none), hides whole sections with no predictions,
// and drops dividers that would end up leading the visible content.
function collectImageHides() {
    const toHide = [];
    let sectionEls = [], hasSubmitted = false, anyKept = false;
    const flush = () => {
        if (!sectionEls.length) return;
        if (hasSubmitted) {
            if (!anyKept) {
                while (sectionEls.length && sectionEls[0].classList.contains('section-divider')) {
                    toHide.push(sectionEls.shift());
                }
            }
            anyKept = true;
        } else {
            toHide.push(...sectionEls);
        }
        sectionEls = [];
        hasSubmitted = false;
    };
    for (const el of $('grid').children) {
        if (el.classList.contains('d-none')) continue;
        if (el.classList.contains('section-divider')) {
            flush();
            sectionEls.push(el);
        } else if (el.classList.contains('section-header')) {
            sectionEls.push(el);
        } else {
            sectionEls.push(el);
            const i = +el.dataset.index;
            if (i in state.scores || state.submitted.has(i)) hasSubmitted = true;
        }
    }
    flush();
    return toHide;
}

async function saveImage() {
    const toHide = collectImageHides();
    toHide.forEach(el => { el.style.display = 'none'; });
    try {
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--bs-body-bg').trim();
        const canvas = await html2canvas($('grid'), {
            backgroundColor: bg,
            scale: window.devicePixelRatio,
            proxy: '/api/proxy',
            useCORS: false,
        });
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
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
    $('save-image-btn').addEventListener('click', saveImage);

    $('submit-all-btn').addEventListener('click', () => doSubmit(state.pendingIndices()));
    const shakeEl = el => {
        el.classList.remove('shake');
        void el.offsetWidth;
        el.classList.add('shake');
    };

    const submitLogin = async () => {
        const name = $('name-input').value.trim();
        const password = $('password-input').value;
        if (!name) {
            shakeEl($('name-input'));
            return;
        }
        $('modal-submit').disabled = true;
        $('modal-cancel').disabled = true;
        try {
            const data = await fetchJSON('/api/login', {method: 'POST', body: {name, password}});
            saveToken(data.token);
            nameModal.close(null);
            loadCurrentUser();
        } catch {
            $('modal-submit').disabled = false;
            $('modal-cancel').disabled = false;
            const err = $('modal-error');
            err.textContent = 'Invalid name or password.';
            err.classList.remove('d-none');
            shakeEl($('name-input'));
        }
    };

    $('modal-submit').addEventListener('click', () => {
        if (nameModal._loginMode) {
            submitLogin();
            return;
        }
        const name = $('name-input').value.trim();
        if (name) nameModal.resolve(name);
    });
    $('modal-cancel').addEventListener('click', () => nameModal.close(null));
    $('name-input').addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        if (nameModal._loginMode) {
            $('password-input').focus();
            return;
        }
        const name = $('name-input').value.trim();
        if (name) nameModal.resolve(name);
    });
    $('password-skip').addEventListener('click', () => nameModal.resolve(null));

    const submitPassword = async () => {
        const password = $('password-input').value;
        if (!password) {
            shakeEl($('password-input'));
            return;
        }
        $('password-submit').disabled = true;
        $('password-skip').disabled = true;
        try {
            const res = await fetch('/api/password', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}`},
                body: JSON.stringify({password}),
            });
            if (!res.ok) throw new Error();
            nameModal.resolve(null);
        } catch {
            $('password-submit').disabled = false;
            $('password-skip').disabled = false;
            const err = $('modal-error');
            err.textContent = 'Failed to set password. Please try again.';
            err.classList.remove('d-none');
            shakeEl($('password-input'));
        }
    };

    $('password-submit').addEventListener('click', submitPassword);
    $('password-input').addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        if (nameModal._loginMode) submitLogin();
        else submitPassword();
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
        location.reload();
    });
    document.addEventListener('click', () => $('user-dropdown').classList.add('d-none'));

    $('login-btn').addEventListener('click', () => nameModal.promptLogin());

    try {
        const matches = await fetchJSON('/api/matches');
        renderGrid(matches);
        await loadPastPredictions();
        applyFinalScoreStates();
    } catch {
        $('grid').innerHTML = '<p class="text-secondary text-center py-5">Failed to load matches. Please refresh.</p>';
    }
    if (!getToken()) show($('login-btn'));
    loadCurrentUser();
});
