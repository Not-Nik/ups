// ============== Shared overlay/control helpers ==============
// Loaded by both the overlay page (overlay.js) and the control room (control.js),
// after common.js (which provides $, makeEl and the section/day ordering helpers).
// Holds the cross-tab localStorage state, match fetching and logo-colour
// utilities they both depend on. Plain script (no modules): the top-level
// bindings here are visible to whichever page script loads after it.

const SIDES = ['a', 'b'];
const noop = () => {
};

// ============== Shared cross-tab state ==============
// Persisted in localStorage; the `storage` event lets the control tab and the
// overlay tab drive each other live (works across tabs of the same browser).
const CURRENT_KEY = 'ups_overlay_current';
const SCORE_PREFIX = 'ups_overlay_score_';
const SWAP_PREFIX = 'ups_overlay_swap_';
const BAN_PREFIX = 'ups_overlay_ban_';
const scoreKey = id => `${SCORE_PREFIX}${id}`;
const swapKey = id => `${SWAP_PREFIX}${id}`;
const banKey = id => `${BAN_PREFIX}${id}`;

// Scores and bans both persist as a two-element array indexed by team [a, b].
// Returns null on missing/malformed data so callers supply their own default.
function loadPair(key, map) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key));
        if (Array.isArray(parsed) && parsed.length === 2) return parsed.map(map);
    } catch { /* malformed — fall through */
    }
    return null;
}

const loadScores = id => loadPair(scoreKey(id), Number) ?? [0, 0];
const saveScores = (id, scores) => localStorage.setItem(scoreKey(id), JSON.stringify(scores));

function bumpScore(id, idx, delta) {
    const scores = loadScores(id);
    scores[idx] = Math.max(0, scores[idx] + delta);
    saveScores(id, scores);
}

const loadSwap = id => localStorage.getItem(swapKey(id)) === '1';
const saveSwap = (id, swap) => localStorage.setItem(swapKey(id), swap ? '1' : '0');

// Hero bans: one optional banned hero key per side; null means no ban.
const loadBans = id => loadPair(banKey(id), v => v || null) ?? [null, null];
const saveBans = (id, bans) => localStorage.setItem(banKey(id), JSON.stringify(bans));

// Local hero icons + name manifest live under /heroes (downloaded at build time).
const heroIcon = key => `/heroes/${key}.png`;
let heroListPromise = null;
const fetchHeroes = () => (heroListPromise ??= fetch('/heroes/heroes.json').then(r => r.json()));

// The "Powered by" badge position is a global overlay setting (not per-match):
// bottom-left, bottom-right, or hidden. The control room cycles through these.
const LOGO_KEY = 'ups_overlay_logo';
const LOGO_STATES = ['left', 'right', 'hidden'];
const loadLogo = () => {
    const v = localStorage.getItem(LOGO_KEY);
    return LOGO_STATES.includes(v) ? v : 'left';
};
const saveLogo = state => localStorage.setItem(LOGO_KEY, state);
const nextLogo = state => LOGO_STATES[(LOGO_STATES.indexOf(state) + 1) % LOGO_STATES.length];

// "Big view" is a global presentation scene (like the logo position, not per-match):
// the control room toggles it, the overlay animates between its transparent default
// and a full-background scene. Persisted so a reload keeps the chosen scene.
const SCENE_KEY = 'ups_overlay_scene';
const SCENE_STATES = ['normal', 'big'];
const loadScene = () => {
    const v = localStorage.getItem(SCENE_KEY);
    return SCENE_STATES.includes(v) ? v : 'normal';
};
const saveScene = state => localStorage.setItem(SCENE_KEY, state);

// Wipe every per-match overlay key (scores, swap, bans) regardless of which match
// owns it. Called only when explicitly switching matches so a fresh match starts
// clean; reloads never run this, so re-reading the same match is non-destructive.
// LOGO_KEY is a global overlay setting and is intentionally preserved.
const PER_MATCH_PREFIXES = [SCORE_PREFIX, SWAP_PREFIX, BAN_PREFIX];

function clearMatchData() {
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (PER_MATCH_PREFIXES.some(p => key.startsWith(p))) localStorage.removeItem(key);
    }
}

async function fetchMatches() {
    const res = await fetch('/api/matches');
    if (!res.ok) throw new Error('request failed');
    return res.json();
}

async function fetchMatch(id) {
    const matches = await fetchMatches();
    return matches.find(m => String(m.id) === String(id));
}

// Day / section ordering (dayOf, sectionOrder, compareDays) lives in common.js, so
// the match picker orders matches identically to the main site's tab bar.

// ============== Logo color ==============
const proxied = url => `/api/proxy?url=${encodeURIComponent(url)}`;

// Average color of an image's non-transparent pixels, sampled from a 32x32 draw.
// Same-origin (proxied) images don't taint the canvas, so getImageData works.
function averageColor(img) {
    const size = 32;
    const canvas = makeEl('canvas', {width: size, height: size});
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    const {data} = ctx.getImageData(0, 0, size, size);
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 16) continue; // skip near-transparent pixels
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
    }
    if (!count) return null;
    return [r, g, b].map(v => Math.round(v / count));
}

// Black or white, whichever contrasts better against the given rgb background.
function contrastText([r, g, b]) {
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? '#000' : '#fff';
}
