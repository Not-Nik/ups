// ============== Standings ==============
// The Standings view: one table per league/swiss/pools group, one table at a time.
// Its tab bar mirrors the matches one: a button per stage on top, and below it the
// group tabs of the open stage — left out when the stage has only one group, since
// its button already carries the selection. Rows arrive sorted by stage, group,
// then position, so the render keeps that order. Loaded once, the first time the
// view opens.

let standingsLoad = null;

const standings = {
    stages: [],   // [{name, tables: [{param, label}]}] in display order
    active: null, // param of the open table
};

const loadStandings = id => standingsLoad ??= renderStandings(id);

// URL form of a table (?table=): the stage name, plus ":<group>" only where the
// stage holds several groups. Like the tab params, only ever compared against the
// rendered tables.
const standingsParam = (stage, group, single) => single ? stage : `${stage}:${group}`;

// Read by syncUrl; null until the standings have loaded.
const activeStandingsTable = () => standings.active;

const stageOfTable = param => standings.stages.find(s => s.tables.some(t => t.param === param));

// `record` works as in activateTab.
function activateStandingsTable(param, record = 'push') {
    standings.active = param;
    const stage = stageOfTable(param);
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
    const wanted = urlParams().get('table');
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

const standingsStatus = (cls, text) => makeEl('p', {
    className: `${cls} text-center py-5`,
    textContent: text,
});

async function renderStandings(id) {
    const root = $('standings');
    root.replaceChildren(standingsStatus('text-secondary', 'Loading…'));
    try {
        const {data: rows, res} = await api(`/api/standings/${id}`, {response: true});
        // Same background toornament refresh as /api/matches (see loadTournament).
        if (res.headers.get('X-Refreshing') === '1') showToast(REFRESH_MSG);
        if (!rows.length) {
            root.replaceChildren(standingsStatus('text-secondary', 'No standings for this tournament.'));
            return;
        }
        root.replaceChildren();
        standings.stages = [...groupBy(rows, r => r.stage_number).values()].map(stageRows => {
            const groups = [...groupBy(stageRows.map(([r]) => r), r => r.group_number).values()]
                .map(groupRows => groupRows.map(([r]) => r));
            const name = groups[0][0].stage_name;
            return {
                name,
                tables: groups.map(groupRows => {
                    const {group_name} = groupRows[0];
                    const param = standingsParam(name, group_name, groups.length === 1);
                    const card = standingsTable(groupRows);
                    card.dataset.table = param;
                    root.appendChild(card);
                    return {param, label: group_name || name};
                }),
            };
        });
        renderStandingsTabs();
        activateWantedStandingsTable('replace');
    } catch {
        // Let the next open try again.
        standingsLoad = null;
        root.replaceChildren(standingsStatus('text-danger', 'Failed to load standings. Please refresh.'));
    }
}

const signed = n => n > 0 ? `+${n}` : `${n}`;

// Swiss groups carry no map scores and a tiebreaker-weighted `points` value, so they
// show W/L only. Draws get a column only where a group actually has some.
function standingsColumns(rows) {
    const swiss = rows[0].stage_type === 'swiss';
    const draws = rows.some(r => r.draws > 0);
    return [
        {head: 'P', title: 'Played', cell: r => r.played},
        {head: 'W', title: 'Wins', cell: r => r.wins},
        ...(draws ? [{head: 'D', title: 'Draws', cell: r => r.draws}] : []),
        {head: 'L', title: 'Losses', cell: r => r.losses},
        ...(swiss ? [] : [
            {head: 'Maps', title: 'Maps won : lost', cell: r => `${r.score_for}:${r.score_against}`, wide: true},
            {head: '+/-', title: 'Map difference', cell: r => signed(r.score_difference)},
            {head: 'Pts', title: 'Points', cell: r => r.points, cls: 'fw-semibold'},
        ]),
    ];
}

function standingsTable(rows) {
    const cols = standingsColumns(rows);
    const first = rows[0];
    const card = makeEl('div', {className: 'card standings-card'});
    const body = rows.map(r => `
        <tr class="${r.dropped ? 'standings-dropped' : ''}"${r.dropped ? ' title="Dropped out"' : ''}>
            <td class="standings-rank">${r.rank}</td>
            <td class="standings-team">
                <span class="d-flex align-items-center gap-2">
                    ${r.logo ? `<img src="${escapeAttr(r.logo)}" class="team-logo" alt="">` : ''}
                    <span class="text-truncate">${escapeHtml(r.team)}</span>
                </span>
            </td>
            ${cols.map(c => `<td class="standings-num ${c.cls ?? ''}">${c.cell(r)}</td>`).join('')}
        </tr>`).join('');
    card.insertAdjacentHTML('beforeend', `
        <div class="card-body">
            <div class="section-title mb-2">${escapeHtml(first.group_name || first.stage_name)}</div>
            <table class="data-table">
                <thead>
                    <tr>
                        <th class="standings-rank" title="Rank">#</th>
                        <th class="standings-team">Team</th>
                        ${cols.map(c => `<th class="standings-num${c.wide ? ' standings-wide' : ''}" title="${escapeAttr(c.title)}">${c.head}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        </div>`);
    return card;
}
