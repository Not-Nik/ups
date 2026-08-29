// ============== Admin ==============
// Panel for adding tournaments and matches. Both endpoints require a valid
// token belonging to an admin account; the server answers 404 otherwise.

const shake = el => {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
};

function toast(msg, ok = false) {
    showToast(msg);
    $('toast').classList.toggle('toast-success', ok);
}

function report(e, fallback) {
    if (e.rateLimited) return;
    toast(e.code === 'AccessDenied' ? 'This account is not an admin.' : e.code || fallback);
}

const intOrNull = id => {
    const v = $(id).value.trim();
    if (!v) return null;
    const n = parseInt(v, 10);
    return (!isNaN(n) && n >= 0) ? n : null;
};

const textOrNull = id => {
    const v = $(id).value.trim();
    return v || null;
};

// ============== Session ==============

function render() {
    const loggedIn = !!getToken();
    setHidden($('login-card'), loggedIn);
    setHidden($('admin-cards'), !loggedIn);
    setHidden($('who'), !loggedIn);
    setHidden($('logout'), !loggedIn);
    if (loggedIn) {
        loadCurrentUser();
        loadTournamentOptions();
    }
}

async function loadCurrentUser() {
    const me = await tryFetch(() => api('/api/me'));
    if (me?.name) $('who').textContent = me.name;
}

async function submitLogin(btn) {
    const name = $('login-name').value.trim();
    const password = $('login-password').value;
    if (!name || !password) {
        shake(!name ? $('login-name') : $('login-password'));
        return;
    }
    btn.disabled = true;
    try {
        const data = await api('/api/login', {method: 'POST', body: {name, password}});
        saveToken(data.token);
        $('login-password').value = '';
        render();
    } catch (e) {
        if (e.rateLimited) return;
        toast('Invalid name or password.');
    } finally {
        btn.disabled = false;
    }
}

$('logout').addEventListener('click', () => {
    localStorage.removeItem('ups_token');
    render();
});

$('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitLogin($('login-submit'));
});

// ============== Tournaments ==============

async function loadTournamentOptions() {
    const list = await tryFetch(() => api('/api/tournaments'));
    if (!Array.isArray(list)) return;
    const select = $('match-tournament');
    select.replaceChildren(...list.slice().sort(byNewestTournament).map(t =>
        makeEl('option', {value: t.tournament_id, textContent: t.name})
    ));
}

async function submitTournament(btn) {
    const name = $('tournament-name').value.trim();
    if (!name) {
        shake($('tournament-name'));
        return;
    }
    btn.disabled = true;
    try {
        await api('/api/tournament', {method: 'POST', body: {
            tournament_id: 0,
            name,
            toornament_id: textOrNull('tournament-toornament'),
        }});
        toast('Tournament created.', true);
        $('tournament-name').value = '';
        $('tournament-toornament').value = '';
        await loadTournamentOptions(); // the new tournament lands in the match form
    } catch (e) {
        report(e, 'Tournament could not be added');
    } finally {
        btn.disabled = false;
    }
}

// ============== Matches ==============

function matchBody() {
    const required = ['match-team-a', 'match-team-b', 'match-stage-name', 'match-group-name', 'match-round-name'];
    for (const id of required) {
        const el = $(id);
        if (!el.value.trim()) {
            shake(el);
            el.focus();
            return null;
        }
    }
    const tournament_id = parseInt($('match-tournament').value, 10);
    if (isNaN(tournament_id)) {
        shake($('match-tournament'));
        return null;
    }
    return {
        id: 0,
        tournament_id,
        team_a: $('match-team-a').value.trim(),
        team_b: $('match-team-b').value.trim(),
        logo_a: $('match-logo-a').value.trim(),
        logo_b: $('match-logo-b').value.trim(),
        score_a: intOrNull('match-score-a'),
        score_b: intOrNull('match-score-b'),
        toornament_id: textOrNull('match-toornament'),
        stage_type: textOrNull('match-stage-type'),
        stage_number: intOrNull('match-stage-number'),
        stage_name: $('match-stage-name').value.trim(),
        group_name: $('match-group-name').value.trim(),
        round_name: $('match-round-name').value.trim(),
    };
}

async function submitMatch(btn) {
    const body = matchBody();
    if (!body) return;
    btn.disabled = true;
    try {
        await api('/api/match', {method: 'POST', body});
        toast('Match added.', true);
        for (const id of ['match-team-a', 'match-team-b', 'match-logo-a', 'match-logo-b',
                          'match-score-a', 'match-score-b']) {
            $(id).value = '';
        }
        $('match-team-a').focus();
    } catch (e) {
        report(e, 'Match could not be added');
    } finally {
        btn.disabled = false;
    }
}

// ============== Init ==============

$('tournament-submit').addEventListener('click', () => submitTournament($('tournament-submit')));
$('match-submit').addEventListener('click', () => submitMatch($('match-submit')));
$('login-submit').addEventListener('click', () => submitLogin($('login-submit')));

render();
