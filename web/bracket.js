// ============== Bracket view ==============
// Tournament-format stages render as a drawn bracket inside the main grid, reusing
// the same score-box cards as the league view. Data comes from /api/bracket (one
// fetch per stage+group); structure/edges come from the node `source_*` fields.
// Loaded after app.js, so it shares its globals (createCard, state, helpers).

const BRACKET_STAGE_TYPES = new Set(['single_elimination', 'double_elimination', 'bracket_groups']);

// The image export hides individual cells/edges via display:none; that resizes cells
// and would trigger the reflow observer, which rebuilds the SVG and undoes those hides.
// saveImage() raises this flag to suspend the live reflow for the duration of a render.
let bracketReflowPaused = false;

// Layout geometry (px). A column per round, a row per bracket slot. GAP is the clear
// channel between columns that edges route through. Column 0 holds only seeds (no
// incoming edges), so the bracket can start flush at the left, aligned with the grid.
const COL_W = 230;
const GAP = 80;
const COL_STRIDE = COL_W + GAP;
const LEFT_PAD = 0;
const CARD_H = 84;
const ROW_STRIDE = 120;
const BRANCH_GAP = 64;
const LABEL_H = 32;
const BRANCH_LABEL = {wb: 'Winners Bracket', lb: 'Losers Bracket'};
const BRANCH_RANK = {wb: 0, lb: 1};
const branchRank = b => BRANCH_RANK[b] ?? 9; // sort key: winners above losers, unknown last

// Append a value to the array stored at map[key], creating it on first use.
const pushTo = (map, key, value) => (map.get(key) ?? map.set(key, []).get(key)).push(value);

// A unique, never-displayed day key so activateTab can toggle a whole bracket as a
// unit; and the short label shown on its tab button.
const bracketDayKey = (stage, group) => `\u0000bracket\u0000${stage}\u0000${group}`;
const GROUP_ABBR = {'Winners Bracket': 'WB', 'Losers Bracket': 'LB', 'Main Bracket': 'Main'};
const bracketGroupLabel = group => GROUP_ABBR[group] ?? group;

// Fetch the list of bracket (stage, group) pairs from /api/brackets, then each one's
// nodes. Using the dedicated list (not the match feed) means all-TBD brackets — ones
// with no predictable match yet, like an undrawn Playoffs — still get a tab.
async function loadBrackets() {
    const pairs = await tryFetch(() => api('/api/brackets'));
    if (!pairs || !pairs.length) return [];
    const out = [];
    await Promise.all(pairs.map(async ({stage, group}) => {
        const nodes = await tryFetch(() => api(
            `/api/bracket?stage=${encodeURIComponent(stage)}&group=${encodeURIComponent(group)}`));
        if (nodes && nodes.length) out.push({stage, group, nodes});
    }));
    out.sort((a, b) =>
        (a.nodes[0].stage_number - b.nodes[0].stage_number) || a.group.localeCompare(b.group));
    return mergeConnected(out);
}

// Within a stage, merge groups whose matches feed into each other into one tab, so a
// bracket split across groups (e.g. a double-elim's Winners/Losers Bracket, where the
// losers' slots are fed by the winners') is shown as a single connected tree. Groups
// with no cross-group edges stay as their own tab. Returns entries with a unique
// `key` (for the day key) and a display `label`.
function mergeConnected(brackets) {
    const byStage = new Map();
    for (const b of brackets) pushTo(byStage, b.stage, b);
    const out = [];
    for (const [stage, list] of byStage) {
        const groupOf = new Map(); // node_id -> group index in this stage
        list.forEach((b, gi) => b.nodes.forEach(n => groupOf.set(n.node_id, gi)));

        const parent = list.map((_, i) => i);
        const find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
        list.forEach((b, gi) => b.nodes.forEach(n => {
            for (const src of [n.source_a, n.source_b]) {
                const og = groupOf.get(src);
                if (og != null && og !== gi) parent[find(gi)] = find(og);
            }
        }));

        const comps = new Map(); // component root -> [group indices]
        list.forEach((_, gi) => (comps.get(find(gi)) ?? comps.set(find(gi), []).get(find(gi))).push(gi));

        for (const idxs of [...comps.values()].sort((a, b) => a[0] - b[0])) {
            const members = idxs.sort((a, b) => a - b).map(i => list[i]);
            if (members.length === 1) {
                const b = members[0];
                out.push({stage, key: b.group, label: bracketGroupLabel(b.group), nodes: b.nodes});
            } else {
                out.push({
                    stage,
                    key: members.map(m => m.group).join('|'),
                    label: 'Bracket',
                    nodes: members.flatMap(m => m.nodes),
                });
            }
        }
    }
    return out;
}

// Pure layout: assign every node an {x, y, col} and resolve the source edges into
// orthogonal paths. Columns come from longest-path layering over the feed graph: a
// node sits one column past its deepest feeder (cross-branch drops included), so a
// match lines up with whatever actually feeds it (e.g. a losers round that only takes
// the previous winners round's losers sits level with that winners round, not after
// it). Rows place each node at the average height of its same-branch feeders.
// `expanded` maps a node id to extra pixels (an open predictions panel); those cards
// push everything below them down so nothing overlaps. Empty = the base layout.
function bracketLayout(nodes, expanded = new Map()) {
    const byId = new Map(nodes.map(n => [n.node_id, n]));
    const sourcesOf = n => [n.source_a, n.source_b].filter(s => s && byId.has(s));
    const branches = new Map();
    for (const n of nodes) pushTo(branches, n.branch ?? '', n);
    const branchKeys = [...branches.keys()].sort((a, b) => branchRank(a) - branchRank(b));
    const multiBranch = branchKeys.length > 1;

    // Longest-path column per node (memoised DFS; the feed graph is a DAG).
    const col = new Map();
    const lp = id => {
        if (col.has(id)) return col.get(id);
        const srcs = sourcesOf(byId.get(id));
        col.set(id, 0); // guards against a malformed cycle
        const c = srcs.length ? 1 + Math.max(...srcs.map(lp)) : 0;
        col.set(id, c);
        return c;
    };
    nodes.forEach(n => lp(n.node_id));
    // Keep a whole round in one column (its deepest member's), and strictly increasing
    // across a branch's rounds, so same-branch edges always step forward by ≥1 column.
    for (const branch of branchKeys) {
        let prev = -1;
        for (const r of [...new Set(branches.get(branch).map(n => n.round_number))].sort((x, y) => x - y)) {
            const rn = branches.get(branch).filter(n => n.round_number === r);
            const c = Math.max(prev + 1, ...rn.map(n => col.get(n.node_id)));
            rn.forEach(n => col.set(n.node_id, c));
            prev = c;
        }
    }

    const labelTop = multiBranch ? LABEL_H : 0;
    const pos = new Map();
    const branchInfo = [];
    let yBase = 0;
    for (const branch of branchKeys) {
        const bn = branches.get(branch);
        const rowOf = new Map();
        let seed = 0; // sequential fallback row for nodes with no same-branch feeder
        const cols = [...new Set(bn.map(n => col.get(n.node_id)))].sort((x, y) => x - y);
        for (const c of cols) {
            const cn = bn.filter(n => col.get(n.node_id) === c);
            const want = new Map();
            for (const n of cn) {
                const f = sourcesOf(n)
                    .filter(s => byId.get(s).branch === branch && rowOf.has(s))
                    .map(s => rowOf.get(s));
                want.set(n.node_id, f.length ? f.reduce((a, v) => a + v, 0) / f.length : null);
            }
            // Seeds (no same-branch feeder) take the next free rows, in bracket order.
            cn.filter(n => want.get(n.node_id) == null).sort((a, b) => a.position - b.position)
                .forEach(n => want.set(n.node_id, seed++));
            // Place by desired row, nudging down to keep a one-row minimum gap.
            let last = -Infinity;
            cn.slice().sort((a, b) => want.get(a.node_id) - want.get(b.node_id) || a.position - b.position)
                .forEach(n => {
                    const row = Math.max(want.get(n.node_id), last + 1);
                    rowOf.set(n.node_id, row);
                    last = row;
                });
        }
        const maxRow = Math.max(0, ...rowOf.values());
        for (const n of bn) {
            const c = col.get(n.node_id);
            pos.set(n.node_id, {
                x: LEFT_PAD + c * COL_STRIDE,
                y: yBase + labelTop + rowOf.get(n.node_id) * ROW_STRIDE,
                col: c, branch,
            });
        }
        branchInfo.push({branch, label: BRANCH_LABEL[branch] ?? ''});
        yBase += labelTop + (maxRow + 1) * ROW_STRIDE + BRANCH_GAP;
    }

    // Expansion: push every card below an expanded one down by its extra height, then
    // derive the band extents from the resulting positions (edges still attach at the
    // score-box, which stays at the card's top). With no expansion this is the base.
    const heightOf = id => CARD_H + (expanded.get(id) ?? 0);
    if (expanded.size) {
        const baseY = new Map([...pos].map(([id, p]) => [id, p.y]));
        for (const [id, p] of pos) {
            let shift = 0;
            for (const oid of pos.keys()) if (baseY.get(oid) < baseY.get(id)) shift += expanded.get(oid) ?? 0;
            p.y = baseY.get(id) + shift;
        }
    }
    const sections = branchInfo.map(({branch, label}) => {
        const bn = nodes.filter(n => (n.branch ?? '') === branch);
        const tops = bn.map(n => pos.get(n.node_id).y);
        const bottoms = bn.map(n => pos.get(n.node_id).y + heightOf(n.node_id));
        return {branch, label, top: Math.min(...tops) - labelTop,
            bottom: Math.max(...bottoms) + (ROW_STRIDE - CARD_H)};
    });

    // Edges enter at the target's two slot heights. They leave the source's top (winner)
    // or bottom (loser) only when the source sends both onward, so its two outgoing lines
    // don't coincide; a source that sends on only one result leaves from its centre.
    const slotY = (p, slot) => p.y + (slot === 0 ? 0.30 : 0.70) * CARD_H;
    const sectionByBranch = new Map(sections.map(s => [s.branch, s]));
    const outTypes = new Map();
    for (const n of nodes)
        [[n.source_a, n.source_type_a], [n.source_b, n.source_type_b]].forEach(([src, t]) => {
            if (src && pos.has(src) && t) (outTypes.get(src) ?? outTypes.set(src, new Set()).get(src)).add(t);
        });
    const exitY = (src, type) => {
        const frac = (outTypes.get(src)?.size ?? 0) >= 2 ? (type === 'loser' ? 0.70 : 0.30) : 0.5;
        return pos.get(src).y + frac * CARD_H;
    };
    const raw = [];
    for (const n of nodes) {
        const to = pos.get(n.node_id);
        [[n.source_a, n.source_type_a, 0], [n.source_b, n.source_type_b, 1]].forEach(([src, type, slot]) => {
            if (!src || !pos.has(src)) return;
            raw.push({
                from: pos.get(src), to, type, fromId: src, toId: n.node_id,
                exitY: exitY(src, type), enterY: slotY(to, slot)
            });
        });
    }

    // Routing. Forward-adjacent edges are simple 3-segment elbows (source stub, vertical
    // trunk in the gap, target stub) — the common case. Everything else (long drops, the
    // odd same-column cross-branch drop) detours through the clear inter-branch band as a
    // 5-segment "channel". An adjacent elbow only falls back to a 5-segment route (turning
    // in the left/right halves of the gap with its own crossing lane) when its plain trunk
    // would actually share a line with an already-placed edge — so most stay 3-segment.
    const gapLeft = c => LEFT_PAD + c * COL_STRIDE + COL_W; // x where the gap after col c starts
    const adjEdges = raw.filter(e => e.to.col - e.from.col === 1);
    const spanEdges = raw.filter(e => e.to.col - e.from.col !== 1);

    // Fallback turn x's: source-side in the left part of a gap, target-side in the right
    // part, so a fallback source stub and target stub can never lie on the same lane.
    const sxOf = new Map(), exOf = new Map(), laneOf = new Map();
    const leftTurns = new Map(), rightTurns = new Map();
    for (const e of [...adjEdges, ...spanEdges]) {
        pushTo(leftTurns, e.from.col, e);
        pushTo(rightTurns, e.to.col - 1, e);
    }
    const spread = (list, x0, x1, keyY, out) => {
        list.sort((a, b) => keyY(a) - keyY(b));
        const n = list.length;
        list.forEach((e, i) => out.set(e, n === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (n - 1)));
    };
    for (const [c, list] of leftTurns)
        spread(list, gapLeft(c) + GAP * 0.12, gapLeft(c) + GAP * 0.42, e => e.exitY, sxOf);
    for (const [c, list] of rightTurns)
        spread(list, gapLeft(c) + GAP * 0.58, gapLeft(c) + GAP * 0.88, e => e.enterY, exOf);
    const adjByGap = new Map();
    for (const e of adjEdges) pushTo(adjByGap, e.from.col, e);
    for (const list of adjByGap.values()) {
        list.sort((a, b) => (a.exitY + a.enterY) - (b.exitY + b.enterY));
        let last = -Infinity;
        for (const e of list) {
            const y = Math.max((e.exitY + e.enterY) / 2, last + 8);
            laneOf.set(e, y);
            last = y;
        }
    }

    // Greedy placement: collinear-overlap check against already-routed segments.
    const EPS = 1;
    const routeSegs = e => {
        const p = edgePath(e).replace(/[ML]/g, ' ').trim().split(/\s+/).map(s => s.split(',').map(Number));
        return p.slice(0, -1).map((a, i) => [a, p[i + 1]]);
    };
    const overlap = ([[ax, ay], [bx, by]], [[cx, cy], [dx, dy]]) => {
        const span = (lo1, hi1, lo2, hi2) => Math.min(hi1, hi2) - Math.max(lo1, lo2) > EPS;
        if (Math.abs(ax - bx) < EPS && Math.abs(cx - dx) < EPS && Math.abs(ax - cx) < EPS)
            return span(Math.min(ay, by), Math.max(ay, by), Math.min(cy, dy), Math.max(cy, dy));
        if (Math.abs(ay - by) < EPS && Math.abs(cy - dy) < EPS && Math.abs(ay - cy) < EPS)
            return span(Math.min(ax, bx), Math.max(ax, bx), Math.min(cx, dx), Math.max(cx, dx));
        return false;
    };
    const placed = [];
    const conflicts = segs => segs.some(s => placed.some(t => overlap(s, t)));
    const commit = e => {
        placed.push(...routeSegs(e));
        return e;
    };

    const edges = [];
    // Spanning edges first (they own the band tracks the elbows then avoid).
    spanEdges.forEach((e, i) => {
        const upper = e.from.y <= e.to.y ? e.from : e.to;
        const band = sectionByBranch.get(upper.branch).bottom;
        edges.push(commit({
            ...e, kind: 'channel', sx: sxOf.get(e), ex: exOf.get(e),
            chY: band + BRANCH_GAP * (i + 1) / (spanEdges.length + 1)
        }));
    });
    // Adjacent edges: keep them 3-segment, trying a sweep of trunk positions across the
    // gap to dodge conflicts; only when no clear trunk exists fall back to the 5-segment
    // route. Sweeping first keeps the fallback (and any residual overlap) rare.
    const TRUNKS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.45, 0.55, 0.35, 0.65, 0.25, 0.75];
    for (const [c, list] of adjByGap) {
        list.sort((a, b) => a.enterY - b.enterY);
        for (const e of list) {
            const three = TRUNKS
                .map(f => ({...e, kind: 'elbow3', mx: gapLeft(c) + GAP * f}))
                .find(cand => !conflicts(routeSegs(cand)));
            edges.push(commit(three
                ?? {...e, kind: 'elbow5', sx: sxOf.get(e), ex: exOf.get(e), laneY: laneOf.get(e)}));
        }
    }

    const width = Math.max(0, ...[...pos.values()].map(p => p.x)) + COL_W;
    const height = Math.max(0, ...sections.map(s => s.bottom));
    return {pos, edges, sections, multiBranch, width, height};
}

// elbow3: source stub, one vertical trunk in the gap, target stub. elbow5/channel: turn
// in the left half, cross a horizontal lane (a gap height, or the inter-branch band),
// turn in the right half, enter — used only where a plain trunk would share a line.
function edgePath(e) {
    const fx = e.from.x + COL_W, tx = e.to.x;
    if (e.kind === 'elbow3')
        return `M${fx},${e.exitY} L${e.mx},${e.exitY} L${e.mx},${e.enterY} L${tx},${e.enterY}`;
    const midY = e.kind === 'channel' ? e.chY : e.laneY;
    return `M${fx},${e.exitY} L${e.sx},${e.exitY} L${e.sx},${midY} `
        + `L${e.ex},${midY} L${e.ex},${e.enterY} L${tx},${e.enterY}`;
}

// A TBD / not-yet-predictable slot: the score-box shape, dimmed, no toggle.
function bracketPlaceholder(node) {
    const final = node.score_a != null && node.score_b != null;
    const color = (a, b) => final ? winnerColor(a, b) : ''; // green/red only on a final score
    const row = (second, name, logo, score, cls) => `
        <div class="team-row${second ? ' mt-1' : ''}">
            ${logo ? `<img src="${escapeAttr(logo)}" class="team-logo" alt="">` : ''}
            <span class="team-name fw-semibold small ${cls}">${escapeHtml(name ?? 'TBD')}</span>
            ${score != null ? `<span class="actual-score small ${cls || 'text-secondary'}">${score}</span>` : ''}
        </div>`;
    const card = makeEl('div', {className: 'card bracket-tbd'});
    card.innerHTML = `<div class="card-body"><div class="score-box">
        ${row(false, node.team_a, node.logo_a, node.score_a, color(node.score_a, node.score_b))}
        ${row(true, node.team_b, node.logo_b, node.score_b, color(node.score_b, node.score_a))}
    </div></div>`;
    return card;
}

// The real prediction card for a predictable node, or a placeholder otherwise.
function bracketCard(node, dayKey) {
    if (node.match_id != null) {
        const index = state.matches.findIndex(m => m.id === node.match_id);
        if (index !== -1) return createCard(state.matches[index], index, dayKey);
    }
    return bracketPlaceholder(node);
}

// SVG markup for the edge layer. Each path carries its source/target node ids so
// hovering a card can light up the lines feeding into and out of that match.
const edgesHTML = edges => edges.map(e =>
    `<path class="bracket-edge bracket-edge-${e.type ?? 'none'}"`
    + ` data-from="${escapeAttr(e.fromId)}" data-to="${escapeAttr(e.toId)}" d="${edgePath(e)}"/>`).join('');

// Build the whole bracket block (one stage+group), tagged with its day key so
// activateTab shows/hides it as a unit.
function renderBracketBlock({stage, key, nodes}) {
    const dayKey = bracketDayKey(stage, key);
    const block = makeEl('div', {className: 'bracket-block', dataset: {day: dayKey}});
    const L = bracketLayout(nodes);

    const canvas = makeEl('div', {className: 'bracket-canvas'});
    canvas.style.width = `${L.width}px`;
    canvas.style.height = `${L.height}px`;

    canvas.insertAdjacentHTML('beforeend',
        `<svg class="bracket-edges" width="${L.width}" height="${L.height}" fill="none">${edgesHTML(L.edges)}</svg>`);
    const svg = canvas.querySelector('.bracket-edges');

    const labelByBranch = new Map();
    if (L.multiBranch) {
        for (const s of L.sections) {
            if (!s.label) continue;
            const label = makeEl('div', {
                className: 'bracket-branch-label', textContent: s.label,
                dataset: {branch: s.branch}
            });
            label.style.top = `${s.top}px`;
            canvas.appendChild(label);
            labelByBranch.set(s.branch, label);
        }
    }

    const cellByNode = new Map();
    for (const node of nodes) {
        const p = L.pos.get(node.node_id);
        const cell = makeEl('div', {
            className: 'bracket-cell',
            dataset: {node: node.node_id, branch: node.branch ?? ''}
        });
        cell.style.left = `${p.x}px`;
        cell.style.top = `${p.y}px`;
        cell.appendChild(bracketCard(node, dayKey));
        cellByNode.set(node.node_id, cell);

        const id = node.node_id;
        const lines = () => svg.querySelectorAll(`[data-from="${CSS.escape(id)}"],[data-to="${CSS.escape(id)}"]`);
        cell.addEventListener('mouseenter', () => lines().forEach(line => {
            line.classList.add('bracket-edge-hl');
            svg.appendChild(line); // raise highlighted lines above the rest
        }));
        cell.addEventListener('mouseleave', () => lines().forEach(line => line.classList.remove('bracket-edge-hl')));
        canvas.appendChild(cell);
    }

    // Cards are absolutely positioned, so an opening predictions panel can't push its
    // neighbours by itself. A ResizeObserver re-runs the layout whenever a card's height
    // changes (panel opening/closing, predictions loading), feeding back each open panel's
    // height so the cards below slide down by exactly that much (preserving their normal
    // gap) and the edges follow — live, as the panel animates. The panel is 0px tall when
    // collapsed, so nothing is pushed and the layout matches the base.
    const relayout = () => {
        if (bracketReflowPaused) return;
        const expanded = new Map();
        for (const [id, cell] of cellByNode) {
            const panel = cell.querySelector('.predictions-panel');
            const extra = panel ? panel.offsetHeight : 0;
            if (extra > 1) expanded.set(id, extra);
        }
        const R = bracketLayout(nodes, expanded);
        for (const [id, cell] of cellByNode) cell.style.top = `${R.pos.get(id).y}px`;
        for (const s of R.sections) labelByBranch.get(s.branch)?.style.setProperty('top', `${s.top}px`);
        svg.innerHTML = edgesHTML(R.edges);
        svg.setAttribute('width', R.width);
        svg.setAttribute('height', R.height);
        canvas.style.width = `${R.width}px`;
        canvas.style.height = `${R.height}px`;
    };
    const observer = new ResizeObserver(() => relayout());
    cellByNode.forEach(cell => observer.observe(cell));

    block.appendChild(canvas);
    return block;
}

// One tab-group row per stage (stage name as the label, its groups as buttons),
// matching the day-tab layout.
function appendBracketTabs(brackets) {
    if (!brackets.length) return;
    const bar = $('tabs-bar');
    const byStage = new Map();
    brackets.forEach(b => pushTo(byStage, b.stage, b));
    for (const [stage, groups] of byStage) {
        bar.appendChild(makeEl('span', {
            className: 'tab-prefix small text-secondary fw-semibold', textContent: stage,
        }));
        const row = makeEl('div', {className: 'd-flex gap-2 flex-wrap'});
        groups.forEach(({key, label}) => {
            const day = bracketDayKey(stage, key);
            const btn = makeEl('button', {
                className: 'tab-btn btn btn-sm btn-outline-secondary',
                textContent: label,
                dataset: {day},
            });
            btn.addEventListener('click', () => activateTab(day));
            row.appendChild(btn);
        });
        bar.appendChild(row);
    }
}
