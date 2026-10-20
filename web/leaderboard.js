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
const EXACT_POINTS = 2;

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
// Per predicted team, with `diff` = |predicted place - current place| and
//   max = teams in the group - 1: a team earns (max - diff) — never negative, since no
//   pick can be more than max places off, and max for an exact one. A group's sum is
//   divided by (max * predicted teams), the most this user could score there, and
//   scaled to STAGE_POINTS, shared equally by the stage's groups (40 for one group,
//   20 each for two). A perfect league is worth exactly STAGE_POINTS and every place a
//   pick is off costs it its full share. The total over a user's groups is rounded to
//   quarters, the exact number shown on hover.
//   exact: diff is 0; top: the team currently sits inside the predicted range, the
//   top `pick_count` of its group (4, or what the admin panel sets for the stage).
const STAGE_POINTS = 40;
const roundQuarter = x => Math.round(x * 4) / 4;
// The rounded score keeps its two decimals; the exact one, cut after the last
// significant digit, sits in a bubble over it on hover.
function pointsCell(points, exact) {
    const value = escapeAttr(String(Number(exact.toFixed(6))));
    return `<span class="leaderboard-exact" data-exact="${value}">${points.toFixed(2)}</span>`;
}

// [{name, leagues, points, pointsExact, exact, top, rank}], best first: most points,
// then exact, then teams inside the predicted range. Ties share a rank.
function rankLeaguePredictions(standingRows, predictions) {
    const current = new Map();
    const teamSizes = new Map();
    const stageGroups = new Map();
    const groupWeight = new Map();
    const pickCount = new Map();
    standingRows.forEach(r => {
        pickCount.set(r.group_id, r.pick_count);
        teamSizes.set(r.group_id, (teamSizes.get(r.group_id) ?? 0) + 1);
        if (!stageGroups.has(r.stage_number)) stageGroups.set(r.stage_number, new Set());
        stageGroups.get(r.stage_number).add(r.group_id);
        if (!r.open) current.set(`${r.group_id}:${r.team_id}`, r.position);
    });
    stageGroups.forEach(ids => ids.forEach(g => groupWeight.set(g, STAGE_POINTS / ids.size)));
    const maxPickPoints = groupId => teamSizes.get(groupId) - 1;

    const byName = new Map();
    // name -> group_id -> {sum, count} of the scored picks
    const perGroup = new Map();
    predictions.forEach(p => {
        const now = current.get(`${p.group_id}:${p.team_id}`);
        if (now === undefined) return;
        if (!byName.has(p.name)) {
            byName.set(p.name, {name: p.name, leagues: 0, points: 0, pointsExact: 0, exact: 0, top: 0});
            perGroup.set(p.name, new Map());
        }
        const e = byName.get(p.name);
        const g = perGroup.get(p.name);
        if (!g.has(p.group_id)) g.set(p.group_id, {sum: 0, count: 0});
        const diff = Math.abs(p.position - now);
        g.get(p.group_id).sum += maxPickPoints(p.group_id) - diff;
        g.get(p.group_id).count++;
        if (diff === 0) e.exact++;
        if (now <= pickCount.get(p.group_id)) e.top++;
    });
    byName.forEach((e, name) => {
        perGroup.get(name).forEach(({sum, count}, groupId) => {
            const max = maxPickPoints(groupId);
            if (max > 0) e.pointsExact += sum / (max * count) * groupWeight.get(groupId);
            e.leagues++;
        });
        e.points = roundQuarter(e.pointsExact);
    });
    const key = e => [-e.points, -e.exact, -e.top];
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
            {
                label: 'League predictions', node: leagueRows.length
                    ? leaderboardTable(leagueRows, LEAGUE_COLUMNS)
                    : leaderboardStatus('text-secondary', 'No predictions on started leagues yet.')
            },
            {
                label: 'Match predictions', node: rows.length
                    ? leaderboardTable(rows, LEADERBOARD_COLUMNS)
                    : leaderboardStatus('text-secondary', 'No predictions on finished matches yet.')
            },
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
    {
        key: 'name', head: 'Name', cls: 'standings-team text-truncate', asc: true,
        compare: (a, b) => a.name.localeCompare(b.name), cell: r => escapeHtml(r.name)
    },
    {key: 'predicted', head: 'Predicted', cls: 'standings-num', title: 'Predictions on finished matches'},
    {key: 'correct', head: 'Winners', cls: 'standings-num', title: 'Correct winners, exact scores included'},
    {key: 'exact', head: 'Exact', cls: 'standings-num', title: 'Exact scores'},
    {
        key: 'accuracy',
        head: '%',
        cls: 'standings-num',
        title: 'Accuracy: share of predictions with the correct winner',
        compare: (a, b) => a.correct / a.predicted - b.correct / b.predicted,
        cell: r => `${Math.round(100 * r.correct / r.predicted)}%`
    },
    {
        key: 'points', head: 'Points', cls: 'standings-num fw-semibold',
        title: `${WINNER_POINTS} per correct winner, ${EXACT_POINTS} per exact score`
    },
];

const RANK_NAME_COLUMNS = LEADERBOARD_COLUMNS.slice(0, 2);

// League predictions; Points is the main score, higher is better.
const LEAGUE_COLUMNS = [
    ...RANK_NAME_COLUMNS,
    {key: 'leagues', head: 'Leagues', cls: 'standings-num', title: 'Leagues with a prediction that has started'},
    {
        key: 'top', head: 'In top', cls: 'standings-num',
        title: 'Predicted teams currently inside the predicted range (the top 4 of their league, or as many as it asks for)'
    },
    {key: 'exact', head: 'Exact', cls: 'standings-num', title: 'Teams predicted on exactly their current place'},
    {
        key: 'points', head: 'Points', cls: 'standings-num fw-semibold',
        title: `Up to ${STAGE_POINTS} per league (shared by its groups), less for every place a pick is off. Rounded to quarters, the exact number on hover`,
        cell: r => pointsCell(r.points, r.pointsExact)
    },
];

// A sortableTable (app.js) of leaderboard rows. They arrive in rank order, and the sort
// is stable, so ties keep that order either way. The rank shown is always the points rank.
function leaderboardTable(rows, columns) {
    const {card, trs} = sortableTable(rows, columns, {
        sortKey: 'rank',
        tableClass: 'leaderboard-table',
        bodyClass: 'leaderboard-scroll',
    });
    // The logged-in user's name is marked; empty when logged out.
    const me = $('user-menu').classList.contains('d-none') ? '' : $('user-name').textContent;
    trs.forEach((tr, r) => {
        if (r.name !== me) return;
        tr.querySelector('.standings-team').append(' ', makeEl('span', {
            className: 'leaderboard-you',
            textContent: 'You',
        }));
    });
    return card;
}
