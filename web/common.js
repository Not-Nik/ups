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

// Append a value to the array stored at map[key], creating it on first use.
const pushTo = (map, key, value) => (map.get(key) ?? map.set(key, []).get(key)).push(value);

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
const SIDES = ['a', 'b'];
const OTHER_SIDE = {a: 'b', b: 'a'};

// ============== Prediction rows ==============
// One prediction as a row, shared by a match card's prediction panel (app.js) and the
// prediction list on me.html. `sep` joins the two predicted scores, `current` joins the
// prediction to the final score. The final score and its mark are only shown for the
// viewer's own prediction (`own`, or the row whose name is `you`), since everyone
// else's row ends at what they predicted.
//   {match}   the prediction's match — the row then carries its section title and its
//             teams instead of a name (me.html).
//   {heading} an already-known section title in place of the match's, or '' for none;
//             with no match it asks for the id-only row of a prediction whose match is gone.
//   {you}     the logged-in user's name, marked "You" on their row.
//   {own}     the row is the viewer's own (me.html has no name to compare).
const predictionRowHTML = (p, sep = ' : ', current = sep, {match = null, you = '', own = null, heading = null} = {}) => {
    const isYou = !!you && p.name === you;
    const finished = match && match.score_a != null && match.score_b != null;
    const score = `${predictionText(p, sep)}${finished && (own ?? isYou)
        ? `<span class="ms-2 small ${sameOutcome(p, match) ? 'text-success' : 'text-danger'}">` +
          `${escapeHtml(current)}${sameOutcome(p, match) ? '&#10003;' : '&#10007;'} ${match.score_a}:${match.score_b}</span>`
        : ''}`;
    if (!match && heading == null) {
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
        : `Match #${escapeHtml(String(p.id))}`;
    return `<li class="prediction-item">
        <div>
            ${title ? `<div class="text-secondary small">${title}</div>` : ''}
            <div class="fw-semibold small">${teams}</div>
        </div>
        <span class="pred-score small">${score}</span>
    </li>`;
};

// ============== Standings picks ==============
// The server's default pick_count for a stage, for a standings row arriving without
// one. The standings view and the leaderboard both fall back to it, so a group's
// pick slots are never counted as zero.
const DEFAULT_PICK_COUNT = 4;

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
// container in place of whatever was there. Both escape the text. grid-span keeps it
// on one line of a tile grid instead of centred inside the first column.
const statusLine = ({cls = 'text-secondary', text}) => makeEl('p', {
    className: `${cls} text-center py-5 grid-span`,
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

// ============== Dialogs ==============
// What every modal does: keep the keyboard inside it and hide the page behind it from
// assistive tech. The dialog's own markup stays in its page; these drive an element the
// caller has just shown, and the caller still decides where focus goes.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// Rows hidden with d-none have no layout box, so their controls stay out of the trap.
// Also answers whether the control that opened a dialog is still around to take the
// focus back; a menu item that hid with its menu is not.
const isVisible = el => !!(el?.offsetWidth || el?.offsetHeight || el?.getClientRects().length);
const focusables = root => [...root.querySelectorAll(FOCUSABLE)].filter(isVisible);

// aria-hidden set on the rest of the page while the dialog is open, so it only ever
// comes off again where this put it on. Elements already carrying it (or announcing
// themselves, like the toast) are left alone.
let hiddenForDialog = [];

const hidePage = dialog => {
    showPage();
    hiddenForDialog = [...document.body.children].filter(el => el !== dialog
        && !el.hasAttribute('aria-hidden')
        && !el.hasAttribute('aria-live')
        && el.getAttribute('role') !== 'alert');
    hiddenForDialog.forEach(el => el.setAttribute('aria-hidden', 'true'));
};

const showPage = () => {
    hiddenForDialog.forEach(el => el.removeAttribute('aria-hidden'));
    hiddenForDialog = [];
};

// Keeps the keyboard on the dialog while it is open, and Escape is its cancel
// button. The dialog on top of this stack holds the trap and the hidden page: opening a
// second hands the pair over instead of stacking a second keydown listener, and closing
// the second takes them back from where the first left off — so a takeover can never
// strand a listener, leave the page permanently aria-hidden, or leave the dialog still
// open but no longer trapped.
let dialogHolders = [];

// Binds the trap for one open dialog; returns the function that unbinds it.
function addDialogTrap(dialog, onEscape) {
    const onKey = e => trapKeys(e, dialog, onEscape);
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
}

// For a dialog the caller has just shown; the caller focuses into it itself. Re-opening
// the dialog already on top — the next step of one flow — replaces its own holder.
function openDialog(dialog, onEscape) {
    closeDialog(dialog);
    const holder = {dialog, onEscape, undo: null};
    hidePage(dialog);
    dialogHolders.at(-1)?.undo();
    holder.undo = addDialogTrap(dialog, onEscape);
    dialogHolders.push(holder);
}

function closeDialog(dialog) {
    const index = dialogHolders.map(h => h.dialog).lastIndexOf(dialog);
    if (index === -1) return;
    const [holder] = dialogHolders.splice(index, 1);
    // A dialog closed from underneath the open one: the holder keeps what it holds.
    if (index !== dialogHolders.length) return;
    holder.undo();
    const last = dialogHolders.at(-1);
    if (!last) {
        showPage();
        return;
    }
    hidePage(last.dialog);
    last.undo = addDialogTrap(last.dialog, last.onEscape);
}

function trapKeys(e, dialog, onEscape) {
    if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
        return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables(dialog);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!dialog.contains(active) || (e.shiftKey && (active === first || !items.includes(active)))) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
    }
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
// Asking for matches or standings makes the server pull fresh results from toornament
// (at most once every few minutes). That runs in the background, so what a caller
// renders predates it and a reload picks it up — a response answering X-Refreshing says
// so, and api() toasts this line for it, so no caller has to repeat the check.
const REFRESH_MSG = "Hang tight, we're fetching the latest results just for you";

// JSON fetch with auto-auth. Returns the parsed body ({} when the response has none).
// Throws on !res.ok with `code` populated from a { err } body and `rateLimited`
// flagged when the server reports {err: "RateLimited"} — the helper also
// surfaces a toast so the user sees something even when the caller swallows.
async function api(url, {method = 'GET', body} = {}) {
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
    if (res.headers.get('X-Refreshing') === '1') showToast(REFRESH_MSG);
    // Whose predictions /api/predictions/me answers, and what they are, and the name
    // /api/me answers, all change here, so a cached copy must not outlive a submission
    // or a login.
    if (method === 'POST' && (url === '/api/submit' || url === '/api/login')) {
        invalidateLoad('me:predictions');
        invalidateLoad('me');
    }
    return data;
}

// Run an async function, swallowing errors and returning undefined on failure.
const tryFetch = async fn => {
    try {
        return await fn();
    } catch {
        return undefined;
    }
};

// ============== Cached data ==============
// Several views of one page want the same endpoint (the leaderboard ranks the matches
// the matches view already rendered), so each key is asked for once, whether the calls
// land together or one after the other. A rejected load is dropped, so the next caller
// tries again, and invalidateLoad drops a settled one.
const dataCache = new Map();

const cachedLoad = (key, load) => {
    const hit = dataCache.get(key);
    if (hit) return hit;
    const promise = Promise.resolve().then(load).catch(err => {
        if (dataCache.get(key) === promise) dataCache.delete(key);
        throw err;
    });
    dataCache.set(key, promise);
    return promise;
};

const invalidateLoad = key => dataCache.delete(key);
const clearLoads = () => dataCache.clear();

const loadMatches = id => cachedLoad(`matches:${id}`, () => api(`/api/matches/${id}`));
// The standings rows of one tournament. loadStandings (standings.js) is that view's
// loader, which re-renders, so this one is named for what it returns.
const loadStandingsRows = id => cachedLoad(`standings:${id}`, () => api(`/api/standings/${id}`));
const loadMyPredictions = () => cachedLoad('me:predictions', () => api('/api/predictions/me'));
// The logged-in user's name. The header, the "You" marks and the admin panel all want
// the same answer on one page load.
const loadMe = () => cachedLoad('me', () => api('/api/me'));

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
