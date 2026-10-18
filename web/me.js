// My predictions page: profile header + the user's past predictions with their
// outcome where the match has a final score.

const SIDES = ['a', 'b'];

function predictionRowHTML(pred, match) {
    const teams = match
        ? SIDES.map(k => teamLinkHTML(match.tournament_id, match[`team_${k}`])).join(' vs ')
        : `Match #${pred.id}`;
    let outcome = '';
    if (match && match.score_a != null && match.score_b != null) {
        const correct = sameOutcome(pred, match);
        outcome = `<span class="ms-2 small ${correct ? 'text-success' : 'text-danger'}">${correct ? '&#10003;' : '&#10007;'} ` +
            `${match.score_a}:${match.score_b}</span>`;
    }
    return `<li class="prediction-item">
        <div>
            ${match && match.stage_name ? `<div class="text-secondary small">${escapeHtml(sectionTitle(sectionKey(match)))}</div>` : ''}
            <div class="fw-semibold small">${teams}</div>
        </div>
        <span class="pred-score small">${predictionText(pred)}${outcome}</span>
    </li>`;
}

// One league's top-N picks (sorted by position). Once the league has started, each
// pick shows the team's current place, green where it's the predicted one. While it's
// still open, an Edit link leads to the tournament's Standings view.
function leagueHTML(picks) {
    const [first] = picks;
    const title = [first.tournament, first.stage_name, first.group_name]
        .filter(Boolean).map(escapeHtml).join(' · ');
    const edit = first.open
        ? ` · <a href="${escapeAttr(`${tournamentHref(first.tournament_id)}&view=standings`)}" class="text-secondary">Edit</a>`
        : '';
    const rows = picks.map(p => {
        let now = '';
        if (!p.open && p.current_position != null) {
            const hit = p.current_position === p.position;
            now = `<span class="pred-score small ${hit ? 'text-success' : 'text-secondary'}">now ${p.current_position}.</span>`;
        }
        return `<li class="prediction-item">
            <span class="league-pick d-flex align-items-center gap-2 small fw-semibold">
                <span class="pick-place">${p.position}.</span>
                ${p.logo ? `<img src="${escapeAttr(proxied(p.logo))}" class="team-logo" alt="">` : ''}
                <span class="text-truncate">${teamLinkHTML(p.tournament_id, p.team)}</span>
            </span>
            ${now}
        </li>`;
    }).join('');
    return `<div class="mb-3">
        <div class="text-secondary small">${title}${edit}</div>
        <ol class="list-unstyled mb-0">${rows}</ol>
    </div>`;
}

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

async function init() {
    if (!getToken()) {
        hide($('profile'));
        show($('not-logged-in'));
        return;
    }

    let name;
    try {
        ({name} = await api('/api/me'));
    } catch {
        hide($('profile'));
        show($('not-logged-in'));
        return;
    }

    $('profile-name').textContent = name;
    $('profile-initial').textContent = (name[0] || '?').toUpperCase();
    show($('profile-icon'));

    let predictions, standings;
    try {
        ({matches: predictions, standings} = await api('/api/predictions/me'));
    } catch {
        $('profile-sub').textContent = 'Failed to load predictions.';
        return;
    }
    predictions.reverse()

    if (!predictions.length && !standings.length) {
        $('profile-sub').textContent = 'No predictions yet';
        show($('no-predictions'));
        return;
    }

    // Picks arrive sorted by group, then position; newest league first.
    const leagues = new Map();
    standings.forEach(p => {
        if (!leagues.has(p.group_id)) leagues.set(p.group_id, []);
        leagues.get(p.group_id).push(p);
    });
    if (leagues.size) {
        show($('leagues-heading'));
        $('league-list').innerHTML = [...leagues.values()].reverse().map(leagueHTML).join('');
    }

    let done = 0;
    if (predictions.length) {
        const ids = predictions.map(p => p.id).join(',');
        let byId = new Map();
        try {
            byId = new Map((await api(`/api/match?ids=${ids}`)).map(m => [m.id, m]));
        } catch {
            $('profile-sub').textContent = 'Failed to load matches.';
            return;
        }

        const rows = predictions.map(p => {
            const match = byId.get(p.id) ?? null;
            if (match && match.score_a != null && match.score_b != null) done++;
            return predictionRowHTML(p, match);
        });
        show($('predictions-heading'));
        $('prediction-list').innerHTML = rows.join('');
    }

    $('profile-sub').textContent = [
        predictions.length && plural(predictions.length, 'prediction'),
        done && `${plural(done, 'match', 'matches')} finished`,
        leagues.size && plural(leagues.size, 'league'),
    ].filter(Boolean).join(' · ');
}

init();
