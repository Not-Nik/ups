// ============== Teams & players ==============
// The Teams and Players views: every team / every lineup entry of the tournament,
// each with a search box that filters what's already loaded. Each list loads once,
// the first time its view opens.

// Case- and accent-insensitive: "muller" finds "Müller".
const searchKey = s => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

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

const logoHTML = (logo, cls) => logo ? `<img src="${escapeAttr(logo)}" class="${cls}" alt="">` : '';

// ============== Teams ==============
let teamsLoad = null;

const loadTeams = id => teamsLoad ??= loadRoster('teams', `/api/teams/${id}`, (root, teams) =>
    teams.map(team => {
        const card = makeEl('div', {className: 'card roster-team'});
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

const loadPlayers = id => playersLoad ??= loadRoster('players', `/api/players/${id}`, (root, players) => {
    const card = makeEl('div', {className: 'card'});
    card.insertAdjacentHTML('beforeend', `
        <div class="card-body">
            <table class="data-table roster-table">
                <thead>
                    <tr><th>Player</th><th>BattleTag</th><th>Team</th></tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>`);
    const body = card.querySelector('tbody');
    root.appendChild(card);
    return players.map(p => {
        const row = makeEl('tr');
        row.insertAdjacentHTML('beforeend', `
            <td class="fw-semibold">${escapeHtml(p.name)}</td>
            <td class="text-secondary">${escapeHtml(p.battle_tag ?? '')}</td>
            <td>
                <span class="d-flex align-items-center gap-2">
                    ${logoHTML(p.logo, 'team-logo')}
                    <span class="text-truncate">${escapeHtml(p.team)}</span>
                </span>
            </td>`);
        body.appendChild(row);
        return {el: row, text: searchKey(`${p.name} ${p.battle_tag ?? ''} ${p.team} ${p.short_name ?? ''}`)};
    });
}).then(ok => ok || (playersLoad = null));
