// ============== Bracket view ==============
// Tournament-format stages render as a drawn bracket inside the main grid, reusing
// the same score-box cards as the league view. Data comes from /api/bracket (one
// fetch per stage+group); structure/edges come from the node `source_*` fields.
// Loaded after app.js, so it shares its globals (createCard, state, helpers).

const BRACKET_STAGE_TYPES = new Set(['single_elimination', 'double_elimination', 'bracket_groups', 'custom_bracket']);

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

// Fetch the list of bracket (stage, group) pairs for one tournament from
// /api/brackets/:id, then each one's nodes. Using the dedicated list (not the match
// feed) means all-TBD brackets — ones with no predictable match yet, like an undrawn
// Playoffs — still get a tab.
async function loadBrackets(tournamentId) {
    const pairs = await tryFetch(() => api(`/api/brackets/${tournamentId}`));
    if (!pairs || !pairs.length) return [];
    const out = [];
    await Promise.all(pairs.map(async ({stage, group}) => {
        const nodes = await tryFetch(() => api(`/api/bracket?tournament_id=${tournamentId}`
            + `&stage=${encodeURIComponent(stage)}&group=${encodeURIComponent(group)}`));
        if (nodes && nodes.length) {
            // Toornament's custom_bracket stages send branch as "WB"/"LB"; elimination
            // stages send lowercase. Normalize so BRANCH_RANK/BRANCH_LABEL always match.
            for (const n of nodes) if (n.branch) n.branch = n.branch.toLowerCase();
            out.push({stage, group, nodes});
        }
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

// The edge slots bracketLayout worked out per bracket (its nodes array).
const slotCache = new WeakMap();

// Layout: assign every node an {x, y, col} and resolve the source edges into
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

    // Routing. Every vertical run of a line sits on a slot: a lane in the gap between two
    // columns, slot 0 leftmost. A run comes in horizontally from the gap's left edge at
    // `leftY` and leaves towards its right edge at `rightY`. Two runs need different slots
    // when they overlap along the height they pass; and where one comes in at the height
    // another leaves at, the incoming one must sit left of the leaving one, or their
    // horizontals would lie on top of each other. That's VLSI channel routing turned on
    // its side (gap = channel, slot = track, the second rule = the vertical constraint
    // graph), so each gap gets the constrained left-edge algorithm: fill slots left to
    // right, each with the runs whose required left neighbours are all placed already,
    // taken top-down and skipping any that overlap a run already on the slot. A cycle of
    // ordering rules can't be met; it's broken at the run with the fewest unplaced left
    // neighbours. The slots are then spread evenly across the gap. Forward-adjacent
    // edges are 3-segment elbows with one run; longer edges detour through the clear
    // inter-branch band as a 5-segment "channel", with a run in the gap after the source
    // and one in the gap before the target.
    const gapLeft = c => LEFT_PAD + c * COL_STRIDE + COL_W; // x where the gap after col c starts
    const RUN_MARGIN = 4; // keeps two runs on one slot from meeting end to end
    const near = (y0, y1) => Math.abs(y0 - y1) < RUN_MARGIN;
    // gaps: gap -> {count, runs}, each run {lo, hi, leftY, rightY, slot}
    const addRun = (gaps, gap, leftY, rightY) => {
        const g = gaps.get(gap) ?? gaps.set(gap, {count: 0, runs: []}).get(gap);
        const r = {gap, g, lo: Math.min(leftY, rightY), hi: Math.max(leftY, rightY), leftY, rightY, slot: null};
        if (!near(leftY, rightY)) g.runs.push(r); // a straight line has no run and takes no slot
        return r;
    };
    const assignSlots = g => {
        const leftOf = new Map(g.runs.map(r => [r, g.runs.filter(o => o !== r && near(o.leftY, r.rightY))]));
        const unplaced = r => r.slot == null;
        let todo = g.runs.slice().sort((a, b) => a.lo - b.lo);
        while (todo.length) {
            let ready = todo.filter(r => !leftOf.get(r).some(unplaced));
            if (!ready.length) {
                const blocked = r => leftOf.get(r).filter(unplaced).length;
                ready = [todo.reduce((a, b) => blocked(b) < blocked(a) ? b : a)];
            }
            const onSlot = [];
            for (const r of ready)
                if (onSlot.every(o => r.hi + RUN_MARGIN <= o.lo || o.hi + RUN_MARGIN <= r.lo)) {
                    r.slot = g.count;
                    onSlot.push(r);
                }
            g.count++;
            todo = todo.filter(unplaced);
        }
    };
    const slotX = ({gap, g, slot}) => gapLeft(gap) + GAP * (slot == null ? 0.5 : (slot + 1) / (g.count + 1));

    // One line per edge: its runs (one for an elbow, two for a channel) and, for a channel,
    // its lane across the band, lane 0 on top. Lanes start in edge order.
    const spanEdges = raw.filter(e => e.to.col - e.from.col !== 1);
    const bandOf = e => sectionByBranch.get((e.from.y <= e.to.y ? e.from : e.to).branch).bottom;
    const laneY = (e, lane) => bandOf(e) + BRANCH_GAP * (lane + 1) / (spanEdges.length + 1);
    const gaps = new Map();
    const lines = raw.map(e => {
        const lane = spanEdges.indexOf(e);
        if (lane === -1) return {e, runs: [addRun(gaps, e.from.col, e.exitY, e.enterY)]};
        const chY = laneY(e, lane);
        return {e, lane, runs: [addRun(gaps, e.from.col, e.exitY, chY), addRun(gaps, e.to.col - 1, chY, e.enterY)]};
    });
    const channels = lines.filter(l => l.lane != null);
    const edgeOf = ({e, lane, runs}) => runs.length === 1
        ? {...e, kind: 'elbow3', mx: slotX(runs[0])}
        : {...e, kind: 'channel', chY: laneY(e, lane), sx: slotX(runs[0]), ex: slotX(runs[1])};

    // Untangling. The left-edge pass only keeps the rules; it doesn't look at crossings,
    // and the band's lanes (a channel the classic way round, lanes as its tracks) need
    // ordering too. Lane order and gap slots decide crossings together, so both are
    // hill-climbed at once on the drawn lines themselves: a pair of lines costs one per
    // crossing of their segments, and far more than any crossing count where two segments
    // lie on top of each other or meet end to end, so no move ever breaks a rule. Moves:
    // put a run on another slot of its gap, swap two runs' slots, swap two whole slots of
    // a gap, swap two channels' lanes; whatever lowers the cost is kept, until nothing does.
    const RULE_COST = 1e6;
    const shapeOf = line => {
        const pts = edgePoints(edgeOf(line));
        const segs = [];
        for (let k = 0; k + 1 < pts.length; k++) {
            const [[x0, y0], [x1, y1]] = [pts[k], pts[k + 1]];
            if (Math.abs(x1 - x0) + Math.abs(y1 - y0) < 0.5) continue;
            segs.push(y0 === y1
                ? {h: true, at: y0, lo: Math.min(x0, x1), hi: Math.max(x0, x1)}
                : {h: false, at: x0, lo: Math.min(y0, y1), hi: Math.max(y0, y1)});
        }
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        return {segs, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys)};
    };
    const pairCost = (a, b) => {
        const A = a.shape, B = b.shape;
        if (A.x1 + RUN_MARGIN < B.x0 || B.x1 + RUN_MARGIN < A.x0
            || A.y1 + RUN_MARGIN < B.y0 || B.y1 + RUN_MARGIN < A.y0) return 0;
        const shared = a.e.fromId === b.e.fromId && a.e.exitY === b.e.exitY; // one stub out of one source
        let c = 0;
        for (const s of A.segs)
            for (const t of B.segs) {
                if (s.h !== t.h) {
                    const h = s.h ? s : t, v = s.h ? t : s;
                    c += v.at > h.lo + 0.5 && v.at < h.hi - 0.5 && h.at > v.lo + 0.5 && h.at < v.hi - 0.5;
                } else if (!shared && Math.abs(s.at - t.at) < RUN_MARGIN
                    && Math.min(s.hi, t.hi) + RUN_MARGIN > Math.max(s.lo, t.lo))
                    c += RULE_COST;
            }
        return c;
    };
    // Whatever its slots and lane, a line stays between its source's and target's columns
    // and between its exit and entry heights (plus the band, for a channel), so only lines
    // whose such bounds meet can ever touch.
    const boundsOf = ({e, lane}) => {
        const ys = lane == null ? [e.exitY, e.enterY] : [e.exitY, e.enterY, bandOf(e), bandOf(e) + BRANCH_GAP];
        return {x0: e.from.x + COL_W, x1: e.to.x, y0: Math.min(...ys), y1: Math.max(...ys)};
    };
    const meet = (A, B) => A.x0 <= B.x1 + RUN_MARGIN && B.x0 <= A.x1 + RUN_MARGIN
        && A.y0 <= B.y1 + RUN_MARGIN && B.y0 <= A.y1 + RUN_MARGIN;
    const untangle = () => {
        // A line's state is its slots and lane. The same trial states come round on every
        // pass, so pair costs are memoised per pair of states, and a line's shape is only
        // worked out when a cost isn't known yet.
        const reshape = l => {
            l.shape = null;
            const key = l.runs.map(r => r.slot).join() + '|' + l.lane;
            l.state = l.states.get(key) ?? l.states.set(key, l.states.size).get(key);
        };
        const memoCost = (a, b) => {
            if (a.id > b.id) [a, b] = [b, a];
            const memo = a.memo.get(b) ?? a.memo.set(b, new Map()).get(b);
            const key = a.state * 65536 + b.state;
            let c = memo.get(key);
            if (c === undefined) {
                a.shape ??= shapeOf(a);
                b.shape ??= shapeOf(b);
                memo.set(key, c = pairCost(a, b));
            }
            return c;
        };
        lines.forEach((l, id) => Object.assign(l, {id, states: new Map(), memo: new Map(), bounds: boundsOf(l)}));
        lines.forEach(l => {
            l.near = lines.filter(o => o !== l && meet(l.bounds, o.bounds));
            reshape(l);
        });
        const lineOf = new Map(lines.flatMap(l => l.runs.map(r => [r, l])));
        // Every pair touching the set, each counted once.
        const setCost = set => {
            const done = new Set();
            let c = 0;
            for (const a of set) {
                done.add(a);
                for (const b of a.near) if (!done.has(b)) c += memoCost(a, b);
            }
            return c;
        };
        // `flip` undoes itself when called again.
        const attempt = (set, flip) => {
            const before = setCost(set);
            flip();
            set.forEach(reshape);
            if (setCost(set) < before) return true;
            flip();
            set.forEach(reshape);
            return false;
        };
        for (let pass = 0, better = true; better && pass < 8; pass++) {
            better = false;
            // A run goes to whichever slot of its gap costs least.
            for (const g of gaps.values())
                for (const r of g.runs) {
                    const line = lineOf.get(r), from = r.slot;
                    let best = setCost([line]), bestSlot = from;
                    for (r.slot = 0; r.slot < g.count; r.slot++) {
                        if (r.slot === from) continue;
                        reshape(line);
                        const c = setCost([line]);
                        if (c < best) [best, bestSlot] = [c, r.slot];
                    }
                    r.slot = bestSlot;
                    reshape(line);
                    if (bestSlot !== from) better = true;
                }
            // Only runs that share heights can untangle each other by trading slots.
            for (const g of gaps.values())
                g.runs.forEach((r, i) => g.runs.slice(i + 1).forEach(o => {
                    if (r.slot !== o.slot && r.hi + RUN_MARGIN > o.lo && o.hi + RUN_MARGIN > r.lo
                        && attempt([...new Set([lineOf.get(r), lineOf.get(o)])],
                            () => [r.slot, o.slot] = [o.slot, r.slot])) better = true;
                }));
            for (const g of gaps.values())
                for (let a = 0; a < g.count; a++)
                    for (let b = a + 1; b < g.count; b++) {
                        const runs = g.runs.filter(r => r.slot === a || r.slot === b);
                        const set = [...new Set(runs.map(r => lineOf.get(r)))];
                        if (attempt(set, () => runs.forEach(r => r.slot = r.slot === a ? b : a))) better = true;
                    }
            for (let i = 0; i < channels.length; i++)
                for (let k = i + 1; k < channels.length; k++) {
                    const x = channels[i], y = channels[k];
                    if (attempt([x, y], () => [x.lane, y.lane] = [y.lane, x.lane])) better = true;
                }
        }
        // Moves can empty a slot; drop those.
        for (const g of gaps.values()) {
            const used = [...new Set(g.runs.map(r => r.slot))].sort((x, y) => x - y);
            g.runs.forEach(r => r.slot = used.indexOf(r.slot));
            g.count = used.length;
        }
    };

    // An open panel pushes everything below it down by the same amount, which keeps every
    // height's order, so the lanes and slots worked out for a bracket hold for every
    // relayout of it (and lines don't hop between slots while a panel animates).
    const allRuns = [...gaps.values()].flatMap(g => g.runs);
    const cached = slotCache.get(nodes);
    if (cached?.slots.length === allRuns.length) {
        channels.forEach((l, i) => l.lane = cached.lanes[i]);
        allRuns.forEach((r, i) => r.slot = cached.slots[i]);
        gaps.forEach((g, gap) => g.count = cached.counts.get(gap));
    } else {
        gaps.forEach(assignSlots);
        untangle();
        slotCache.set(nodes, {
            lanes: channels.map(l => l.lane),
            slots: allRuns.map(r => r.slot),
            counts: new Map([...gaps].map(([gap, g]) => [gap, g.count])),
        });
    }
    const edges = lines.map(edgeOf);

    const width = Math.max(0, ...[...pos.values()].map(p => p.x)) + COL_W;
    const height = Math.max(0, ...sections.map(s => s.bottom));
    return {pos, edges, sections, multiBranch, width, height};
}

// elbow3: source stub, one vertical run on its slot, target stub. channel: a run on a
// slot of the gap after the source, across the inter-branch band, a run on a slot of the
// gap before the target, enter.
function edgePoints(e) {
    const fx = e.from.x + COL_W, tx = e.to.x;
    if (e.kind === 'elbow3') return [[fx, e.exitY], [e.mx, e.exitY], [e.mx, e.enterY], [tx, e.enterY]];
    return [[fx, e.exitY], [e.sx, e.exitY], [e.sx, e.chY], [e.ex, e.chY], [e.ex, e.enterY], [tx, e.enterY]];
}
const edgePath = e => 'M' + edgePoints(e).map(p => p.join(',')).join(' L');

// A TBD / not-yet-predictable slot: the score-box shape, dimmed, no toggle.
function bracketPlaceholder(node) {
    const final = node.score_a != null && node.score_b != null;
    const color = (a, b) => final ? winnerColor(a, b) : ''; // green/red only on a final score
    const row = (second, name, logo, score, cls) => `
        <div class="team-row${second ? ' mt-1' : ''}">
            ${logo ? `<img src="${escapeAttr(proxied(logo))}" class="team-logo" alt="">` : ''}
            <span class="team-name fw-semibold small ${cls}">${name != null ? teamLinkHTML(state.activeTournament, name) : 'TBD'}</span>
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
