// ============== Control room ==============
// The OBS dock dashboard. Shared state/helpers live in overlay-common.js (loaded
// first). Writes to localStorage drive the overlay tab live via the `storage`
// event; same-tab re-renders are triggered manually since `storage` doesn't fire
// in the tab that made the change.

const crEmpty = text => makeEl('p', {className: 'cr-empty', textContent: text});

// Scene switcher buttons: persisted state value -> label. 'normal' is the
// transparent in-game scoreboard; 'big' and 'maps' are the full-screen scenes.
const SCENE_LABELS = [['normal', 'In-game'], ['big', 'Big view'], ['maps', 'Maps']];

// Best-of selector: persisted length (or null = off) -> label.
const BO_OPTIONS = [[null, 'Bo: Off'], [3, 'Bo3'], [5, 'Bo5'], [7, 'Bo7']];

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
    let syncBo = noop;
    let syncMaps = noop;
    let mapsEl = null; // the horizontal map list, set in render() (for scroll-to-end)
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

    // Bans live on each map; the global ban row edits the latest (current) map's
    // bans. No-op when there is no map yet to attach them to.
    const setBan = (mid, idx, key) => {
        const maps = loadMaps(mid);
        const i = latestMapIndex(maps);
        if (i === -1) return;
        maps[i].bans[idx] = key;
        saveMaps(mid, maps);
        syncBans();
    };

    const setMap = (mid, slotIdx, key) => {
        const maps = loadMaps(mid);
        if (!maps[slotIdx]) return;
        maps[slotIdx].map = key;
        saveMaps(mid, maps);
        syncMaps();
    };

    // Declare (or swap to) `side` as the winner of the latest unplayed map. This is
    // the per-team "Won" control that replaces the manual +/- once maps are in play;
    // clicking the other team's button swaps the result. The score is derived from
    // the winners, so we recompute it here. No-op when there is no map yet.
    const setLatestWinner = (mid, side) => {
        const maps = loadMaps(mid);
        const i = latestMapIndex(maps);
        if (i === -1) return;
        maps[i].winner = maps[i].winner === side ? null : side; // re-click clears it
        saveMaps(mid, maps);
        saveScores(mid, derivedScore(mid));
        syncMaps();
        syncScores();
        syncBans(); // a winner change can move the "current" map the ban row edits
    };

    const addMap = (mid, mapKey) => {
        const maps = loadMaps(mid);
        maps.push({map: mapKey || null, winner: null, bans: [null, null]});
        saveMaps(mid, maps);
        // The new slot is appended at the right; reveal it once the row is in the DOM.
        const done = syncMaps();
        if (done?.then) done.then(() => mapsEl && (mapsEl.scrollLeft = mapsEl.scrollWidth));
        syncBans();   // the new map may become the current one the ban row edits
        syncScores(); // first map flips the +/- over to the Won buttons
    };

    const removeMap = (mid, slotIdx) => {
        const maps = loadMaps(mid);
        maps.splice(slotIdx, 1);
        saveMaps(mid, maps);
        saveScores(mid, derivedScore(mid));
        syncMaps();
        syncScores();
        syncBans();
    };

    // key -> name, fetched once for the picker thumbnails and slot labels.
    let mapNamePromise = null;
    const mapNames = () => (mapNamePromise ??= fetchMaps()
        .then(list => new Map(list.map(m => [m.key, m.name])))
        .catch(() => new Map()));

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

    // Searchable, mode-grouped grid for choosing a map. `slotIdx === null` adds a new
    // map slot on pick; an existing index changes that slot's map (and offers removal).
    async function openMapPicker(mid, slotIdx) {
        const search = makeEl('input', {className: 'ban-search', type: 'text', placeholder: 'Search map…'});
        const head = makeEl('div', {className: 'ban-picker-head'});
        head.append(search);
        if (slotIdx !== null) {
            const removeBtn = makeEl('button', {className: 'cr-swap ban-clear', type: 'button', textContent: 'Remove map'});
            removeBtn.addEventListener('click', () => {
                removeMap(mid, slotIdx);
                closeModal();
            });
            head.append(removeBtn);
        }
        const grid = makeEl('div', {className: 'map-grid'});

        const box = openModal('ban-picker');
        box.append(head, grid);
        search.focus();

        const maps = await fetchMaps().catch(() => []);
        const MODES = ['Control', 'Hybrid', 'Escort', 'Push', 'Flashpoint', 'Clash'];
        const groups = []; // {wrap, cells} so search can hide whole empty modes
        MODES.forEach(mode => {
            const inMode = maps.filter(m => m.mode === mode);
            if (!inMode.length) return;
            const wrap = makeEl('div', {className: 'map-group'});
            wrap.append(makeEl('h3', {className: 'map-group-title', textContent: mode}));
            const cellsRow = makeEl('div', {className: 'map-cells'});
            const cells = inMode.map(m => {
                const cell = makeEl('button', {
                    className: 'ban-cell',
                    type: 'button',
                    title: m.name,
                    dataset: {name: m.name.toLowerCase()},
                });
                const img = makeEl('img', {className: 'map-cell-icon', alt: ''});
                img.addEventListener('error', () => img.classList.add('map-cell-noart'));
                img.src = mapImage(m.key);
                cell.append(img, makeEl('span', {className: 'ban-cell-name', textContent: m.name}));
                cell.addEventListener('click', () => {
                    if (slotIdx === null) addMap(mid, m.key);
                    else setMap(mid, slotIdx, m.key);
                    closeModal();
                });
                cellsRow.append(cell);
                return cell;
            });
            wrap.append(cellsRow);
            grid.append(wrap);
            groups.push({wrap, cells});
        });

        search.addEventListener('input', () => {
            const q = search.value.trim().toLowerCase();
            groups.forEach(({wrap, cells}) => {
                let anyVisible = false;
                cells.forEach(c => {
                    const hide = !!q && !c.dataset.name.includes(q);
                    c.hidden = hide;
                    if (!hide) anyVisible = true;
                });
                wrap.hidden = !anyVisible;
            });
        });
    }

    const selectMatch = (tid, mid) => {
        clearMatchData(); // drop residual scores/swap/bans before repointing
        localStorage.setItem(TOURNAMENT_KEY, String(tid));
        localStorage.setItem(CURRENT_KEY, String(mid));
        closeModal();
        render(); // same-tab write doesn't fire `storage`, so re-render manually
    };

    // Three-stage match picker: pick a tournament, then a day, then a match.
    async function openMatchPicker(currentTournamentId, currentId) {
        const box = openModal('match-picker');
        box.append(crEmpty('Loading tournaments…'));

        let tournaments;
        try {
            tournaments = await fetchTournaments();
        } catch {
            return box.replaceChildren(crEmpty('Failed to load tournaments.'));
        }
        if (!tournaments.length) {
            return box.replaceChildren(crEmpty('No tournaments available.'));
        }

        // Stage 1: the whole screen is the tournament list.
        const showTournaments = () => {
            const title = makeEl('h2', {className: 'mp-title', textContent: 'Change match'});
            const sub = makeEl('p', {className: 'mp-sub', textContent: 'Pick a tournament'});
            const list = makeEl('div', {className: 'mp-days'});
            tournaments.forEach(t => {
                const btn = makeEl('button', {className: 'mp-day', type: 'button', textContent: t.name});
                if (String(t.tournament_id) === String(currentTournamentId)) btn.classList.add('mp-match-current');
                btn.addEventListener('click', () => showDays(t));
                list.append(btn);
            });
            box.replaceChildren(title, sub, list);
        };

        // Stage 2: the whole screen is that tournament's day list, with a way back.
        const showDays = async tournament => {
            box.replaceChildren(crEmpty('Loading matches…'));
            let matches;
            try {
                matches = await fetchMatches(tournament.tournament_id);
            } catch {
                return box.replaceChildren(crEmpty('Failed to load matches.'));
            }
            if (!matches.length) {
                return box.replaceChildren(crEmpty('No matches available.'));
            }

            const days = [...new Set(matches.map(m => m.round_name ?? ''))].sort(compareDays);
            const matchesForDay = day => matches
                .filter(m => (m.round_name ?? '') === day)
                .sort((a, b) => sectionOrder(sectionKey(a), sectionKey(b))
                    || (a.team_a ?? '').localeCompare(b.team_a ?? ''));

            const back = makeEl('button', {className: 'mp-back', type: 'button', textContent: '‹ Tournaments'});
            back.addEventListener('click', showTournaments);
            const head = makeEl('div', {className: 'mp-head'});
            head.append(back, makeEl('h2', {className: 'mp-title', textContent: tournament.name}));
            const sub = makeEl('p', {className: 'mp-sub', textContent: 'Pick a day'});
            const dayList = makeEl('div', {className: 'mp-days'});
            days.forEach(day => {
                const btn = makeEl('button', {className: 'mp-day', type: 'button', textContent: day});
                btn.addEventListener('click', () => showMatches(tournament, day, matchesForDay(day)));
                dayList.append(btn);
            });
            box.replaceChildren(head, sub, dayList);
        };

        // Stage 3: the whole screen is that day's matches, with a way back.
        const showMatches = (tournament, day, dayMatches) => {
            const back = makeEl('button', {className: 'mp-back', type: 'button', textContent: '‹ Days'});
            back.addEventListener('click', () => showDays(tournament));
            const head = makeEl('div', {className: 'mp-head'});
            head.append(back, makeEl('h2', {className: 'mp-title', textContent: day}));

            const list = makeEl('div', {className: 'mp-list'});
            list.append(...dayMatches.map(m => {
                const row = makeEl('button', {className: 'mp-match', type: 'button'});
                if (String(tournament.tournament_id) === String(currentTournamentId)
                    && String(m.id) === String(currentId)) row.classList.add('mp-match-current');
                row.append(
                    makeEl('img', {className: 'mp-logo', alt: '', src: proxied(m.logo_a)}),
                    makeEl('span', {className: 'mp-vs', textContent: `${m.team_a} vs ${m.team_b}`}),
                    makeEl('img', {className: 'mp-logo', alt: '', src: proxied(m.logo_b)}),
                );
                row.addEventListener('click', () => selectMatch(tournament.tournament_id, m.id));
                return row;
            }));
            box.replaceChildren(head, list);
        };

        showTournaments();
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });

    async function render() {
        syncScores = noop;
        syncBans = noop;
        syncScene = noop;
        syncBo = noop;
        syncMaps = noop;
        const id = localStorage.getItem(CURRENT_KEY);
        const tid = localStorage.getItem(TOURNAMENT_KEY);
        if (!id || !tid) {
            // No match set yet (e.g. the overlay was opened bare); still let the
            // operator pick one, which the empty overlay will then switch to.
            const note = crEmpty('No match selected yet.');
            const pick = actionBtn('Choose match', () => openMatchPicker(null, null));
            return panel.replaceChildren(note, pick);
        }

        let match;
        try {
            match = await fetchMatch(tid, id);
        } catch {
            return message('Failed to load matches.');
        }
        if (!match) return message(`Match ${id} not found.`);

        const scoreEls = [];
        const stepEls = []; // [minus, plus] per team — hidden once maps drive the score
        const winBtns = []; // per-team "Won" button — shown instead, once maps exist
        const banBtns = []; // per-team ban picker button
        // One line per team, columns aligned by the grid: name | score (+/- or Won) | ban.
        const teamsRow = makeEl('div', {className: 'cr-teams'});
        SIDES.forEach((k, idx) => {
            const nameEl = makeEl('div', {className: 'cr-name', textContent: match[`team_${k}`]});

            const scoreEl = makeEl('span', {className: 'cr-score', textContent: loadScores(id)[idx]});
            const stepBtn = (label, aria, delta) => {
                const btn = makeEl('button', {className: 'cr-btn', textContent: label, ariaLabel: aria});
                btn.addEventListener('click', () => adjust(id, idx, delta));
                return btn;
            };
            const minus = stepBtn('−', 'Decrease score', -1);
            const plus = stepBtn('+', 'Increase score', +1);
            // Once maps are in play the score is derived: this declares the team the
            // winner of the latest unplayed map (or swaps it). Gold outline = winner.
            const wonBtn = makeEl('button', {className: 'cr-won', type: 'button', textContent: 'Won', hidden: true});
            wonBtn.addEventListener('click', () => setLatestWinner(id, k));
            const controls = makeEl('div', {className: 'cr-score-controls'});
            controls.append(minus, scoreEl, plus, wonBtn);

            // Per-team ban for the current map (the picker itself can clear it).
            const banBtn = makeEl('button', {
                className: 'cr-ban',
                type: 'button',
                title: `Ban hero for ${match[`team_${k}`]}`,
            });
            banBtn.addEventListener('click', () => openPicker(id, idx));

            teamsRow.append(nameEl, controls, banBtn);
            scoreEls.push(scoreEl);
            stepEls.push([minus, plus]);
            winBtns.push(wonBtn);
            banBtns.push(banBtn);
        });

        const sceneBtns = SCENE_LABELS.map(([state, label]) => {
            const btn = actionBtn(label, () => {
                saveScene(state);
                syncScene();
            });
            btn.dataset.scene = state;
            return btn;
        });
        const boSelect = makeEl('select', {className: 'cr-select'});
        BO_OPTIONS.forEach(([n, label]) => {
            boSelect.append(makeEl('option', {value: n === null ? '' : String(n), textContent: label}));
        });
        boSelect.addEventListener('change', () => {
            saveBo(id, boSelect.value === '' ? null : Number(boSelect.value));
            syncBo();
            syncMaps(); // the match-point highlight depends on best-of
        });

        const mapsList = makeEl('div', {className: 'cr-maps'});
        mapsEl = mapsList;
        // Title, best-of dropdown and "Add map" share one header line. Best-of lives
        // here (not the control grid) since it drives the maps' match-point detection.
        const mapsHead = makeEl('div', {className: 'cr-maps-head'});
        mapsHead.append(
            makeEl('h2', {className: 'cr-maps-title', textContent: 'Maps'}),
            boSelect,
            actionBtn('Add map', () => openMapPicker(id, null)),
        );
        const mapsSection = makeEl('div', {className: 'cr-maps-section'});
        mapsSection.append(mapsHead, mapsList);

        // Compact control grid: a label column beside each button group, so the view
        // and the one-off match actions stack tightly instead of as full-width rows.
        const controlTable = makeEl('div', {className: 'cr-control-table'});
        const controlRow = (label, ...controls) => {
            const cell = makeEl('div', {className: 'cr-control-cell'});
            cell.append(...controls);
            controlTable.append(
                makeEl('span', {className: 'cr-control-label', textContent: label}),
                cell,
            );
        };
        controlRow('View', ...sceneBtns);
        controlRow('Match',
            actionBtn('Change match', () => openMatchPicker(tid, id)),
            actionBtn('Swap teams', () => saveSwap(id, !loadSwap(id))),
            actionBtn('Cycle logo', () => saveLogo(nextLogo(loadLogo()))),
        );

        panel.replaceChildren(teamsRow, mapsSection, controlTable);

        syncScores = () => {
            const scores = loadScores(id);
            const maps = loadMaps(id);
            const li = latestMapIndex(maps);
            const active = li !== -1; // maps drive the score -> swap +/- for the Won button
            const winner = active ? maps[li].winner : null;
            scoreEls.forEach((el, idx) => {
                el.textContent = scores[idx];
            });
            SIDES.forEach((k, idx) => {
                stepEls[idx].forEach(btn => btn.hidden = active);
                winBtns[idx].hidden = !active;
                winBtns[idx].classList.toggle('cr-won-on', winner === k);
            });
        };
        syncScores();

        syncBans = async () => {
            const names = await heroMap();
            const maps = loadMaps(id);
            const i = latestMapIndex(maps);
            const bans = i === -1 ? [null, null] : maps[i].bans;
            banBtns.forEach((btn, idx) => {
                fillBanBtn(btn, bans[idx], names.get(bans[idx]));
                btn.disabled = i === -1; // nothing to ban for until a map exists
            });
        };
        syncBans();

        syncScene = () => {
            const cur = loadScene();
            sceneBtns.forEach(btn => btn.classList.toggle('cr-toggle-on', btn.dataset.scene === cur));
        };
        syncScene();

        syncBo = () => {
            const cur = loadBo(id);
            boSelect.value = cur === null ? '' : String(cur);
        };
        syncBo();

        syncMaps = async () => {
            const names = await mapNames();
            const maps = loadMaps(id);
            const upi = upcomingIndex(maps);
            const mpoint = matchPointTeams(countWins(maps), loadBo(id));
            mapsList.replaceChildren(...maps.map((slot, i) => {
                const row = makeEl('div', {className: 'cr-map-row'});
                if (i === upi) row.classList.add('cr-map-upcoming');
                if (i === upi && mpoint.length) row.classList.add('cr-map-matchpoint');

                // The card is just the map; clicking it re-opens the picker (change or
                // remove). Winners are set from the per-team Won buttons up top.
                const pick = makeEl('button', {className: 'cr-map-pick', type: 'button'});
                if (slot.map) {
                    pick.append(
                        makeEl('img', {className: 'cr-map-thumb', src: mapImage(slot.map), alt: ''}),
                        makeEl('span', {textContent: names.get(slot.map) || slot.map}),
                    );
                } else {
                    pick.append(makeEl('span', {textContent: 'Pick map'}));
                }
                pick.addEventListener('click', () => openMapPicker(id, i));

                row.append(pick);
                return row;
            }));
            if (!maps.length) mapsList.append(crEmpty('No maps yet. Add the first map.'));
        };
        syncMaps();
    }

    await render();
    window.addEventListener('storage', e => {
        if (e.key === CURRENT_KEY) render();             // overlay switched match
        else if (e.key?.startsWith(SCORE_PREFIX)) syncScores();
        else if (e.key?.startsWith(MAPS_PREFIX)) {
            syncMaps();
            syncBans();   // bans live on the maps now
            syncScores(); // the Won button's gold/visibility tracks the latest map
        } else if (e.key?.startsWith(BO_PREFIX)) {
            syncBo();
            syncMaps();
        } else if (e.key === SCENE_KEY) syncScene();
    });
}

initControl();
