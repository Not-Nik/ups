// ============== Leaderboard ==============
// The Leaderboard view: everyone who predicted a finished match of the tournament,
// ranked by points, then by exact scores. Computed on the client from the tournament's
// matches and all predictions on the finished ones. Loaded once, the first time the
// view opens, into two panels — league predictions and match predictions — each with a
// stage and group tab line of its own (see "Stages and groups of a leaderboard").

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

// Every group's share of its stage's points: STAGE_POINTS for a stage on its own, half
// of it where the stage holds two groups, and so on. Computed over a whole tournament,
// so a single group's table still shows only what that group adds up to.
function groupWeights(standingRows) {
    const stages = new Map();
    standingRows.forEach(r => {
        if (!stages.has(r.stage_number)) stages.set(r.stage_number, new Set());
        stages.get(r.stage_number).add(r.group_id);
    });
    const weights = new Map();
    stages.forEach(ids => ids.forEach(g => weights.set(g, STAGE_POINTS / ids.size)));
    return weights;
}

// [{name, leagues, points, pointsExact, exact, top, rank}], best first: most points,
// then exact, then teams inside the predicted range. Ties share a rank.
function rankLeaguePredictions(standingRows, predictions, groupWeight = groupWeights(standingRows)) {
    const current = new Map();
    const teamSizes = new Map();
    const pickCount = new Map();
    standingRows.forEach(r => {
        pickCount.set(r.group_id, r.pick_count);
        teamSizes.set(r.group_id, (teamSizes.get(r.group_id) ?? 0) + 1);
        if (!r.open) current.set(`${r.group_id}:${r.team_id}`, r.position);
    });
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

// ============== Stages and groups of a leaderboard ==============
// Both tables open on everyone combined, then a category per stage with a tab per group
// of it below and an "All" ahead of those, holding the stage's groups together — the
// same two lines the matches and standings views use. Every tab ranks on its own subset,
// so each one is a race of its own (a group's table tops out at STAGE_POINTS by itself).
// Neither line is kept in the URL.

const ALL_TAB = 'All';

const tabButton = (label, onClick) => {
    const btn = makeEl('button', {className: 'tab-btn btn category-btn', textContent: label});
    btn.addEventListener('click', onClick);
    return btn;
};

// Two lines of tabs above one table each: a button per category, and under it the tabs
// of the open category. A category with a single tab shows no second line, and a tab's
// `build` only runs the first time it opens, so a leaderboard with a tab per group
// builds no table nobody looks at.
function leaderboardTabs(categories) {
    const panel = makeEl('div');
    const nodeOf = tab => tab.node ??= tab.build();
    const hasGroups = category => category.tabs.length > 1;
    if (categories.length < 2 && !hasGroups(categories[0])) return nodeOf(categories[0].tabs[0]);

    const cats = makeEl('div', {className: 'd-flex flex-wrap'});
    const subs = makeEl('div', {className: 'd-flex flex-wrap'});
    categories.forEach(category => {
        category.button = tabButton(category.label, () => select(category.tabs[0]));
        category.tabs.forEach(tab => {
            tab.button = tabButton(tab.label, () => select(tab));
        });
        cats.append(category.button);
    });
    const select = active => {
        const category = categories.find(c => c.tabs.includes(active));
        const shown = nodeOf(active);
        if (shown.parentElement !== panel) panel.append(shown);
        categories.forEach(c => {
            c.button.classList.toggle('active', c === category);
            c.tabs.forEach(t => {
                t.button.classList.toggle('active', t === active);
                if (t.node) setHidden(t.node, t !== active);
            });
        });
        subs.replaceChildren(...category.tabs.map(t => t.button));
        setHidden(subs, !hasGroups(category));
    };
    const bars = makeEl('div', {className: 'd-flex flex-column mb-3'});
    bars.append(cats, subs);
    panel.append(bars);
    select(categories[0].tabs[0]);
    return panel;
}

// A tab covers one stage/group pair: a section key without the round, so a whole league
// group or bracket is one tab. A match with no group (a seeding week) is named by its
// round instead, which is what the matches view shows for it.
const matchSubgroupKey = m => [m.stage_name ?? '', m.group_name ?? '', m.group_name ? '' : m.round_name ?? '']
    .join(SECTION_SEP);
const groupSubgroupKey = r => [r.stage_name ?? '', r.group_name ?? '', ''].join(SECTION_SEP);
// A key's stage and group with its round blanked, so ordering falls through to the
// league (Erste < Zweite < …) and the group name.
const stageGroupOf = key => {
    const [stage, group] = sectionParts(key);
    return [stage, group, ''].join(SECTION_SEP);
};

// One category per stage of `items`, its tabs the stage's groups, both in the order the
// matches view uses, with "All" in front of them once a stage has more than one.
// `tabOf(label, items)` builds a tab, or returns null to leave that group out; a stage
// whose groups all drop out gets no category.
function stageCategories(items, keyOf, tabOf) {
    const pairs = [...groupBy(items, keyOf)].map(([key, listed]) => {
        const [stage, ...rest] = sectionParts(key);
        return {key, stage, label: rest.find(Boolean) ?? stage, items: listed.map(([item]) => item)};
    }).sort((a, b) => sectionOrder(stageGroupOf(a.key), stageGroupOf(b.key)));
    return [...groupBy(pairs, p => p.stage)].map(([stage, listed]) => {
        const groups = listed.map(([pair]) => pair);
        const tabs = groups.map(g => tabOf(g.label, g.items)).filter(Boolean);
        if (tabs.length > 1) tabs.unshift(tabOf(ALL_TAB, groups.flatMap(g => g.items)));
        return {label: stage, tabs: tabs.filter(Boolean)};
    }).filter(category => category.tabs.length);
}

const subgroupTable = (rows, columns, empty) => rows.length
    ? leaderboardTable(rows, columns)
    : leaderboardStatus('text-secondary', empty);

// Everyone on the tournament's started leagues, then everyone on one stage or group.
// Every table scores with the weights of the whole tournament, so a group's own table
// tops out at the share it adds to the total. The Leagues column counts the groups a
// score spans, which a group's table doesn't need.
function leagueLeaderboard(standingRows, standingPicks) {
    const weights = groupWeights(standingRows);
    return leaderboardTabs([
        {
            label: ALL_TAB,
            tabs: [{
                label: ALL_TAB,
                build: () => subgroupTable(rankLeaguePredictions(standingRows, standingPicks, weights), LEAGUE_COLUMNS,
                    'No predictions on started leagues yet.'),
            }],
        },
        ...stageCategories(standingRows, groupSubgroupKey, (label, items) => {
            const groups = new Set(items.map(r => r.group_id));
            const picks = standingPicks.filter(p => groups.has(p.group_id));
            if (!picks.length || items.every(r => r.open)) return null;
            const max = [...groups].reduce((sum, g) => sum + weights.get(g), 0);
            return {
                label,
                build: () => subgroupTable(rankLeaguePredictions(items, picks, weights), leagueGroupColumns(max),
                    'No predictions on this league yet.'),
            };
        }),
    ]);
}

// Everyone on the tournament's finished matches, then everyone on one group of matches.
function matchLeaderboard(matches, predictions) {
    return leaderboardTabs([
        {
            label: ALL_TAB,
            tabs: [{
                label: ALL_TAB,
                build: () => subgroupTable(rankLeaderboard(matches, predictions), LEADERBOARD_COLUMNS,
                    'No predictions on finished matches yet.'),
            }],
        },
        ...stageCategories(matches, matchSubgroupKey, (label, items) => {
            const ids = new Set(items.map(m => m.id));
            const picks = predictions.filter(p => ids.has(p.id));
            if (!picks.length) return null;
            return {
                label,
                build: () => subgroupTable(rankLeaderboard(items, picks), LEADERBOARD_COLUMNS,
                    'No predictions on these matches yet.'),
            };
        }),
    ]);
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
        // League predictions come first.
        const panels = [
            {label: 'League predictions', node: leagueLeaderboard(standingRows, standingPicks)},
            {label: 'Match predictions', node: matchLeaderboard(matches, predictions)},
        ];
        const bar = makeEl('div', {className: 'd-flex flex-wrap mb-3'});
        const buttons = panels.map(panel => {
            const btn = makeEl('button', {className: 'tab-btn btn category-btn', textContent: panel.label});
            btn.addEventListener('click', () => showLeaderboardPanel(panels, buttons, panel));
            bar.append(btn);
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

// One group's (or one stage's) table: everyone on that subset alone, so the Leagues
// column, which counts the groups a score spans, has nothing to say, and Points says
// what its groups are worth in the total.
const leagueGroupColumns = max => {
    const cap = String(Number(max.toFixed(2)));
    const whole = max === STAGE_POINTS ? '' : `, ${STAGE_POINTS} for the whole league`;
    return LEAGUE_COLUMNS.filter(c => c.key !== 'leagues')
        .map(c => c.key === 'points'
            ? {...c, title: `Up to ${cap} here${whole}, less for every place a pick is off. Rounded to quarters, the exact number on hover`}
            : c);
};

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
