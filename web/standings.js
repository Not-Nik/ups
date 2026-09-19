// ============== Standings ==============
// The Standings view: one table per league/swiss/pools group, under a heading per
// stage. Rows arrive sorted by stage, group, then position, so the render keeps
// that order. Loaded once, the first time the view opens.

let standingsLoad = null;

const loadStandings = id => standingsLoad ??= renderStandings(id);

const standingsStatus = (cls, text) => makeEl('p', {
    className: `${cls} text-center py-5 standings-status`,
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
        groupBy(rows, r => r.stage_number).forEach(stageRows => {
            const stage = stageRows[0][0];
            root.appendChild(makeEl('div', {className: 'section-title standings-stage', textContent: stage.stage_name}));
            groupBy(stageRows.map(([r]) => r), r => r.group_number)
                .forEach(groupRows => root.appendChild(standingsTable(groupRows.map(([r]) => r))));
        });
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
            <table class="standings-table">
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
