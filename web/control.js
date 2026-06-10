// ============== Control room ==============
// The OBS dock dashboard. Shared state/helpers live in overlay-common.js (loaded
// first). Writes to localStorage drive the overlay tab live via the `storage`
// event; same-tab re-renders are triggered manually since `storage` doesn't fire
// in the tab that made the change.

const TRASH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5M11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1zm1.958 1-.846 10.58a1 1 0 0 1-.997.92h-6.23a1 1 0 0 1-.997-.92L3.042 3.5zM5.5 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5M8 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7A.5.5 0 0 1 8 5m2.5 0a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5"/></svg>';

const crEmpty = text => makeEl('p', {className: 'cr-empty', textContent: text});

// At most one picker modal is open at a time. openModal dismisses any current one,
// mounts a fresh full-screen backdrop with a box of `boxClass` (clicking outside the
// box closes it), and returns the box to fill. closeModal (and Escape) dismiss it.
let activeModal = null;
const closeModal = () => {
    activeModal?.remove();
    activeModal = null;
};

function openModal(boxClass) {
    closeModal();
    const box = makeEl('div', {className: boxClass});
    const overlay = makeEl('div', {className: 'ban-picker-overlay'});
    overlay.append(box);
    overlay.addEventListener('click', e => {
        if (e.target === overlay) closeModal();
    });
    document.body.append(overlay);
    activeModal = overlay;
    return box;
}

async function initControl() {
    const panel = $('control');
    panel.hidden = false;

    let syncScores = noop;
    let syncBans = noop;
    let syncScene = noop;
    const message = text => panel.replaceChildren(crEmpty(text));
    const actionBtn = (label, onClick) => {
        const btn = makeEl('button', {className: 'cr-swap', type: 'button', textContent: label});
        btn.addEventListener('click', onClick);
        return btn;
    };

    const adjust = (id, idx, delta) => {
        bumpScore(id, idx, delta);
        syncScores();
    };

    const setBan = (id, idx, key) => {
        const bans = loadBans(id);
        bans[idx] = key;
        saveBans(id, bans);
        syncBans();
    };

    // key -> display name, fetched once and reused for both ban buttons and picker.
    let heroMapPromise = null;
    const heroMap = () => (heroMapPromise ??= fetchHeroes()
        .then(list => new Map(list.map(h => [h.key, h.name])))
        .catch(() => new Map()));

    const fillBanBtn = (btn, key, name) => {
        btn.replaceChildren();
        if (key) {
            btn.append(
                makeEl('img', {className: 'cr-ban-icon', src: heroIcon(key), alt: ''}),
                makeEl('span', {textContent: name || key}),
            );
        } else {
            btn.append(makeEl('span', {textContent: 'Ban hero'}));
        }
        btn.classList.toggle('cr-ban-set', !!key);
    };

    // Searchable icon grid for choosing (or clearing) a team's banned hero.
    async function openPicker(id, idx) {
        const search = makeEl('input', {className: 'ban-search', type: 'text', placeholder: 'Search hero…'});
        const clearBtn = makeEl('button', {className: 'cr-swap ban-clear', type: 'button', textContent: 'Clear ban'});
        clearBtn.addEventListener('click', () => {
            setBan(id, idx, null);
            closeModal();
        });
        const head = makeEl('div', {className: 'ban-picker-head'});
        head.append(search, clearBtn);
        const grid = makeEl('div', {className: 'ban-grid'});

        const box = openModal('ban-picker');
        box.append(head, grid);
        search.focus();

        const heroes = await fetchHeroes().catch(() => []);
        const cells = heroes.map(h => {
            const cell = makeEl('button', {
                className: 'ban-cell',
                type: 'button',
                title: h.name,
                dataset: {name: h.name.toLowerCase()},
            });
            cell.append(
                makeEl('img', {className: 'ban-cell-icon', src: heroIcon(h.key), alt: ''}),
                makeEl('span', {className: 'ban-cell-name', textContent: h.name}),
            );
            cell.addEventListener('click', () => {
                setBan(id, idx, h.key);
                closeModal();
            });
            grid.append(cell);
            return cell;
        });
        search.addEventListener('input', () => {
            const q = search.value.trim().toLowerCase();
            cells.forEach(c => {
                c.hidden = !!q && !c.dataset.name.includes(q);
            });
        });
    }

    const selectMatch = mid => {
        clearMatchData(); // drop residual scores/swap/bans before repointing
        localStorage.setItem(CURRENT_KEY, String(mid));
        closeModal();
        render(); // same-tab write doesn't fire `storage`, so re-render manually
    };

    // Two-stage match picker: first pick a day, then a match within that day.
    async function openMatchPicker(currentId) {
        const box = openModal('match-picker');
        box.append(crEmpty('Loading matches…'));

        let matches;
        try {
            matches = await fetchMatches();
        } catch {
            return box.replaceChildren(crEmpty('Failed to load matches.'));
        }
        if (!matches.length) {
            return box.replaceChildren(crEmpty('No matches available.'));
        }

        const days = [...new Set(matches.map(m => dayOf(m.section ?? '')))].sort(compareDays);
        const matchesForDay = day => matches
            .filter(m => dayOf(m.section ?? '') === day)
            .sort((a, b) => sectionOrder(a.section ?? '', b.section ?? '')
                || (a.team_a ?? '').localeCompare(b.team_a ?? ''));

        // Stage 1: the whole screen is the day list.
        const showDays = () => {
            const title = makeEl('h2', {className: 'mp-title', textContent: 'Change match'});
            const sub = makeEl('p', {className: 'mp-sub', textContent: 'Pick a day'});
            const dayList = makeEl('div', {className: 'mp-days'});
            days.forEach(day => {
                const btn = makeEl('button', {className: 'mp-day', type: 'button', textContent: day});
                btn.addEventListener('click', () => showMatches(day));
                dayList.append(btn);
            });
            box.replaceChildren(title, sub, dayList);
        };

        // Stage 2: the whole screen is that day's matches, with a way back.
        const showMatches = day => {
            const back = makeEl('button', {className: 'mp-back', type: 'button', textContent: '‹ Days'});
            back.addEventListener('click', showDays);
            const head = makeEl('div', {className: 'mp-head'});
            head.append(back, makeEl('h2', {className: 'mp-title', textContent: day}));

            const list = makeEl('div', {className: 'mp-list'});
            list.append(...matchesForDay(day).map(m => {
                const row = makeEl('button', {className: 'mp-match', type: 'button'});
                if (String(m.id) === String(currentId)) row.classList.add('mp-match-current');
                row.append(
                    makeEl('img', {className: 'mp-logo', alt: '', src: proxied(m.logo_a)}),
                    makeEl('span', {className: 'mp-vs', textContent: `${m.team_a} vs ${m.team_b}`}),
                    makeEl('img', {className: 'mp-logo', alt: '', src: proxied(m.logo_b)}),
                );
                row.addEventListener('click', () => selectMatch(m.id));
                return row;
            }));
            box.replaceChildren(head, list);
        };

        showDays();
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });

    async function render() {
        syncScores = noop;
        syncBans = noop;
        syncScene = noop;
        const id = localStorage.getItem(CURRENT_KEY);
        if (!id) {
            // No match set yet (e.g. the overlay was opened bare); still let the
            // operator pick one, which the empty overlay will then switch to.
            const note = crEmpty('No match selected yet.');
            const pick = actionBtn('Choose match', () => openMatchPicker(null));
            return panel.replaceChildren(note, pick);
        }

        let match;
        try {
            match = await fetchMatch(id);
        } catch {
            return message('Failed to load matches.');
        }
        if (!match) return message(`Match ${id} not found.`);

        const scoreEls = [];
        const teamsRow = makeEl('div', {className: 'cr-teams'});
        SIDES.forEach((k, idx) => {
            const teamEl = makeEl('div', {className: 'cr-team'});
            teamEl.append(makeEl('div', {className: 'cr-name', textContent: match[`team_${k}`]}));

            const scoreEl = makeEl('span', {className: 'cr-score', textContent: loadScores(id)[idx]});
            const stepBtn = (label, aria, delta) => {
                const btn = makeEl('button', {className: 'cr-btn', textContent: label, ariaLabel: aria});
                btn.addEventListener('click', () => adjust(id, idx, delta));
                return btn;
            };
            const controls = makeEl('div', {className: 'cr-score-controls'});
            controls.append(stepBtn('−', 'Decrease score', -1), scoreEl, stepBtn('+', 'Increase score', +1));
            teamEl.append(controls);

            teamsRow.append(teamEl);
            scoreEls.push(scoreEl);
        });

        // Both teams' ban pickers sit together in one row beneath the scores
        // (left button = team a, right = team b), with a trashcan that clears both.
        const banBtns = SIDES.map((k, idx) => {
            const banBtn = makeEl('button', {
                className: 'cr-ban',
                type: 'button',
                title: `Ban hero for ${match[`team_${k}`]}`,
            });
            banBtn.addEventListener('click', () => openPicker(id, idx));
            return banBtn;
        });

        const clearBtn = makeEl('button', {
            className: 'cr-clear',
            type: 'button',
            title: 'Clear both bans',
            ariaLabel: 'Clear both bans',
        });
        clearBtn.innerHTML = TRASH_SVG;
        clearBtn.addEventListener('click', () => {
            saveBans(id, [null, null]);
            syncBans();
        });

        const bansRow = makeEl('div', {className: 'cr-bans'});
        bansRow.append(...banBtns, clearBtn);

        const bigBtn = actionBtn('Big view', () => {
            saveScene(loadScene() === 'big' ? 'normal' : 'big');
            syncScene();
        });
        const actions = makeEl('div', {className: 'cr-actions'});
        actions.append(
            actionBtn('Change match', () => openMatchPicker(id)),
            actionBtn('Swap teams', () => saveSwap(id, !loadSwap(id))),
            actionBtn('Cycle logo', () => saveLogo(nextLogo(loadLogo()))),
            bigBtn,
        );
        panel.replaceChildren(teamsRow, bansRow, actions);

        syncScores = () => {
            const scores = loadScores(id);
            scoreEls.forEach((el, idx) => {
                el.textContent = scores[idx];
            });
        };

        syncBans = async () => {
            const names = await heroMap();
            const bans = loadBans(id);
            banBtns.forEach((btn, idx) => fillBanBtn(btn, bans[idx], names.get(bans[idx])));
        };
        syncBans();

        syncScene = () => bigBtn.classList.toggle('cr-toggle-on', loadScene() === 'big');
        syncScene();
    }

    await render();
    window.addEventListener('storage', e => {
        if (e.key === CURRENT_KEY) render();             // overlay switched match
        else if (e.key?.startsWith(SCORE_PREFIX)) syncScores();
        else if (e.key?.startsWith(BAN_PREFIX)) syncBans();
        else if (e.key === SCENE_KEY) syncScene();
    });
}

initControl();
