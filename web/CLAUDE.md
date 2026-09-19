# PULOW (web/)

**Predictions für die Uniliga Overwatch** — prediction site for Uniliga (German university) Overwatch matches.
Production at https://pulow.cc. Currently labelled BETA in the header.

The Rust backend lives one directory up (`../src/main.rs`, warp + sqlx/sqlite). Match data, brackets and league
standings are pulled from toornament by `../src/loader.rs`, on demand whenever `/api/matches/:id` or
`/api/standings/:id` is hit.

## Stack & layout

Vanilla HTML/CSS/JS, **no build step**. Files are served as-is.

- `index.html` / `index.js` — landing page: every tournament as a tiled grid
- `tournament.html` — one tournament: Matches (predictions grid) and Standings views
- `404.html` — error page
- `privacy.html` / `privacy.js` — privacy policy
- `admin.html` / `admin.js` — admin panel: add tournaments and matches (login-gated, admin-only)
- `app.js` — all tournament-page logic except the standings
- `standings.js` — the Standings view (tables from `/api/standings/:id`)
- `auth.js` — header Log in button / user menu and the name + logout modals; loaded by index.html and
  tournament.html (both carry that markup), before app.js
- `common.js` — shared theme toggle (loaded by every page)
- `style.css` — all styles, including Bootstrap overrides
- `vendor/bootstrap.min.css` (5.3.3) and `vendor/html2canvas.min.js` (1.4.1) — vendored, do not load from CDN
- `pulow.png` — watermark for saved images
- `docs/superpowers/` — design specs and implementation plans

## API surface

All JSON. Auth via `Authorization: Bearer <token>`.

| Method | Path                   | Auth | Notes                                                                                       |
|--------|------------------------|------|---------------------------------------------------------------------------------------------|
| GET    | `/api/tournaments`     | -    | Array of `{tournament_id, name, toornament_id}` — drives the landing grid                    |
| GET    | `/api/matches/:id`     | -    | Matches for one tournament; each has `id`, `team_a/b`, `logo_a/b`, `score_a/b` (nullable). Also triggers a toornament refresh (max once per 6 h) and answers `X-Refreshing: 1` while one runs |
| GET    | `/api/match?ids=1,2,3` | -    | Matches by comma-separated id list; used by me.html for the user's prediction history       |
| GET    | `/api/brackets/:id`    | -    | `{stage, group}` pairs of one tournament's bracket stages                                   |
| GET    | `/api/bracket`         | -    | `?tournament_id=&stage=&group=` — the nodes of one bracket                                  |
| GET    | `/api/standings/:id`   | -    | Current table of every league/swiss/pools group of one tournament, sorted by stage, group, then `position`. Triggers the same refresh as `/api/matches/:id` and answers `X-Refreshing` the same way |
| GET    | `/api/players/:id`     | -    | Every team's lineup for one tournament as a flat list of `{team, short_name, logo, position, name, battle_tag, toornament_user_id}`, sorted by team name then lineup `position`. Same refresh and `X-Refreshing` as `/api/matches/:id`. Player names aren't unique, not even within a tournament, and there's no player id: lineups are rewritten on every refresh |
| GET    | `/api/predictions/:id` | -    | All users' predictions for a match                                                          |
| GET    | `/api/predictions/me`  | yes  | Current user's past predictions                                                             |
| GET    | `/api/me`              | yes  | `{name}`                                                                                    |
| POST   | `/api/submit`          | opt  | `{predictions, name?}` — name only when no token; returns `{token}` for new accounts        |
| POST   | `/api/login`           | -    | `{name, password}` → `{token}`                                                              |
| POST   | `/api/password`        | yes  | `{password}` — sets/updates account password                                                |
| POST   | `/api/tournament`      | admin| `{name, toornament_id?}` (+ a dummy `tournament_id`) — creates a tournament; the id is auto-assigned and returned on `/api/tournaments` |
| POST   | `/api/match`           | admin| Full `Match` body: `tournament_id`, `team_a/b`, `logo_a/b`, `score_a/b?`, `stage_name`, `group_name`, `round_name`, plus optional `stage_type`, `stage_number`, `toornament_id` (+ dummy `id`) |
| -      | `/api/proxy`           | -    | Image proxy used by html2canvas for cross-origin team logos                                 |

A standings row carries `stage_name`, `stage_number`, `stage_type`, `group_name`, `group_number`, `position`, `rank`
(ties share a rank, `position` breaks them), `team`, `short_name`, `logo`, `points`, `played`, `wins`, `draws`,
`losses`, `forfeits`, `score_for`, `score_against`, `score_difference` and `dropped`. Swiss groups have no map scores:
the three score fields are `null` there, and `points` is toornament's tiebreaker-weighted value (925, 818, …), so show
W/L for swiss rather than points.

Server returns `{err: 'Code'}` on failures. `AccountExists` is the only error code handled specially in the client (
retry name prompt).

"admin" auth means a token whose account has the `Admin` flag (`is_admin` in `../src/account.rs`). Non-admins get a
404 with `{err: 'AccessDenied'}`; `admin.js` maps that to "This account is not an admin."

## Auth

- Token stored in `localStorage` under `ups_token`.
- `api()` helper auto-attaches the bearer header when a token exists. Don't call `fetch` directly for `/api/*`.
- Theme preference under `ups_theme` (`dark`/`light`/`system`).

## Location state

Where you are lives in the **query string**, never in `localStorage` — a link reproduces the exact view and
Back walks through it. `localStorage` is only for the token and the theme.

- `?tournament=<id>` — which tournament tournament.html shows. It is fixed for the page's lifetime;
  unknown or missing redirects to `/`. `TOURNAMENT_PARAM` / `tournamentHref(id)` in common.js are the
  one place that spells this param, so the landing grid links in without knowing how app.js reads it.
  `index.js` forwards the old `/?tournament=` links to tournament.html.
- `?view=matches|standings` — which header tab is open (`VIEWS`, `activateView`). Unknown or missing
  falls back to `matches`.
- `?table=<stage>[:<group>]` — which standings table is open; the group is appended only where the
  stage holds several (`standingsParam` in standings.js). Unknown or missing falls back to the first.
- `?tab=<tab>` — which day/bracket tab of the matches view is open. `renderTabs` assigns each tab its `param`: a league day is its own
  name (`tab=Day+5`), a bracket is `bracket:<stage>` — the group is appended only where one stage holds
  more than one bracket tab, since `mergeConnected` usually leaves a stage with exactly one. A bracket's
  internal day key (`bracketDayKey`) joins its parts on NUL and never goes in the URL. `tabParam(day)`
  just looks the param up; params are only compared against the rendered tabs, so they must be stable,
  not reversible.
- `syncUrl(replace)` writes all four from `state.activeTournament` / `state.activeView` /
  `state.activeTab` / `activeStandingsTable()`, keeping any other params. A user's click **pushes** a history entry; settling on a
  default **replaces**, so the URL is always complete without cluttering history.
- `applyLocation()` is the `popstate` handler: it re-picks the view, the tab and the standings table.
  First load picks the view in the init handler, `renderGrid` → `activateWantedTab()` picks the tab,
  and `renderStandings` → `activateWantedStandingsTable()` the table once the standings have loaded.
- Unknown tab values are dropped silently — `activateWantedTab()` falls back to the default and rewrites
  the URL, so a stale link still lands somewhere sensible.

## Landing page & tournament page

Tournaments are ordered newest first (`byNewestTournament` in common.js — descending `tournament_id`).
`index.html` lists them in a grid, newest in the top left, oldest in the bottom right (plain row-major
CSS grid over the sorted list). Cards link to tournament.html via `tournamentHref`.

tournament.html's second header line (`#back-bar`) holds a "← Back to tournaments" `.bar-link` to `/`.
The `.view-btn` tabs — Matches and Standings — sit in `#view-bar` in main, between the tournament name
and the matches' day tabs. Each view shows the main-area elements
marked `data-view-panel="<view>"` and hides the rest. The matches load on page load whatever the view;
the standings load once, the first time their view opens (`loadStandings` in standings.js).

The Standings view shows one group's table at a time. Its tab bar (`#standings-tabs`) works like the
matches one: a `.category-btn` per stage on top, and the open stage's group tabs below — left out when
the stage has a single group. League and
pools tables show P/W/L, maps, map difference and points; swiss tables show P/W/L only. A D column
appears only where a group has draws. Dropped teams are dimmed and struck through.

## Section / day model

A match has three name fields: `stage_name` ("Erste Liga"), `group_name` ("Division 1", or `""` for a match with no
group, like Seedingwoche) and `round_name` ("Day 5"). The round is the **day** and drives the tab bar. The backend
turns toornament's "Round N" into "Day N" for league/swiss/pools matches and leaves bracket rounds alone, so
`round_name` is always the display name.

`sectionKey(m)` in common.js joins the three with `SECTION_SEP` (`$`) into one key per grid section;
`sectionParts`/`sectionTitle`/`dayOf` split it back. Bracket tabs use their own key, `bracketDayKey(stage, group)`
in bracket.js, which starts with NUL so it can never collide with a round name.

The tab bar is two lines: one button per category (a league day prefix or a bracket
stage) on top, and below it the tabs of the category that holds the open tab — groups
without a label (a lone day like "Seedingwoche") sit in the top line as plain tabs,
and a category holding a single bracket tab shows no lower line at all, since its
button already carries the selection.
Clicking a category opens its first tab; `selectCategory`/`renderCategoryTabs` in
app.js own the switching, and `refreshTabStates` re-applies `.active`/`.invalid-day`
across both lines after any re-render.
Sorting:

- **Sections** (`sectionOrder` in common.js): round number desc (newest day first), then
  `Erste < Zweite < Dritte` on the stage name, then alphabetical on the group name.
- **Days** (`compareDays`): alphabetical on the non-digit prefix, then numeric ascending. So `Day 1`, `Day 2`, `Day 10`
  sort naturally; different prefixes group together.
- **Default tab** (when the URL names none, or names one this tournament doesn't have): the lowest-ranked
  day still containing matches without final scores, else the last tab.

## app.js conventions

- 4-space indent (the local formatter will reformat anything else).
- Helpers — prefer these to raw DOM calls (most live in common.js; `loadImage`, `groupBy` and
  `findCard` in app.js):
    - `$(id)` — `getElementById`
    - `show`/`hide`/`setHidden(el, hidden)` — `d-none` toggling
    - `onClick(id, fn)` / `onEnter(id, fn)` — listener binding by id
    - `makeEl(tag, {dataset, ...props})` — element construction
    - `shakeEl(el)` — restart the shake animation across a forced reflow
    - `escapeHtml` / `escapeAttr` — for any user-provided string in templates
    - `loadImage(src)` — Promise wrapper around `new Image()`
    - `firstInt(s)` — first `\d+` match as integer or `NaN`
    - `groupBy(items, key)` — returns `Map<key, [[item, index], ...]>`
    - `api(url, {method, body, response})` — auth + JSON; throws with `.code` from `{err}` on `!ok`. With
      `response: true` it returns `{data, res}` so the caller can read headers
    - `tryFetch(fn)` — swallows errors, returns `undefined` (use for non-critical loads)
    - `withDisabled(ids, fn)` — disables buttons around an async op, re-enables in `finally`
    - `findCard(index)` — `.card[data-index="..."]` lookup
    - `ifLogin(yes, no)` — branches by current modal mode
- Iterate teams with `SIDES = ['a','b']` and `OTHER_SIDE = {a:'b', b:'a'}` rather than hard-coding the two sides.
- Templates use `insertAdjacentHTML` / template literals. Always run user-controlled strings through `escapeHtml` (text
  content) or `escapeAttr` (attribute values).

## Modal

Lives in auth.js. Single `#name-modal` re-used for three flows via `MODAL_MODES`:

- `'name'` — first-submit name prompt (with optional error + shake)
- `'login'` — login form, exposes the password field
- `'password'` — post-submit "set a password?" prompt

`nameModal.open(mode, opts)` is the single entry point; `prompt`/`promptLogin`/`promptPassword` are thin wrappers that
return a Promise resolved by user action. `nameModal.mode` is the source of truth for `ifLogin` branching. `close()`
hides the modal and resolves; `resolve()` only resolves (used by password-skip).

## Save-as-image

`saveImage()` hides irrelevant grid children, then `renderGridCanvas()` runs html2canvas with the body background +
watermark. `collectImageHides()` walks `#grid` in order: it drops whole sections with no user predictions and trims any
leading `section-divider` from the first kept section in a single pass.

## Working with the user

- **Do not run `git commit` during implementation.** The user commits themselves. (Mirrors the persisted memory.)
- Don't add emojis to code or files unless explicitly requested.
