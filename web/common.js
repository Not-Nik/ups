// ============== Shared primitives ==============
// Side-effect-free helpers used by every page (main site + overlay/control).
// Keep these free of load-time DOM access so the file stays safe to include on
// pages with different markup.

const $ = id => document.getElementById(id);

const makeEl = (tag, {dataset, ...props} = {}) => {
    const el = Object.assign(document.createElement(tag), props);
    if (dataset) Object.assign(el.dataset, dataset);
    return el;
};

// First run of digits in a string as an integer, or NaN. Underpins the
// section/day ordering below.
const firstInt = s => {
    const m = s.match(/\d+/);
    return m ? parseInt(m[0], 10) : NaN;
};

// Whether a prediction got the winner of a finished match right. Compares the sign of
// the score differences, so a predicted draw counts only on an actual draw.
const sameOutcome = (pred, match) =>
    Math.sign(pred.score_a - pred.score_b) === Math.sign(match.score_a - match.score_b);

// A prediction whose two numbers add up to 100 is a pair of win chances (60:40), not
// a map score: shown with % signs, and it earns no leaderboard points.
const isPercentPrediction = p => p.score_a + p.score_b === 100;
const predictionText = (p, sep = ':') => isPercentPrediction(p)
    ? `${p.score_a}%${sep}${p.score_b}%`
    : `${p.score_a}${sep}${p.score_b}`;

// ============== Tournaments ==============
// Newest (highest id) first, so the landing grid opens with the current season.
const byNewestTournament = (a, b) => b.tournament_id - a.tournament_id;

// The tournament page keeps its view in the query string (see "Location state" in
// app.js). This is the one place that spells the param, so the landing page can link
// straight into a tournament without knowing how app.js reads it.
const TOURNAMENT_PARAM = 'tournament';
const tournamentHref = id => `/tournament.html?${TOURNAMENT_PARAM}=${encodeURIComponent(id)}`;
// A team's lineup: the tournament's Players view, searched for the team's name.
const teamPlayersHref = (tournamentId, team) =>
    `${tournamentHref(tournamentId)}&view=players&search=${encodeURIComponent(team)}`;
// A team name linking to its lineup. tournament.html opens it in place (openTeamPlayers).
const teamLinkHTML = (tournamentId, team) =>
    `<a class="team-link" href="${escapeAttr(teamPlayersHref(tournamentId, team))}" data-team="${escapeAttr(team)}">${escapeHtml(team)}</a>`;

// ============== Section/day ordering ==============
// A match has stage_name / group_name / round_name (from the API). The round is
// the "day" that drives the tab bar. A section is identified by an unambiguous
// composite key (joined on a control char, since a stage name can itself contain
// "/") and shown via a readable title. Shared so the main site's tab bar and the
// control room's match picker order matches identically.
const SECTION_SEP = '$'; // never appears in a stage/group/round name
const sectionKey = m => [m.stage_name ?? '', m.group_name ?? '', m.round_name ?? ''].join(SECTION_SEP);
const sectionParts = key => key.split(SECTION_SEP);
const sectionTitle = key => sectionParts(key).filter(Boolean).join(' / ');
const letters = s => s.replace(/\d+/g, '').trim();

// Wildcard stages keep their days to themselves: "Day 1" of a wildcard round robin is
// its own tab, under a category named after the stage, not part of the leagues' "Day 1".
const hasOwnDays = stage => /wildcard/i.test(stage ?? '');
// The day (tab) of a section: its round, or "<stage>$<round>" for a stage with its own days.
const stageDay = (stage, round) => hasOwnDays(stage) ? stage + SECTION_SEP + round : round;
const dayOf = key => {
    const [stage, , round] = sectionParts(key);
    return stageDay(stage, round ?? key);
};
const dayKey = m => stageDay(m.stage_name, m.round_name ?? '');
// Split a day back into its stage (null for a shared day) and round.
const dayParts = day => {
    const i = day.indexOf(SECTION_SEP);
    return i < 0 ? [null, day] : [day.slice(0, i), day.slice(i + 1)];
};

// A league's rank from its stage name, spelled out ("Erste Liga") or numbered ("1. Liga").
const LIGA_WORDS = {Erste: 1, Zweite: 2, Dritte: 3, Vierte: 4};
const ligaRank = stage => LIGA_WORDS[stage.split(' ')[0]] ?? (/^\d+\./.test(stage) ? firstInt(stage) : 99);

// Order sections: newest day first (round number desc), the sections of one day
// together, then by league (Erste < Zweite < Dritte, or 1. < 2. < 3.), then group.
function sectionOrder(a, b) {
    const [stageA, groupA, roundA] = sectionParts(a);
    const [stageB, groupB, roundB] = sectionParts(b);
    const na = firstInt(roundA), nb = firstInt(roundB);
    return ((!isNaN(na) && !isNaN(nb)) ? nb - na : roundB.localeCompare(roundA))
        || dayOf(a).localeCompare(dayOf(b))
        || ligaRank(stageA) - ligaRank(stageB)
        || stageA.localeCompare(stageB)
        || groupA.localeCompare(groupB, undefined, {numeric: true});
}

function compareDays(dayA, dayB) {
    const [stageA, a] = dayParts(dayA), [stageB, b] = dayParts(dayB);
    const stageCmp = (stageA ?? '').localeCompare(stageB ?? '');
    if (stageCmp) return stageCmp;
    const lettersCmp = letters(a).localeCompare(letters(b));
    if (lettersCmp) return lettersCmp;
    const na = firstInt(a), nb = firstInt(b);
    return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
}

const escapeHtml = str => {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
};
const escapeAttr = s => escapeHtml(s).replaceAll('"', '&quot;');

// Team logos live on toornament; every page loads them through the server's proxy
// instead, so they are same-origin (no third-party request, and a canvas can read them).
const proxied = url => `/api/proxy?url=${encodeURIComponent(url)}`;

// ============== Match sides ==============
// Assigned on globalThis rather than declared, here and for REFRESH_MSG and
// predictionRowHTML below: each of those four still has a top-level copy in a page
// script, and one name declared by two scripts of a page is a SyntaxError that kills
// both. A page script's own copy shadows (or redeclares) these until it is deleted.
globalThis.SIDES = ['a', 'b'];
globalThis.OTHER_SIDE = {a: 'b', b: 'a'};

// ============== Prediction rows ==============
// One prediction as a row, shared by a match card's prediction panel (app.js) and the
// prediction list on me.html. `sep` joins the two predicted scores, `current` joins the
// prediction to the final score. The final score and its mark are only shown for the
// viewer's own prediction (`own`, or the row whose name is `you`), since everyone
// else's row ends at what they predicted.
//   {match} the prediction's match — the row then carries its section title and its
//           teams instead of a name (me.html); pass an already-known title in {heading}.
//   {you}   the logged-in user's name, marked "You" on their row.
//   {own}   the row is the viewer's own (me.html has no name to compare).
globalThis.predictionRowHTML = (p, sep = ' : ', current = sep, {match = null, you = '', own = null, heading = null} = {}) => {
    const isYou = !!you && p.name === you;
    const finished = match && match.score_a != null && match.score_b != null;
    const score = `${predictionText(p, sep)}${finished && (own ?? isYou)
        ? `<span class="ms-2 small ${sameOutcome(p, match) ? 'text-success' : 'text-danger'}">` +
          `${escapeHtml(current)}${sameOutcome(p, match) ? '&#10003;' : '&#10007;'} ${match.score_a}:${match.score_b}</span>`
        : ''}`;
    if (!match && !heading) {
        return `
  <div class="d-flex justify-content-between align-items-baseline gap-3 py-1">
    <span class="small text-truncate">${escapeHtml(p.name)}${isYou ? '<span class="leaderboard-you">You</span>' : ''}</span>
    <span class="small fw-semibold text-secondary text-nowrap flex-shrink-0">${score}</span>
  </div>`;
    }
    const title = heading ?? (match.stage_name || match.group_name || match.round_name
        ? escapeHtml(sectionTitle(sectionKey(match))) : null);
    const teams = match
        ? SIDES.map(k => teamLinkHTML(match.tournament_id, match[`team_${k}`])).join(' vs ')
        : `Match #${p.id}`;
    return `<li class="prediction-item">
        <div>
            ${title ? `<div class="text-secondary small">${title}</div>` : ''}
            <div class="fw-semibold small">${teams}</div>
        </div>
        <span class="pred-score small">${score}</span>
    </li>`;
};

// ============== DOM helpers ==============
const show = el => el.classList.remove('d-none');
const hide = el => el.classList.add('d-none');
const setHidden = (el, hidden) => el.classList.toggle('d-none', hidden);

const onClick = (id, fn) => $(id).addEventListener('click', fn);
const onEnter = (id, fn) => $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') fn(e);
});

// The centred one-liner a view shows while it loads, when there is nothing there, or
// when its fetch failed. statusLine builds the element, renderStatus puts it in a
// container in place of whatever was there. Both escape the text.
const statusLine = ({cls = 'text-secondary', text}) => makeEl('p', {
    className: `${cls} text-center py-5`,
    textContent: text,
});

const renderStatus = (el, {cls, text} = {}) => {
    const p = statusLine({cls, text});
    el.replaceChildren(p);
    return p;
};

// Restart the shake animation by toggling the class across a forced reflow.
function shakeEl(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
}

// Disable the buttons with these ids while fn runs.
async function withDisabled(ids, fn) {
    ids.forEach(id => {
        $(id).disabled = true;
    });
    try {
        return await fn();
    } finally {
        ids.forEach(id => {
            $(id).disabled = false;
        });
    }
}

// ============== Auth ==============
const getToken = () => localStorage.getItem('ups_token');
const saveToken = t => localStorage.setItem('ups_token', t);

// ============== Toast ==============
let toastTimer = null;

function showToast(msg, duration = 4000) {
    const toast = $('toast');
    if (!toast) return;
    toast.textContent = msg;
    show(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(toast), duration);
}

$('toast')?.addEventListener('click', () => hide($('toast')));

// ============== API ==============
// JSON fetch with auto-auth. Returns parsed body ({} when the response has none),
// or {data, res} when `response` is set and the caller needs the headers.
// Throws on !res.ok with `code` populated from a { err } body and `rateLimited`
// flagged when the server reports {err: "RateLimited"} — the helper also
// surfaces a toast so the user sees something even when the caller swallows.
async function api(url, {method = 'GET', body, response = false} = {}) {
    const init = {method, headers: {}};
    const token = getToken();
    if (token) init.headers['Authorization'] = `Bearer ${token}`;
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const code = data.err;
        const rateLimited = code === 'RateLimited';
        if (rateLimited) showToast('Too many requests — please wait a moment and try again.');
        throw Object.assign(new Error('Request failed'), {code, rateLimited});
    }
    return response ? {data, res} : data;
}

// Run an async function, swallowing errors and returning undefined on failure.
const tryFetch = async fn => {
    try {
        return await fn();
    } catch {
        return undefined;
    }
};

// ============== Theme ==============
const THEME_CYCLE = ['dark', 'light', 'system'];
const THEME_ICONS = {dark: '☾', light: '☀', system: '◑'};
let _systemThemeListener = null;

function applyTheme(theme) {
    if (_systemThemeListener) {
        window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', _systemThemeListener);
        _systemThemeListener = null;
    }
    if (theme === 'system') {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        _systemThemeListener = () => {
            document.documentElement.dataset.bsTheme = mq.matches ? 'dark' : 'light';
        };
        _systemThemeListener();
        mq.addEventListener('change', _systemThemeListener);
    } else {
        document.documentElement.dataset.bsTheme = theme;
    }
    const toggle = $('theme-toggle');
    if (toggle) toggle.textContent = THEME_ICONS[theme];
}

// Pages without a theme toggle (overlay, control room) skip the toggle wiring
// but still apply the stored theme.
applyTheme(localStorage.getItem('ups_theme') ?? 'dark');
$('theme-toggle')?.addEventListener('click', () => {
    const current = localStorage.getItem('ups_theme') ?? 'dark';
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
    localStorage.setItem('ups_theme', next);
    applyTheme(next);
});
