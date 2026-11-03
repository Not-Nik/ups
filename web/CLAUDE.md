# PULOW (web/)

**Predictions für die Uniliga Overwatch** — prediction site for Uniliga (German university) Overwatch matches.
Production at https://pulow.cc. Currently labelled BETA in the header.

The Rust backend lives one directory up (`../src/main.rs`, warp + sqlx/sqlite). Match data, brackets and league
standings are pulled from toornament by `../src/loader.rs`, on demand whenever `/api/matches/:id`,
`/api/standings/:id`, `/api/teams/:id` or `/api/players/:id` is hit.

## Stack & layout

Vanilla HTML/CSS/JS, **no build step**. Files are served as-is.

- `index.html` / `index.js` — landing page: every tournament as a tiled grid
- `tournament.html` — one tournament: Matches (the predictions grid and the brackets), Standings, Teams, Players and Leaderboard views
- `404.html` — error page
- `me.html` / `me.js` — the user's profile: league (top-N) predictions, newest league first, each pick
  with the team's current place once the league has started (green where it matches) or an Edit link to
  the Standings view while it's open; then match predictions with ✓/✗ on finished matches
- `privacy.html` / `privacy.js` — privacy policy and its two buttons: "Clear local data" (`/api/logout`, this
  browser's keys, theme aside) and "Clear server data" (`/api/delete`)
- `incidents.html` / `incidents.js` — incident write-ups hardcoded in `INCIDENTS` (no endpoint — publishing means
  prepending an entry); the same script also runs on tournament.html and toasts the newest one once per change of
  the list (content fingerprint under `ups_incidents_seen`)
- `admin.html` / `admin.js` — admin panel: add tournaments and matches, set each league stage's pick count
  and whether its groups stay predictable after their first result, each tournament's refresh interval,
  and release a passwordless account so its name can be claimed again
  (login-gated, admin-only)
- `app.js` — all tournament-page logic except the standings and the brackets
- `bracket.js` — the bracket sections of the matches view; loaded after app.js and shares its globals
- `standings.js` — the Standings view (tables from `/api/standings/:id`)
- `roster.js` — the searchable Teams and Players views
- `leaderboard.js` — the Leaderboard view (ranked from matches + predictions on the client)
- `overlay.html` / `overlay.js` and `control.html` / `control.js` — the stream pair: a transparent OBS browser source
  (two team banners with logo, name, score and hero-ban badge, tinted from the logo's average colour, plus a
  full-screen "big" scene and a map-timeline scene) and the control room that drives it — pick the live match, score
  it, set the best-of, the map sequence and the bans, switch scene, swap sides, move the logo
- `overlay-common.js` — what they share: the `ups_overlay_*` localStorage keys that are their whole contract (current
  match and tournament, per-match score, maps and best-of, global scene and logo position), the series derivations read
  off them and the `/heroes/` and `/maps/` manifest loads. They talk through `storage` events only — no
  BroadcastChannel, no polling, no URL params — and fetch with plain `fetch`, not `api()`: a broadcast surface has no
  token and wants no refresh toast
- `auth.js` — header Log in button / user menu (profile, change password, log out), the `#name-modal` dialog and the
  log-out confirmation; loaded by index.html and tournament.html (both carry that markup), before app.js
- `theme-head.js` — the blocking `<head>` script that puts the stored colour scheme on the document before its first
  paint
- `common.js` — the shared helpers and the theme toggle (loaded by every page)
- `style.css` — all styles, including Bootstrap overrides; `overlay.css` — the overlay and control room's alone,
  without Bootstrap. Both end in a `prefers-reduced-motion` block, dropping the motion that carries no information
- `vendor/bootstrap.min.css` (5.3.3) and `vendor/html2canvas.min.js` (1.4.1) — vendored, do not load from CDN
- `pulow.png` — watermark for saved images; `favicon.ico`, `favicon-32.png` and `apple-touch-icon.png` are in every
  page's head, `og.png` is the shareable pages' link preview
- `heroes/` and `maps/` — the overlay's hero portraits and map screenshots; only the `heroes.json` / `maps.json`
  manifests are committed, `../fetch-assets.py` (OverFast API) downloads the gitignored images
- The document root is exactly `web/` (`warp::fs::dir("web")` in `../src/main.rs`): `../docs/superpowers/` (design
  specs and plans, git-ignored) and `../fetch-assets.py` sit one directory up and are never served

## API surface

All JSON. Auth via `Authorization: Bearer <token>`.

| Method | Path                   | Auth | Notes                                                                                       |
|--------|------------------------|------|---------------------------------------------------------------------------------------------|
| GET    | `/api/tournaments`     | -    | Array of `{tournament_id, name, toornament_id, refresh_interval}` — drives the landing grid. `refresh_interval` is in seconds |
| GET    | `/api/matches/:id`     | -    | Matches for one tournament; each has `id`, `team_a/b`, `logo_a/b`, `score_a/b` (nullable). Also triggers a toornament refresh (max once per the tournament's `refresh_interval`, 6 h by default) and answers `X-Refreshing: 1` while one runs |
| GET    | `/api/match?ids=1,2,3` | -    | Matches by comma-separated id list; used by me.html for the user's prediction history       |
| GET    | `/api/brackets/:id`    | -    | `{tournament_id, stage, group}` pairs of one tournament's bracket stages                     |
| GET    | `/api/bracket`         | -    | `?tournament_id=&stage=&group=` — one bracket's nodes: `{node_id, stage_number, stage_type, group_name, branch, round_number, position, depth, team_a/b?, logo_a/b?, score_a/b?, match_id?}` plus `source_a/b`, the feeding nodes, each with a `source_type_a/b` of `"winner"` or `"loser"` — that pair is what draws the edges, and `match_id` is null for a slot with no predictable match |
| GET    | `/api/standings/:id`   | -    | Current table of every league/swiss/pools group of one tournament, sorted by stage, group, then `position`. Triggers the same refresh as `/api/matches/:id` and answers `X-Refreshing` the same way. Every row carries its group's `group_id`, `open` (no match of the group has a score yet, or its stage is forced open, so it still takes predictions) and `pick_count` (how many places users predict, from its stage) |
| GET    | `/api/stages/:id`      | -    | The stages of one tournament that have standings (league/swiss/pools) as `{stage_id, number, name, stage_type, pick_count, force_open}`, sorted by `number`. Empty until the tournament's first refresh |
| POST   | `/api/stage/picks`     | admin| `{stage_id, pick_count}` — sets how many places of the stage's groups users predict, 1 to 32 (4 by default). `BadRequest` outside that range or for an unknown stage. Predictions already stored are left alone |
| POST   | `/api/stage/open`      | admin| `{stage_id, force_open}` — while on, the stage's groups keep taking standing picks even after one of their matches has a score (off by default, so a result locks the group like before). Only ever opens: turning it off hands the decision back to the score rule. `BadRequest` for an unknown stage |
| GET    | `/api/teams/:id`       | -    | Every team of one tournament as `{id, name, short_name, logo, toornament_id}`, sorted by name. Names aren't unique, so `id` is the key to tell two teams apart; `toornament_id` is `null` for teams added by hand. Same refresh and `X-Refreshing` as `/api/matches/:id` |
| GET    | `/api/players/:id`     | -    | Every team's lineup for one tournament as a flat list of `{team_id, team, short_name, logo, position, name, battle_tag, toornament_user_id}`, sorted by player name, then team name and lineup `position`. Same refresh and `X-Refreshing` as `/api/matches/:id`. Player names aren't unique, not even within a tournament, and there's no player id: lineups are rewritten on every refresh |
| GET    | `/api/predictions/:id` | -    | All users' predictions for a match                                                          |
| POST   | `/api/predictions`     | -    | A bare JSON array of match ids → the same rows for all of them at once; used by "expand all" (app.js) and the Leaderboard instead of one `GET` per match |
| GET    | `/api/predictions/me`  | yes  | Current user's past predictions as `{matches, standings}`: `matches` in the `/api/predictions/:id` shape, `standings` as `{group_id, position, team_id, team, short_name, logo, tournament_id, tournament, stage_name, group_name, current_position, open}` across every tournament, sorted by group then `position`. `current_position` is the team's place in the group's standings now (`null` without a standings row); `open` is the same as on a standings row |
| GET    | `/api/standings/predictions/:id` | - | All users' top-N predictions for one tournament as a flat list of `{name, group_id, position, team_id}`, sorted by name, group, then `position` (1 to the stage's `pick_count`). The server only stores them; any scoring happens on the client |
| GET    | `/api/me`              | yes  | `{name}`                                                                                    |
| POST   | `/api/submit`          | opt  | `{predictions?, standings?, name?}` — name only when no token; returns `{token}` for new accounts. `standings` is a list of `{group_id, teams}`, `teams` being up to `pick_count` distinct team ids, 1st place first; each replaces the user's prediction for that group (`[]` clears it). Groups where a match already has a score are skipped, like matches with a score, unless their stage is forced open. `BadRequest` (and nothing stored) for an unknown group, duplicates, more teams than the stage's `pick_count` or a team from another tournament |
| POST   | `/api/login`           | -    | `{name, password}` → `{token}`                                                              |
| POST   | `/api/logout`          | yes  | Drops this session only — the account, its other sessions and its predictions stay. The header's log-out then removes the token and reloads |
| POST   | `/api/delete`          | yes  | No body — ends the account: sessions, match predictions and league predictions all go with it (FK cascade from `users`). privacy.html's "Clear server data" button |
| POST   | `/api/password`        | yes  | `{password}` — sets/updates account password                                                |
| POST   | `/api/account/release` | admin| `{name}` — ends a passwordless account's seven-day claim window right away, so its name can be claimed again (a takeover drops the old owner's sessions and keeps the predictions; the claimer gets a fresh token from `/api/submit`). Returns `{name}` (the stored casing). `BadRequest` for unknown names and for accounts with a password, which are never claimable |
| POST   | `/api/tournament`      | admin| `{name, toornament_id?}` (+ a dummy `tournament_id`) — creates a tournament; the id is auto-assigned and returned on `/api/tournaments` |
| POST   | `/api/tournament/:id/refresh` | admin| The interval as a bare JSON number (e.g. `21600`) — sets the shortest gap between two toornament refreshes of the tournament, in seconds, 60 to 604800 (a week). `BadRequest` outside that range or for an unknown tournament. Applies to the next request at once; the admin panel edits it in minutes |
| POST   | `/api/match`           | admin| Full `Match` body: `tournament_id`, `team_a/b`, `logo_a/b`, `score_a/b?`, `stage_name`, `group_name`, `round_name`, plus optional `stage_type`, `stage_number`, `toornament_id` (+ dummy `id`) |
| -      | `/api/proxy`           | -    | Image proxy for team logos; every `<img>` goes through it (`proxied(url)` in common.js)      |

A standings row carries `stage_name`, `stage_number`, `stage_type`, `group_id` (what a `/api/submit` standings entry takes), `group_name`, `group_number`, `position`, `rank`
(ties share a rank, `position` breaks them), `team_id` (the `id` from `/api/teams/:id`), `team`, `short_name`, `logo`, `points`, `played`, `wins`, `draws`,
`losses`, `forfeits`, `score_for`, `score_against`, `score_difference`, `dropped` and `open` (true while none of the
group's matches has a score, or its stage is forced open — the same rule `/api/submit` uses to accept or skip a standings entry). Swiss groups have no map scores:
the three score fields are `null` there, and `points` is toornament's tiebreaker-weighted value (925, 818, …), so show
W/L for swiss rather than points.

Server returns `{err: 'Code'}` on failures, every route but `/api/proxy` behind an IP rate limiter (100 a minute, burst
50). Two codes are the client's business: `RateLimited`, which `api()` toasts and rethrows as `err.rateLimited` so
callers can stay quiet, and `AccountExists` (401), which makes `submitWithName` ask for another name.

"admin" auth means a token whose account has the `Admin` flag (`is_admin` in `../src/account.rs`). Non-admins
get a plain 404: `verify_admin` rejects with `not_found`, and `handle_rejection` answers that with `web/404.html`,
so there is no `{err}` body to read. `api()` therefore throws with `status: 404` and no `code`, and `admin.js`'s
writes map a bodiless 404 to "This account is not an admin."

## Auth

- Token stored in `localStorage` under `ups_token`.
- `api()` helper auto-attaches the bearer header when a token exists. Don't call `fetch` directly for `/api/*`
  (the overlay pages excepted, by design).
- Theme preference under `ups_theme` (`dark`/`light`/`system`), applied before the first paint by `theme-head.js`.
- Beyond those two, localStorage holds only the incident toast's read marker (`ups_incidents_seen`) and the
  overlay's live-match keys (`ups_overlay_*`) — never a name, never where the user is.

## Location state

Where you are lives in the **query string**, never in `localStorage` — a link reproduces the exact view and
Back walks through it. What localStorage does hold is listed under Auth.

- `?tournament=<id>` — which tournament tournament.html shows. It is fixed for the page's lifetime;
  unknown or missing redirects to `/`. `TOURNAMENT_PARAM` / `tournamentHref(id)` in common.js are the
  one place that spells this param, so the landing grid links in without knowing how app.js reads it.
  `index.js` forwards the old `/?tournament=` links to tournament.html.
- `?view=matches|standings|teams|players|leaderboard` — which view tab is open (`VIEWS`, `activateView`). Unknown or missing
  falls back to `matches`.
- `?table=<stage>[:<group>]` — which standings table is open; the group is appended only where the
  stage holds several (`standingsParam` in standings.js). Unknown or missing falls back to the first.
- `?tab=<tab>` — which day/bracket tab of the matches view is open. `renderTabs` assigns each tab its `param`: a league day is its own
  name (`tab=Day+5`), a day of a wildcard stage is `<stage>:<round>` (`tab=Wildcard+Liga+3:Day+1`), a bracket is `bracket:<stage>` — its merged group key is appended only where one stage holds
  more than one bracket tab, since `mergeConnected` usually leaves a stage with exactly one. A bracket's
  internal day key (`bracketDayKey`) joins its parts on NUL and never goes in the URL. `tabParam(day)`
  just looks the param up; params are only compared against the rendered tabs, so they must be stable,
  not reversible.
- `?search=<text>` — the Players view's search box, only while that view is open. Typing replaces it; a team link
  (`teamLinkHTML` / `teamPlayersHref` in common.js) pushes `view=players&search=<team name>`. Every team name on the
  tournament page links there (match cards, bracket slots, standings rows, "Your top N" picks, Teams-view tiles), as
  do the teams on me.html. On tournament.html a plain left click is caught and handled in place (`openTeamPlayers`);
  a modified or middle click follows the href.
- `syncUrl(replace)` writes all five from `state.activeTournament` / `state.activeView` /
  `state.activeTab` / `activeStandingsTable()` / `#players-search`, keeping any other params. A user's click **pushes** a history entry; settling on a
  default **replaces**, so the URL is always complete without cluttering history.
- `applyLocation()` is the `popstate` handler: it re-picks the players search, the view, the tab and the standings table.
  First load picks the view in the init handler, `renderGrid` → `activateWantedTab()` picks the tab,
  and `renderStandings` → `activateWantedStandingsTable()` the table once the standings have loaded.
- Unknown tab values are dropped silently — `activateWantedTab()` falls back to the default and rewrites
  the URL, so a stale link still lands somewhere sensible.

## Landing page & tournament page

Tournaments are ordered newest first (`byNewestTournament` in common.js — descending `tournament_id`).
`index.html` lists them in a grid, newest in the top left, oldest in the bottom right (plain row-major
CSS grid over the sorted list). Cards link to tournament.html via `tournamentHref`.

tournament.html's second header line (`#back-bar`) holds a "← Back to tournaments" `.bar-link` to `/`, its footer links
privacy.html and incidents.html. The `.view-btn` tabs — Matches, Standings, Teams, Players and Leaderboard — sit in
`#view-bar` in main, between the tournament name and the matches' day tabs. Each view shows the main-area elements
marked `data-view-panel="<view>"` and hides the rest. The matches load on page load whatever the view; every other view
loads once, the first time it opens, through its entry in `VIEW_LOADERS` (app.js). The row above the grid also holds the
stream-overlay dialog (links to overlay.html and control.html), "expand all" (one batched `POST /api/predictions` for
the panels it opens) and "Save as image".

A stage of a bracket format (`BRACKET_STAGE_TYPES`) is drawn as a bracket instead of a day grid (bracket.js), inside the
matches view — there is no sixth tab. Its matches never enter the section grid, and its nodes come from
`/api/brackets/:id` plus one `/api/bracket` per pair, so an all-TBD bracket still gets a tab. `mergeConnected` unions a
stage's groups whose nodes feed each other (a double-elim's Winners and Losers Bracket) into one tab labelled `Bracket`;
a group nobody crosses into keeps its own name (WB/LB/Main abbreviated), and only a stage holding several brackets
appends that key to its `?tab=bracket:<stage>`. `bracketLayout` places everything in plain data (graph, a column per
round, rows, edge routing, edge slots, winners above losers), drawn as absolutely positioned `.bracket-cell`s over one
SVG layer of elbow paths; a `ResizeObserver` relayouts when a predictions panel opens, which `bracketReflowPaused`
suspends during an image export. A node with a `match_id` is app.js's own `createCard` — predictions and Players links
and all; the rest are dimmed `TBD` boxes. Nothing animates — the edges are all that shows who advanced.

The Standings view shows one group's table at a time. Its tab bar (`#standings-tabs`) works like the
matches one: a `.category-btn` per stage on top, and the open stage's group tabs below — left out when
the stage has a single group. League and
pools tables show P/W/L, maps, map difference and points; swiss tables show P/W/L only. A D column
appears only where a group has draws. Dropped teams are dimmed and struck through.

Under each table sits the user's top-N prediction ("Your top N", `standingsPrediction` in standings.js). N is the
row's `pick_count`: 4 by default, set per stage in the admin panel (last season: 6 for Erste Liga, 8 for Vierte Liga). The
user's saved picks come from `/api/predictions/me` (`loadStandingPicks`, fetched alongside the standings; empty
when logged out). While the group is `open`, every team is listed — saved picks first, then the rest in table
order — and dragged into order by its `.pick-handle`, or moved with the arrow keys on a focused handle
(`makePickable`). A dragged row sits in the slot under the pointer, kept there by `translateY` and inside the list's top
and bottom edges.
The rows it displaces slide into their new slots (`slideRows`, a FLIP animation through the Web Animations API, also
used for arrow-key moves; skipped under `prefers-reduced-motion`). Slots are picked by `offsetTop`, which ignores
the slide transforms, so a row mid-slide can't flip the order back. Dragging uses document pointer events, not HTML5
drag and drop, so it works on touch; the handle sets `touch-action: none` and the row still scrolls the page. A dashed line under the Nth
row marks the cut (`.pick-cut`, set by `numberPicks`), only where a row exists below it (in a group of N or fewer, every team is saved). "Submit Prediction" (worded like the matches' "Submit Predictions", "Submitted" once stored) posts the first N as a `standings` entry through `submitWithName`
(app.js), the same name prompt / taken-name retry / password prompt as match predictions. Once the group is
locked, only the saved picks are shown, without handles; a locked group without picks shows nothing. An admin can
force a whole stage open (`force_open`, a switch in the admin panel), which keeps its groups predictable after their
first result; the standings view shows no hint of it — an open group simply reads as open.

The Teams view is a tile per team (`/api/teams/:id`); the Players view one `.data-table` row per lineup
entry (`/api/players/:id`). Both live in roster.js and share `bindSearch`: a search box filtering the
loaded list on the client, case- and accent-insensitive, keeping items that contain every typed word.
Players match on name, BattleTag, team and short name. The Teams search is not kept in the URL; the Players
search is (`?search=`, filled from outside through `setRosterSearch`). A team tile is an `<a class="team-link">`
to that team's players.
The players table is a `sortableTable` (`PLAYER_COLUMNS`): sorted by player name at first, a click on
Team groups the lineups again (team name, then lineup position), BattleTag sorts too.

The Leaderboard view (leaderboard.js) is computed on the client, no endpoint of its own: it takes the page's cached
matches and standings (`loadMatches`, `loadStandingsRows`, so opening it after the other views costs nothing), keeps
the matches with a final score, and posts their ids to `POST /api/predictions`.
An exact score earns `EXACT_POINTS` (2), any other correct winner `WINNER_POINTS` (1) — the winner
check is `sameOutcome` in common.js, shared with me.js's ✓/✗: sign of the score difference, so a draw
only counts on an actual draw. A prediction whose two numbers add up to 100 is a percentage
prediction (`isPercentPrediction` in common.js, e.g. 60:40): shown with % signs (`predictionText`),
earning no leaderboard points (it still counts under Predicted, Winners, Exact and %), and listed after
the score predictions in a match's predictions panel, under a "Win chance" heading, each row
its own bar (`percentRowHTML`, `.chance-row`: the row's background is split at team A's share, team A on
the left, the bigger share tinted in the accent color; team B's chance at the right end, team A's at the
end of its part of the bar or, where the name needs the room, right after the name). Ranked by points, then exact scores; users tied on both share a rank.
Columns are headed by whole words: Rank, Name, Predicted (predictions on finished matches), Winners
(correct winners, exact included), Exact, % (accuracy: Winners / Predicted), Points. Each
header has a `sort-col-<key>` class; the tables are built by `sortableTable` in app.js, shared with the Players view; the count columns share one width (`th:nth-child(n+3)`) so the match and league tables line up; together
they're wider than the standings' columns, so on narrow screens the table scrolls sideways (`.leaderboard-scroll`). The logged-in user's name is followed by a "You" in the accent color (`.leaderboard-you`), in both tables.
Every header is a `.sort-btn` (`LEADERBOARD_COLUMNS`): the first click sorts in the column's `asc`
direction (rank and name ascending, counts descending), a second flips it; `aria-sort` on the `th`
drives the arrow. Ties keep rank order, the Rank cell always shows the points rank, and the sort is not
kept in the URL (like the Teams search).

The view has two panels (not kept in the URL): League predictions, open first, and Match predictions (the table
above). Each holds `leaderboardTabs`' two tab lines — a category per stage and, under it, a tab per group of that
stage plus an `All` ahead of them holding the stage's groups together, exactly like the matches and standings bars
(`d-flex flex-wrap` lines of `.category-btn` inside a `d-flex flex-column mb-3` wrapper; the second line stays hidden
while the open stage has a single group, and clicking a stage opens its first group tab). The first category is the
panel-wide `All`, everyone with no group tabs below it; every other tab re-ranks on its own subset, so each is a race
of its own, scored with `groupWeights(all standing rows)` — each group's share of its stage's `STAGE_POINTS` — so a
group's table tops out at that share (20 in a two-group league) and the tables add up to the combined total.
`stageCategories(items, keyOf, tabOf)` does the grouping: league groups come
from the standings rows (`groupSubgroupKey`), match groups from each match's stage and group
(`matchSubgroupKey` — a section key without its round, or with its round where a stage has no groups, like a seeding
week), both ordered by `sectionOrder` on the stage/group pair; `tabOf` returns null to leave a group out, so a group
nobody predicted gets no tab. A panel or tab without rows shows a short status line,
and each tab's table is built the first time it opens, so a leaderboard with a tab per group builds nothing nobody
looks at. League predictions (`LEAGUE_COLUMNS`,
league tabs `leagueGroupColumns(max)` — the same without the Leagues column) are scored on the
client from `/api/standings/:id` and `/api/standings/predictions/:id`. Every group with standings rows is scored,
started or not — toornament already lists its teams, so a league before its first match ranks its predictors against
that seeding (`open` on a standings row is *not* a gate here); each predicted team is compared with its current `position`
(`diff` = predicted minus current place, absolute). Columns: Leagues (scored groups), In top (predicted teams
currently inside the predicted range, the top `pick_count` of their group), Exact (`diff` 0), Points (per team
`(teams in group - 1) - diff`, so 0 for a pick as far off as it can be; a group's sum
÷ ((teams in group - 1) × the group's pick slots, `min(pick_count, teams in group)`) × `STAGE_POINTS` (40) ÷ groups in its
stage — the slot count, not the number of picks stored, so leaving a place empty costs what a correct pick there
would have added, and the ratio capped at 1 because picks stored under a higher pick count outlive it; the total is rounded to quarters by
`roundQuarter`, shown with two decimals and its exact value in a hover bubble over the score (`.leaderboard-exact` in style.css, fed
by `pointsCell`), so a perfect league is worth 40, or 20 each when the stage has two groups). Ranked by points, then exact, then In top; ties share a rank. Points, the main score, is higher-is-better like every other count.

## Section / day model

A match has three name fields: `stage_name` ("Erste Liga"), `group_name` ("Division 1", or `""` for a match with no
group, like Seedingwoche) and `round_name` ("Day 5"). The round is the **day** and drives the tab bar. The backend
turns toornament's "Round N" into "Day N" for league/swiss/pools matches and leaves bracket rounds alone, so
`round_name` is always the display name.

`sectionKey(m)` in common.js joins the three with `SECTION_SEP` (`$`) into one key per grid section;
`sectionParts`/`sectionTitle`/`dayOf` split it back. Bracket tabs use their own key, `bracketDayKey(stage, group)`
in bracket.js, which starts with NUL so it can never collide with a round name.

Wildcard stages (`hasOwnDays` in common.js: the stage name contains "wildcard", hardcoded) keep their days to
themselves. Their day key is `<stage>$<round>` (`dayKey(m)` for a match, `dayOf` for a section key, `dayParts`
splits it), so a wildcard round robin's "Day 1" is its own tab, under a category named after the stage, instead of
sharing the leagues' "Day 1". Compare a match against a tab with `dayKey(m)`, never `round_name`.

The tab bar is two lines: one button per category (a league day prefix, a wildcard
stage or a bracket stage) on top, and below it the tabs of the category that holds the open tab — groups
without a label (a lone day like "Seedingwoche") sit in the top line as plain tabs,
and a category holding a single bracket tab shows no lower line at all, since its
button already carries the selection.
Clicking a category opens its first tab; `selectCategory`/`renderCategoryTabs` in
app.js own the switching, and `refreshTabStates` re-applies `.active`/`.invalid-day`
across both lines after any re-render.
Sorting:

- **Sections** (`sectionOrder` in common.js): round number desc (newest day first), then by day key (so a day's
  sections sit together), then league rank (`ligaRank`: `Erste < Zweite < Dritte < Vierte`, or the leading number
  of `1. Liga`, `2. Liga`, ...), then stage name, then group name (numbers compared numerically).
- **Days** (`compareDays`): shared days before wildcard ones (by stage name), then alphabetical on the non-digit
  prefix, then numeric ascending. So `Day 1`, `Day 2`, `Day 10` sort naturally; different prefixes group together.
- **Default tab** (when the URL names none, or names one this tournament doesn't have): the lowest-ranked
  day still containing matches without final scores, else the last tab.

## app.js conventions

- 4-space indent (the local formatter will reformat anything else).
- Helpers — prefer these to raw DOM calls. Almost all of them live in common.js, which loads first on every page;
  `loadImage`, `groupBy`, `sortableTable`, `findCard` and `percentRowHTML` are the ones app.js still owns:
    - `$(id)` — `getElementById`
    - `show`/`hide`/`setHidden(el, hidden)` — `d-none` toggling
    - `onClick(id, fn)` / `onEnter(id, fn)` — listener binding by id
    - `makeEl(tag, {dataset, ...props})` — element construction
    - `shakeEl(el)` — restart the shake animation across a forced reflow
    - `escapeHtml` / `escapeAttr` — for any user-provided string in templates; `proxied(url)` for every logo `src`
    - `statusLine({cls, text})` / `renderStatus(el, {cls, text})` — the centred line a view shows loading, empty and
      failed (app.js's `statusMsg` is the string form a predictions panel uses)
    - `loadImage(src)` — Promise wrapper around `new Image()`
    - `firstInt(s)` — first `\d+` match as integer or `NaN`
    - `groupBy(items, key)` — returns `Map<key, [[item, index], ...]>`
    - `sortableTable(rows, columns, {sortKey, tableClass, bodyClass})` (app.js) — a card with a `.data-table`
      sorted by clicking its headers; returns `{card, trs}`
    - `predictionRowHTML(p, sep, current, {match, you, own, heading})` — one prediction as a row, shared by a match
      card's panel and me.html so the two can't drift
    - `DEFAULT_PICK_COUNT` (4) — the pick slots a standings row arriving without a `pick_count` falls back to
    - `api(url, {method, body})` — auth + JSON; throws with `.code` and `.rateLimited` from `{err}` on `!ok`, owns the
      `X-Refreshing` toast, and drops the cached `/api/me` and `/api/predictions/me` after a `POST /api/submit` or
      `/api/login`
    - the load cache — `cachedLoad(key, load)` / `invalidateLoad(key)` behind `loadMatches`, `loadStandingsRows`,
      `loadMyPredictions` and `loadMe`: several views of one page ask an endpoint once, whoever gets there first, and a
      rejected load is dropped so the next call retries. `loadRoster` and the overlay pages key their own data in the
      same cache
    - `tryFetch(fn)` — swallows errors, returns `undefined` (use for non-critical loads)
    - `withDisabled(ids, fn)` — disables buttons around an async op, re-enables in `finally`
    - `findCard(index)` — `.card[data-index="..."]` lookup
    - `ifLogin(yes, no)` — branches by current modal mode
- Iterate teams with `SIDES = ['a','b']` and `OTHER_SIDE = {a:'b', b:'a'}` rather than hard-coding the two sides.
  `predictionRowHTML` and `REFRESH_MSG` are shared from common.js the same way: every `web/*.js` is a classic script in
  one global scope, so a name two of a page's scripts declare is a SyntaxError that kills both, and common.js is what
  loads before all of them.
- Templates use `insertAdjacentHTML` / template literals. Always run user-controlled strings through `escapeHtml` (text
  content) or `escapeAttr` (attribute values).

## Modal

Lives in auth.js. One `#name-modal` dialog re-used for four flows via `MODAL_MODES`:

- `'name'` — first-submit name prompt (with optional error + shake)
- `'login'` — login form, plus a "Create account" button (an empty `POST /api/submit`, then `/api/password`)
- `'password'` — post-submit "set a password?" prompt, name field disabled
- `'changePassword'` — the user menu's, same shape as `'password'`

`nameModal.open(mode, opts)` is the single entry point; `prompt`/`promptLogin`/`promptPassword`/`promptChangePassword`
are thin wrappers returning a Promise resolved by user action. `nameModal.mode` is the source of truth for `ifLogin`
branching; only the pending prompt is ever resolved (`_settle`), so a second close is harmless. Its one password field
is `current-password` in `'login'` and `new-password` everywhere else.

`openDialog`/`closeDialog`, next to the modal in auth.js, are how every dialog opens and shuts: the keyboard stays
inside it (Tab cycles its visible controls, Escape is its Cancel — or Skip, whichever the mode shows), the page behind
goes `aria-hidden`, and focus lands on `focusId` or the first control, then back on whatever opened it (the user button,
not the menu item that hid with the menu, for the log-out confirmation). One dialog holds the trap at a time; an overlap
hands it over. The image dialog and `#logout-modal` are static markup driven through them, `#overlay-info-modal` the
last one left on bare `show`/`hide`.

## Save-as-image

`saveImage()` runs from the image dialog (`imageDialog`): a checkbox per section of the open day (pre-checked to those
with the user's own predictions, or all of them where they have none) or per bracket branch (Winners / Losers), plus an
"Include my predictions" switch. `collectImageHides()` walks `#grid` in order, dropping unchecked sections and trimming
any leading `section-divider` from the first kept one; `collectBracketHides()` drops the cells, labels and edges of
unchecked branches (an edge goes when either endpoint does, so none dangles). Submitted badges and edit overlays never
belong in an image, and an expanded predictions panel — every user's picks — is stripped from every export whatever the
switches say; score inputs and outcome signs go only when the user excludes their predictions, in which case the inputs
of submitted scores are re-enabled for the render so they show ungreyed. `renderGridCanvas()` runs html2canvas over the
bracket's own canvas on a bracket tab, else over `#grid`, with the body background at device-pixel scale, then pads it
and draws the `pulow.png` watermark (a watermark that fails to load is no failure; any other one is caught by the caller
as "Failed to create the image"). `saveImage`'s `finally` restores everything either way.

## Working with the user

- **Do not run `git commit` during implementation.** The user commits themselves. (Mirrors the persisted memory.)
- Don't add emojis to code or files unless explicitly requested.
