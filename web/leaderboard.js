// ============== Leaderboard ==============
// The Leaderboard view: everyone who predicted a finished match of the tournament,
// ranked by points, then by exact scores. Computed on the client from the tournament's
// matches and all predictions on the finished ones. Loaded once, the first time the
// view opens.

let leaderboardLoad = null;

const loadLeaderboard = id => leaderboardLoad ??= renderLeaderboard(id);

const leaderboardStatus = (cls, text) => makeEl('p', {
    className: `${cls} text-center py-5`,
    textContent: text,
});

// Points per prediction: the right winner earns WINNER_POINTS, an exact score
// EXACT_POINTS in total (not on top of the winner's).
const WINNER_POINTS = 1;
const EXACT_POINTS = 3;

// [{name, predicted, correct, exact, points, rank}], best first. Ties (same points
// and exact) share a rank; the name breaks them for display order.
function rankLeaderboard(matches, predictions) {
    const finished = new Map(matches.map(m => [m.id, m]));
    const byName = new Map();
    predictions.forEach(p => {
        const m = finished.get(p.id);
        if (!m) return;
        if (!byName.has(p.name)) byName.set(p.name, {name: p.name, predicted: 0, correct: 0, exact: 0, points: 0});
        const e = byName.get(p.name);
        e.predicted++;
        if (p.score_a === m.score_a && p.score_b === m.score_b) {
            e.exact++;
            e.correct++;
            e.points += EXACT_POINTS;
        } else if (sameOutcome(p, m)) {
            e.correct++;
            e.points += WINNER_POINTS;
        }
    });
    const rows = [...byName.values()].sort((a, b) =>
        b.points - a.points || b.exact - a.exact || a.name.localeCompare(b.name));
    rows.forEach((r, i) => {
        const prev = rows[i - 1];
        r.rank = prev && prev.points === r.points && prev.exact === r.exact ? prev.rank : i + 1;
    });
    return rows;
}

async function renderLeaderboard(id) {
    const root = $('leaderboard');
    root.replaceChildren(leaderboardStatus('text-secondary', 'Loading…'));
    try {
        const matches = (await api(`/api/matches/${id}`))
            .filter(m => m.score_a != null && m.score_b != null);
        const predictions = matches.length
            ? await api('/api/predictions', {method: 'POST', body: matches.map(m => m.id)})
            : [];
        const rows = rankLeaderboard(matches, predictions);
        if (!rows.length) {
            root.replaceChildren(leaderboardStatus('text-secondary', 'No predictions on finished matches yet.'));
            return;
        }
        root.replaceChildren(leaderboardTable(rows));
    } catch {
        // Let the next open try again.
        leaderboardLoad = null;
        root.replaceChildren(leaderboardStatus('text-danger', 'Failed to load leaderboard. Please refresh.'));
    }
}

// `asc` is the direction a column sorts in on its first click: rank and name read
// top-down, the counts biggest first.
const LEADERBOARD_COLUMNS = [
    {key: 'rank', head: 'Rank', cls: 'standings-rank', asc: true},
    {key: 'name', head: 'Name', cls: 'standings-team text-truncate', asc: true,
        compare: (a, b) => a.name.localeCompare(b.name), cell: r => escapeHtml(r.name)},
    {key: 'predicted', head: 'Predicted', cls: 'standings-num', title: 'Predictions on finished matches'},
    {key: 'correct', head: 'Winners', cls: 'standings-num', title: 'Correct winners, exact scores included'},
    {key: 'exact', head: 'Exact', cls: 'standings-num', title: 'Exact scores'},
    {key: 'accuracy', head: '%', cls: 'standings-num', title: 'Accuracy: share of predictions with the correct winner',
        compare: (a, b) => a.correct / a.predicted - b.correct / b.predicted,
        cell: r => `${Math.round(100 * r.correct / r.predicted)}%`},
    {key: 'points', head: 'Points', cls: 'standings-num fw-semibold',
        title: `${WINNER_POINTS} per correct winner, ${EXACT_POINTS} per exact score`},
];

// Clicking a header sorts by it; clicking the sorted one again flips it. Rows arrive
// in rank order, and the sort is stable, so ties keep that order either way. The rank
// shown is always the points rank. The sort isn't kept in the URL.
function leaderboardTable(rows) {
    // The logged-in user's row is highlighted; empty when logged out.
    const me = $('user-menu').classList.contains('d-none') ? '' : $('user-name').textContent;
    const card = makeEl('div', {className: 'card'});
    card.insertAdjacentHTML('beforeend', `
        <div class="card-body leaderboard-scroll">
            <table class="data-table leaderboard-table">
                <thead>
                    <tr>
                        ${LEADERBOARD_COLUMNS.map(c => `
                            <th class="${c.cls} leaderboard-col-${c.key}"${c.title ? ` title="${escapeAttr(c.title)}"` : ''}>
                                <button class="sort-btn" data-key="${c.key}">${c.head}</button>
                            </th>`).join('')}
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>`);
    const body = card.querySelector('tbody');
    const trs = new Map(rows.map(r => {
        const tr = makeEl('tr', {className: r.name === me ? 'leaderboard-me' : ''});
        tr.insertAdjacentHTML('beforeend', LEADERBOARD_COLUMNS
            .map(c => `<td class="${c.cls}">${c.cell ? c.cell(r) : r[c.key]}</td>`).join(''));
        return [r, tr];
    }));

    const sort = {key: 'rank', asc: true};
    const apply = () => {
        const col = LEADERBOARD_COLUMNS.find(c => c.key === sort.key);
        const compare = col.compare ?? ((a, b) => a[col.key] - b[col.key]);
        const sorted = [...rows].sort((a, b) => sort.asc ? compare(a, b) : compare(b, a));
        body.replaceChildren(...sorted.map(r => trs.get(r)));
        card.querySelectorAll('.sort-btn').forEach(btn => {
            const th = btn.parentElement;
            if (btn.dataset.key === sort.key) th.setAttribute('aria-sort', sort.asc ? 'ascending' : 'descending');
            else th.removeAttribute('aria-sort');
        });
    };
    card.querySelectorAll('.sort-btn').forEach(btn => btn.addEventListener('click', () => {
        const col = LEADERBOARD_COLUMNS.find(c => c.key === btn.dataset.key);
        sort.asc = sort.key === col.key ? !sort.asc : !!col.asc;
        sort.key = col.key;
        apply();
    }));
    apply();
    return card;
}
