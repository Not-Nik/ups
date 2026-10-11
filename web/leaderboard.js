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
        // Percentage predictions (60:40) count like any other, but earn no points.
        const scores = !isPercentPrediction(p);
        e.predicted++;
        if (p.score_a === m.score_a && p.score_b === m.score_b) {
            e.exact++;
            e.correct++;
            if (scores) e.points += EXACT_POINTS;
        } else if (sameOutcome(p, m)) {
            e.correct++;
            if (scores) e.points += WINNER_POINTS;
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

// A league prediction scores once the group has started (`open` is false on its
// standings rows); until then it can still change and is left out.
// Per predicted team, with `diff` = |predicted place - current place|:
//   legacy points, as in last season's script: a team earns (teams in the group - diff);
//   a group's sum is divided by (teams in the group * predicted teams) and scaled to
//   STAGE_POINTS, shared equally by the stage's groups (40 for one group, 20 each for
//   two), then rounded to halves.
//   exact: diff is 0; top: the team currently sits inside the predicted range, the
//   top `pick_count` of its group (4, or what the admin panel sets for the stage).
const STAGE_POINTS = 40;
const roundHalf = x => Math.round(x * 2) / 2;

// [{name, leagues, legacy, exact, top, rank}], best first: most legacy points, then
// exact, then teams inside the predicted range. Ties share a rank.
function rankLeaguePredictions(standingRows, predictions) {
    const current = new Map();
    const teamCount = new Map();
    const stageGroups = new Map();
    const groupWeight = new Map();
    const pickCount = new Map();
    standingRows.forEach(r => {
        pickCount.set(r.group_id, r.pick_count);
        teamCount.set(r.group_id, (teamCount.get(r.group_id) ?? 0) + 1);
        if (!stageGroups.has(r.stage_number)) stageGroups.set(r.stage_number, new Set());
        stageGroups.get(r.stage_number).add(r.group_id);
        if (!r.open) current.set(`${r.group_id}:${r.team_id}`, r.position);
    });
    stageGroups.forEach(ids => ids.forEach(g => groupWeight.set(g, STAGE_POINTS / ids.size)));

    const byName = new Map();
    // name -> group_id -> {sum, count} for the legacy points
    const perGroup = new Map();
    predictions.forEach(p => {
        const now = current.get(`${p.group_id}:${p.team_id}`);
        if (now === undefined) return;
        if (!byName.has(p.name)) {
            byName.set(p.name, {name: p.name, leagues: 0, legacy: 0, exact: 0, top: 0});
            perGroup.set(p.name, new Map());
        }
        const e = byName.get(p.name);
        const g = perGroup.get(p.name);
        if (!g.has(p.group_id)) g.set(p.group_id, {sum: 0, count: 0});
        const diff = Math.abs(p.position - now);
        g.get(p.group_id).sum += teamCount.get(p.group_id) - diff;
        g.get(p.group_id).count++;
        if (diff === 0) e.exact++;
        if (now <= pickCount.get(p.group_id)) e.top++;
    });
    byName.forEach((e, name) => {
        perGroup.get(name).forEach(({sum, count}, groupId) => {
            e.legacy += roundHalf(sum / (teamCount.get(groupId) * count) * groupWeight.get(groupId));
            e.leagues++;
        });
    });
    const key = e => [-e.legacy, -e.exact, -e.top];
    const cmp = (a, b) => key(a).map((v, i) => v - key(b)[i]).find(d => d) ?? 0;
    const rows = [...byName.values()].sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name));
    rows.forEach((r, i) => {
        r.rank = i && cmp(rows[i - 1], r) === 0 ? rows[i - 1].rank : i + 1;
    });
    return rows;
}

function showLeaderboardPanel(panels, buttons, active) {
    panels.forEach((p, i) => {
        p.node.classList.toggle('d-none', p !== active);
        buttons[i].classList.toggle('active', p === active);
    });
}

async function renderLeaderboard(id) {
    const root = $('leaderboard');
    root.replaceChildren(leaderboardStatus('text-secondary', 'Loading…'));
    try {
        const [allMatches, standingRows, standingPicks] = await Promise.all([
            api(`/api/matches/${id}`),
            api(`/api/standings/${id}`),
            api(`/api/standings/predictions/${id}`),
        ]);
        const matches = allMatches.filter(m => m.score_a != null && m.score_b != null);
        const predictions = matches.length
            ? await api('/api/predictions', {method: 'POST', body: matches.map(m => m.id)})
            : [];
        const rows = rankLeaderboard(matches, predictions);
        const leagueRows = rankLeaguePredictions(standingRows, standingPicks);
        // League predictions come first. The sub-tab isn't kept in the URL.
        const panels = [
            {label: 'League predictions', node: leagueRows.length
                ? leaderboardTable(leagueRows, LEAGUE_COLUMNS)
                : leaderboardStatus('text-secondary', 'No predictions on started leagues yet.')},
            {label: 'Match predictions', node: rows.length
                ? leaderboardTable(rows, LEADERBOARD_COLUMNS)
                : leaderboardStatus('text-secondary', 'No predictions on finished matches yet.')},
        ];
        const bar = makeEl('div', {className: 'd-flex flex-wrap mb-3'});
        const buttons = panels.map(panel => {
            const btn = makeEl('button', {className: 'tab-btn btn category-btn', textContent: panel.label});
            btn.addEventListener('click', () => showLeaderboardPanel(panels, buttons, panel));
            bar.appendChild(btn);
            return btn;
        });
        root.replaceChildren(bar, ...panels.map(p => p.node));
        showLeaderboardPanel(panels, buttons, panels[0]);
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

const RANK_NAME_COLUMNS = LEADERBOARD_COLUMNS.slice(0, 2);

// League predictions; Points is the main score, higher is better.
const LEAGUE_COLUMNS = [
    ...RANK_NAME_COLUMNS,
    {key: 'leagues', head: 'Leagues', cls: 'standings-num', title: 'Leagues with a prediction that has started'},
    {key: 'top', head: 'In top', cls: 'standings-num',
        title: 'Predicted teams currently inside the predicted range (the top 4 of their league, or as many as it asks for)'},
    {key: 'exact', head: 'Exact', cls: 'standings-num', title: 'Teams predicted on exactly their current place'},
    {key: 'legacy', head: 'Points', cls: 'standings-num fw-semibold',
        title: `Up to ${STAGE_POINTS} per stage (shared by its groups), less for every place off`},
];

// Clicking a header sorts by it; clicking the sorted one again flips it. Rows arrive
// in rank order, and the sort is stable, so ties keep that order either way. The rank
// shown is always the points rank. The sort isn't kept in the URL.
function leaderboardTable(rows, columns) {
    // The logged-in user's row is highlighted; empty when logged out.
    const me = $('user-menu').classList.contains('d-none') ? '' : $('user-name').textContent;
    const card = makeEl('div', {className: 'card'});
    card.insertAdjacentHTML('beforeend', `
        <div class="card-body leaderboard-scroll">
            <table class="data-table leaderboard-table">
                <thead>
                    <tr>
                        ${columns.map(c => `
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
        const tr = makeEl('tr');
        tr.insertAdjacentHTML('beforeend', columns
            .map(c => `<td class="${c.cls}">${c.cell ? c.cell(r) : r[c.key]}</td>`).join(''));
        if (r.name === me) {
            tr.querySelector('.standings-team').append(' ', makeEl('span', {
                className: 'leaderboard-you',
                textContent: 'You',
            }));
        }
        return [r, tr];
    }));

    const sort = {key: 'rank', asc: true};
    const apply = () => {
        const col = columns.find(c => c.key === sort.key);
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
        const col = columns.find(c => c.key === btn.dataset.key);
        sort.asc = sort.key === col.key ? !sort.asc : !!col.asc;
        sort.key = col.key;
        apply();
    }));
    apply();
    return card;
}
