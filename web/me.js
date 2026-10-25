// My predictions page: profile header + the user's past predictions with their
// outcome where the match has a final score. predictionRowHTML itself lives in
// common.js.

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
            now = `<span class="pred-score small ${hit ? 'text-success' : 'text-secondary'}">now ${escapeHtml(p.current_position)}.</span>`;
        }
        return `<li class="prediction-item">
            <span class="league-pick d-flex align-items-center gap-2 small fw-semibold">
                <span class="pick-place">${escapeHtml(p.position)}.</span>
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

// A long history outgrows one request line, so the match ids are fetched in chunks.
const MATCH_IDS_CHUNK = 300;

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
    $('profile-initial').textContent = (Array.from(name)[0] ?? '?').toUpperCase();
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
        const ids = predictions.map(p => p.id);
        let byId = new Map();
        try {
            const matches = [];
            for (let i = 0; i < ids.length; i += MATCH_IDS_CHUNK) {
                matches.push(...await api(`/api/match?ids=${ids.slice(i, i + MATCH_IDS_CHUNK)}`));
            }
            byId = new Map(matches.map(m => [m.id, m]));
        } catch {
            $('profile-sub').textContent = 'Failed to load matches.';
            return;
        }

        const rows = predictions.map(p => {
            const match = byId.get(p.id) ?? null;
            if (match && match.score_a != null && match.score_b != null) done++;
            // A prediction whose match is gone is named by its id alone.
            return match
                ? predictionRowHTML(p, ' : ', ' | ', {match, own: true})
                : `<li class="prediction-item"><div><div class="fw-semibold small">Match #${escapeHtml(String(p.id))}</div></div><span class="pred-score small">${predictionText(p, ' : ')}</span></li>`;
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
