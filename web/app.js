// $, makeEl, firstInt, the section/day ordering helpers, show/hide/setHidden,
// onClick/onEnter/shakeEl/withDisabled, getToken/saveToken, api(), tryFetch(),
// showToast() and theming all live in common.js; nameModal, loadCurrentUser and
// the header's login/user menu in auth.js. Both load before this script.

// ============== DOM helpers (app-only) ==============
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

// ============== State ==============
const SIDES = ['a', 'b'];
const OTHER_SIDE = {a: 'b', b: 'a'};

const state = {
    activeTournament: null,
    activeView: null, // one of VIEWS: which header tab (and main panel) is open
    activeTab: null, // internal day key of the open tab (a round name or a bracketDayKey)
    tabs: [],        // the last render's tabs in display order, as {day, param, unfinished}
    categories: [],  // the last render's labelled tab groups, as {label, name, entries}
    invalidDays: new Set(), // days whose hidden cards hold invalid inputs; drives .invalid-day
    matches: [],
    brackets: [], // rendered bracket entries {stage, key, nodes} — for the image dialog
    scores: {},   // { index: [scoreA, scoreB] } — set only when both inputs are valid ints
    submitted: new Set(),
    pendingIndices() {
        return Object.keys(this.scores).map(Number).filter(i => !this.submitted.has(i));
    },
};

const findCard = index => document.querySelector(`.card[data-index="${index}"]`);

// ============== Location state ==============
// Where you are — the tournament and the open tab — lives in the query string, so a
// link reproduces the exact view and Back walks through it. Nothing about it is kept
// in localStorage; only the token and the theme are.

// URL form of a tab, assigned by renderTabs: a league day is its own name ("Day 5"), a
// bracket is "bracket:<stage>" (plus ":<group>" only where a stage holds several). A
// bracket's internal day key joins its parts on NUL and has no place in a URL. The param
// is only ever compared against the rendered tabs, so it must be stable, not reversible.
const tabParam = day => state.tabs.find(t => t.day === day)?.param ?? null;

// The current query, always re-read: it is the state, so nothing may cache it.
const urlParams = () => new URLSearchParams(location.search);

function syncUrl(replace = false) {
    const params = urlParams();
    const set = (key, value) => value == null ? params.delete(key) : params.set(key, value);
    set(TOURNAMENT_PARAM, state.activeTournament);
    set('view', state.activeView);
    set('tab', state.activeTab && tabParam(state.activeTab));
    set('table', activeStandingsTable());
    const query = params.toString();
    history[replace ? 'replaceState' : 'pushState'](null, '', query ? `?${query}` : location.pathname);
}

// Adopt whatever the URL says on back/forward. The tournament is fixed for the page's
// lifetime (switching one is a page load from the landing grid), so only the view, the
// tab and the standings table move.
function applyLocation() {
    activateView(wantedView(), null);
    activateWantedTab();
    activateWantedStandingsTable();
}

// ============== Views ==============
// The Matches / Standings / Teams / Players / Leaderboard tabs. Each shows the main-area
// elements marked with its data-view-panel. The matches load with the page; every other
// view loads the first time it opens, through its loader (defined in standings.js,
// roster.js and leaderboard.js, loaded after this script, hence the arrows).
const VIEW_LOADERS = {
    matches: null,
    standings: id => loadStandings(id),
    teams: id => loadTeams(id),
    players: id => loadPlayers(id),
    leaderboard: id => loadLeaderboard(id),
};
const VIEWS = Object.keys(VIEW_LOADERS);

// Unknown or missing ?view= falls back to the matches.
const wantedView = () => {
    const view = urlParams().get('view');
    return VIEWS.includes(view) ? view : VIEWS[0];
};

// `record` works as in activateTab.
function activateView(view, record = 'push') {
    state.activeView = view;
    $('view-bar').querySelectorAll('.view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    document.querySelectorAll('[data-view-panel]').forEach(el => {
        setHidden(el, el.dataset.viewPanel !== view);
    });
    VIEW_LOADERS[view]?.(state.activeTournament);
    if (record) syncUrl(record === 'replace');
}

// ============== Tournament ==============
// The one the URL names, or undefined when it names none we know.
async function findTournament() {
    const tournaments = await api('/api/tournaments');
    const wanted = Number(urlParams().get(TOURNAMENT_PARAM));
    return tournaments.find(t => t.tournament_id === wanted);
}

async function loadTournament(id) {
    try {
        const {data: matches, res} = await api(`/api/matches/${id}`, {response: true});
        const brackets = await loadBrackets(id);
        renderGrid(matches, brackets);
        await loadPastPredictions();
        applyFinalScoreStates();
        // Asking for the matches makes the server pull fresh results from toornament
        // (at most once every few minutes). That runs in the background, so what we
        // just rendered predates it — X-Refreshing says so, and a reload picks it up.
        if (res.headers.get('X-Refreshing') === '1') showToast(REFRESH_MSG);
    } catch {
        $('grid').innerHTML = '<p class="text-secondary text-center py-5">Failed to load matches. Please refresh.</p>';
    }
}

const REFRESH_MSG = "Hang tight, we're fetching the latest results just for you";

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
// `record` says what the URL should do about it: 'push' for a click (Back returns to
// the previous tab), 'replace' when we only settle on a default, null when the URL
// already says this (back/forward).
function activateTab(day, record = 'push') {
    state.activeTab = day;
    state.invalidDays.delete(day);
    renderCategoryTabs();
    refreshTabStates();
    $('grid').querySelectorAll('[data-day]').forEach(el => {
        setHidden(el, el.dataset.day !== day);
    });
    refreshExpandIcons();
    if (record) syncUrl(record === 'replace');
}

// The bar is two lines: a button per category on top (plus tabs that have none), and
// the open tab's category's tabs below.
const categoryIndexOf = day => state.categories.findIndex(g => g.entries.some(e => e.day === day));

function renderCategoryTabs() {
    const row = $('category-tabs');
    row.replaceChildren();
    const g = state.categories[categoryIndexOf(state.activeTab)];
    // A category holding a single bracket tab is fully carried by its own button.
    if (!g || (g.bracket && g.entries.length === 1)) {
        hide(row);
        return;
    }
    show(row);
    g.entries.forEach(e => appendTabBtn(row, e));
}

// Clicking a category opens its first tab, unless one of its tabs is already open.
function selectCategory(group) {
    if (group.entries.some(e => e.day === state.activeTab)) return;
    activateTab(group.entries[0].day);
}

// Re-apply .active and .invalid-day across both lines after a re-render.
function refreshTabStates() {
    const i = categoryIndexOf(state.activeTab);
    $('tab-categories').querySelectorAll('.category-btn').forEach((btn, k) => {
        btn.classList.toggle('active', k === i);
        btn.classList.toggle('invalid-day', state.categories[k].entries.some(e => state.invalidDays.has(e.day)));
    });
    $('tabs-bar').querySelectorAll('.tab-btn[data-day]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.day === state.activeTab);
        btn.classList.toggle('invalid-day', state.invalidDays.has(btn.dataset.day));
    });
}

// A tab button for an entry {day, text}, wired to activateTab.
function appendTabBtn(row, e) {
    const btn = makeEl('button', {
        className: 'tab-btn btn', textContent: e.text, dataset: {day: e.day},
    });
    btn.addEventListener('click', () => activateTab(e.day));
    row.appendChild(btn);
    return btn;
}

// The button standing in for a day: its own tab where one is rendered, else the
// category button holding it.
function tabButtonFor(day) {
    const i = categoryIndexOf(day);
    return $('tabs-bar').querySelector(`.tab-btn[data-day="${CSS.escape(day)}"]`)
        ?? (i >= 0 ? $('tab-categories').querySelectorAll('.category-btn')[i] : null);
}

// Open the tab the URL asks for; failing that the first one still missing a result,
// else the last. Normalises the URL, which may have named a tab this tournament
// doesn't have.
function activateWantedTab() {
    const wanted = urlParams().get('tab');
    const tab = state.tabs.find(t => t.param === wanted)
        ?? state.tabs.find(t => t.unfinished)
        ?? state.tabs.at(-1);
    activateTab(tab?.day ?? null, 'replace');
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

// Render the two-line tab bar — a category button per labelled group (league
// day-prefixes and bracket stages alike) on top, the open category's tabs below —
// and return all tabs in display order (each {day, param, unfinished}) so the
// caller can pick a default.
function renderTabs(days, brackets, matches) {
    // A day tab is unfinished only because of the matches it actually shows — bracket
    // matches are drawn as brackets (and some carry "Day N" round names), so exclude
    // them here just like the day grid does.
    const dayUnfinished = day => matches.some(m =>
        !BRACKET_STAGE_TYPES.has(m.stage_type) && (m.round_name ?? '') === day
        && (m.score_a == null || m.score_b == null));
    // League days grouped by their non-digit prefix (e.g. "Day"). When every day in a
    // group has a suffix, the prefix is its category and the buttons carry bare
    // suffixes; otherwise the group has no category and the buttons carry the full name.
    const leagueGroups = [...groupBy(days, letters)].map(([prefix, group]) => {
        const items = group.map(([day]) => ({day, suffix: day.slice(prefix.length).trim()}));
        const labelled = prefix && items.every(i => i.suffix);
        return {
            name: labelled ? prefix : (items[0]?.day ?? prefix),
            label: labelled ? prefix : '',
            entries: items.map(i => ({
                day: i.day, param: i.day, text: labelled ? i.suffix : i.day, unfinished: dayUnfinished(i.day),
            })),
        };
    });
    // Bracket stages, one category each. A bracket is "unfinished" while it has a known
    // matchup that hasn't been played (a predictable node without a score).
    const bracketUnfinished = b => b.nodes.some(n => n.match_id != null && n.score_a == null);
    const byStage = new Map();
    brackets.forEach(b => pushTo(byStage, b.stage, b));
    const bracketGroups = [...byStage].map(([stage, list]) => ({
        name: stage,
        label: stage,
        bracket: true,
        entries: list.map(b => ({
            day: bracketDayKey(b.stage, b.key),
            // The stage alone names the tab unless it holds more than one bracket — only
            // then does the group (itself a merge of connected groups) earn a place too.
            param: `bracket:${stage}${list.length > 1 ? `:${b.key}` : ''}`,
            text: b.label,
            unfinished: bracketUnfinished(b),
        })),
    }));

    const bar = $('tabs-bar');
    bar.innerHTML = '';
    // Categories (labelled groups) get a top-line button each; groups without a label
    // (a lone tab like "Seedingwoche") have no category, so their tabs sit in the top
    // line next to the category buttons.
    const groups = [...leagueGroups, ...bracketGroups]
        .sort((a, b) => a.name.localeCompare(b.name));
    const categories = groups.filter(g => g.label);
    const loose = groups.filter(g => !g.label).flatMap(g => g.entries);
    state.categories = categories;

    const top = makeEl('div', {id: 'tab-categories', className: 'd-flex flex-wrap'});
    categories.forEach(g => {
        const btn = makeEl('button', {
            className: 'tab-btn btn category-btn', textContent: g.label,
        });
        btn.addEventListener('click', () => selectCategory(g));
        top.appendChild(btn);
    });
    loose.forEach(e => appendTabBtn(top, e));
    bar.appendChild(top);
    bar.appendChild(makeEl('div', {id: 'category-tabs', className: 'd-flex flex-wrap d-none'}));

    return [...categories.flatMap(g => g.entries), ...loose];
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

    // Tabs for league days and brackets together, sorted by group name; which one opens
    // is up to the URL (see activateWantedTab).
    state.tabs = renderTabs(days, brackets, matches);
    activateWantedTab();
}

// ============== Image dialog ==============
const activeDay = () => state.activeTab;

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
            // The inputs to fix live on the matches view.
            if (state.activeView !== 'matches') activateView('matches');
            const hiddenDays = new Set();
            invalid.forEach(input => {
                input.classList.add('invalid');
                const card = input.closest('.card');
                if (card.classList.contains('d-none')) hiddenDays.add(card.dataset.day);
                else shakeEl(input);
            });
            hiddenDays.forEach(day => {
                state.invalidDays.add(day);
                const tab = tabButtonFor(day);
                if (tab) shakeEl(tab);
            });
            refreshTabStates();
            return;
        }
        doSubmit(state.pendingIndices());
    });

    $('view-bar').querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.view !== state.activeView) activateView(btn.dataset.view);
        });
    });

    // Back/forward move between views instead of leaving the page.
    window.addEventListener('popstate', applyLocation);
}

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();

    let tournament;
    try {
        tournament = await findTournament();
    } catch {
        $('grid').innerHTML = '<p class="text-secondary text-center py-5">Failed to load tournaments. Please refresh.</p>';
        return;
    }
    // A link to a tournament that doesn't exist (any more) lands on the full list.
    if (!tournament) {
        location.replace('/');
        return;
    }

    state.activeTournament = tournament.tournament_id;
    $('tournament-name').textContent = tournament.name;
    document.title = `${tournament.name} – PULOW`;
    // The matches' render settles the tab and replaces the URL with the full view.
    activateView(wantedView(), null);
    await loadTournament(tournament.tournament_id);
});
