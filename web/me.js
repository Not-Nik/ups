// My predictions page: profile header + the user's past predictions with their
// outcome where the match has a final score.

const SIDES = ['a', 'b'];

function predictionRowHTML(pred, match) {
    const teams = match
        ? SIDES.map(k => escapeHtml(match[`team_${k}`])).join(' vs ')
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
        <span class="pred-score small">${pred.score_a}:${pred.score_b}${outcome}</span>
    </li>`;
}

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

    let predictions;
    try {
        predictions = (await api('/api/predictions/me')).matches;
    } catch {
        $('profile-sub').textContent = 'Failed to load predictions.';
        return;
    }
    predictions.reverse()

    if (!predictions.length) {
        $('profile-sub').textContent = 'No predictions yet';
        show($('no-predictions'));
        return;
    }

    const ids = predictions.map(p => p.id).join(',');
    let byId = new Map();
    try {
        byId = new Map((await api(`/api/match?ids=${ids}`)).map(m => [m.id, m]));
    } catch {
        $('profile-sub').textContent = 'Failed to load matches.';
        return;
    }

    let done = 0;
    const rows = predictions.map(p => {
        const match = byId.get(p.id) ?? null;
        if (match && match.score_a != null && match.score_b != null) done++;
        return predictionRowHTML(p, match);
    });

    $('profile-sub').textContent = `${predictions.length} prediction${predictions.length === 1 ? '' : 's'}` +
        (done ? ` · ${done} match${done === 1 ? '' : 'es'} finished` : '');
    show($('predictions-heading'));
    $('prediction-list').innerHTML = rows.join('');
}

init();
