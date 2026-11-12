// ============== Shared overlay/control helpers ==============
// Loaded by both the overlay page (overlay.js) and the control room (control.js),
// after common.js (which provides $, makeEl and the section/day ordering helpers).
// Holds the cross-tab localStorage state, match fetching and logo-colour
// utilities they both depend on. Plain script (no modules): the top-level
// bindings here are visible to whichever page script loads after it.

const noop = () => {
};

// Hero and map keys name a file under /heroes or /maps, and only the manifests' own
// keys ever should. The per-match slots are read back from localStorage, so a key that
// is not a plain slug is dropped rather than becoming an image path.
const ASSET_KEY = /^[A-Za-z0-9_-]+$/;
const assetKey = v => (typeof v === 'string' && ASSET_KEY.test(v) ? v : null);

// ============== Shared cross-tab state ==============
// Persisted in localStorage; the `storage` event lets the control tab and the
// overlay tab drive each other live (works across tabs of the same browser).
const CURRENT_KEY = 'ups_overlay_current';
const TOURNAMENT_KEY = 'ups_overlay_tournament';
const SCORE_PREFIX = 'ups_overlay_score_';
const SWAP_PREFIX = 'ups_overlay_swap_';
const scoreKey = id => `${SCORE_PREFIX}${id}`;
const swapKey = id => `${SWAP_PREFIX}${id}`;

// Scores persist as a two-element array indexed by team [a, b].
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

// Per-side hero bans live on each map slot (see loadMaps): a two-element array
// [aKey, bKey] of banned hero keys, null where a side hasn't banned.
const normaliseBans = b => Array.isArray(b) && b.length === 2
    ? b.map(v => assetKey(v))
    : [null, null];

// Maps: an ordered list of slots, one per game in the series. Each slot is
// {map, winner, bans}: `map` is a key from maps.json (or null = no map chosen
// yet), `winner` is 'a' | 'b' | null (null = not played yet), `bans` is the
// per-side banned heroes for that map. The first winner-less slot is the
// upcoming map; later winner-less slots are still to come.
const MAPS_PREFIX = 'ups_overlay_maps_';
const BO_PREFIX = 'ups_overlay_bo_';
const mapsKey = id => `${MAPS_PREFIX}${id}`;
const boKey = id => `${BO_PREFIX}${id}`;

function loadMaps(id) {
    try {
        const parsed = JSON.parse(localStorage.getItem(mapsKey(id)));
        if (Array.isArray(parsed)) {
            return parsed.map(s => ({
                map: assetKey(s && s.map),
                winner: s && (s.winner === 'a' || s.winner === 'b') ? s.winner : null,
                bans: normaliseBans(s && s.bans),
            }));
        }
    } catch { /* malformed — fall through */
    }
    return [];
}

const saveMaps = (id, maps) => localStorage.setItem(mapsKey(id), JSON.stringify(maps));

// Best-of length (3/5/7) or null when unset. Drives match-point detection only.
const loadBo = id => {
    const n = Number(localStorage.getItem(boKey(id)));
    return n === 3 || n === 5 || n === 7 ? n : null;
};
const saveBo = (id, n) => {
    if (n === 3 || n === 5 || n === 7) localStorage.setItem(boKey(id), String(n));
    else localStorage.removeItem(boKey(id));
};

// Lineups: per match, each team's five players for its lineup scene, keyed by the
// match's own side ('a' / 'b', not the swapped slot) so a swap never hands a lineup
// to the other team. Spots follow LINEUP_ROLES; each holds the name shown on stream
// (a toornament player name or a custom one), null while empty. The role keys are
// OverFast's and name the icons under /roles.
const LINEUP_PREFIX = 'ups_overlay_lineup_';
const lineupKey = id => `${LINEUP_PREFIX}${id}`;
const LINEUP_ROLES = ['tank', 'damage', 'damage', 'support', 'support'];
const ROLE_LABELS = {tank: 'Tank', damage: 'DPS', support: 'Support'};
const EMPTY_LINEUP = () => LINEUP_ROLES.map(() => null);

// Exactly one entry per spot, each a trimmed non-empty string or null; anything not
// shaped like a lineup is an empty one.
function normaliseLineup(v) {
    if (!Array.isArray(v) || v.length !== LINEUP_ROLES.length) return EMPTY_LINEUP();
    return v.map(name => (typeof name === 'string' && name.trim() ? name.trim() : null));
}

function loadLineups(id) {
    try {
        const parsed = JSON.parse(localStorage.getItem(lineupKey(id)));
        if (parsed && typeof parsed === 'object') {
            return {a: normaliseLineup(parsed.a), b: normaliseLineup(parsed.b)};
        }
    } catch { /* malformed — fall through */
    }
    return {a: EMPTY_LINEUP(), b: EMPTY_LINEUP()};
}

// `names` null clears the side; the key goes once neither side holds anyone.
function saveLineup(id, side, names) {
    const lineups = loadLineups(id);
    lineups[side] = names ? normaliseLineup(names) : EMPTY_LINEUP();
    if ([...lineups.a, ...lineups.b].every(n => n === null)) localStorage.removeItem(lineupKey(id));
    else localStorage.setItem(lineupKey(id), JSON.stringify(lineups));
}

// All five spots filled, and nobody in two of them.
function isLineupComplete(names) {
    const lineup = normaliseLineup(names);
    if (lineup.includes(null)) return false;
    return new Set(lineup.map(n => n.toLowerCase())).size === lineup.length;
}

// Names of one team's lineup entries from /api/players/:id, deduplicated, in the
// endpoint's order (player name first). Matches carry team names, not ids, and the
// backend resolves a match's teams by name within the tournament too.
function playersOf(players, teamName) {
    const names = players.filter(p => p.team === teamName && p.name).map(p => p.name);
    return [...new Set(names)];
}

// --- Pure derivations (no storage access, unit-testable) ---
// Tally of map wins per side as [aWins, bWins].
function countWins(maps) {
    const wins = [0, 0];
    for (const slot of maps) {
        if (slot.winner === 'a') wins[0]++;
        else if (slot.winner === 'b') wins[1]++;
    }
    return wins;
}

// Index of the upcoming map = first slot with no winner yet, or -1 if all played.
function upcomingIndex(maps) {
    return maps.findIndex(s => s.winner === null);
}

// The "current" map for the in-game / big screens (which show only one map's
// bans): the upcoming map, or the last map once the series is decided. -1 when
// there are no maps at all.
function latestMapIndex(maps) {
    const up = upcomingIndex(maps);
    return up !== -1 ? up : maps.length - 1;
}

// Sides at match point given win tallies and a best-of length: a side is at match
// point when one more map win clinches the series and nobody has clinched already.
// Returns [], ['a'], ['b'] or ['a','b'] (a decider).
function matchPointTeams([aWins, bWins], bo) {
    if (!bo) return [];
    const need = Math.ceil(bo / 2);
    if (aWins >= need || bWins >= need) return [];
    const out = [];
    if (aWins === need - 1) out.push('a');
    if (bWins === need - 1) out.push('b');
    return out;
}

const derivedScore = id => countWins(loadMaps(id));

// Local hero icons + name manifest live under /heroes (downloaded at build time).
// The url is '' for a key that is not a plain slug (see assetKey), so a caller falls
// back to showing no image instead of requesting something arbitrary.
const heroIcon = key => (assetKey(key) ? `/heroes/${key}.png` : '');

// Local map art + name/mode manifest live under /maps (populated like /heroes).
const mapImage = key => (assetKey(key) ? `/maps/${key}.jpg` : '');

// ============== JSON loads ==============
// Straight to fetch rather than through api(): these are our own files and endpoints,
// need no token, and must never toast (the overlay is a broadcast surface). A !ok
// response throws, and cachedLoad drops a failure, so one dropped request cannot
// leave the hero and map pickers empty until the next reload.
async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
}

const fetchHeroes = () => cachedLoad('heroes', () => getJson('/heroes/heroes.json'));
const fetchMaps = () => cachedLoad('maps', () => getJson('/maps/maps.json'));
const fetchPlayers = tournamentId => cachedLoad(
    `players:${tournamentId}`,
    () => getJson(`/api/players/${tournamentId}`),
);

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

// The scene is a global presentation setting (like the logo position, not per-match):
// the control room picks it, the overlay animates between its transparent default
// ('normal') and the full-background scenes: big view, maps and one lineup scene per
// team, named by the match's own side. Persisted so a reload keeps the chosen scene.
const SCENE_KEY = 'ups_overlay_scene';
const LINEUP_SCENES = {a: 'lineup-a', b: 'lineup-b'};
const SCENE_STATES = ['normal', 'big', 'maps', LINEUP_SCENES.a, LINEUP_SCENES.b];
const loadScene = () => {
    const v = localStorage.getItem(SCENE_KEY);
    return SCENE_STATES.includes(v) ? v : 'normal';
};
const saveScene = state => localStorage.setItem(SCENE_KEY, state);
const lineupSide = scene => SIDES.find(k => LINEUP_SCENES[k] === scene) ?? null;

// The scene actually on air: the stored one, except that a lineup scene whose team has
// no complete lineup (a match switch, a Clear, a reload after either) shows big view.
function effectiveScene(id) {
    const scene = loadScene();
    const side = lineupSide(scene);
    return side && !isLineupComplete(loadLineups(id)[side]) ? 'big' : scene;
}

// Wipe every per-match overlay key (scores, swap, maps incl. bans, best-of, lineups) regardless of which match
// owns it. Called only when explicitly switching matches so a fresh match starts
// clean; reloads never run this, so re-reading the same match is non-destructive.
// LOGO_KEY is a global overlay setting and is intentionally preserved.
const PER_MATCH_PREFIXES = [SCORE_PREFIX, SWAP_PREFIX, MAPS_PREFIX, BO_PREFIX, LINEUP_PREFIX];

function clearMatchData() {
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (PER_MATCH_PREFIXES.some(p => key.startsWith(p))) localStorage.removeItem(key);
    }
}

async function fetchTournaments() {
    return getJson('/api/tournaments');
}

async function fetchMatches(tournamentId) {
    return getJson(`/api/matches/${tournamentId}`);
}

async function fetchMatch(tournamentId, id) {
    const matches = await fetchMatches(tournamentId);
    return matches.find(m => String(m.id) === String(id));
}

// Day / section ordering (dayOf, sectionOrder, compareDays) lives in common.js, so
// the match picker orders matches identically to the main site's tab bar.

// ============== Logo color ==============
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

// A short text mark for teams with no logo. Multi-word names become initials
// ("Team Liquid" -> "TL", a leading "the" is dropped); single words keep their
// embedded capitals/digits ("Cloud9" -> "C9", "NRG" -> "NRG") or fall back to the
// first few letters. Capped at four characters so it fits a logo-sized badge.
function shortName(name) {
    const clean = (name || '').trim();
    if (!clean) return '?';
    const words = clean.split(/\s+/);
    if (words.length > 1) {
        const sig = words.filter(w => !/^the$/i.test(w));
        return (sig.length ? sig : words).map(w => w[0]).join('').toUpperCase().slice(0, 4);
    }
    const caps = clean.replace(/[^A-Z0-9]/g, '');
    if (caps.length >= 2) return caps.slice(0, 4);
    return clean.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
}
