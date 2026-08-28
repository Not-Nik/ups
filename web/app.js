// $, makeEl, firstInt, the section/day ordering helpers, show/hide/setHidden,
// getToken/saveToken, api(), tryFetch(), showToast() and theming all live in
// common.js, loaded before this script.

// ============== DOM helpers (app-only) ==============
const onClick = (id, fn) => $(id).addEventListener('click', fn);
const onEnter = (id, fn) => $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') fn(e);
});

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
    ids.forEach(id => {
        $(id).disabled = true;
    });
    try {
        return await fn();
    } finally {
        ids.forEach(id => {
            $(id).disabled = false;
        });
    }
}

// ============== State ==============
const SIDES = ['a', 'b'];
const OTHER_SIDE = {a: 'b', b: 'a'};

const state = {
    tournaments: [],
    activeTournament: null,
    matches: [],
    brackets: [], // rendered bracket entries {stage, key, nodes} — for the image dialog
    scores: {},   // { index: [scoreA, scoreB] } — set only when both inputs are valid ints
    submitted: new Set(),
    pendingIndices() {
        return Object.keys(this.scores).map(Number).filter(i => !this.submitted.has(i));
    },
};

const findCard = index => document.querySelector(`.card[data-index="${index}"]`);

// ============== Tournaments ==============
function updateTournamentTabs() {
    $('tournament-bar').querySelectorAll('.tournament-btn').forEach(btn => {
        btn.classList.toggle('active', Number(btn.dataset.id) === state.activeTournament);
    });
}

function renderTournamentTabs() {
    const bar = $('tournament-bar');
    bar.replaceChildren();
    state.tournaments.forEach(t => {
        const btn = makeEl('button', {
            className: 'tournament-btn btn',
            textContent: t.name,
            dataset: {id: String(t.tournament_id)},
        });
        btn.addEventListener('click', () => switchTournament(t.tournament_id));
        bar.appendChild(btn);
    });
    updateTournamentTabs();
    setHidden(bar, state.tournaments.length === 0);
}

function setActiveTournament(id) {
    state.activeTournament = id;
    localStorage.setItem('ups_tournament', String(id));
    updateTournamentTabs();
}

async function switchTournament(id) {
    if (id === state.activeTournament) return;
    setActiveTournament(id);
    await loadTournament(id);
}

// Scores/submissions are keyed by match index, so they go stale the moment the
// match list changes — reset them before each tournament load.
async function loadTournament(id) {
    state.scores = {};
    state.submitted = new Set();
    updateSubmitAll();
    try {
        const matches = await api(`/api/matches/${id}`);
        const brackets = await loadBrackets();
        renderGrid(matches, brackets);
        await loadPastPredictions();
        applyFinalScoreStates();
    } catch {
        $('grid').innerHTML = '<p class="text-secondary text-center py-5">Failed to load matches. Please refresh.</p>';
    }
}

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

const winnerSign = p => Math.sign(p.score_a - p.score_b);

// With a final score: predictions that picked the winner correctly come first,
// then incorrect — each group sorted by closeness. Without a score: A-wins on
// top, then draws, then B-wins, by how strongly each side is favoured.
function sortPredictions(predictions, match) {
    const hasFinal = match.score_a != null && match.score_b != null;
    const byScore = (a, b) => (a.score_a - b.score_a) || (a.score_b - b.score_b);
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'});
    if (hasFinal) {
        const target = winnerSign(match);
        const wrong = p => winnerSign(p) === target ? 0 : 1;
        const dist = p => Math.abs(p.score_a - match.score_a) + Math.abs(p.score_b - match.score_b);
        return [...predictions].sort((a, b) =>
            (wrong(a) - wrong(b)) || (dist(a) - dist(b)) || byScore(a, b) || byName(a, b)
        );
    }
    return [...predictions].sort((a, b) =>
        (winnerSign(b) - winnerSign(a))
        || ((a.score_b - a.score_a) - (b.score_b - b.score_a))
        || byScore(a, b)
        || byName(a, b)
    );
}

const renderPanelPredictions = (panel, match, predictions) => {
    if (!predictions.length) return setPanelStatus(panel, 'text-secondary', 'No predictions yet.');
    const sorted = sortPredictions(predictions, match);
    const hasFinal = match.score_a != null && match.score_b != null;
    const splitAt = hasFinal
        ? sorted.findIndex(p => winnerSign(p) !== winnerSign(match))
        : sorted.findIndex(p => p.score_b > p.score_a);
    const rows = sorted.map((p, i) => {
        const divider = i === splitAt && i > 0 ? '<hr class="prediction-divider">' : '';
        return divider + predictionRowHTML(p);
    });
    setPanelHTML(panel, rows.join(''));
};

async function togglePredictions(match, panel, btn) {
    const opening = !panel.classList.contains('open');
    [panel, btn].forEach(el => el.classList.toggle('open', opening));
    if (!opening) return;

    setPanelStatus(panel, 'text-secondary', 'Loading…');
    try {
        renderPanelPredictions(panel, match, await api(`/api/predictions/${match.id}`));
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
        <div class="score-box">${rows.join('')}</div>
        <div class="toggle-row">
          <button class="toggle-btn" aria-label="Show predictions"></button>
        </div>
        <div class="predictions-panel"><div class="predictions-inner"></div></div>
      </div>`;

    const toggleBtn = card.querySelector('.toggle-btn');
    const panel = card.querySelector('.predictions-panel');
    toggleBtn.addEventListener('click', () => {
        togglePredictions(match, panel, toggleBtn);
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

const EDIT_ICON_HTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 16 16" fill="currentColor"
         aria-hidden="true">
        <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/>
    </svg>`;

const setScoresDisabled = (card, disabled) =>
    card.querySelectorAll('.score-input').forEach(input => {
        input.disabled = disabled;
    });

function markSubmitted(index) {
    state.submitted.add(index);
    delete state.scores[index];

    const card = findCard(index);
    if (!card) return;

    setScoresDisabled(card, true);
    if (!card.querySelector('.submitted-badge')) {
        card.querySelector('.toggle-btn').after(makeEl('span', {
            className: 'submitted-badge text-success small',
            textContent: '✓',
        }));
    }
    // Edit affordance only makes sense before the match is decided.
    if (!card.querySelector('.pred-sign') && !card.querySelector('.edit-overlay')) {
        const editBtn = makeEl('button', {
            className: 'edit-overlay d-flex align-items-center justify-content-center border-0 p-0 lh-1',
            type: 'button',
            title: 'Edit prediction',
            ariaLabel: 'Edit prediction',
            innerHTML: EDIT_ICON_HTML,
        });
        editBtn.addEventListener('click', () => unlockPrediction(index));
        card.querySelector('.score-box').append(editBtn);
    }
    updateSubmitAll();
}

function unlockPrediction(index) {
    state.submitted.delete(index);
    const card = findCard(index);
    if (!card) return;
    setScoresDisabled(card, false);
    card.querySelector('.submitted-badge')?.remove();
    card.querySelector('.edit-overlay')?.remove();
    updateCardState(card, index);
    // The edit button is gone; land focus on a field the user can now type into.
    card.querySelector('.score-input')?.focus();
}

// Section helpers (sectionKey, sectionTitle, dayOf, sectionOrder, compareDays) live in common.js.

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
                match: state.matches[+card.dataset.index],
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
        const ids = targets.map(t => t.match.id);
        const all = await api('/api/predictions', {method: 'POST', body: ids});
        const byId = new Map();
        all.forEach(p => {
            if (!byId.has(p.id)) byId.set(p.id, []);
            byId.get(p.id).push(p);
        });
        targets.forEach(({panel, match}) =>
            renderPanelPredictions(panel, match, byId.get(match.id) ?? [])
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

function createSectionHeader(key, day) {
    const header = makeEl('div', {
        className: 'section-header',
        dataset: {day, section: key},
    });
    header.insertAdjacentHTML('beforeend', `
        <span class="section-title">${escapeHtml(sectionTitle(key))}</span>
        <button class="section-expand-btn btn btn-sm btn-outline-secondary flex-shrink-0"
                aria-label="Show or hide all predictions in this section"
                title="Show or hide all predictions in this section">
            <span class="chevron-icon">
                <span class="chevron-arrow"></span>
                <span class="chevron-arrow"></span>
            </span>
        </button>`);
    header.querySelector('.section-expand-btn').addEventListener('click', () => toggleSectionPredictions(key));
    return header;
}

// Render one row per tab group — league round-prefixes and bracket stages alike,
// sorted together by group name — and return the tabs in display order (each
// {day, unfinished}) so the caller can pick a default.
function renderTabs(days, brackets, matches) {
    // A day tab is unfinished only because of the matches it actually shows — bracket
    // matches are drawn as brackets (and some carry "Day N" round names), so exclude
    // them here just like the day grid does.
    const dayUnfinished = day => matches.some(m =>
        !BRACKET_STAGE_TYPES.has(m.stage_type) && (m.round_name ?? '') === day
        && (m.score_a == null || m.score_b == null));
    // League days grouped by their non-digit prefix (e.g. "Day"). When every day in a
    // group has a suffix, show the prefix once as a row label with bare suffixes on the
    // buttons; otherwise the buttons carry the full name and the label cell is empty.
    const leagueGroups = [...groupBy(days, letters)].map(([prefix, group]) => {
        const items = group.map(([day]) => ({day, suffix: day.slice(prefix.length).trim()}));
        const labelled = prefix && items.every(i => i.suffix);
        return {
            name: labelled ? prefix : (items[0]?.day ?? prefix),
            label: labelled ? prefix : '',
            entries: items.map(i => ({day: i.day, text: labelled ? i.suffix : i.day, unfinished: dayUnfinished(i.day)})),
        };
    });
    // Bracket stages, one row each. A bracket is "unfinished" while it has a known
    // matchup that hasn't been played (a predictable node without a score).
    const bracketUnfinished = b => b.nodes.some(n => n.match_id != null && n.score_a == null);
    const byStage = new Map();
    brackets.forEach(b => pushTo(byStage, b.stage, b));
    const bracketGroups = [...byStage].map(([stage, list]) => ({
        name: stage,
        label: stage,
        entries: list.map(b => ({day: bracketDayKey(b.stage, b.key), text: b.label, unfinished: bracketUnfinished(b)})),
    }));

    const bar = $('tabs-bar');
    bar.innerHTML = '';
    const order = [];
    // Sort by group name, but sink groups with no heading (a lone tab like "Seedingwoche")
    // to the bottom.
    const groups = [...leagueGroups, ...bracketGroups]
        .sort((a, b) => (!a.label - !b.label) || a.name.localeCompare(b.name));
    for (const g of groups) {
        // Label cell (column 1, empty when unlabelled) then the buttons cell (column 2),
        // so buttons line up across rows via the shared grid column.
        bar.appendChild(makeEl('span', {
            className: 'tab-prefix small text-secondary fw-semibold', textContent: g.label,
        }));
        const row = makeEl('div', {className: 'd-flex gap-2 flex-wrap'});
        for (const e of g.entries) {
            const btn = makeEl('button', {
                className: 'tab-btn btn btn-sm btn-outline-secondary', textContent: e.text, dataset: {day: e.day},
            });
            btn.addEventListener('click', () => activateTab(e.day));
            row.appendChild(btn);
            order.push(e);
        }
        bar.appendChild(row);
    }
    return order;
}

// ============== Grid render ==============
function renderGrid(matches, brackets = []) {
    state.matches = matches;
    state.brackets = brackets;
    const grid = $('grid');
    grid.innerHTML = '';

    // Bracket-format stages are drawn as brackets (see bracket.js), not in the
    // day-grid, so leave their sections out here.
    const groups = groupBy(matches, sectionKey);
    const isBracketKey = key => BRACKET_STAGE_TYPES.has(groups.get(key)[0]?.[0]?.stage_type);
    const sortedSections = [...groups.keys()].sort(sectionOrder).filter(key => !isBracketKey(key));
    const days = [...new Set(sortedSections.map(dayOf))].sort(compareDays);

    sortedSections.forEach((key, si) => {
        const day = dayOf(key);
        const prevDay = si > 0 ? dayOf(sortedSections[si - 1]) : null;

        if (si > 0 && prevDay === day) {
            grid.appendChild(makeEl('div', {className: 'section-divider', dataset: {day}}));
        }
        if (sectionTitle(key)) {
            grid.appendChild(createSectionHeader(key, day));
        }
        groups.get(key).forEach(([match, i]) => {
            const card = createCard(match, i, day);
            card.dataset.section = key;
            grid.appendChild(card);
        });
    });

    // One block per bracket; its tab is added by renderTabs alongside the league days.
    brackets.forEach(b => grid.appendChild(renderBracketBlock(b)));

    // Tabs for league days and brackets together, sorted by group name; default to the
    // first tab still missing a result (league day or bracket alike), else the last.
    const tabs = renderTabs(days, brackets, matches);
    const def = tabs.find(t => t.unfinished) ?? tabs.at(-1);
    if (def) activateTab(def.day);
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
    changePassword: {
        title: 'Change password',
        subtitle: 'Set a new password for your account.',
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

        modal.querySelectorAll('button').forEach(b => {
            b.disabled = false;
        });

        show(modal);
        if (cfg.shake) shakeEl(nameInput);
        (cfg.focusId ? $(cfg.focusId) : nameInput).focus();

        return new Promise(resolve => {
            this._resolve = resolve;
        });
    },

    prompt(errorMsg = null) {
        return this.open('name', {errorMsg, shake: !!errorMsg});
    },
    promptLogin() {
        return this.open('login');
    },
    promptPassword(name) {
        return this.open('password', {nameValue: name});
    },
    promptChangePassword(name) {
        return this.open('changePassword', {nameValue: name});
    },

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
        if ((m.round_name ?? '') === day) set.add(sectionKey(m));
    });
    return [...set].sort(sectionOrder);
};

const userHasPredictionInSection = key =>
    state.matches.some((m, i) =>
        sectionKey(m) === key && (i in state.scores || state.submitted.has(i))
    );

// The bracket shown on the active tab, if any (its day key is a bracketDayKey).
const activeBracket = () =>
    (state.brackets ?? []).find(b => bracketDayKey(b.stage, b.key) === activeDay());

// Toggle options for the image dialog. On a bracket tab the options are the bracket's
// branches (Winners/Losers Bracket, full names) so each can be toggled even when a stage
// keeps both in one group; on a league day they're the day's sections. Each is
// {value, label, checked} — value is what the export hide logic keys on.
const imageSectionItems = () => {
    const bracket = activeBracket();
    if (bracket) {
        const branches = [...new Set(bracket.nodes.map(n => n.branch ?? ''))].sort((a, b) => branchRank(a) - branchRank(b));
        const single = branches.length <= 1;
        return branches.map(b => ({
            value: b,
            label: !single && BRANCH_LABEL[b]
                ? BRANCH_LABEL[b]
                : bracket.nodes.find(n => (n.branch ?? '') === b).group_name,
            checked: true,
        }));
    }
    const sections = sectionsForDay(activeDay());
    const withPredictions = sections.filter(userHasPredictionInSection);
    const pre = new Set(withPredictions.length ? withPredictions : sections);
    return sections.map(key => ({value: key, label: sectionTitle(key), checked: pre.has(key)}));
};

const imageDialog = {
    open() {
        const list = $('image-section-list');
        list.replaceChildren();
        imageSectionItems().forEach((item, i) => {
            const id = `image-section-${i}`;
            list.insertAdjacentHTML('beforeend', `
                <div class="form-check">
                    <input type="checkbox" id="${escapeAttr(id)}" class="form-check-input" data-section="${escapeAttr(item.value)}"${item.checked ? ' checked' : ''}>
                    <label for="${escapeAttr(id)}" class="form-check-label small">${escapeHtml(item.label)}</label>
                </div>`);
        });

        $('image-include-predictions').checked = true;
        this.updateSaveEnabled();
        show($('image-modal'));
    },

    close() {
        hide($('image-modal'));
    },

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
        } catch (e) {
            if (!e.rateLimited) failSubmission();
        }
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
        // A bracket tab is a single block; hide the cells/edges of unchecked branches.
        if (el.classList.contains('bracket-block')) {
            collectBracketHides(el, sections, toHide);
            continue;
        }
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

    // Submitted-badges and edit overlays are UI affordances and never belong in
    // the image; score inputs and prediction signs are stripped only when the
    // user opts out.
    const selector = includePredictions
        ? '.submitted-badge, .edit-overlay'
        : '.score-input, .pred-sign, .submitted-badge, .edit-overlay';
    exportVisibleCards(toHide).forEach(card =>
        card.querySelectorAll(selector).forEach(n => toHide.push(n)));
    forEachKeptEl(toHide, '.section-header', header => {
        header.querySelectorAll('.section-expand-btn').forEach(n => toHide.push(n));
    });

    return toHide;
}

// Hide a bracket's cells and edges for any branch the user unchecked. An edge is
// dropped when either endpoint's branch is hidden so no line dangles; a branch label
// goes with its branch.
function collectBracketHides(block, sections, toHide) {
    const branchOf = new Map();
    block.querySelectorAll('.bracket-cell').forEach(cell => {
        branchOf.set(cell.dataset.node, cell.dataset.branch);
        if (!sections.has(cell.dataset.branch)) toHide.push(cell);
    });
    block.querySelectorAll('.bracket-edge').forEach(edge => {
        if (!sections.has(branchOf.get(edge.dataset.from)) || !sections.has(branchOf.get(edge.dataset.to)))
            toHide.push(edge);
    });
    block.querySelectorAll('.bracket-branch-label').forEach(label => {
        if (!sections.has(label.dataset.branch)) toHide.push(label);
    });
}

function forEachKeptEl(toHide, selector, fn) {
    const hidden = new Set(toHide);
    for (const el of $('grid').children) {
        if (hidden.has(el) || el.classList.contains('d-none')) continue;
        if (el.matches(selector)) fn(el);
    }
}

// Every kept, on-screen card (league grid + bracket cells), skipping ones inside a
// hidden container — so prediction affordances get stripped from brackets too.
function exportVisibleCards(toHide) {
    const hidden = new Set(toHide);
    const visible = el => {
        for (let n = el; n && n !== $('grid'); n = n.parentElement)
            if (hidden.has(n) || n.classList.contains('d-none')) return false;
        return true;
    };
    return [...$('grid').querySelectorAll('.card')].filter(visible);
}

async function renderGridCanvas() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bs-body-bg').trim();
    // On a bracket tab, capture just the bracket's canvas (its own content width) rather
    // than the full-width grid, so the image isn't padded out with empty space.
    const target = $('grid').querySelector('.bracket-block:not(.d-none) .bracket-canvas') ?? $('grid');
    const canvas = await html2canvas(target, {
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
    } catch { /* watermark is non-critical */
    }
    return padded;
}

async function saveImage({sections, includePredictions}) {
    // Suspend the bracket reflow: the hides below resize cells, which would otherwise
    // trigger a relayout that rebuilds the SVG and undoes the per-branch edge hiding.
    bracketReflowPaused = true;
    const toHide = collectImageHides({sections, includePredictions});
    toHide.forEach(el => {
        el.style.display = 'none';
    });

    // Submitted predictions live in disabled inputs — re-enable them just for
    // the render so they appear in their normal active styling, not greyed out.
    const reEnabled = [];
    if (includePredictions) {
        exportVisibleCards(toHide).forEach(card => {
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
        toHide.forEach(el => {
            el.style.display = '';
        });
        reEnabled.forEach(input => {
            input.disabled = true;
        });
        bracketReflowPaused = false;
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
    if (!name) {
        shakeEl(nameInput);
        return;
    }
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
    if (!name) {
        shakeEl(nameInput);
        return;
    }
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
    if (!password) {
        shakeEl(passwordInput);
        return;
    }
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

    const overlayInfoModal = $('overlay-info-modal');
    onClick('overlay-info-btn', () => show(overlayInfoModal));
    onClick('overlay-info-close', () => hide(overlayInfoModal));
    overlayInfoModal.addEventListener('click', e => {
        if (e.target === overlayInfoModal) hide(overlayInfoModal);
    });
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

    onClick('change-password-btn', async () => {
        hide(userDropdown);
        await nameModal.promptChangePassword($('user-name').textContent);
        nameModal.close(null);
    });
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
        state.tournaments = await api('/api/tournaments');
    } catch {
        state.tournaments = [];
    }
    renderTournamentTabs();

    // Remember the last viewed tournament across reloads; default to the first one.
    const saved = Number(localStorage.getItem('ups_tournament'));
    const tournament = state.tournaments.find(t => t.tournament_id === saved) ?? state.tournaments[0];
    if (tournament) {
        state.activeTournament = tournament.tournament_id;
        updateTournamentTabs();
        await loadTournament(tournament.tournament_id);
    } else {
        $('grid').innerHTML = '<p class="text-secondary text-center py-5">Failed to load tournaments. Please refresh.</p>';
    }
    if (!getToken()) show($('login-btn'));
    loadCurrentUser();
});
