// DOM helpers, $, show/hide/setHidden, getToken/saveToken, api(), tryFetch(),
// showToast() and theming all live in common.js (loaded before this script).

// ============== DOM helpers (app-only) ==============
const onClick = (id, fn) => $(id).addEventListener('click', fn);
const onEnter = (id, fn) => $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') fn(e);
});

const makeEl = (tag, {dataset, ...props} = {}) => {
    const el = Object.assign(document.createElement(tag), props);
    if (dataset) Object.assign(el.dataset, dataset);
    return el;
};

// Restart the shake animation by toggling the class across a forced reflow.
function shakeEl(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
}

const escapeHtml = str => {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
};
const escapeAttr = s => escapeHtml(s).replaceAll('"', '&quot;');

const loadImage = src => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
});

const firstInt = s => {
    const m = s.match(/\d+/);
    return m ? parseInt(m[0], 10) : NaN;
};

function groupBy(items, key) {
    const map = new Map();
    items.forEach((item, i) => {
        const k = key(item, i);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push([item, i]);
    });
    return map;
}

async function withDisabled(ids, fn) {
    ids.forEach(id => { $(id).disabled = true; });
    try { return await fn(); }
    finally { ids.forEach(id => { $(id).disabled = false; }); }
}

// ============== State ==============
const SIDES = ['a', 'b'];
const OTHER_SIDE = {a: 'b', b: 'a'};

const state = {
    matches: [],
    scores: {},   // { index: [scoreA, scoreB] } — set only when both inputs are valid ints
    submitted: new Set(),
    pendingIndices() {
        return Object.keys(this.scores).map(Number).filter(i => !this.submitted.has(i));
    },
};

const findCard = index => document.querySelector(`.card[data-index="${index}"]`);

// ============== Predictions ==============
const isValidScore = v => /^\d+$/.test(v.trim());

const findInvalidInputs = () =>
    [...document.querySelectorAll('.card .score-input:not(:disabled)')]
        .filter(input => {
            const v = input.value.trim();
            return v && !/^\d+$/.test(v);
        });

const predictionFor = (predicted, actual) =>
    predicted > actual ? {cls: 'prediction-high', sign: '>'}
        : predicted < actual ? {cls: 'prediction-low', sign: '<'}
            : {cls: 'prediction-exact', sign: '='};

const winnerColor = (a, b) => a > b ? 'text-success' : a < b ? 'text-danger' : '';

function updateSubmitAll() {
    const count = state.pendingIndices().length;
    $('submit-all-count').textContent = count;
    setHidden($('submit-all-container'), count === 0);
    $('main').classList.toggle('pb-5', count > 0);
}

function updateCardState(card, index) {
    const values = [...card.querySelectorAll('.score-input')].map(i => i.value);
    if (values.every(isValidScore)) state.scores[index] = values.map(Number);
    else delete state.scores[index];
    updateSubmitAll();
}

// ============== Cards ==============
const predictionRowHTML = ({name, score_a, score_b}) => `
  <div class="d-flex justify-content-between align-items-baseline gap-3 py-1">
    <span class="small text-truncate">${escapeHtml(name)}</span>
    <span class="small fw-semibold text-secondary text-nowrap flex-shrink-0">${score_a} : ${score_b}</span>
  </div>`;

const statusMsg = (cls, text) => `<p class="${cls} small text-center my-2">${text}</p>`;

const setPanelHTML = (panel, html) => {
    const inner = panel.querySelector('.predictions-inner');
    inner.replaceChildren();
    inner.insertAdjacentHTML('beforeend', html);
};

const setPanelStatus = (panel, cls, text) => setPanelHTML(panel, statusMsg(cls, text));

const renderPanelPredictions = (panel, predictions) => {
    if (!predictions.length) return setPanelStatus(panel, 'text-secondary', 'No predictions yet.');
    setPanelHTML(panel, predictions.map(predictionRowHTML).join(''));
};

async function togglePredictions(matchId, panel, btn) {
    const opening = !panel.classList.contains('open');
    [panel, btn].forEach(el => el.classList.toggle('open', opening));
    if (!opening) return;

    setPanelStatus(panel, 'text-secondary', 'Loading…');
    try {
        renderPanelPredictions(panel, await api(`/api/predictions/${matchId}`));
    } catch {
        setPanelStatus(panel, 'text-danger', 'Failed to load.');
    }
}

const teamRowHTML = ({name, logo, score, color, side}) => `
  <div class="team-row${side === 1 ? ' mt-1' : ''}">
    ${logo ? `<img src="${escapeAttr(logo)}" class="team-logo" alt="">` : ''}
    <span class="team-name fw-semibold small ${color}">${escapeHtml(name)}</span>
    <input type="text" class="form-control score-input" data-side="${side}" inputmode="numeric" placeholder="0">
    ${score != null ? `<span class="actual-score small ${color || 'text-secondary'}">${score}</span>` : ''}
  </div>`;

function createCard(match, index, day) {
    const card = makeEl('div', {className: 'card', dataset: {index, day}});
    const hasFinal = match.score_a != null && match.score_b != null;

    const rows = SIDES.map((k, side) => teamRowHTML({
        name: match[`team_${k}`],
        logo: match[`logo_${k}`],
        score: match[`score_${k}`],
        color: hasFinal ? winnerColor(match[`score_${k}`], match[`score_${OTHER_SIDE[k]}`]) : '',
        side,
    }));

    card.innerHTML = `
      <div class="card-body">
        ${rows.join('')}
        <div class="toggle-row">
          <button class="toggle-btn" aria-label="Show predictions"></button>
        </div>
        <div class="predictions-panel"><div class="predictions-inner"></div></div>
      </div>`;

    const toggleBtn = card.querySelector('.toggle-btn');
    const panel = card.querySelector('.predictions-panel');
    toggleBtn.addEventListener('click', () => {
        togglePredictions(match.id, panel, toggleBtn);
        refreshExpandIcons();
    });
    card.querySelectorAll('.score-input').forEach(input =>
        input.addEventListener('input', () => {
            input.classList.remove('invalid');
            updateCardState(card, index);
        })
    );
    return card;
}

function markSubmitted(index) {
    state.submitted.add(index);
    delete state.scores[index];

    const card = findCard(index);
    if (!card) return;

    card.querySelectorAll('.score-input').forEach(input => { input.disabled = true; });
    if (!card.querySelector('.submitted-badge')) {
        card.querySelector('.toggle-btn').insertAdjacentHTML('afterend',
            '<span class="submitted-badge text-success small">✓</span>');
    }
    updateSubmitAll();
}

// ============== Section/day ordering ==============
const dayOf = sec => sec.split('/').at(-1) ?? sec;
const letters = s => s.replace(/\d+/g, '').trim();

function sectionOrder(a, b) {
    const pa = a.split('/'), pb = b.split('/');
    const lastA = pa.at(-1) ?? '', lastB = pb.at(-1) ?? '';
    const na = firstInt(lastA), nb = firstInt(lastB);
    const ligaRank = s => ({Erste: 0, Zweite: 1, Dritte: 2}[s.split(' ')[0]] ?? 99);
    return ((!isNaN(na) && !isNaN(nb)) ? nb - na : lastB.localeCompare(lastA))
        || ligaRank(pa[0] ?? '') - ligaRank(pb[0] ?? '')
        || (pa[1] ?? '').localeCompare(pb[1] ?? '');
}

function compareDays(a, b) {
    const lettersCmp = letters(a).localeCompare(letters(b));
    if (lettersCmp) return lettersCmp;
    const na = firstInt(a), nb = firstInt(b);
    return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
}

// ============== Tabs ==============
function activateTab(day) {
    $('tabs-bar').querySelectorAll('.tab-btn').forEach(btn => {
        const isActive = btn.dataset.day === day;
        btn.classList.toggle('btn-secondary', isActive);
        btn.classList.toggle('btn-outline-secondary', !isActive);
        if (isActive) btn.classList.remove('invalid-day');
    });
    $('grid').querySelectorAll('[data-day]').forEach(el => {
        setHidden(el, el.dataset.day !== day);
    });
    refreshExpandIcons();
}

const visibleToggleBtns = () =>
    [...document.querySelectorAll('.card:not(.d-none) .toggle-btn')];

const sectionToggleBtns = sec =>
    [...$('grid').querySelectorAll(
        `.card[data-section="${CSS.escape(sec)}"]:not(.d-none) .toggle-btn`
    )];

function toggleBtnsToTargets(btns, opening) {
    return btns
        .filter(btn => btn.classList.contains('open') !== opening)
        .map(btn => {
            const card = btn.closest('.card');
            return {
                btn,
                panel: card.querySelector('.predictions-panel'),
                matchId: state.matches[+card.dataset.index].id,
            };
        });
}

function togglePredictionsForBtns(btns) {
    if (!btns.length) return;
    const opening = btns.some(btn => !btn.classList.contains('open'));
    const targets = toggleBtnsToTargets(btns, opening);
    if (opening) openAllPredictions(targets);
    else targets.forEach(({btn, panel}) => [btn, panel].forEach(el => el.classList.remove('open')));
    refreshExpandIcons();
}

function toggleAllPredictions() {
    togglePredictionsForBtns(visibleToggleBtns());
}

function toggleSectionPredictions(sec) {
    togglePredictionsForBtns(sectionToggleBtns(sec));
}

async function openAllPredictions(targets) {
    if (!targets.length) return;
    targets.forEach(({btn, panel}) => {
        [btn, panel].forEach(el => el.classList.add('open'));
        setPanelStatus(panel, 'text-secondary', 'Loading…');
    });
    try {
        const ids = targets.map(t => t.matchId);
        const all = await api('/api/predictions', {method: 'POST', body: ids});
        const byId = new Map();
        all.forEach(p => {
            if (!byId.has(p.id)) byId.set(p.id, []);
            byId.get(p.id).push(p);
        });
        targets.forEach(({panel, matchId}) =>
            renderPanelPredictions(panel, byId.get(matchId) ?? [])
        );
    } catch {
        targets.forEach(({panel}) => setPanelStatus(panel, 'text-danger', 'Failed to load.'));
    }
}

function updateExpandAllIcon() {
    const btns = visibleToggleBtns();
    const allOpen = btns.length > 0 && btns.every(btn => btn.classList.contains('open'));
    $('expand-all-btn').classList.toggle('open', allOpen);
}

function updateSectionExpandIcons() {
    $('grid').querySelectorAll('.section-header').forEach(header => {
        const btn = header.querySelector('.section-expand-btn');
        if (!btn) return;
        const cardBtns = sectionToggleBtns(header.dataset.section);
        const allOpen = cardBtns.length > 0 && cardBtns.every(b => b.classList.contains('open'));
        btn.classList.toggle('open', allOpen);
    });
}

function refreshExpandIcons() {
    updateExpandAllIcon();
    updateSectionExpandIcons();
}

function createSectionHeader(sec, day) {
    const header = makeEl('div', {
        className: 'section-header',
        dataset: {day, section: sec},
    });
    header.insertAdjacentHTML('beforeend', `
        <span class="section-title">${escapeHtml(sec)}</span>
        <button class="section-expand-btn btn btn-sm btn-outline-secondary flex-shrink-0"
                aria-label="Show or hide all predictions in this section"
                title="Show or hide all predictions in this section">
            <span class="chevron-icon">
                <span class="chevron-arrow"></span>
                <span class="chevron-arrow"></span>
            </span>
        </button>`);
    header.querySelector('.section-expand-btn').addEventListener('click', () => toggleSectionPredictions(sec));
    return header;
}

function renderTabs(days) {
    const bar = $('tabs-bar');
    bar.innerHTML = '';
    days.forEach(day => {
        const btn = makeEl('button', {
            className: 'tab-btn btn btn-sm btn-outline-secondary',
            textContent: day,
            dataset: {day},
        });
        btn.addEventListener('click', () => activateTab(day));
        bar.appendChild(btn);
    });
}

// ============== Grid render ==============
function renderGrid(matches) {
    state.matches = matches;
    const grid = $('grid');
    grid.innerHTML = '';

    const groups = groupBy(matches, m => m.section ?? '');
    const sortedSections = [...groups.keys()].sort(sectionOrder);
    const days = [...new Set(sortedSections.map(dayOf))].sort(compareDays);
    renderTabs(days);

    sortedSections.forEach((sec, si) => {
        const day = dayOf(sec);
        const prevDay = si > 0 ? dayOf(sortedSections[si - 1]) : null;

        if (si > 0 && prevDay === day) {
            grid.appendChild(makeEl('div', {className: 'section-divider', dataset: {day}}));
        }
        if (sec) {
            grid.appendChild(createSectionHeader(sec, day));
        }
        groups.get(sec).forEach(([match, i]) => {
            const card = createCard(match, i, day);
            card.dataset.section = sec;
            grid.appendChild(card);
        });
    });

    // Default to the lowest-ranked day still missing scores.
    const defaultDay = days.find(day =>
        matches.some(m => dayOf(m.section ?? '') === day && (m.score_a == null || m.score_b == null))
    ) ?? days.at(-1);
    if (defaultDay) activateTab(defaultDay);
}

// ============== Modal ==============
const MODAL_MODES = {
    name: {
        title: 'Who are you?',
        subtitle: 'Enter a name to save your prediction.',
        showCookie: true,
    },
    login: {
        title: 'Log in',
        subtitle: 'Enter your name and password, or create a new account.',
        submitLabel: 'Log in',
        showPassword: true,
        showCreate: true,
    },
    password: {
        title: 'Set a password?',
        subtitle: 'Optionally protect your account with a password.',
        nameDisabled: true,
        showPassword: true,
        actions: 'password',
        focusId: 'password-input',
    },
};

const nameModal = {
    _resolve: null,
    mode: null,

    open(mode, opts = {}) {
        const cfg = {...MODAL_MODES[mode], ...opts};
        this.mode = mode;

        const modal = $('name-modal');
        const nameInput = $('name-input');
        const passwordInput = $('password-input');

        $('modal-title').textContent = cfg.title;
        $('modal-subtitle').textContent = cfg.subtitle;
        $('modal-submit').textContent = cfg.submitLabel ?? 'Submit';

        nameInput.value = cfg.nameValue ?? '';
        nameInput.disabled = !!cfg.nameDisabled;

        passwordInput.value = '';
        setHidden(passwordInput, !cfg.showPassword);

        const altActions = cfg.actions === 'password';
        setHidden($('modal-actions-1'), altActions);
        setHidden($('modal-actions-2'), !altActions);
        setHidden($('modal-create'), !cfg.showCreate);
        setHidden($('modal-cookie'), !cfg.showCookie);

        if (cfg.errorMsg) this.showError(cfg.errorMsg);
        else hide($('modal-error'));

        modal.querySelectorAll('button').forEach(b => { b.disabled = false; });

        show(modal);
        if (cfg.shake) shakeEl(nameInput);
        (cfg.focusId ? $(cfg.focusId) : nameInput).focus();

        return new Promise(resolve => { this._resolve = resolve; });
    },

    prompt(errorMsg = null) { return this.open('name', {errorMsg, shake: !!errorMsg}); },
    promptLogin() { return this.open('login'); },
    promptPassword(name) { return this.open('password', {nameValue: name}); },

    showError(msg) {
        const err = $('modal-error');
        err.textContent = msg;
        show(err);
    },

    resolve(result) {
        this._resolve?.(result);
        this._resolve = null;
    },

    close(result) {
        this.mode = null;
        hide($('name-modal'));
        this.resolve(result);
    },
};

// ============== Image dialog ==============
const activeDay = () => $('tabs-bar').querySelector('.btn-secondary')?.dataset.day ?? null;

const sectionsForDay = day => {
    const set = new Set();
    state.matches.forEach(m => {
        const sec = m.section ?? '';
        if (sec && dayOf(sec) === day) set.add(sec);
    });
    return [...set].sort(sectionOrder);
};

const userHasPredictionInSection = section =>
    state.matches.some((m, i) =>
        m.section === section && (i in state.scores || state.submitted.has(i))
    );

const imageDialog = {
    open() {
        const day = activeDay();
        const sections = sectionsForDay(day);
        const withPredictions = sections.filter(userHasPredictionInSection);
        const preChecked = new Set(withPredictions.length ? withPredictions : sections);

        const list = $('image-section-list');
        list.replaceChildren();
        sections.forEach((section, i) => {
            const id = `image-section-${i}`;
            const checked = preChecked.has(section) ? ' checked' : '';
            list.insertAdjacentHTML('beforeend', `
                <div class="form-check">
                    <input type="checkbox" id="${escapeAttr(id)}" class="form-check-input" data-section="${escapeAttr(section)}"${checked}>
                    <label for="${escapeAttr(id)}" class="form-check-label small">${escapeHtml(section)}</label>
                </div>`);
        });

        $('image-include-predictions').checked = true;
        this.updateSaveEnabled();
        show($('image-modal'));
    },

    close() { hide($('image-modal')); },

    updateSaveEnabled() {
        const any = !!$('image-section-list').querySelector('input[type="checkbox"]:checked');
        $('image-modal-save').disabled = !any;
    },

    readOptions() {
        const sections = new Set();
        $('image-section-list').querySelectorAll('input[type="checkbox"]:checked')
            .forEach(cb => sections.add(cb.dataset.section));
        return {
            sections,
            includePredictions: $('image-include-predictions').checked,
        };
    },
};

// ============== Submission ==============
async function submitPredictions(predictions, name = null) {
    const body = getToken() ? {predictions} : {predictions, name};
    const data = await api('/api/submit', {method: 'POST', body});
    if (data.token) {
        saveToken(data.token);
        loadCurrentUser();
    }
    return !!data.token;
}

const failSubmission = () => alert('Submission failed. Please try again.');

async function doSubmit(indices) {
    const predictions = indices.map(i => {
        const [score_a, score_b] = state.scores[i];
        return {id: state.matches[i].id, score_a, score_b};
    });

    if (getToken()) {
        try {
            await submitPredictions(predictions);
            indices.forEach(markSubmitted);
        } catch (e) { if (!e.rateLimited) failSubmission(); }
        return;
    }

    let name = await nameModal.prompt();
    while (name) {
        try {
            const isNew = await submitPredictions(predictions, name);
            if (isNew) await nameModal.promptPassword(name);
            nameModal.close(null);
            indices.forEach(markSubmitted);
            return;
        } catch (e) {
            if (e.rateLimited) {
                nameModal.close(null);
                return;
            }
            if (e.code !== 'AccountExists') {
                nameModal.close(null);
                failSubmission();
                return;
            }
            name = await nameModal.prompt('That name is already taken. Please choose another.');
        }
    }
}

// ============== Past predictions / finished matches ==============
const predSignHTML = ({cls, sign}) => `<span class="pred-sign small ${cls}">${sign}</span>`;

function applyPastPrediction(p) {
    const index = state.matches.findIndex(m => m.id === p.id);
    if (index === -1) return;
    const card = findCard(index);
    if (!card) return;

    const match = state.matches[index];
    const hasFinal = match.score_a != null && match.score_b != null;

    [...card.querySelectorAll('.score-input')].forEach((input, i) => {
        const k = SIDES[i];
        input.value = p[`score_${k}`];
        if (hasFinal) {
            const pred = predictionFor(p[`score_${k}`], match[`score_${k}`]);
            input.classList.add(pred.cls);
            input.insertAdjacentHTML('afterend', predSignHTML(pred));
        }
    });
    markSubmitted(index);
}

async function loadPastPredictions() {
    if (!getToken()) return;
    const predictions = await tryFetch(() => api('/api/predictions/me'));
    predictions?.forEach(applyPastPrediction);
}

function applyFinalScoreStates() {
    state.matches.forEach((match, index) => {
        if (match.score_a == null || match.score_b == null) return;
        if (state.submitted.has(index)) return;
        findCard(index)?.querySelectorAll('.score-input').forEach(el => el.remove());
    });
}

async function loadCurrentUser() {
    if (!getToken()) return;
    const data = await tryFetch(() => api('/api/me'));
    if (!data) return;
    $('user-name').textContent = data.name;
    show($('user-menu'));
    hide($('login-btn'));
}

// ============== Save as image ==============
function collectImageHides({sections, includePredictions}) {
    const toHide = [];
    let sectionEls = [], keep = false, anyKept = false;
    const flush = () => {
        if (!sectionEls.length) return;
        if (keep) {
            // Drop the divider that would lead the very first kept section.
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
        keep = false;
    };
    // A batch is [divider?, header, ...cards] — the divider belongs to the
    // following section, so its keep/drop decision is set by the header we
    // haven't read yet. Only flush at the next divider or at end of grid.
    let currentSection = '';
    for (const el of $('grid').children) {
        if (el.classList.contains('d-none')) continue;
        if (el.classList.contains('section-divider')) {
            flush();
            sectionEls.push(el);
        } else if (el.classList.contains('section-header')) {
            currentSection = el.dataset.section ?? '';
            keep = sections.has(currentSection);
            sectionEls.push(el);
        } else {
            if (!sectionEls.length) keep = sections.has(currentSection);
            sectionEls.push(el);
        }
    }
    flush();

    // Submitted-badges are a UI affordance and never belong in the image; score
    // inputs and prediction signs are stripped only when the user opts out.
    const selector = includePredictions
        ? '.submitted-badge'
        : '.score-input, .pred-sign, .submitted-badge';
    forEachKeptEl(toHide, '.card', card => {
        card.querySelectorAll(selector).forEach(n => toHide.push(n));
    });
    forEachKeptEl(toHide, '.section-header', header => {
        header.querySelectorAll('.section-expand-btn').forEach(n => toHide.push(n));
    });

    return toHide;
}

function forEachKeptEl(toHide, selector, fn) {
    const hidden = new Set(toHide);
    for (const el of $('grid').children) {
        if (hidden.has(el) || el.classList.contains('d-none')) continue;
        if (el.matches(selector)) fn(el);
    }
}

async function renderGridCanvas() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bs-body-bg').trim();
    const canvas = await html2canvas($('grid'), {
        backgroundColor: bg,
        scale: window.devicePixelRatio,
        proxy: '/api/proxy',
        useCORS: false,
    });
    const pad = 16 * window.devicePixelRatio;
    const padded = makeEl('canvas');
    padded.width = canvas.width + pad * 2;
    padded.height = canvas.height + pad * 2;
    const ctx = padded.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, padded.width, padded.height);
    ctx.drawImage(canvas, pad, pad);
    try {
        const wm = await loadImage('/pulow.png');
        const wmH = 32 * window.devicePixelRatio;
        const wmW = (wm.naturalWidth / wm.naturalHeight) * wmH;
        ctx.globalAlpha = 0.5;
        ctx.drawImage(wm, padded.width - wmW - pad / 2, padded.height - wmH - pad / 2, wmW, wmH);
        ctx.globalAlpha = 1;
    } catch { /* watermark is non-critical */ }
    return padded;
}

async function saveImage({sections, includePredictions}) {
    const toHide = collectImageHides({sections, includePredictions});
    toHide.forEach(el => { el.style.display = 'none'; });

    // Submitted predictions live in disabled inputs — re-enable them just for
    // the render so they appear in their normal active styling, not greyed out.
    const reEnabled = [];
    if (includePredictions) {
        forEachKeptCard(toHide, card => {
            card.querySelectorAll('.score-input:disabled').forEach(input => {
                input.disabled = false;
                reEnabled.push(input);
            });
        });
    }

    try {
        const padded = await renderGridCanvas();
        makeEl('a', {
            download: 'predictions.png',
            href: padded.toDataURL('image/png'),
        }).click();
    } finally {
        toHide.forEach(el => { el.style.display = ''; });
        reEnabled.forEach(input => { input.disabled = true; });
    }
}

// ============== Modal action handlers ==============
const resolveNameInput = () => {
    const name = $('name-input').value.trim();
    if (name) nameModal.resolve(name);
};

const ifLogin = (yes, no) => () => (nameModal.mode === 'login' ? yes : no)();

async function attemptLogin() {
    const nameInput = $('name-input');
    const name = nameInput.value.trim();
    const password = $('password-input').value;
    if (!name) { shakeEl(nameInput); return; }
    try {
        const data = await withDisabled(['modal-submit', 'modal-cancel', 'modal-create'], () =>
            api('/api/login', {method: 'POST', body: {name, password}})
        );
        saveToken(data.token);
        nameModal.close(null);
        loadCurrentUser();
    } catch (e) {
        if (e.rateLimited) return;
        nameModal.showError('Invalid name or password.');
        shakeEl(nameInput);
    }
}

async function attemptCreateAccount() {
    const nameInput = $('name-input');
    const name = nameInput.value.trim();
    const password = $('password-input').value;
    if (!name) { shakeEl(nameInput); return; }
    try {
        const data = await withDisabled(['modal-submit', 'modal-cancel', 'modal-create'], async () => {
            const r = await api('/api/submit', {method: 'POST', body: {predictions: [], name}});
            if (r.token) saveToken(r.token);
            if (password) await tryFetch(() => api('/api/password', {method: 'POST', body: {password}}));
            return r;
        });
        nameModal.close(null);
        loadCurrentUser();
    } catch (e) {
        if (e.rateLimited) return;
        nameModal.showError(e.code === 'AccountExists'
            ? 'That name is already taken. Please choose another.'
            : 'Failed to create account.');
        shakeEl(nameInput);
    }
}

async function attemptSetPassword() {
    const passwordInput = $('password-input');
    const password = passwordInput.value;
    if (!password) { shakeEl(passwordInput); return; }
    try {
        await withDisabled(['password-submit', 'password-skip'], () =>
            api('/api/password', {method: 'POST', body: {password}})
        );
        nameModal.resolve(null);
    } catch (e) {
        if (e.rateLimited) return;
        nameModal.showError('Failed to set password. Please try again.');
        shakeEl(passwordInput);
    }
}

// ============== Init ==============
function bindEvents() {
    onClick('expand-all-btn', toggleAllPredictions);
    onClick('save-image-btn', () => imageDialog.open());
    onClick('image-modal-cancel', () => imageDialog.close());
    onClick('image-modal-save', () => {
        const opts = imageDialog.readOptions();
        imageDialog.close();
        saveImage(opts);
    });
    $('image-section-list').addEventListener('change', () => imageDialog.updateSaveEnabled());
    onClick('submit-all-btn', () => {
        const invalid = findInvalidInputs();
        if (invalid.length) {
            const hiddenDays = new Set();
            invalid.forEach(input => {
                input.classList.add('invalid');
                const card = input.closest('.card');
                if (card.classList.contains('d-none')) hiddenDays.add(card.dataset.day);
                else shakeEl(input);
            });
            hiddenDays.forEach(day => {
                const tab = $('tabs-bar').querySelector(`.tab-btn[data-day="${CSS.escape(day)}"]`);
                if (tab) {
                    tab.classList.add('invalid-day');
                    shakeEl(tab);
                }
            });
            return;
        }
        doSubmit(state.pendingIndices());
    });

    onClick('modal-submit', ifLogin(attemptLogin, resolveNameInput));
    onClick('modal-create', attemptCreateAccount);
    onClick('modal-cancel', () => nameModal.close(null));
    onEnter('name-input', ifLogin(() => $('password-input').focus(), resolveNameInput));

    onClick('password-skip', () => nameModal.resolve(null));
    onClick('password-submit', attemptSetPassword);
    onEnter('password-input', ifLogin(attemptLogin, attemptSetPassword));

    const userDropdown = $('user-dropdown');
    const logoutModal = $('logout-modal');

    onClick('user-btn', e => {
        e.stopPropagation();
        userDropdown.classList.toggle('d-none');
    });
    document.addEventListener('click', () => hide(userDropdown));

    onClick('logout-btn', () => {
        hide(userDropdown);
        show(logoutModal);
    });
    onClick('logout-cancel', () => hide(logoutModal));
    onClick('logout-confirm', async () => {
        await tryFetch(() => api('/api/logout', {method: 'POST'}));
        localStorage.removeItem('ups_token');
        location.reload();
    });

    onClick('login-btn', () => nameModal.promptLogin());
}

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    try {
        const matches = await api('/api/matches');
        renderGrid(matches);
        await loadPastPredictions();
        applyFinalScoreStates();
    } catch {
        $('grid').innerHTML = '<p class="text-secondary text-center py-5">Failed to load matches. Please refresh.</p>';
    }
    if (!getToken()) show($('login-btn'));
    loadCurrentUser();
});
