// ============== Admin ==============
// Panel for adding tournaments and matches and setting how many places of a league
// users predict. The endpoints require a valid token belonging to an admin account;
// the server answers 404 otherwise.

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
        loadTournamentOptions().then(() => {
            loadTournamentData();
            loadPickCounts();
        });
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
    for (const select of [$('match-tournament'), $('picks-tournament')]) {
        select.replaceChildren(...list.slice().sort(byNewestTournament).map(t =>
            makeEl('option', {value: t.tournament_id, textContent: t.name})
        ));
    }
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
        loadPickCounts(); // ... and the select above the pick counts starts over
    } catch (e) {
        report(e, 'Tournament could not be added');
    } finally {
        btn.disabled = false;
    }
}

// ============== League predictions ==============
// One number input per stage that has standings: how many places of its groups users
// predict. Save posts the stages whose value changed.

const MAX_PICK_COUNT = 32; // same limit as the server

async function loadPickCounts() {
    const box = $('picks-stages');
    const tid = parseInt($('picks-tournament').value, 10);
    const stages = isNaN(tid) ? [] : await tryFetch(() => api(`/api/stages/${tid}`));
    if (!Array.isArray(stages) || !stages.length) {
        box.replaceChildren(makeEl('p', {
            className: 'text-secondary small mb-0',
            textContent: 'No leagues loaded for this tournament yet.',
        }));
        return;
    }
    box.replaceChildren(...stages.map(stage => {
        const id = `picks-stage-${stage.stage_id}`;
        const row = makeEl('div', {className: 'd-flex align-items-center justify-content-between gap-3 mb-2'});
        const input = makeEl('input', {
            id,
            type: 'number',
            min: 1,
            max: MAX_PICK_COUNT,
            className: 'form-control admin-pick-count',
            value: stage.pick_count,
            dataset: {stage: stage.stage_id, saved: stage.pick_count},
        });
        row.append(makeEl('label', {htmlFor: id, className: 'text-truncate', textContent: stage.name}), input);
        return row;
    }));
}

async function submitPickCounts(btn) {
    const changed = [];
    for (const input of $('picks-stages').querySelectorAll('input')) {
        const pick_count = parseInt(input.value, 10);
        if (isNaN(pick_count) || pick_count < 1 || pick_count > MAX_PICK_COUNT) {
            shake(input);
            input.focus();
            return;
        }
        if (String(pick_count) !== input.dataset.saved) changed.push({input, pick_count});
    }
    if (!changed.length) {
        toast('Nothing changed.');
        return;
    }
    btn.disabled = true;
    try {
        for (const {input, pick_count} of changed) {
            await api('/api/stage/picks', {method: 'POST', body: {
                stage_id: Number(input.dataset.stage),
                pick_count,
            }});
            input.dataset.saved = pick_count;
        }
        toast('Saved.', true);
    } catch (e) {
        report(e, 'Could not be saved');
    } finally {
        btn.disabled = false;
    }
}

// ============== Pickers ==============
// <option> can't render images, so every pick is a custom listbox: a button
// showing the current value, and a panel of rows. Team rows carry logos;
// stage/group/round rows come from existing matches and offer "Custom…" to
// fall back to free text.

const pickers = {};
let teamLogos = new Map();
let sectionCombos = new Map(); // "stage\0group\0round" -> {stage_number, stage_type}
let sectionNames = {stage: [], group: [], round: []};

function makePicker({key, btn, list, placeholder, render, onSelect, custom = false}) {
    const picker = {btn, list, value: '', customEl: null};
    pickers[key] = picker;

    // render(value) -> array of nodes for one row (or the button)
    const renderBtn = () => {
        btn.replaceChildren(...render(picker.value));
    };

    picker.close = () => {
        list.classList.add('d-none');
        btn.setAttribute('aria-expanded', 'false');
    };

    picker.set = (name, {notify = true} = {}) => {
        picker.value = name;
        renderBtn();
        picker.close();
        if (notify && onSelect) onSelect(name);
    };

    picker.toCustom = () => {
        picker.close();
        const input = makeEl('input', {
            type: 'text',
            className: 'form-control',
            value: picker.value,
            placeholder,
        });
        input.addEventListener('input', () => {
            picker.value = input.value.trim();
            onSelect?.(picker.value);
        });
        btn.replaceWith(input);
        picker.customEl = input;
        input.focus();
        input.select();
    };

    picker.fill = names => {
        if (picker.customEl) return; // stay in custom mode
        picker.value = '';
        renderBtn();
        const items = names.map(name => {
            const item = makeEl('button', {type: 'button', className: 'admin-team-item', role: 'option'});
            item.append(...render(name));
            item.addEventListener('click', () => picker.set(name));
            return item;
        });
        if (!names.length) {
            items.push(makeEl('div', {
                className: 'admin-team-empty',
                textContent: custom ? 'No entries yet — or pick "Custom…" below.' : 'No entries yet.',
            }));
        }
        if (custom) {
            const customItem = makeEl('button', {
                type: 'button',
                className: 'admin-team-item admin-team-custom',
                textContent: 'Custom…',
            });
            customItem.addEventListener('click', picker.toCustom);
            items.push(customItem);
        }
        list.replaceChildren(...items);
    };

    picker.reset = () => {
        if (picker.customEl) {
            picker.customEl.replaceWith(btn);
            picker.customEl = null;
        }
        picker.value = '';
        renderBtn();
    };

    picker.clear = () => {
        picker.value = '';
        renderBtn();
    };

    btn.addEventListener('click', e => {
        e.stopPropagation();
        closeAllPickers(picker);
        const opened = list.classList.toggle('d-none');
        btn.setAttribute('aria-expanded', String(opened));
    });
    list.addEventListener('click', e => e.stopPropagation());

    return picker;
}

const closeAllPickers = except => {
    for (const p of Object.values(pickers)) {
        if (p !== except) p.close();
    }
};

document.addEventListener('click', () => closeAllPickers());

const label = (name, placeholder) => makeEl('span', {
    className: 'admin-team-choice' + (name ? '' : ' text-secondary'),
    textContent: name || placeholder,
});

const teamRender = name => {
    const nodes = [];
    const logo = name ? teamLogos.get(name) : '';
    if (logo) nodes.push(makeEl('img', {className: 'admin-team-logo', src: proxied(logo), alt: ''}));
    nodes.push(label(name, 'Select team…'));
    return nodes;
};

makePicker({
    key: 'team-a', btn: $('team-btn-a'), list: $('team-list-a'),
    placeholder: 'Team A', render: teamRender,
});
makePicker({
    key: 'team-b', btn: $('team-btn-b'), list: $('team-list-b'),
    placeholder: 'Team B', render: teamRender,
});

// Picking an existing stage/group/round combo fills the stage number and type
// from a match that already uses it.
const sectionRender = placeholder => name => [label(name, placeholder)];

makePicker({
    key: 'stage', btn: $('section-btn-stage'), list: $('section-list-stage'),
    placeholder: 'Select stage…', render: sectionRender('Select stage…'), custom: true,
    onSelect: syncSection,
});
makePicker({
    key: 'group', btn: $('section-btn-group'), list: $('section-list-group'),
    placeholder: 'Select group…', render: sectionRender('Select group…'), custom: true,
    onSelect: syncSection,
});
makePicker({
    key: 'round', btn: $('section-btn-round'), list: $('section-list-round'),
    placeholder: 'Select round…', render: sectionRender('Select round…'), custom: true,
    onSelect: syncSection,
});

function syncSection() {
    const key = [pickers.stage.value, pickers.group.value, pickers.round.value].join('\u0000');
    const combo = sectionCombos.get(key);
    if (!combo) return;
    $('match-stage-number').value = combo.stage_number ?? '';
    $('match-stage-type').value = combo.stage_type ?? '';
}

async function loadTournamentData() {
    teamLogos = new Map();
    sectionCombos = new Map();
    const stages = new Set(), groups = new Set(), rounds = new Set();
    const tid = parseInt($('match-tournament').value, 10);
    if (!isNaN(tid)) {
        const matches = await tryFetch(() => api(`/api/matches/${tid}`));
        if (Array.isArray(matches)) {
            for (const m of matches) {
                for (const side of ['a', 'b']) {
                    const team = m[`team_${side}`];
                    if (team && !teamLogos.has(team)) teamLogos.set(team, m[`logo_${side}`] || '');
                }
                if (m.stage_name) stages.add(m.stage_name);
                if (m.group_name) groups.add(m.group_name);
                if (m.round_name) rounds.add(m.round_name);
                const key = [m.stage_name, m.group_name, m.round_name].join('\u0000');
                if (!sectionCombos.has(key)) {
                    sectionCombos.set(key, {stage_number: m.stage_number, stage_type: m.stage_type});
                }
            }
        }
    }
    const sortByName = (a, b) => a.localeCompare(b);
    sectionNames = {
        stage: [...stages].sort(sortByName),
        group: [...groups].sort(sortByName),
        round: [...rounds].sort(compareDays),
    };
    const teamNames = [...teamLogos.keys()].sort(sortByName);
    pickers['team-a'].fill(teamNames);
    pickers['team-b'].fill(teamNames);
    pickers.stage.fill(sectionNames.stage);
    pickers.group.fill(sectionNames.group);
    pickers.round.fill(sectionNames.round);
}

// ============== Matches ==============

function matchBody() {
    for (const key of ['team-a', 'team-b', 'stage', 'group', 'round']) {
        const p = pickers[key];
        if (!p.value) {
            const el = p.customEl ?? p.btn;
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
        team_a: pickers['team-a'].value,
        team_b: pickers['team-b'].value,
        logo_a: teamLogos.get(pickers['team-a'].value) || '',
        logo_b: teamLogos.get(pickers['team-b'].value) || '',
        score_a: intOrNull('match-score-a'),
        score_b: intOrNull('match-score-b'),
        toornament_id: textOrNull('match-toornament'),
        stage_type: textOrNull('match-stage-type'),
        stage_number: intOrNull('match-stage-number'),
        stage_name: pickers.stage.value,
        group_name: pickers.group.value,
        round_name: pickers.round.value,
    };
}

async function submitMatch(btn) {
    const body = matchBody();
    if (!body) return;
    btn.disabled = true;
    try {
        await api('/api/match', {method: 'POST', body});
        toast('Match added.', true);
        pickers['team-a'].clear();
        pickers['team-b'].clear();
        for (const key of ['stage', 'group', 'round']) {
            pickers[key].reset();
        }
        for (const id of ['match-score-a', 'match-score-b', 'match-stage-number', 'match-stage-type']) {
            $(id).value = '';
        }
        pickers['team-a'].btn.focus();
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
$('match-tournament').addEventListener('change', loadTournamentData);
$('picks-tournament').addEventListener('change', loadPickCounts);
$('picks-submit').addEventListener('click', () => submitPickCounts($('picks-submit')));

render();
