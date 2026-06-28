// ============== Overlay ==============
// The transparent OBS browser source. Shared state/helpers live in
// overlay-common.js (loaded first). The control room (control.js) is the single
// source of truth for the live match (CURRENT_KEY in localStorage); reloading
// re-reads it and rebuilds, and all per-match state keys off that id, so a clean
// reload is the simplest way to repoint everything.

function showError(msg) {
    const el = $('error');
    el.textContent = msg;
    el.hidden = false;
}

// Centered prompt shown when the overlay is opened with no match to display.
function showSelectPrompt() {
    const link = makeEl('a', {href: 'control.html', textContent: 'control room'});
    const box = makeEl('div', {className: 'overlay-prompt'});
    box.append('Select a match in the ', link);
    document.body.append(box);
}

function switchMatch() {
    location.reload();
}

async function initOverlay() {
    const id = localStorage.getItem(CURRENT_KEY);
    if (!id) {
        showSelectPrompt();
        // Follow the control room once it picks a match.
        window.addEventListener('storage', e => {
            if (e.key === CURRENT_KEY && e.newValue) switchMatch();
        });
        return;
    }

    let match;
    try {
        match = await fetchMatch(id);
    } catch {
        return showError('Failed to load matches.');
    }
    if (!match) return showError(`Match ${id} not found.`);

    const slots = [$('team-a'), $('team-b')];
    const banSlots = [$('ban-left'), $('ban-right')];
    // Big view's central scoreboard mirrors the two banners' scores in slot order.
    const sceneScores = [...document.querySelectorAll('#scene-score .scene-score-num')];

    // Give each background shape a random starting angle so they aren't aligned.
    document.querySelectorAll('#scene-bg .scene-shape').forEach(shape => {
        shape.style.setProperty('--shape-rot', `${Math.floor(Math.random() * 360)}deg`);
    });

    // Scatter a handful of firework bursts across the scene. Each is a flash + ring
    // + radiating sparks (styled in overlay.css); random position and a negative
    // delay spread the pops out in time. Alternating boom-a/boom-b tints them with
    // the two team colours. Built into #scene-bg so they only show in big view.
    const BOOM_SPARKS = 12;
    const sceneBg = $('scene-fx');
    for (let i = 0; i < 6; i++) {
        const boom = makeEl('span', {className: `scene-boom boom-${i % 2 === 0 ? 'a' : 'b'}`});
        boom.style.left = `${10 + Math.random() * 80}%`;
        boom.style.top = `${15 + Math.random() * 70}%`;
        boom.style.setProperty('--boom-delay', `${-(Math.random() * 9).toFixed(2)}s`);
        boom.append(makeEl('span', {className: 'boom-flash'}), makeEl('span', {className: 'boom-ring'}));
        for (let s = 0; s < BOOM_SPARKS; s++) {
            const spark = makeEl('span', {className: 'boom-spark'});
            spark.style.setProperty('--a', `${(360 / BOOM_SPARKS) * s}deg`);
            boom.append(spark);
        }
        sceneBg.append(boom);
    }

    const bump = (idx, delta) => {
        bumpScore(id, idx, delta);
        paint(); // `storage` doesn't fire in the same tab, so repaint locally
    };

    // Proxied hi-res team logo. The API hands back the low-res `icon_medium` URL;
    // swapping in `logo_large` gives the crisp version used on the banners and on
    // the map-card winner badges.
    const teamLogo = side => {
        const url = match[`logo_${side}`];
        return url ? proxied(url.replace('icon_medium', 'logo_large')) : '';
    };

    // A winner badge's contents: the team's logo over the dimmed map art, or a short
    // text mark (shortName) when the team has no logo / it fails to load. Fills the
    // given `.map-winner` container (which owns the dimming + sizing in overlay.css).
    const fillWinner = (box, side) => {
        const textMark = () => box.replaceChildren(
            makeEl('span', {className: 'map-winner-text', textContent: shortName(match[`team_${side}`])}),
        );
        if (!match[`logo_${side}`]) return textMark();
        const img = makeEl('img', {className: 'map-winner-img', alt: ''});
        img.addEventListener('error', textMark, {once: true});
        img.src = teamLogo(side);
        box.replaceChildren(img);
    };

    // One block (logo, name, score) per team; paint() drops them into the left
    // or right slot per the swap state and tints each slot with the team color.
    // Banner tint for teams with no logo (no pixels to sample): team A red, team B
    // blue. Logo'd teams override this with their sampled average colour.
    const DEFAULT_TEAM_COLORS = [[13, 110, 253], [220, 53, 69]];

    const teams = SIDES.map((k, idx) => {
        // The logo box holds either an <img> or, for teams with no logo, a text
        // monogram (shortName). The box is the stable element the FLIP measures.
        const logo = makeEl('span', {className: 'team-logo'});
        const logoImg = makeEl('img', {className: 'team-logo-img', alt: ''});
        const nameEl = makeEl('span', {className: 'team-name', textContent: match[`team_${k}`]});
        // Outer wrapper clips the reveal (overflow + max-width); the inner plate keeps
        // a fixed width so its slant never collapses (see overlay.css). The number
        // lives on the inner plate.
        const scoreEl = makeEl('span', {className: 'team-score'});
        const scoreNum = makeEl('span', {className: 'team-score-plate'});
        scoreEl.append(scoreNum);
        const banImg = makeEl('img', {className: 'ban-icon', alt: ''});
        const banEl = makeEl('div', {className: 'ban-badge'});
        banEl.append(banImg);
        // Drop the intro class once it finishes (the strike is the last step) so
        // later DOM moves/repaints don't restart it; only a ban change re-adds it.
        banEl.addEventListener('animationend', e => {
            if (e.animationName === 'ban-strike') banEl.classList.remove('ban-animate');
        });
        const team = {idx, logo, nameEl, scoreEl, scoreNum, banImg, banEl, color: null, ban: undefined};

        scoreEl.addEventListener('click', () => bump(idx, +1));
        scoreEl.addEventListener('contextmenu', e => {
            e.preventDefault();
            bump(idx, -1);
        });

        // Swap the image for a monogram and fall back to the default team colour.
        const fillMonogram = () => {
            team.color = DEFAULT_TEAM_COLORS[idx];
            logo.replaceChildren(makeEl('span', {
                className: 'team-logo-text',
                textContent: shortName(match[`team_${k}`])
            }));
        };
        if (match[`logo_${k}`]) {
            logoImg.addEventListener('load', () => {
                team.color = averageColor(logoImg);
                paint();
            });
            logoImg.addEventListener('error', () => {
                fillMonogram();
                paint();
            }, {once: true});
            logoImg.src = teamLogo(k);
            logo.append(logoImg);
        } else {
            fillMonogram(); // the initial paint() at the end of init applies the colour
        }
        return team;
    });

    function paint() {
        const swap = loadSwap(id);
        const scores = loadScores(id);
        // The banner ban badges (shown on the in-game / big screens) carry only the
        // current map's bans; the maps screen shows every map's bans on its card.
        const maps = loadMaps(id);
        const li = latestMapIndex(maps);
        const bans = li === -1 ? [null, null] : maps[li].bans;
        const order = swap ? [teams[1], teams[0]] : [teams[0], teams[1]];
        order.forEach((team, slotPos) => {
            const slot = slots[slotPos];
            const rgb = team.color ? `rgb(${team.color.join(',')})` : '';
            // Re-appending the already-loaded nodes just moves them; no reload.
            slot.append(team.logo, team.nameEl, team.scoreEl);
            team.scoreNum.textContent = scores[team.idx];
            sceneScores[slotPos].textContent = scores[team.idx];
            slot.style.backgroundColor = rgb;
            slot.style.color = team.color ? contrastText(team.color) : '';

            // Drive the big-view background gradient from the two banner colors:
            // top-left slot 0 (upper banner) to bottom-right slot 1 (lower banner).
            document.body.style.setProperty(`--scene-color-${slotPos}`, rgb);

            // The ban badge follows its team to whichever side the swap puts it.
            // Only move it when the slot actually changes, and only (re)play the
            // reveal when this team's ban itself changes — not on unrelated
            // repaints (scores, the other team's ban), which would otherwise
            // restart the CSS animation by re-inserting the node.
            const ban = bans[team.idx];
            const banSlot = banSlots[slotPos];
            if (team.banEl.parentElement !== banSlot) banSlot.append(team.banEl);
            if (ban !== team.ban) {
                team.ban = ban;
                if (ban) team.banImg.src = heroIcon(ban);
                team.banEl.hidden = !ban;
                if (ban) {
                    team.banEl.classList.remove('ban-animate');
                    void team.banEl.offsetWidth; // reflow so the animation restarts
                    team.banEl.classList.add('ban-animate');
                }
            }
        });
    }

    const powered = $('powered');

    function paintLogo() {
        const state = loadLogo();
        powered.hidden = state === 'hidden';
        powered.classList.toggle('powered-left', state === 'left');
        powered.classList.toggle('powered-right', state === 'right');
    }

    // Switching scenes is a two-step move: `scene-exit` shoves the banners off their
    // sides, then one step later we set the target layout and drop scene-exit so they
    // slide back in. A team can change sides between scenes (team B sits on the left
    // on the maps screen), so the swap runs under `scene-snap`, which kills the banner
    // transition for that instant — otherwise the new resting anchor would make the
    // off-screen banner slide in from mid-screen instead of teleporting (invisibly) to
    // the new layout's off-screen position. The delay matches the .team transition in
    // overlay.css. Before anim-ready (initial load) we just snap to the target.
    const SCENE_STEP_MS = 450;
    let sceneTimer = null;
    let leaveTimer = null; // holds the maps screen visible while its cards fade out
    // Drive the body scene class off the persisted state. SCENE_STATES lives in
    // overlay-common.js; we toggle exactly one `scene-<state>` class at a time.
    const applyScene = scene => {
        SCENE_STATES.forEach(s => document.body.classList.toggle(`scene-${s}`, s === scene));
    };
    const isBigMaps = (a, b) => (a === 'big' && b === 'maps') || (a === 'maps' && b === 'big');

    // FLIP the logo and name across a big<->maps layout change. The banner itself
    // glides via CSS transitions, but the content's in-banner alignment (justify-
    // content / flex-direction) and size aren't transitionable, so they'd snap to
    // their new arrangement. Record each element's box (First), let applyScene change
    // the layout (Last), then invert the delta and transition it away (Play) — size
    // included — so the content rides along with the gliding banner. Returns the Play
    // step so the caller can run it straight after applyScene.
    const FLIP_EASE = '.45s cubic-bezier(.4, 0, .2, 1)';
    const cssProp = p => p === 'fontSize' ? 'font-size' : p;
    const captureContentFlip = () => {
        const movers = teams.flatMap(t => [
            {el: t.logo, sizes: ['width', 'height']},
            {el: t.nameEl, sizes: ['fontSize']},
        ]);
        const first = movers.map(m => {
            const cs = getComputedStyle(m.el);
            return {rect: m.el.getBoundingClientRect(), sizes: m.sizes.map(p => cs[p])};
        });
        return () => {
            movers.forEach((m, i) => {
                const a = first[i];
                const now = m.el.getBoundingClientRect();
                m.el.style.transition = 'none';
                m.el.style.transform = `translate(${a.rect.left - now.left}px, ${a.rect.top - now.top}px)`;
                m.sizes.forEach((p, j) => m.el.style[p] = a.sizes[j]);
            });
            void document.body.offsetWidth; // commit the inverted (old) layout
            movers.forEach(m => {
                const props = [...m.sizes.map(cssProp), 'transform'].map(p => `${p} ${FLIP_EASE}`);
                m.el.style.transition = props.join(', ');
                m.el.style.transform = '';
                m.sizes.forEach(p => m.el.style[p] = '');
            });
        };
    };

    const SCORE_EASE = 'max-width .4s cubic-bezier(.4, 0, .2, 1)';

    // Wipe each score plate open from zero width once it's on screen in the maps
    // scene. The plate is display:none in big view, so we force it to display (via the
    // applyScene that just ran) and a committed max-width:0, then transition to full —
    // an un-hide and animate in the same frame doesn't start reliably.
    const revealScores = () => {
        teams.forEach(t => {
            const el = t.scoreEl;
            el.style.cssText = ''; // drop any leftover collapse styles, then re-open in flow
            el.style.transition = 'none';
            el.style.maxWidth = '0';
            void el.offsetWidth;
            el.style.transition = SCORE_EASE;
            el.style.maxWidth = 'var(--score-w)';
        });
    };

    // Wipe each plate closed on the way back to big view. We pull it out of flow
    // (absolute, pinned to the banner's inner edge) for the wipe: that keeps it from
    // disturbing the logo/name as they glide, and removes the flex margin that would
    // otherwise make team B's plate slide to the other side. Cleared to CSS (which is
    // display:none in big) once the wipe finishes.
    const collapseScores = () => {
        teams.forEach(t => {
            const el = t.scoreEl;
            el.style.display = 'flex';
            el.style.position = 'absolute';
            el.style.top = '0';
            el.style.bottom = '0';
            el.style.right = '0';
            el.style.left = 'auto';
            el.style.transition = 'none';
            el.style.maxWidth = 'var(--score-w)';
            void el.offsetWidth;
            el.style.transition = SCORE_EASE;
            el.style.maxWidth = '0';
            const done = e => {
                if (e.propertyName !== 'max-width') return;
                el.removeEventListener('transitionend', done);
                el.style.cssText = '';
            };
            el.addEventListener('transitionend', done);
        });
    };

    const paintScene = () => {
        const scene = loadScene();
        const body = document.body;
        if (!body.classList.contains('anim-ready')) {
            applyScene(scene);
            body.classList.toggle('scene-fx-right', scene === 'maps'); // resting state on load
            return;
        }
        clearTimeout(sceneTimer);
        clearTimeout(leaveTimer);
        body.classList.remove('maps-leaving'); // cancel any in-flight maps fade-out
        const rightBanner = slots[1]; // #team-b, always the right-side banner
        rightBanner.style.left = ''; // drop any left-over pin from an interrupted move
        // Big and maps share the full-screen background, so move directly between them
        // (no off-screen slide). Team B traces an L: it first slides left along its
        // big-view row, then both banners glide to the stacked maps layout. The shared
        // mid state is "big layout, team B pinned to the left edge"; each phase is one
        // .team transition (top/left/width/height/clip-path), with the logo/name carried
        // by the FLIP in captureContentFlip. Transitions touching `normal` still slide.
        const prev = SCENE_STATES.find(s => body.classList.contains(`scene-${s}`));
        if (isBigMaps(prev, scene)) {
            body.classList.remove('scene-exit');
            if (scene === 'maps') {
                // Phase 1: team B slides left only (stays at its big-view height) and the
                // fx layer slides right in step with it. Phase 2: both banners glide in to
                // the stacked layout; scores + cards appear.
                rightBanner.style.left = '0';
                body.classList.add('scene-fx-right');
                sceneTimer = setTimeout(() => {
                    const playFlip = captureContentFlip();
                    applyScene('maps');
                    rightBanner.style.left = ''; // hand back to maps CSS (also left:0)
                    playFlip();
                    revealScores();
                }, SCENE_STEP_MS);
            } else {
                // Inverse. Phase 1: both banners drop to the big layout but team B holds
                // at the left edge (the mid corner, fx still shifted right) while the
                // scores wipe closed. Phase 2: team B slides right to its big-view spot
                // and the fx layer slides back left with it.
                // Keep the maps screen rendered so its cards can fade/drop out (reverse
                // of the entry rise) instead of being cut off by display:none.
                body.classList.add('maps-leaving');
                leaveTimer = setTimeout(() => body.classList.remove('maps-leaving'), SCENE_STEP_MS);
                const playFlip = captureContentFlip();
                applyScene('big');
                rightBanner.style.left = '0';
                playFlip();
                collapseScores();
                sceneTimer = setTimeout(() => {
                    rightBanner.style.left = '';
                    body.classList.remove('scene-fx-right');
                }, SCENE_STEP_MS);
            }
            return;
        }
        body.classList.add('scene-exit');
        sceneTimer = setTimeout(() => {
            body.classList.add('scene-snap');
            applyScene(scene);
            body.classList.toggle('scene-fx-right', scene === 'maps');
            void body.offsetWidth; // commit the snapped off-screen layout as the slide-in start
            body.classList.remove('scene-snap', 'scene-exit');
        }, SCENE_STEP_MS);
    };

    // Team accent colour for the match-point border, or null until sampled.
    const teamColor = side => {
        const c = teams[side === 'a' ? 0 : 1].color;
        return c ? `rgb(${c.join(',')})` : null;
    };

    // Manifest name lookup; starts empty and repaints once /maps/maps.json loads.
    let mapInfo = new Map();
    fetchMaps().then(list => {
        mapInfo = new Map(list.map(m => [m.key, m]));
        paintMaps();
    }).catch(noop);

    // One map tile: art (background image) + name + optional winner-team badge.
    // `kind` is played | upcoming | later and selects styling in overlay.css.
    function mapTile(slot, kind) {
        const tile = makeEl('div', {className: `map-tile map-${kind}`});
        const card = makeEl('div', {className: 'map-card'});
        const art = makeEl('div', {className: 'map-art'});
        if (slot.map) {
            const img = makeEl('img', {className: 'map-art-img', alt: ''});
            img.addEventListener('error', () => tile.classList.add('map-noart'));
            img.src = mapImage(slot.map);
            art.append(img);
        } else {
            tile.classList.add('map-noart');
        }
        // Played maps: the winner's logo (or text mark) fills the (dimmed) map art.
        if (slot.winner) {
            const badge = makeEl('span', {className: 'map-winner'});
            fillWinner(badge, slot.winner);
            art.append(badge);
        }
        const info = mapInfo.get(slot.map);
        const label = slot.map ? (info ? info.name : slot.map) : '—';
        card.append(art, makeEl('span', {className: 'map-name', textContent: label}));
        tile.append(card);
        return tile;
    }

    // Persistent maps-track tiles, keyed by slot index, so map changes animate
    // (appear, move, winner reveal) instead of rebuilding the whole timeline.
    const trackTiles = [];

    // A ban badge for the maps-screen card: reuses .ban-badge (red ring + strike)
    // at a smaller size. Hidden when the side hasn't banned for this map.
    function createBanBadge(cls) {
        const badge = makeEl('div', {className: `map-ban ${cls} ban-badge`, hidden: true});
        const icon = makeEl('img', {className: 'ban-icon', alt: ''});
        badge.append(icon);
        return {badge, icon, key: undefined};
    }

    function createTrackTile() {
        const tile = makeEl('div', {className: 'map-tile'});
        const card = makeEl('div', {className: 'map-card'});
        const art = makeEl('div', {className: 'map-art'});
        const img = makeEl('img', {className: 'map-art-img', alt: ''});
        img.addEventListener('error', () => tile.classList.add('map-noart'));
        art.append(img);
        const nameEl = makeEl('span', {className: 'map-name'});
        card.append(art, nameEl);
        // The top/bottom bans line up with the stacked banners (top = slot 0's team).
        const banTop = createBanBadge('map-ban-top');
        const banBot = createBanBadge('map-ban-bot');
        tile.append(banTop.badge, card, banBot.badge);
        return {tile, art, img, nameEl, banTop, banBot, winnerEl: null, mapKey: undefined, winner: undefined};
    }

    function tileName(slot) {
        if (!slot.map) return '—';
        const info = mapInfo.get(slot.map);
        return info ? info.name : slot.map;
    }

    // `key` = this side's banned hero (or null). `reserve` keeps the slot's space
    // (but invisible) when the other side banned, so a lone ban doesn't pull the
    // card off-centre; with neither side banning, the slot collapses entirely.
    const applyBan = (b, key, reserve) => {
        if (b.key !== key) {
            b.key = key;
            if (key) b.icon.src = heroIcon(key);
        }
        b.badge.hidden = !key && !reserve;
        b.badge.style.visibility = key ? '' : 'hidden';
    };

    function updateTrackTile(entry, slot, kind, mpColor, animate) {
        const {tile, art, img, nameEl} = entry;
        if (slot.map !== entry.mapKey) {
            entry.mapKey = slot.map;
            tile.classList.toggle('map-noart', !slot.map);
            if (slot.map) img.src = mapImage(slot.map);
        }
        nameEl.textContent = tileName(slot);

        // Top ban belongs to the team in the upper banner (slot 0); swap flips them.
        const swap = loadSwap(id);
        const topBan = slot.bans[swap ? 1 : 0];
        const botBan = slot.bans[swap ? 0 : 1];
        applyBan(entry.banTop, topBan, !!botBan);
        applyBan(entry.banBot, botBan, !!topBan);

        if (slot.winner !== entry.winner) {
            entry.winner = slot.winner;
            if (slot.winner) {
                if (!entry.winnerEl) {
                    entry.winnerEl = makeEl('span', {className: 'map-winner'});
                    art.append(entry.winnerEl);
                }
                fillWinner(entry.winnerEl, slot.winner);
                if (animate) {
                    entry.winnerEl.animate(
                        [{opacity: 0, transform: 'scale(.5)'}, {opacity: 1, transform: 'scale(1)'}],
                        {duration: 500, easing: 'cubic-bezier(.2, .7, .3, 1)'}
                    );
                }
            } else if (entry.winnerEl) {
                entry.winnerEl.remove();
                entry.winnerEl = null;
            }
        }

        tile.classList.remove('map-played', 'map-upcoming', 'map-later', 'map-matchpoint');
        tile.classList.add(`map-${kind}`);
        if (mpColor) {
            tile.classList.add('map-matchpoint');
            tile.style.setProperty('--mp-color', mpColor);
        } else {
            tile.style.removeProperty('--mp-color');
        }
    }

    // Reconcile the maps-scene timeline against the slots, animating moves (FLIP),
    // new tiles, and winner reveals — but only while the maps scene is
    // actually on screen (off-screen tiles have no layout to measure, so we snap).
    function syncTrack(maps, upi, mpoint) {
        const track = $('maps-track');
        const animate = document.body.classList.contains('anim-ready')
            && document.body.classList.contains('scene-maps');

        if (!maps.length) {
            trackTiles.length = 0;
            track.replaceChildren(makeEl('p', {className: 'maps-empty', textContent: 'No maps yet'}));
            return;
        }
        const placeholder = track.querySelector('.maps-empty');
        if (placeholder) placeholder.remove();

        const first = animate ? trackTiles.map(e => e.tile.getBoundingClientRect()) : null;

        const entering = [];
        maps.forEach((slot, i) => {
            let entry = trackTiles[i];
            if (!entry) {
                entry = createTrackTile();
                trackTiles[i] = entry;
                track.append(entry.tile);
                if (animate) entering.push(entry);
            }
            const kind = slot.winner ? 'played' : (i === upi ? 'upcoming' : 'later');
            const mpColor = (kind === 'upcoming' && mpoint.length)
                ? (mpoint.length === 2 ? '#ffcf3f' : (teamColor(mpoint[0]) || '#ffcf3f'))
                : null;
            updateTrackTile(entry, slot, kind, mpColor, animate);
        });
        while (trackTiles.length > maps.length) trackTiles.pop().tile.remove();

        if (!animate) return;

        // FLIP: slide any tile that shifted slot (re-centring on add/remove) to its new
        // spot. Same proven mechanism as captureContentFlip — measure boxes with
        // getBoundingClientRect (First, captured above), let the new tile re-flow the row
        // (Last), invert each mover to its old offset with the transition off, force one
        // reflow to commit that, then transition the offset away (Play). The move runs on
        // the outer wrapper so it composes with the inner card's kind scale.
        const movers = [];
        trackTiles.forEach((e, i) => {
            if (!first[i]) return; // created this pass — gets the entrance instead
            const now = e.tile.getBoundingClientRect();
            const dx = first[i].left - now.left;
            const dy = first[i].top - now.top;
            if (!dx && !dy) return;
            e.tile.style.transition = 'none';
            e.tile.style.transform = `translate(${dx}px, ${dy}px)`;
            movers.push(e.tile);
        });
        if (movers.length) {
            void document.body.offsetWidth; // commit the inverted (old) positions
            movers.forEach(tile => {
                tile.style.transition = 'transform .4s cubic-bezier(.4, 0, .2, 1)';
                tile.style.transform = '';
            });
        }
        // New tiles scale/fade in, on the wrapper so it composes with the card's scale.
        entering.forEach(e => {
            e.tile.animate(
                [{opacity: 0, transform: 'scale(.85)'}, {opacity: 1, transform: 'scale(1)'}],
                {duration: 400, easing: 'cubic-bezier(.2, .7, .3, 1)'}
            );
        });
    }

    function paintMaps() {
        const maps = loadMaps(id);
        const bo = loadBo(id);
        const wins = countWins(maps);
        const mpoint = matchPointTeams(wins, bo);

        // Big-view strip: played maps only, each with the winner's logo overlaid.
        const strip = $('maps-strip');
        const played = maps.filter(s => s.winner);
        strip.replaceChildren(...played.map(s => mapTile(s, 'played')));
        strip.hidden = !played.length;

        // The team banners (painted by paint()) carry the names/score on the maps
        // scene; here we reconcile the timeline of map tiles (animated; see syncTrack).
        // Only slots with a map chosen get a card — empty slots stay hidden until picked,
        // so the upcoming highlight tracks the first unplayed chosen map.
        const visible = maps.filter(s => s.map);
        syncTrack(visible, upcomingIndex(visible), mpoint);
    }

    paint();
    paintLogo();
    paintScene();
    paintMaps();
    // Enable transitions only after the first frame so a reload straight into big
    // view snaps into place instead of replaying the slide-in every time.
    requestAnimationFrame(() => document.body.classList.add('anim-ready'));
    window.addEventListener('storage', e => {
        if (e.key === CURRENT_KEY) {
            if (e.newValue && e.newValue !== id) switchMatch();
        } else if (e.key === scoreKey(id)) {
            paint();
        } else if (e.key === swapKey(id) || e.key === mapsKey(id)) {
            // Swap reorders the stacked banners (and the cards' top/bottom bans); a
            // maps change can move the current map whose bans the banners show.
            paint();
            paintMaps();
        } else if (e.key === boKey(id)) {
            paintMaps();
        } else if (e.key === LOGO_KEY) {
            paintLogo();
        } else if (e.key === SCENE_KEY) {
            paintScene();
        }
    });
}

initOverlay();
