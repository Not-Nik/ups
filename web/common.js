// ============== DOM helpers ==============
const $ = id => document.getElementById(id);
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
const tryFetch = async fn => { try { return await fn(); } catch { return undefined; } };

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
    $('theme-toggle').textContent = THEME_ICONS[theme];
}

applyTheme(localStorage.getItem('ups_theme') ?? 'dark');
$('theme-toggle').addEventListener('click', () => {
    const current = localStorage.getItem('ups_theme') ?? 'dark';
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
    localStorage.setItem('ups_theme', next);
    applyTheme(next);
});
