// ============== Teams & players ==============
// The Teams and Players views: every team / every lineup entry of the tournament,
// each with a search box that filters what's already loaded. Each list loads once,
// the first time its view opens.

// Case- and accent-insensitive: "muller" finds "Müller".
const searchKey = s => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// Per view, re-run its search once its list is bound (see setRosterSearch).
const rosterSearches = {};

// Fill a view's search box and filter its list. A list that hasn't loaded yet reads
// the box when it binds.
function setRosterSearch(view, text) {
    $(`${view}-search`).value = text;
    rosterSearches[view]?.();
}

// Wire a search box to a list of items, each {el, text} with `text` already a
// searchKey. An item stays visible when it contains every whitespace-separated term.
function bindSearch(view, items) {
    const input = $(`${view}-search`);
    const count = $(`${view}-count`);
    const empty = $(`${view}-empty`);
    const apply = () => {
        const terms = searchKey(input.value).split(/\s+/).filter(Boolean);
        let shown = 0;
        items.forEach(({el, text}) => {
            const match = terms.every(t => text.includes(t));
            setHidden(el, !match);
            if (match) shown++;
        });
        count.textContent = terms.length ? `${shown} of ${items.length}` : `${items.length}`;
        setHidden(empty, shown > 0);
        // Nothing left to show: drop the list too, so the players' header row goes with it.
        setHidden($(view), shown === 0);
    };
    input.addEventListener('input', apply);
    rosterSearches[view] = apply;
    apply();
}

// Fetch one roster endpoint and hand its rows to `render`, with the loading, empty
// and failure states every list shares. Resolves true once rendered.
async function loadRoster(view, url, render) {
    const root = $(view);
    root.replaceChildren(makeEl('p', {className: 'text-secondary text-center py-5', textContent: 'Loading…'}));
    try {
        const {data: rows, res} = await api(url, {response: true});
        // Same background toornament refresh as /api/matches (see loadTournament).
        if (res.headers.get('X-Refreshing') === '1') showToast(REFRESH_MSG);
        if (!rows.length) {
            $(`${view}-search`).disabled = true;
            root.replaceChildren(makeEl('p', {
                className: 'text-secondary text-center py-5',
                textContent: `No ${view} for this tournament.`,
            }));
            return true;
        }
        root.replaceChildren();
        bindSearch(view, render(root, rows));
        return true;
    } catch {
        root.replaceChildren(makeEl('p', {
            className: 'text-danger text-center py-5',
            textContent: `Failed to load ${view}. Please refresh.`,
        }));
        return false;
    }
}

const logoHTML = (logo, cls) => logo ? `<img src="${escapeAttr(proxied(logo))}" class="${cls}" alt="">` : '';

// ============== Teams ==============
let teamsLoad = null;

const loadTeams = id => teamsLoad ??= loadRoster('teams', `/api/teams/${id}`, (root, teams) =>
    teams.map(team => {
        // The tile links to the team's lineup, like every team-link (see openTeamPlayers).
        const card = makeEl('a', {
            className: 'card roster-team team-link',
            href: teamPlayersHref(id, team.name),
            dataset: {team: team.name},
        });
        card.insertAdjacentHTML('beforeend', `
            <div class="card-body d-flex align-items-center gap-3">
                ${logoHTML(team.logo, 'roster-team-logo')}
                <div class="min-w-0">
                    <div class="fw-semibold text-truncate">${escapeHtml(team.name)}</div>
                    ${team.short_name ? `<div class="small text-secondary text-truncate">${escapeHtml(team.short_name)}</div>` : ''}
                </div>
            </div>`);
        root.appendChild(card);
        return {el: card, text: searchKey(`${team.name} ${team.short_name ?? ''}`)};
    })
).then(ok => ok || (teamsLoad = null));

// ============== Players ==============
let playersLoad = null;

const compareText = (a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'});

// Players arrive sorted by name (`order` keeps that). Sorting by team puts each
// lineup back together, in lineup order; names aren't unique, so teams are told
// apart by id.
const PLAYER_COLUMNS = [
    {key: 'name', head: 'Player', cls: 'fw-semibold', asc: true,
        compare: (a, b) => a.order - b.order, cell: p => escapeHtml(p.name)},
    {key: 'battle_tag', head: 'BattleTag', cls: 'text-secondary', asc: true,
        compare: (a, b) => compareText(a.battle_tag ?? '', b.battle_tag ?? ''),
        cell: p => escapeHtml(p.battle_tag ?? '')},
    {key: 'team', head: 'Team', asc: true,
        compare: (a, b) => compareText(a.team, b.team) || a.team_id - b.team_id || a.position - b.position,
        cell: p => `
            <span class="d-flex align-items-center gap-2">
                ${logoHTML(p.logo, 'team-logo')}
                <span class="text-truncate">${escapeHtml(p.team)}</span>
            </span>`},
];

const loadPlayers = id => playersLoad ??= loadRoster('players', `/api/players/${id}`, (root, players) => {
    players.forEach((p, i) => p.order = i);
    const {card, trs} = sortableTable(players, PLAYER_COLUMNS, {tableClass: 'roster-table'});
    root.appendChild(card);
    return players.map(p => ({
        el: trs.get(p),
        text: searchKey(`${p.name} ${p.battle_tag ?? ''} ${p.team} ${p.short_name ?? ''}`),
    }));
}).then(ok => ok || (playersLoad = null));
