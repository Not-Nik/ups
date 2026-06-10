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
    const sceneBg = $('scene-bg');
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

    // One block (logo, name, score) per team; paint() drops them into the left
    // or right slot per the swap state and tints each slot with the team color.
    const teams = SIDES.map((k, idx) => {
        const logo = makeEl('img', {className: 'team-logo', alt: ''});
        const nameEl = makeEl('span', {className: 'team-name', textContent: match[`team_${k}`]});
        const scoreEl = makeEl('span', {className: 'team-score'});
        const banImg = makeEl('img', {className: 'ban-icon', alt: ''});
        const banEl = makeEl('div', {className: 'ban-badge'});
        banEl.append(banImg);
        // Drop the intro class once it finishes (the strike is the last step) so
        // later DOM moves/repaints don't restart it; only a ban change re-adds it.
        banEl.addEventListener('animationend', e => {
            if (e.animationName === 'ban-strike') banEl.classList.remove('ban-animate');
        });
        const team = {idx, logo, nameEl, scoreEl, banImg, banEl, color: null, ban: undefined};

        scoreEl.addEventListener('click', () => bump(idx, +1));
        scoreEl.addEventListener('contextmenu', e => {
            e.preventDefault();
            bump(idx, -1);
        });

        logo.addEventListener('load', () => {
            team.color = averageColor(logo);
            paint();
        });
        logo.src = proxied(match[`logo_${k}`].replace('icon_medium', 'logo_large'));
        return team;
    });

    function paint() {
        const swap = loadSwap(id);
        const scores = loadScores(id);
        const bans = loadBans(id);
        const order = swap ? [teams[1], teams[0]] : [teams[0], teams[1]];
        order.forEach((team, slotPos) => {
            const slot = slots[slotPos];
            const rgb = team.color ? `rgb(${team.color.join(',')})` : '';
            // Re-appending the already-loaded nodes just moves them; no reload.
            slot.append(team.logo, team.nameEl, team.scoreEl);
            team.scoreEl.textContent = scores[team.idx];
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

    // Entering/leaving big view is a two-step move: `scene-exit` shoves the banners
    // off their sides, then one step later we set the target layout (scene-big) and
    // drop scene-exit so they slide back in. The delay matches the .team transition
    // in overlay.css. Before anim-ready (initial load) we just snap to the target.
    const SCENE_STEP_MS = 450;
    let sceneTimer = null;
    const paintScene = () => {
        const big = loadScene() === 'big';
        const body = document.body;
        if (!body.classList.contains('anim-ready')) {
            body.classList.toggle('scene-big', big);
            return;
        }
        clearTimeout(sceneTimer);
        body.classList.add('scene-exit');
        sceneTimer = setTimeout(() => {
            body.classList.toggle('scene-big', big);
            body.classList.remove('scene-exit');
        }, SCENE_STEP_MS);
    };

    paint();
    paintLogo();
    paintScene();
    // Enable transitions only after the first frame so a reload straight into big
    // view snaps into place instead of replaying the slide-in every time.
    requestAnimationFrame(() => document.body.classList.add('anim-ready'));
    window.addEventListener('storage', e => {
        if (e.key === CURRENT_KEY) {
            if (e.newValue && e.newValue !== id) switchMatch();
        } else if (e.key === scoreKey(id) || e.key === swapKey(id) || e.key === banKey(id)) {
            paint();
        } else if (e.key === LOGO_KEY) {
            paintLogo();
        } else if (e.key === SCENE_KEY) {
            paintScene();
        }
    });
}

initOverlay();
