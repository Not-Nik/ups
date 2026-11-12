// ============== Standings ==============
// The Standings view: one table per league/swiss/pools group, one table at a time.
// Its tab bar mirrors the matches one: a button per stage on top, and below it the
// group tabs of the open stage — left out when the stage has only one group, since
// its button already carries the selection. Rows arrive sorted by stage, group,
// then position, so that is the order each table opens in; every header sorts its
// table. Loaded once, the first time the view opens.

let standingsLoad = null;

const standings = {
    stages: [],      // [{name, tables: [table]}] in display order, a table as built by renderStandings
    active: null,    // param of the open table
    predictor: null, // whose picks the open table's C column shows; null for the community
    // The column every table sorts by, shared so it holds from table to table (and across
    // a predictor switch). Not kept in the URL, like the leaderboard's sort.
    sort: {key: 'position', asc: true},
};

const loadStandings = id => standingsLoad ??= renderStandings(id);

// URL form of a table (?table=): the stage name, plus ":<group>" only where the
// stage holds several groups. Like the tab params, only ever compared against the
// rendered tables.
const standingsParam = (stage, group, single) => single ? stage : `${stage}:${group}`;

// Read by syncUrl; null until the standings have loaded. A null predictor (the
// community) keeps ?predictor= out of the URL.
const activeStandingsTable = () => standings.active;
const activeStandingsPredictor = () => standings.predictor;

const stageOfTable = param => standings.stages.find(s => s.tables.some(t => t.param === param));
const tableOf = param => stageOfTable(param)?.tables.find(t => t.param === param);

// `record` works as in activateTab. The predictor stays chosen from table to table; one
// they didn't predict shows the community's order until a table they did comes up.
function activateStandingsTable(param, record = 'push') {
    standings.active = param;
    const stage = stageOfTable(param);
    const table = tableOf(param);
    if (table) {
        showPredictor(table, predictorIn(table, standings.predictor));
        // Sorted somewhere else since it was last open.
        table.resort();
    }
    renderPredictorPicker(table);
    $('standings-stage-tabs').querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.stage === stage?.name);
    });
    const row = $('standings-group-tabs');
    row.replaceChildren();
    setHidden(row, !stage || stage.tables.length === 1);
    stage?.tables.forEach(t => {
        const btn = makeEl('button', {
            className: 'tab-btn btn', textContent: t.label, dataset: {table: t.param},
        });
        btn.classList.toggle('active', t.param === param);
        btn.addEventListener('click', () => {
            if (t.param !== standings.active) activateStandingsTable(t.param);
        });
        row.appendChild(btn);
    });
    $('standings').querySelectorAll('.standings-card').forEach(card => {
        setHidden(card, card.dataset.table !== param);
    });
    if (record) syncUrl(record === 'replace');
}

// Open the table the URL asks for, else the first. `record` is 'replace' on load (so
// the URL names the table) and null on back/forward. No-op until loaded.
function activateWantedStandingsTable(record = null) {
    const all = standings.stages.flatMap(s => s.tables);
    if (!all.length) return;
    const params = urlParams();
    const wanted = params.get('table');
    standings.predictor = knownPredictor(params.get('predictor'));
    activateStandingsTable((all.find(t => t.param === wanted) ?? all[0]).param, record);
}

function renderStandingsTabs() {
    const bar = $('standings-tabs');
    const top = makeEl('div', {id: 'standings-stage-tabs', className: 'd-flex flex-wrap'});
    standings.stages.forEach(stage => {
        const btn = makeEl('button', {
            className: 'tab-btn btn category-btn', textContent: stage.name, dataset: {stage: stage.name},
        });
        // A stage opens its first group, unless one of its groups is already open.
        btn.addEventListener('click', () => {
            if (stageOfTable(standings.active) !== stage) activateStandingsTable(stage.tables[0].param);
        });
        top.appendChild(btn);
    });
    bar.replaceChildren(top, makeEl('div', {id: 'standings-group-tabs', className: 'd-flex flex-wrap d-none'}));
}

// ============== Top-N predictions ==============
// Under each group's table: the logged-in user's predicted top N, N being the stage's
// `pick_count` (set in the admin panel, 4 by default). While the group is `open` (none
// of its matches has a score) every team is listed and dragged into order by its
// handle, or moved with the arrow keys; the first `pick_count` are saved through
// /api/submit. Once the group is locked only the saved picks are shown.

// Map of group_id -> the user's picked team ids, 1st place first. Empty when logged out.
async function loadStandingPicks() {
    const picks = new Map();
    if (!getToken()) return picks;
    // A failed load costs the saved picks and nothing else — the tables still render.
    const data = await tryFetch(loadMyPredictions);
    // Sorted by group, then position.
    data?.standings.forEach(p => {
        if (!picks.has(p.group_id)) picks.set(p.group_id, []);
        picks.get(p.group_id).push(p.team_id);
    });
    return picks;
}

function pickRow(team, draggable) {
    const row = makeEl('li', {className: 'pick-row', dataset: {team: team.team_id}});
    row.insertAdjacentHTML('beforeend', `
        ${draggable ? `<button type="button" class="pick-handle" aria-label="Move ${escapeAttr(team.team)}">&#8801;</button>` : ''}
        <span class="pick-place"></span>
        ${team.logo ? `<img src="${escapeAttr(proxied(team.logo))}" class="team-logo" alt="">` : ''}
        <span class="text-truncate">${teamLinkHTML(state.activeTournament, team.team)}</span>`);
    return row;
}

// Number the first `count` rows, the ones that are saved; the rest are greyed out below
// a line (.pick-cut), which is only drawn where rows are left out below it.
function numberPicks(list, count) {
    const rows = [...list.children];
    rows.forEach((row, i) => {
        row.querySelector('.pick-place').textContent = i < count ? `${i + 1}.` : '';
        row.classList.toggle('pick-cut', i === count - 1 && i < rows.length - 1);
        row.classList.toggle('pick-out', i >= count);
    });
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Run `reorder`, which moves rows of `list`, then slide every row but `skip` from where
// it was drawn into its new slot. Starting from the drawn position (not the old slot)
// lets a row that's still sliding change course without a jump.
function slideRows(list, reorder, skip = null) {
    const rows = [...list.children].filter(row => row !== skip);
    const from = new Map(rows.map(row => [row, row.getBoundingClientRect().top]));
    reorder();
    if (reducedMotion()) return;
    rows.forEach(row => {
        row.getAnimations().forEach(a => a.cancel());
        const dy = from.get(row) - row.getBoundingClientRect().top;
        if (dy) row.animate([{transform: `translateY(${dy}px)`}, {transform: 'none'}], {duration: 150, easing: 'ease-out'});
    });
}

// Reorder `list` by dragging a row's handle (mouse or touch) or with the arrow keys on
// a focused handle. Calls onChange after every move.
function makePickable(list, onChange) {
    list.addEventListener('pointerdown', e => {
        const handle = e.target.closest('.pick-handle');
        if (!handle || e.button !== 0) return;
        e.preventDefault();
        const row = handle.closest('.pick-row');
        row.classList.add('dragging');
        // Where in the row it was grabbed, so that point stays under the pointer.
        const grab = e.clientY - row.getBoundingClientRect().top;
        // On the document rather than captured on the handle: moving the row in the DOM
        // would drop a pointer capture.
        const move = ev => {
            // Slots by layout (offsetTop ignores transforms), so rows that are still
            // sliding don't make the order flip back and forth.
            const y = ev.clientY - list.getBoundingClientRect().top;
            const before = [...list.children].find(other =>
                other !== row && y < other.offsetTop + other.offsetHeight / 2) ?? null;
            if (row.nextElementSibling !== before) {
                slideRows(list, () => list.insertBefore(row, before), row);
                onChange();
            }
            // The row sits in its new slot; shift it from there to follow the pointer, but
            // never past the top or bottom of the list.
            row.style.transform = '';
            const slot = row.getBoundingClientRect();
            const bounds = list.getBoundingClientRect();
            const top = Math.min(Math.max(ev.clientY - grab, bounds.top), bounds.bottom - slot.height);
            row.style.transform = `translateY(${top - slot.top}px)`;
        };
        const end = () => {
            row.style.transform = '';
            row.classList.remove('dragging');
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', end);
            document.removeEventListener('pointercancel', end);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
        document.addEventListener('pointercancel', end);
    });
    // Moves the neighbour rather than the row itself, so the handle keeps focus.
    list.addEventListener('keydown', e => {
        const row = e.target.closest('.pick-handle')?.closest('.pick-row');
        if (!row) return;
        const {previousElementSibling: prev, nextElementSibling: next} = row;
        if (e.key === 'ArrowUp' && prev) {
            slideRows(list, () => list.insertBefore(prev, next));
        } else if (e.key === 'ArrowDown' && next) {
            slideRows(list, () => list.insertBefore(next, row));
        } else {
            return;
        }
        e.preventDefault();
        onChange();
    });
}

// The prediction block for one group's table, or null when there's nothing to show
// (a locked group the user didn't predict).
function standingsPrediction(rows, saved) {
    const {group_id, open} = rows[0];
    // A row without a usable pick_count still gets the server's default, so a group is
    // never numbered to zero places and an empty prediction submitted.
    const pickCount = Number(rows[0].pick_count);
    const count = pickCount > 0 ? pickCount : DEFAULT_PICK_COUNT;
    const teams = new Map(rows.map(r => [r.team_id, r]));
    const picked = saved.filter(id => teams.has(id));
    if (!open && !picked.length) return null;

    const box = makeEl('div', {className: 'pick-box mt-4'});
    box.insertAdjacentHTML('beforeend', `<div class="section-title mb-1">Your top ${Math.min(count, rows.length)}</div>`);
    const list = makeEl('ol', {className: 'pick-list'});

    if (!open) {
        picked.forEach(id => list.appendChild(pickRow(teams.get(id), false)));
        // Every saved pick counts, even if the stage's pick count was lowered since.
        numberPicks(list, picked.length);
        box.appendChild(list);
        return box;
    }

    box.insertAdjacentHTML('beforeend', `
        <p class="small text-secondary mb-2">
            Drag the teams into the order you expect.${rows.length > count ? ` The top ${count} are submitted.` : ''}
        </p>`);
    // Saved picks first, then the rest in table order.
    [...picked, ...rows.map(r => r.team_id).filter(id => !picked.includes(id))]
        .forEach(id => list.appendChild(pickRow(teams.get(id), true)));
    numberPicks(list, count);

    const save = makeEl('button', {className: 'btn btn-success btn-sm mt-3'});
    // Worded like the matches' "Submit Predictions" button.
    const setSaved = isSaved => {
        save.disabled = isSaved;
        save.textContent = isSaved ? 'Submitted' : 'Submit Prediction';
    };
    setSaved(picked.length > 0);
    makePickable(list, () => {
        numberPicks(list, count);
        setSaved(false);
    });
    save.addEventListener('click', async () => {
        save.disabled = true;
        const top = [...list.children].slice(0, count).map(row => Number(row.dataset.team));
        if (await submitWithName({standings: [{group_id, teams: top}]})) {
            setSaved(true);
            showToast('Prediction submitted.');
        } else {
            save.disabled = false;
        }
    });

    box.append(list, save);
    return box;
}

async function renderStandings(id) {
    const root = $('standings');
    renderStatus(root, {text: 'Loading…'});
    try {
        const [rows, picks, crowd] = await Promise.all([
            loadStandingsRows(id),
            loadStandingPicks(),
            // A failed load of everyone's picks costs the crowd column and nothing else.
            tryFetch(() => loadStandingPredictions(id)) ?? [],
        ]);
        if (!rows.length) {
            renderStatus(root, {text: 'No standings for this tournament.'});
            return;
        }
        const picksByGroup = groupBy(crowd, p => p.group_id);
        root.replaceChildren();
        standings.stages = [...groupBy(rows, r => r.stage_number).values()].map(stageRows => {
            const groups = [...groupBy(stageRows.map(([r]) => r), r => r.group_number).values()]
                .map(groupRows => groupRows.map(([r]) => r));
            const name = groups[0][0].stage_name;
            return {
                name,
                tables: groups.map(groupRows => {
                    const {group_name, group_id} = groupRows[0];
                    const param = standingsParam(name, group_name, groups.length === 1);
                    const predicted = (picksByGroup.get(group_id) ?? []).map(([p]) => p);
                    const table = {
                        param, label: group_name || name, rows: groupRows,
                        crowd: crowdAverages(groupRows, predicted),
                        places: predictorPlaces(groupRows, predicted),
                        prediction: standingsPrediction(groupRows, picks.get(group_id) ?? []),
                        card: null, shown: undefined,
                    };
                    showPredictor(table, null);
                    return table;
                }),
            };
        });
        renderStandingsTabs();
        activateWantedStandingsTable('replace');
    } catch {
        // Let the next open try again.
        standingsLoad = null;
        renderStatus(root, {cls: 'text-danger', text: 'Failed to load standings. Please refresh.'});
    }
}

const signed = n => n > 0 ? `+${n}` : `${n}`;

// ============== The crowd's order ==============
// Every user's top N of a group turned into points: their first pick scores the group's
// pick slots (4 by default, cut down to the group's size), their second one less, and so
// on down to 1; a team they left out scores nothing. Those points, averaged over the
// people who predicted the group, give each team its place in the crowd's order — the
// column's number, tied scores sharing a place and the teams nobody picked sharing the
// last one. Null, and so no column at all, where the group has no usable picks.
function crowdAverages(rows, picks) {
    const {slots, scored} = scoredPicks(rows, picks);
    if (!scored.length) return null;
    const points = new Map(rows.map(r => [r.team_id, 0]));
    scored.forEach(p => points.set(p.team_id, points.get(p.team_id) + slots - p.position + 1));
    const best = [...points].sort((a, b) => b[1] - a[1]);
    const place = new Map();
    best.forEach(([team, sum], i) => place.set(team,
        i && best[i - 1][1] === sum ? place.get(best[i - 1][0]) : i + 1));
    return {place, points, predictors: new Set(scored.map(p => p.name)).size};
}

// The picks of a group that count: teams still in its standings, placed within its pick
// slots (its `pick_count`, 4 by default, cut down to the group's size).
function scoredPicks(rows, picks) {
    const count = Number(rows[0].pick_count);
    const slots = Math.min(count > 0 ? count : DEFAULT_PICK_COUNT, rows.length);
    const teams = new Set(rows.map(r => r.team_id));
    return {slots, scored: picks.filter(p => teams.has(p.team_id) && p.position >= 1 && p.position <= slots)};
}

// Each predictor's own order of a group, from the same picks the crowd's order counts: a
// Map of name -> Map(team_id -> predicted place), in name order. Empty where nobody predicted.
function predictorPlaces(rows, picks) {
    const places = new Map();
    scoredPicks(rows, picks).scored.forEach(p => {
        if (!places.has(p.name)) places.set(p.name, new Map());
        places.get(p.name).set(p.team_id, p.position);
    });
    return new Map([...places].sort(([a], [b]) => a.localeCompare(b)));
}

// A predicted place read against the team's rank: rated higher than it stands (green)
// or lower (red).
const placeRating = (place, rank) => place < rank ? 'text-success' : place > rank ? 'text-danger' : '';

// The community's place for a team, its exact average points in the hover bubble.
function crowdColumn({place, points, predictors}) {
    return {
        key: 'place', head: 'C', cls: 'standings-rank', asc: true,
        title: 'Community Prediction',
        compare: (a, b) => place.get(a.team_id) - place.get(b.team_id),
        cell: r => exactCell(place.get(r.team_id), points.get(r.team_id) / predictors,
            placeRating(place.get(r.team_id), r.rank)),
    };
}

// One predictor's place for a team, a dash for the teams they left out, which sort last.
function predictorColumn(name, place) {
    const at = r => place.get(r.team_id) ?? Infinity;
    return {
        key: 'place', head: 'C', cls: 'standings-rank', asc: true,
        title: `${name}'s prediction`,
        compare: (a, b) => at(a) === at(b) ? 0 : at(a) - at(b),
        cell: r => place.has(r.team_id) ? `<span class="${placeRating(at(r), r.rank)}">${at(r)}</span>` : '–',
    };
}

// ============== Whose prediction ==============
// The dropdown above the table picks whose order the C column shows: the community's, or
// that of any one person who predicted the open group, found through its search box. The
// choice is ?predictor=<name>, left out for the community. It holds across tables: one the
// person didn't predict shows the community's order, the dropdown still naming them.

// The table's own spelling of `name`, or null (the community) where they didn't predict it.
function predictorIn(table, name) {
    if (name == null || table.places.has(name)) return name ?? null;
    const key = name.toLowerCase();
    return [...table.places.keys()].find(n => n.toLowerCase() === key) ?? null;
}

// One standings table (its ?table= param) with `predictor`'s picks in the C column.
const standingsPredictorHref = (tournamentId, table, predictor) => `${tournamentHref(tournamentId)}`
    + `&view=standings&table=${encodeURIComponent(table)}&predictor=${encodeURIComponent(predictor)}`;

// Where the names of a league leaderboard tab lead: name -> the ?table= param of the
// first group of `items` (the tab's standing rows, in standings order) the person
// predicted, counting the picks the C column does. `standingRows` are the whole
// tournament's, which tell whether a stage's param needs its group.
function predictorTables(items, standingRows, picks) {
    const groupsOfStage = new Map();
    standingRows.forEach(r => {
        if (!groupsOfStage.has(r.stage_number)) groupsOfStage.set(r.stage_number, new Set());
        groupsOfStage.get(r.stage_number).add(r.group_id);
    });
    const picksByGroup = groupBy(picks, p => p.group_id);
    const tables = new Map();
    groupBy(items, r => r.group_id).forEach(listed => {
        const rows = listed.map(([r]) => r);
        const {stage_name, stage_number, group_name, group_id} = rows[0];
        const table = standingsParam(stage_name, group_name, groupsOfStage.get(stage_number).size === 1);
        predictorPlaces(rows, (picksByGroup.get(group_id) ?? []).map(([p]) => p)).forEach((_, name) => {
            if (!tables.has(name)) tables.set(name, table);
        });
    });
    return tables;
}

// Open the Standings view on `table` with `predictor`'s picks, in place, as the one
// history entry a link click would make: the view pushes it, and a first load of the
// standings and then the table and predictor only ever replace it.
async function openStandingsPredictor(table, predictor) {
    activateView('standings');
    await loadStandings(state.activeTournament);
    if (state.activeView !== 'standings' || !tableOf(table)) return;
    standings.predictor = knownPredictor(predictor);
    activateStandingsTable(table, 'replace');
}

// The stored spelling of `name` from whichever table they predicted, or null for a name
// that predicted none of this tournament's groups.
function knownPredictor(name) {
    for (const table of standings.stages.flatMap(s => s.tables)) {
        const found = predictorIn(table, name);
        if (found) return found;
    }
    return null;
}

// Draw a table with `name`'s picks in its C column, or the community's for null. Only the
// table is rebuilt: the "Your top N" box under it moves over to the new card as it stands,
// an unsaved order included.
function showPredictor(table, name) {
    if (table.shown === name) return;
    table.shown = name;
    const {card, resort} = standingsTable(table.rows,
        name == null ? table.crowd && crowdColumn(table.crowd) : predictorColumn(name, table.places.get(name)));
    table.resort = resort;
    card.dataset.table = table.param;
    if (table.prediction) card.querySelector('.card-body').appendChild(table.prediction);
    // The dropdown, where it sits in the card being replaced, goes along.
    const picker = table.card?.querySelector('#standings-predictor');
    if (picker) card.querySelector('.standings-head').append(picker);
    if (table.card) {
        setHidden(card, table.card.classList.contains('d-none'));
        table.card.replaceWith(card);
    } else {
        $('standings').appendChild(card);
    }
    table.card = card;
}

// `record` works as in activateTab.
function selectPredictor(name, record = 'push') {
    const table = tableOf(standings.active);
    if (!table) return;
    standings.predictor = predictorIn(table, name);
    showPredictor(table, standings.predictor);
    renderPredictorPicker(table);
    if (record) syncUrl(record === 'replace');
}

// Fill the dropdown with the open table's predictors; hidden where nobody predicted it.
// A chosen predictor without picks here stays on the button, marked as such, while the
// menu checks the community the table falls back to.
function renderPredictorPicker(table) {
    const names = [...(table?.places.keys() ?? [])];
    const shown = table ? predictorIn(table, standings.predictor) : null;
    const absent = standings.predictor != null && shown == null;
    const picker = $('standings-predictor');
    if (table) table.card.querySelector('.standings-head').append(picker);
    setHidden(picker, !names.length);
    $('predictor-name').textContent = standings.predictor ?? 'Community';
    setHidden($('predictor-absent'), !absent);
    $('predictor-btn').title = absent
        ? `${standings.predictor} didn't predict this group: showing the community's prediction`
        : 'Whose prediction the C column shows';
    $('predictor-list').replaceChildren(...[null, ...names].map(name => {
        const item = makeEl('button', {
            className: 'user-dropdown-item predictor-item',
            textContent: name ?? 'Community',
            dataset: name == null ? {} : {key: searchKey(name)},
        });
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(name === shown));
        if (name != null && name === myName) {
            item.append(makeEl('span', {className: 'leaderboard-you', textContent: 'You'}));
        }
        item.addEventListener('click', () => {
            setPredictorPickerOpen(false);
            $('predictor-btn').focus();
            if (name !== standings.predictor) selectPredictor(name);
        });
        return item;
    }));
    filterPredictors();
}

// The search box keeps the names holding every typed word; the community always stays.
function filterPredictors() {
    const terms = searchKey($('predictor-search').value).split(/\s+/).filter(Boolean);
    let shown = 0;
    $('predictor-list').querySelectorAll('.predictor-item[data-key]').forEach(item => {
        const match = terms.every(t => item.dataset.key.includes(t));
        setHidden(item, !match);
        if (match) shown++;
    });
    setHidden($('predictor-empty'), shown > 0);
}

function setPredictorPickerOpen(open) {
    setHidden($('predictor-menu'), !open);
    $('predictor-btn').setAttribute('aria-expanded', String(open));
    if (!open) return;
    $('predictor-search').value = '';
    filterPredictors();
    $('predictor-search').focus();
}

// Up and down walk the search box and the visible names, Enter in the box takes the first
// name left, Escape closes the menu back onto its button.
function bindPredictorPicker() {
    const picker = $('standings-predictor');
    const menu = $('predictor-menu');
    const search = $('predictor-search');
    const visibleItems = () => [...menu.querySelectorAll('.predictor-item:not(.d-none)')];
    onClick('predictor-btn', () => setPredictorPickerOpen(menu.classList.contains('d-none')));
    document.addEventListener('click', e => {
        if (!picker.contains(e.target)) setPredictorPickerOpen(false);
    });
    search.addEventListener('input', filterPredictors);
    picker.addEventListener('keydown', e => {
        if (menu.classList.contains('d-none')) return;
        const stops = [search, ...visibleItems()];
        const at = stops.indexOf(document.activeElement);
        if (e.key === 'Escape') {
            setPredictorPickerOpen(false);
            $('predictor-btn').focus();
        } else if (e.key === 'Enter' && e.target === search) {
            (visibleItems().find(item => item.dataset.key) ?? visibleItems()[0])?.click();
        } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && at >= 0) {
            stops[Math.min(Math.max(at + (e.key === 'ArrowDown' ? 1 : -1), 0), stops.length - 1)].focus();
        } else {
            return;
        }
        e.preventDefault();
    });
}

bindPredictorPicker();

// Swiss groups carry no map scores and a tiebreaker-weighted `points` value, so they
// show W/L only. Draws get a column only where a group actually has some (the crowd's
// place, `crowdAverages`, likewise). Every column sorts on its own numbers, best first at
// the first click.
function standingsColumns(rows) {
    const swiss = rows[0].stage_type === 'swiss';
    const draws = rows.some(r => r.draws > 0);
    const num = (key, head, title, extra = {}) => ({key, head, title, cls: 'standings-num', ...extra});
    return [
        num('played', 'P', 'Played'),
        num('wins', 'W', 'Wins', {asc: false}),
        ...(draws ? [num('draws', 'D', 'Draws', {asc: false})] : []),
        num('losses', 'L', 'Losses'),
        ...(swiss ? [] : [
            num('maps', 'Maps', 'Maps won : lost', {
                cls: 'standings-num standings-wide', asc: false,
                cell: r => `${r.score_for}:${r.score_against}`,
                compare: (a, b) => (a.score_for ?? 0) - (b.score_for ?? 0),
            }),
            num('diff', '+/-', 'Map difference', {
                asc: false, cell: r => signed(r.score_difference ?? 0),
                compare: (a, b) => (a.score_difference ?? 0) - (b.score_difference ?? 0),
            }),
            num('points', 'Pts', 'Points', {cls: 'standings-num fw-semibold', asc: false}),
        ]),
    ];
}

// `place` is the C column (crowdColumn or predictorColumn), null for none. Every table
// sorts by the one shared `standings.sort`; returns {card, resort}.
function standingsTable(rows, place) {
    const first = rows[0];
    const {card, trs, resort} = sortableTable(rows, [
        {key: 'position', head: '#', title: 'Rank', cls: 'standings-rank', asc: true, cell: r => r.rank},
        ...(place ? [place] : []),
        {
            key: 'team', head: 'Team', cls: 'standings-team', asc: true,
            compare: (a, b) => a.team.localeCompare(b.team),
            cell: r => `<span class="d-flex align-items-center gap-2">
                ${r.logo ? `<img src="${escapeAttr(proxied(r.logo))}" class="team-logo" alt="">` : ''}
                <span class="text-truncate">${teamLinkHTML(state.activeTournament, r.team)}</span>
            </span>`,
        },
        ...standingsColumns(rows),
    ], {sort: standings.sort});
    card.classList.add('standings-card');
    // The title line also holds the predictor dropdown, on whichever table is open.
    card.querySelector('.card-body').insertAdjacentHTML('afterbegin', `<div class="standings-head mb-2">
        <div class="section-title">${escapeHtml(first.group_name || first.stage_name)}</div>
    </div>`);
    trs.forEach((tr, r) => {
        tr.classList.toggle('standings-dropped', r.dropped);
        if (r.dropped) tr.title = 'Dropped out';
    });
    return {card, resort};
}
