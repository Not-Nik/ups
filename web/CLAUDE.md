# PULOW (web/)

**Predictions für die Uniliga Overwatch** — prediction site for Uniliga (German university) Overwatch matches.
Production at https://pulow.cc. Currently labelled BETA in the header.

The Rust backend lives one directory up (`../src/main.rs`, warp + sqlx/sqlite). Match data is pulled from toornament
by `../src/loader.rs`, on demand whenever `/api/matches/:id` is hit.

## Stack & layout

Vanilla HTML/CSS/JS, **no build step**. Files are served as-is.

- `index.html` — main page (predictions grid)
- `404.html` — error page
- `privacy.html` / `privacy.js` — privacy policy
- `archive.html` / `archive.js` — every tournament as a grid, linked from the header when tabs don't all fit
- `app.js` — all prediction-page logic
- `common.js` — shared theme toggle (loaded by every page)
- `style.css` — all styles, including Bootstrap overrides
- `vendor/bootstrap.min.css` (5.3.3) and `vendor/html2canvas.min.js` (1.4.1) — vendored, do not load from CDN
- `pulow.png` — watermark for saved images
- `docs/superpowers/` — design specs and implementation plans

## API surface

All JSON. Auth via `Authorization: Bearer <token>`.

| Method | Path                   | Auth | Notes                                                                                       |
|--------|------------------------|------|---------------------------------------------------------------------------------------------|
| GET    | `/api/tournaments`     | -    | Array of `{tournament_id, name, toornament_id}` — drives the header tab bar and the archive |
| GET    | `/api/matches/:id`     | -    | Matches for one tournament; each has `id`, `team_a/b`, `logo_a/b`, `score_a/b` (nullable). Also triggers a toornament refresh (max once per 6 h) and answers `X-Refreshing: 1` while one runs |
| GET    | `/api/match?ids=1,2,3` | -    | Matches by comma-separated id list; used by me.html for the user's prediction history       |
| GET    | `/api/brackets/:id`    | -    | `{stage, group}` pairs of one tournament's bracket stages                                   |
| GET    | `/api/bracket`         | -    | `?tournament_id=&stage=&group=` — the nodes of one bracket                                  |
| GET    | `/api/predictions/:id` | -    | All users' predictions for a match                                                          |
| GET    | `/api/predictions/me`  | yes  | Current user's past predictions                                                             |
| GET    | `/api/me`              | yes  | `{name}`                                                                                    |
| POST   | `/api/submit`          | opt  | `{predictions, name?}` — name only when no token; returns `{token}` for new accounts        |
| POST   | `/api/login`           | -    | `{name, password}` → `{token}`                                                              |
| POST   | `/api/password`        | yes  | `{password}` — sets/updates account password                                                |
| -      | `/api/proxy`           | -    | Image proxy used by html2canvas for cross-origin team logos                                 |

Server returns `{err: 'Code'}` on failures. `AccountExists` is the only error code handled specially in the client (
retry name prompt).

## Auth

- Token stored in `localStorage` under `ups_token`.
- `api()` helper auto-attaches the bearer header when a token exists. Don't call `fetch` directly for `/api/*`.
- Theme preference under `ups_theme` (`dark`/`light`/`system`).

## Location state

Where you are lives in the **query string**, never in `localStorage` — a link reproduces the exact view and
Back walks through it. `localStorage` is only for the token and the theme.

- `?tournament=<id>` — which tournament is loaded. Unknown or missing falls back to the first one.
  `TOURNAMENT_PARAM` / `tournamentHref(id)` in common.js are the one place that spells this param, so
  the archive links in without knowing how app.js reads it.
- `?tab=<tab>` — which tab is open. `renderTabs` assigns each tab its `param`: a league day is its own
  name (`tab=Day+5`), a bracket is `bracket:<stage>` — the group is appended only where one stage holds
  more than one bracket tab, since `mergeConnected` usually leaves a stage with exactly one. A bracket's
  internal day key (`bracketDayKey`) joins its parts on NUL and never goes in the URL. `tabParam(day)`
  just looks the param up; params are only compared against the rendered tabs, so they must be stable,
  not reversible.
- `syncUrl(replace)` writes both from `state.activeTournament` / `state.activeTab`, keeping any other
  params. A user's click **pushes** a history entry; settling on a default **replaces**, so the URL is
  always complete without cluttering history.
- `applyLocation()` reads the URL and is the single entry point for both first load and `popstate`.
  It reloads the tournament only when it actually changed, otherwise just re-picks the tab.
- Unknown tab values are dropped silently — `activateWantedTab()` falls back to the default and rewrites
  the URL, so a stale link still lands somewhere sensible.

## Tournament tabs & archive

Tournaments are ordered newest first everywhere (`byNewestTournament` in common.js — descending
`tournament_id`), so index 0 is the current season and the URL's default lands there.

- The header bar renders one `.tournament-btn` per tournament and never wraps. `fitTournamentTabs()`
  measures `scrollWidth` vs `clientWidth` and hides the oldest tabs until the row fits, revealing
  `#archive-btn` (accent `--accent`, like the active tab's underline) once anything was cut. A
  `ResizeObserver` on the bar re-runs it on every width change.
- The **active** tournament always keeps its tab: `setActiveTournament` re-fits, so a `?tournament=`
  link or a Back into an archived season is never left without one.
- `archive.html` lists all of them in a grid, newest in the top left, oldest in the bottom right
  (plain row-major CSS grid over the same sorted list). Cards link back via `tournamentHref`.

## Section / day model

`match.section` is a path like `"Erste Liga/Group A/Day 5"`. The last segment is the **day** and drives the tab bar.

The tab bar is two lines: one button per category (a league day prefix or a bracket
stage) on top, and below it the tabs of the category that holds the open tab — groups
without a label (a lone day like "Seedingwoche") sit in the top line as plain tabs,
and a category holding a single bracket tab shows no lower line at all, since its
button already carries the selection.
Clicking a category opens its first tab; `selectCategory`/`renderCategoryTabs` in
app.js own the switching, and `refreshTabStates` re-applies `.active`/`.invalid-day`
across both lines after any re-render.
Sorting:

- **Sections** (`sectionOrder` in app.js): last segment by number desc (newest day first), then
  `Erste < Zweite < Dritte` for the first segment, then alphabetical on the second.
- **Days** (`compareDays`): alphabetical on the non-digit prefix, then numeric ascending. So `Day 1`, `Day 2`, `Day 10`
  sort naturally; different prefixes group together.
- **Default tab** (when the URL names none, or names one this tournament doesn't have): the lowest-ranked
  day still containing matches without final scores, else the last tab.

## app.js conventions

- 4-space indent (the local formatter will reformat anything else).
- Helpers — prefer these to raw DOM calls:
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

Single `#name-modal` re-used for three flows via `MODAL_MODES`:

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
