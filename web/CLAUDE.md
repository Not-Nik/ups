# PULOW (web/)

**Predictions für die Uniliga Overwatch** — prediction site for Uniliga (German university) Overwatch matches.
Production at https://pulow.cc. Currently labelled BETA in the header.

The Rust backend lives one directory up (`../src/main.rs`, warp + sqlx/sqlite). Match data is scraped from toornament
via `../scrape_matches.py`.

## Stack & layout

Vanilla HTML/CSS/JS, **no build step**. Files are served as-is.

- `index.html` — main page (predictions grid)
- `404.html` — error page
- `privacy.html` / `privacy.js` — privacy policy
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
| GET    | `/api/tournaments`     | -    | Array of `{tournament_id, name, toornament_id}` — drives the header tournament tab bar      |
| GET    | `/api/matches/:id`     | -    | Matches for one tournament; each has `id`, `team_a/b`, `logo_a/b`, `score_a/b` (nullable)   |
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

## Section / day model

`match.section` is a path like `"Erste Liga/Group A/Day 5"`. The last segment is the **day** and drives the tab bar.
Sorting:

- **Sections** (`sectionOrder` in app.js): last segment by number desc (newest day first), then
  `Erste < Zweite < Dritte` for the first segment, then alphabetical on the second.
- **Days** (`compareDays`): alphabetical on the non-digit prefix, then numeric ascending. So `Day 1`, `Day 2`, `Day 10`
  sort naturally; different prefixes group together.
- **Default tab**: the lowest-ranked day still containing matches without final scores.

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
    - `api(url, {method, body})` — auth + JSON; throws with `.code` from `{err}` on `!ok`
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
