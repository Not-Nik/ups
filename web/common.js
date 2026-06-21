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
const dayOf = key => sectionParts(key).at(-1) ?? key;
const letters = s => s.replace(/\d+/g, '').trim();

// Order sections: newest day first (round number desc), then league rank
// (Erste < Zweite < Dritte), then group alphabetically.
function sectionOrder(a, b) {
    const [stageA, groupA, roundA] = sectionParts(a);
    const [stageB, groupB, roundB] = sectionParts(b);
    const na = firstInt(roundA), nb = firstInt(roundB);
    const ligaRank = s => ({Erste: 0, Zweite: 1, Dritte: 2}[s.split(' ')[0]] ?? 99);
    return ((!isNaN(na) && !isNaN(nb)) ? nb - na : roundB.localeCompare(roundA))
        || ligaRank(stageA) - ligaRank(stageB)
        || groupA.localeCompare(groupB);
}

function compareDays(a, b) {
    const lettersCmp = letters(a).localeCompare(letters(b));
    if (lettersCmp) return lettersCmp;
    const na = firstInt(a), nb = firstInt(b);
    return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
}

// ============== DOM helpers ==============
const show = el => el.classList.remove('d-none');
const hide = el => el.classList.add('d-none');
const setHidden = (el, hidden) => el.classList.toggle('d-none', hidden);

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
// JSON fetch with auto-auth. Returns parsed body ({} when the response has none).
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
