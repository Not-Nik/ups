// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use serde::de::DeserializeOwned;
use serde_derive::Deserialize;
use sqlx::{Connection, SqliteConnection};
use std::collections::HashMap;
use std::ops::DerefMut;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const BASE_URL: &str = "https://play.toornament.com";
const PAST_MATCHES: &str = "statuses=running,completed&sort=latest_results";
const UPCOMING_MATCHES: &str = "statuses=pending&sort=scheduled_asc";

// Toornament rejects a `limit` above each endpoint's own maximum.
const MATCHES_PAGE: usize = 100;
const GROUPS_PAGE: usize = 100;
const NODES_PAGE: usize = 100;
const STAGES_PAGE: usize = 50;
const ROUNDS_PAGE: usize = 50;
const RANKINGS_PAGE: usize = 50;
const PARTICIPANTS_PAGE: usize = 48;

// Shortest gap between two refreshes of the same tournament.
const REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

// Stage types played as a bracket rather than a round-robin league. These get a
// row per match (incl. undecided slots) in bracket_nodes so the bracket can be drawn.
pub const BRACKET_TYPES: [&str; 4] =
    ["single_elimination", "double_elimination", "bracket_groups", "custom_bracket"];

// Stage types whose groups have a ranking table, stored in standings.
pub const STANDINGS_TYPES: [&str; 3] = ["league", "swiss", "pools"];

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Deserialize)]
struct Page<T> {
    items: Vec<T>,
}

#[derive(Deserialize)]
struct Logo {
    icon_medium: String,
}

#[derive(Deserialize)]
struct CustomFieldValues {
    teamkurzel: Option<String>,
    logo: Option<Logo>,
}

#[derive(Deserialize)]
struct Participant {
    id: String,
    name: String,
    #[serde(rename = "customFieldValues")]
    custom_field_values: Option<CustomFieldValues>,
    // Only the participants endpoint fills this; matches and rankings send [].
    lineup: Option<Vec<LineupPlayer>>,
}

#[derive(Deserialize)]
struct PlayerFields {
    battle_net_id: Option<String>,
}

#[derive(Deserialize)]
struct LineupPlayer {
    name: String,
    #[serde(rename = "playerUser")]
    player_user: Option<NodeRef>,
    #[serde(rename = "customFieldValues")]
    custom_field_values: Option<PlayerFields>,
}

#[derive(Deserialize)]
struct NodeRef {
    id: String,
}

#[derive(Deserialize)]
struct Opponent {
    participant: Option<Participant>,
    score: Option<i64>,
    #[serde(rename = "sourceType")]
    source_type: Option<String>,
    #[serde(rename = "sourceNode")]
    source_node: Option<NodeRef>,
}

#[derive(Deserialize)]
struct RawStage {
    id: String,
    number: i64,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    status: Option<String>,
}

#[derive(Deserialize)]
struct RawGroup {
    id: String,
    number: i64,
    name: String,
    status: Option<String>,
    stage: NodeRef,
}

#[derive(Deserialize)]
struct RawRound {
    id: String,
    number: i64,
    name: String,
    status: Option<String>,
    group: NodeRef,
}

#[derive(Deserialize)]
struct RawMatch {
    id: String,
    number: i64,
    opponents: Vec<Opponent>,
    group: NodeRef,
    round: NodeRef,
}

#[derive(Deserialize)]
struct RawNode {
    id: String,
    number: i64,
    depth: i64,
    branch: Option<String>,
    opponents: Vec<Opponent>,
    group: NodeRef,
    round: NodeRef,
}

#[derive(Deserialize)]
struct Ranking {
    group: NodeRef,
}

#[derive(Deserialize)]
struct RankingProperties {
    played: Option<i64>,
    wins: Option<i64>,
    draws: Option<i64>,
    losses: Option<i64>,
    forfeits: Option<i64>,
    score_for: Option<i64>,
    score_against: Option<i64>,
    dropped: Option<bool>,
}

#[derive(Deserialize)]
struct RankingItem {
    position: i64,
    rank: i64,
    points: Option<i64>,
    participant: Participant,
    ranking: Ranking,
    properties: RankingProperties,
}

/// Toornament id -> local row id for everything a match, node or ranking points at.
#[derive(Default)]
struct Ids {
    groups: HashMap<String, i64>,
    rounds: HashMap<String, i64>,
    teams: HashMap<String, i64>,
}

struct NewMatch {
    team_a: i64,
    team_b: i64,
    score_a: Option<i64>,
    score_b: Option<i64>,
    group_id: i64,
    round_id: i64,
    number: i64,
    toornament_id: String,
}

/// Everything fetched for one tournament, gathered before touching the db.
struct Feed {
    stages: Vec<RawStage>,
    groups: Vec<RawGroup>,
    rounds: Vec<RawRound>,
    participants: Vec<Participant>,
    matches: Vec<RawMatch>,
    nodes: Vec<RawNode>,
    rankings: Vec<RankingItem>,
}

/// The team's logo URL (icon_medium) or "" — same source the site already uses.
fn participant_logo(participant: &Participant) -> String {
    participant
        .custom_field_values
        .as_ref()
        .and_then(|c| c.logo.as_ref())
        .map(|l| l.icon_medium.trim().to_string())
        .unwrap_or_default()
}

/// Page through a toornament list endpoint, returning all items.
async fn fetch_items<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    page_size: usize,
    label: &str,
) -> Result<Vec<T>> {
    let mut items = Vec::new();
    let mut offset = 0;

    loop {
        let page: Page<T> = client
            .get(format!("{url}&offset={offset}&limit={page_size}"))
            .send()
            .await?
            .json()
            .await?;

        let len = page.items.len();
        items.extend(page.items);
        log::info!("Loaded {label} {offset}-{}", offset + len);

        if len < page_size {
            return Ok(items);
        }
        offset += page_size;
    }
}

async fn fetch_feed(client: &reqwest::Client, toornament_id: &str) -> Result<Feed> {
    let stages: Vec<RawStage> = fetch_items(
        client,
        &format!("{BASE_URL}/api/stages?tournament_ids={toornament_id}"),
        STAGES_PAGE,
        "stages",
    )
    .await?;
    let stage_ids = stages.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(",");

    let (mut groups, mut rounds) = (Vec::new(), Vec::new());
    if !stages.is_empty() {
        groups = fetch_items(
            client,
            &format!("{BASE_URL}/api/groups?stage_ids={stage_ids}"),
            GROUPS_PAGE,
            "groups",
        )
        .await?;
        rounds = fetch_items(
            client,
            &format!("{BASE_URL}/api/rounds?stage_ids={stage_ids}"),
            ROUNDS_PAGE,
            "rounds",
        )
        .await?;
    }

    let participants = fetch_items(
        client,
        &format!("{BASE_URL}/api/participants?tournament_ids={toornament_id}"),
        PARTICIPANTS_PAGE,
        "participants",
    )
    .await?;

    let matches_url = format!("{BASE_URL}/api/matches?tournament_ids={toornament_id}&");
    let mut matches = Vec::new();
    for filter in [PAST_MATCHES, UPCOMING_MATCHES] {
        matches.extend(
            fetch_items::<RawMatch>(client, &format!("{matches_url}{filter}"), MATCHES_PAGE, "matches")
                .await?,
        );
    }

    let mut nodes = Vec::new();
    for stage in stages.iter().filter(|s| BRACKET_TYPES.contains(&s.kind.as_str())) {
        let url = format!("{BASE_URL}/api/bracket-nodes?stage_ids={}", stage.id);
        nodes.extend(fetch_items::<RawNode>(client, &url, NODES_PAGE, "bracket-nodes").await?);
    }

    // One request for every ranked group: each item names its own group.
    let ranked_stages: Vec<&str> = stages
        .iter()
        .filter(|s| STANDINGS_TYPES.contains(&s.kind.as_str()))
        .map(|s| s.id.as_str())
        .collect();
    let ranked_groups = groups
        .iter()
        .filter(|g: &&RawGroup| ranked_stages.contains(&g.stage.id.as_str()))
        .map(|g| g.id.as_str())
        .collect::<Vec<_>>()
        .join(",");
    let mut rankings = Vec::new();
    if !ranked_groups.is_empty() {
        rankings = fetch_items(
            client,
            &format!("{BASE_URL}/api/ranking-items?group_ids={ranked_groups}"),
            RANKINGS_PAGE,
            "ranking-items",
        )
        .await?;
    }

    Ok(Feed {
        stages,
        groups,
        rounds,
        participants,
        matches,
        nodes,
        rankings,
    })
}

/// Upsert stages, groups and rounds by their toornament id.
async fn upsert_tree(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    feed: &Feed,
    ids: &mut Ids,
) -> sqlx::Result<()> {
    let mut stage_ids = HashMap::new();
    for s in &feed.stages {
        let stage_id: i64 = sqlx::query_scalar(
            "INSERT INTO stages (TournamentID, Number, Name, Type, Status, ToornamentId) \
             VALUES (?, ?, ?, ?, ?, ?) \
             ON CONFLICT (TournamentID, ToornamentId) DO UPDATE SET Number = excluded.Number, \
             Name = excluded.Name, Type = excluded.Type, Status = excluded.Status \
             RETURNING StageID",
        )
        .bind(tournament_id)
        .bind(s.number)
        .bind(s.name.trim())
        .bind(&s.kind)
        .bind(&s.status)
        .bind(&s.id)
        .fetch_one(&mut *conn)
        .await?;
        stage_ids.insert(s.id.as_str(), stage_id);
    }

    for g in &feed.groups {
        let Some(&stage_id) = stage_ids.get(g.stage.id.as_str()) else {
            log::warn!("group {} belongs to unknown stage {}", g.id, g.stage.id);
            continue;
        };
        let group_id: i64 = sqlx::query_scalar(
            "INSERT INTO groups (StageID, Number, Name, Status, ToornamentId) VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT (StageID, ToornamentId) DO UPDATE SET Number = excluded.Number, \
             Name = excluded.Name, Status = excluded.Status \
             RETURNING GroupID",
        )
        .bind(stage_id)
        .bind(g.number)
        .bind(g.name.trim())
        .bind(&g.status)
        .bind(&g.id)
        .fetch_one(&mut *conn)
        .await?;
        ids.groups.insert(g.id.clone(), group_id);
    }

    for r in &feed.rounds {
        let Some(&group_id) = ids.groups.get(&r.group.id) else {
            log::warn!("round {} belongs to unknown group {}", r.id, r.group.id);
            continue;
        };
        let round_id: i64 = sqlx::query_scalar(
            "INSERT INTO rounds (GroupID, Number, Name, Status, ToornamentId) VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT (GroupID, ToornamentId) DO UPDATE SET Number = excluded.Number, \
             Name = excluded.Name, Status = excluded.Status \
             RETURNING RoundID",
        )
        .bind(group_id)
        .bind(r.number)
        .bind(r.name.trim())
        .bind(&r.status)
        .bind(&r.id)
        .fetch_one(&mut *conn)
        .await?;
        ids.rounds.insert(r.id.clone(), round_id);
    }

    Ok(())
}

/// Upsert every team the feed mentions. The participants endpoint is authoritative;
/// a participant seen only in a match, node or ranking fills in the gaps. A row is
/// found by participant id, falling back to a manual (ToornamentId NULL) row of the
/// same name, which then gets the id attached.
async fn upsert_teams(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    feed: &Feed,
    ids: &mut Ids,
) -> sqlx::Result<()> {
    let mut participants: HashMap<&str, &Participant> =
        feed.participants.iter().map(|p| (p.id.as_str(), p)).collect();
    let opponents = feed
        .matches
        .iter()
        .flat_map(|m| &m.opponents)
        .chain(feed.nodes.iter().flat_map(|n| &n.opponents))
        .filter_map(|o| o.participant.as_ref());
    for p in opponents.chain(feed.rankings.iter().map(|r| &r.participant)) {
        participants.entry(p.id.as_str()).or_insert(p);
    }

    for p in participants.values() {
        let name = p.name.trim();
        let short_name = p
            .custom_field_values
            .as_ref()
            .and_then(|c| c.teamkurzel.as_deref());

        let existing: Option<i64> = sqlx::query_scalar(
            "SELECT TeamID FROM teams WHERE TournamentID = ? \
             AND (ToornamentId = ? OR (ToornamentId IS NULL AND Name = ?)) \
             ORDER BY ToornamentId IS NULL LIMIT 1",
        )
        .bind(tournament_id)
        .bind(&p.id)
        .bind(name)
        .fetch_optional(&mut *conn)
        .await?;

        let team_id = match existing {
            Some(team_id) => {
                sqlx::query(
                    "UPDATE teams SET Name = ?, ShortName = ?, Logo = ?, ToornamentId = ? \
                     WHERE TeamID = ?",
                )
                .bind(name)
                .bind(short_name)
                .bind(participant_logo(p))
                .bind(&p.id)
                .bind(team_id)
                .execute(&mut *conn)
                .await?;
                team_id
            }
            None => {
                sqlx::query_scalar(
                    "INSERT INTO teams (TournamentID, Name, ShortName, Logo, ToornamentId) \
                     VALUES (?, ?, ?, ?, ?) RETURNING TeamID",
                )
                .bind(tournament_id)
                .bind(name)
                .bind(short_name)
                .bind(participant_logo(p))
                .bind(&p.id)
                .fetch_one(&mut *conn)
                .await?
            }
        };
        ids.teams.insert(p.id.clone(), team_id);
    }

    Ok(())
}

/// Replace the lineup of every team the participants endpoint returned. Lineup entries
/// have no id of their own and names aren't unique, so the whole lineup is rewritten.
async fn replace_players(
    conn: &mut SqliteConnection,
    feed: &Feed,
    ids: &Ids,
) -> sqlx::Result<()> {
    for p in &feed.participants {
        let Some(&team_id) = ids.teams.get(&p.id) else {
            continue;
        };
        sqlx::query("DELETE FROM players WHERE TeamID = ?")
            .bind(team_id)
            .execute(&mut *conn)
            .await?;

        for (position, player) in p.lineup.iter().flatten().enumerate() {
            let battle_tag = player
                .custom_field_values
                .as_ref()
                .and_then(|c| c.battle_net_id.as_deref())
                .map(str::trim)
                .filter(|tag| !tag.is_empty());

            sqlx::query(
                "INSERT INTO players (TeamID, Position, Name, BattleTag, ToornamentUserId) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(team_id)
            .bind(position as i64 + 1)
            .bind(player.name.trim())
            .bind(battle_tag)
            .bind(player.player_user.as_ref().map(|u| &u.id))
            .execute(&mut *conn)
            .await?;
        }
    }

    Ok(())
}

/// The local team id of a known opponent, or None for a TBD slot.
fn opponent_team(opponent: &Opponent, ids: &Ids) -> Option<i64> {
    ids.teams.get(&opponent.participant.as_ref()?.id).copied()
}

/// A NewMatch for the predictable (both teams known) `matches` table, or None.
fn build_match(raw: &RawMatch, ids: &Ids) -> Option<NewMatch> {
    let (o_a, o_b) = (raw.opponents.first()?, raw.opponents.get(1)?);
    // a TBD slot — not predictable; lives only in bracket_nodes
    let (team_a, team_b) = (opponent_team(o_a, ids)?, opponent_team(o_b, ids)?);

    let (Some(&group_id), Some(&round_id)) =
        (ids.groups.get(&raw.group.id), ids.rounds.get(&raw.round.id))
    else {
        log::warn!("match {} has an unknown group or round", raw.id);
        return None;
    };

    Some(NewMatch {
        team_a,
        team_b,
        score_a: o_a.score,
        score_b: o_b.score,
        group_id,
        round_id,
        number: raw.number,
        toornament_id: raw.id.clone(),
    })
}

/// Insert/update league + predictable bracket matches. An existing row is found by its
/// stable ToornamentId first, falling back to the natural (TeamA, TeamB, GroupID,
/// RoundID) key only for legacy rows without one. Keying on ToornamentId means a
/// changed field updates the row in place instead of inserting a duplicate, so MatchID
/// (and the predictions that reference it) is preserved.
async fn upsert_matches(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    matches: &[NewMatch],
) -> sqlx::Result<()> {
    for m in matches {
        let mut match_id =
            sqlx::query_scalar::<_, i64>("SELECT MatchID FROM matches WHERE ToornamentId = ?")
                .bind(&m.toornament_id)
                .fetch_optional(&mut *conn)
                .await?;

        if match_id.is_none() {
            match_id = sqlx::query_scalar::<_, i64>(
                "SELECT MatchID FROM matches WHERE TournamentID = ? AND TeamA = ? AND TeamB = ? \
                 AND GroupID = ? AND RoundID = ? AND ToornamentId IS NULL",
            )
            .bind(tournament_id)
            .bind(m.team_a)
            .bind(m.team_b)
            .bind(m.group_id)
            .bind(m.round_id)
            .fetch_optional(&mut *conn)
            .await?;
        }

        // A NULL MatchID inserts a fresh row; a known one updates that row in place.
        // Scores are only overwritten when the feed actually has them (don't wipe a
        // stored score if a match briefly reports null).
        sqlx::query(
            "INSERT INTO matches (MatchID, TournamentID, GroupID, RoundID, TeamA, TeamB, ScoreA, \
             ScoreB, ToornamentId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(MatchID) DO UPDATE SET GroupID = excluded.GroupID, \
             RoundID = excluded.RoundID, TeamA = excluded.TeamA, TeamB = excluded.TeamB, \
             ScoreA = COALESCE(excluded.ScoreA, matches.ScoreA), \
             ScoreB = COALESCE(excluded.ScoreB, matches.ScoreB), \
             ToornamentId = excluded.ToornamentId",
        )
        .bind(match_id)
        .bind(tournament_id)
        .bind(m.group_id)
        .bind(m.round_id)
        .bind(m.team_a)
        .bind(m.team_b)
        .bind(m.score_a)
        .bind(m.score_b)
        .bind(&m.toornament_id)
        .execute(&mut *conn)
        .await?;
    }

    Ok(())
}

/// (sourceType, sourceNodeId) for an opponent fed by another node, else (None, None).
fn node_source(opponent: &Opponent) -> (Option<&str>, Option<&str>) {
    match (
        opponent.source_type.as_deref(),
        opponent.source_node.as_ref(),
    ) {
        (Some(kind @ ("winner" | "loser")), Some(node)) => (Some(kind), Some(node.id.as_str())),
        _ => (None, None),
    }
}

/// Store every bracket node (incl. TBD slots and the winner/loser source edges).
/// MatchID is linked when both teams are known.
async fn upsert_bracket_nodes(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    nodes: &[RawNode],
    ids: &Ids,
) -> sqlx::Result<()> {
    for n in nodes {
        let (Some(o_a), Some(o_b)) = (n.opponents.first(), n.opponents.get(1)) else {
            continue;
        };
        let (Some(&group_id), Some(&round_id)) =
            (ids.groups.get(&n.group.id), ids.rounds.get(&n.round.id))
        else {
            log::warn!("bracket node {} has an unknown group or round", n.id);
            continue;
        };
        let (source_type_a, source_a) = node_source(o_a);
        let (source_type_b, source_b) = node_source(o_b);

        // Predictable only when both teams are present — then a matches row exists
        // with ToornamentId == this node id (set by upsert_matches above).
        let match_id =
            sqlx::query_scalar::<_, i64>("SELECT MatchID FROM matches WHERE ToornamentId = ?")
                .bind(&n.id)
                .fetch_optional(&mut *conn)
                .await?;

        sqlx::query(
            "INSERT OR REPLACE INTO bracket_nodes (NodeId, TournamentID, GroupID, RoundID, Branch, \
             Position, Depth, TeamA, TeamB, ScoreA, ScoreB, SourceTypeA, SourceA, SourceTypeB, \
             SourceB, MatchID) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&n.id)
        .bind(tournament_id)
        .bind(group_id)
        .bind(round_id)
        .bind(n.branch.as_deref())
        .bind(n.number)
        .bind(n.depth)
        .bind(opponent_team(o_a, ids))
        .bind(opponent_team(o_b, ids))
        .bind(o_a.score)
        .bind(o_b.score)
        .bind(source_type_a)
        .bind(source_a)
        .bind(source_type_b)
        .bind(source_b)
        .bind(match_id)
        .execute(&mut *conn)
        .await?;
    }

    Ok(())
}

/// Replace the standings of every ranked group. Replacing (rather than upserting row by
/// row) drops teams that left a group and avoids UNIQUE (GroupID, Position) clashes
/// while positions shift.
async fn replace_standings(
    conn: &mut SqliteConnection,
    feed: &Feed,
    ids: &Ids,
) -> sqlx::Result<()> {
    let ranked_stages: Vec<&str> = feed
        .stages
        .iter()
        .filter(|s| STANDINGS_TYPES.contains(&s.kind.as_str()))
        .map(|s| s.id.as_str())
        .collect();
    for g in feed.groups.iter().filter(|g| ranked_stages.contains(&g.stage.id.as_str())) {
        if let Some(group_id) = ids.groups.get(&g.id) {
            sqlx::query("DELETE FROM standings WHERE GroupID = ?")
                .bind(group_id)
                .execute(&mut *conn)
                .await?;
        }
    }

    for item in &feed.rankings {
        let (Some(&group_id), Some(&team_id)) = (
            ids.groups.get(&item.ranking.group.id),
            ids.teams.get(&item.participant.id),
        ) else {
            log::warn!("ranking of {} has an unknown group or team", item.participant.name);
            continue;
        };
        let p = &item.properties;

        sqlx::query(
            "INSERT INTO standings (GroupID, TeamID, Position, Rank, Points, Played, Wins, Draws, \
             Losses, Forfeits, ScoreFor, ScoreAgainst, Dropped) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(group_id)
        .bind(team_id)
        .bind(item.position)
        .bind(item.rank)
        .bind(item.points)
        .bind(p.played.unwrap_or(0))
        .bind(p.wins.unwrap_or(0))
        .bind(p.draws.unwrap_or(0))
        .bind(p.losses.unwrap_or(0))
        .bind(p.forfeits.unwrap_or(0))
        .bind(p.score_for)
        .bind(p.score_against)
        .bind(p.dropped.unwrap_or(false))
        .execute(&mut *conn)
        .await?;
    }

    Ok(())
}

async fn load_tournament(
    db: &Mutex<SqliteConnection>,
    client: &reqwest::Client,
    tournament_id: i64,
    toornament_id: &str,
) -> Result<()> {
    // Fetch everything first so the db lock is only held for the writes.
    let feed = fetch_feed(client, toornament_id).await?;

    let mut conn = db.lock().await;
    let mut tx = conn.begin().await?;
    let mut ids = Ids::default();

    upsert_tree(&mut tx, tournament_id, &feed, &mut ids).await?;
    upsert_teams(&mut tx, tournament_id, &feed, &mut ids).await?;
    replace_players(&mut tx, &feed, &ids).await?;

    let mut matches: Vec<NewMatch> = feed.matches.iter().filter_map(|m| build_match(m, &ids)).collect();
    matches.sort_by_key(|m| m.number);

    // Matches are written before the nodes so the MatchID links resolve.
    upsert_matches(&mut tx, tournament_id, &matches).await?;
    upsert_bracket_nodes(&mut tx, tournament_id, &feed.nodes, &ids).await?;
    replace_standings(&mut tx, &feed, &ids).await?;

    tx.commit().await?;
    Ok(())
}

#[derive(Default)]
struct Refresh {
    running: bool,
    last: Option<Instant>,
}

/// Keeps every tournament's data fresh on demand: hitting its matches endpoint
/// starts a refresh, but at most once per REFRESH_INTERVAL. Refreshes run
/// detached so a visitor never waits on toornament — the endpoint answers with
/// the data it has and flags that fresher data is on its way.
pub struct Refresher {
    db: Arc<Mutex<SqliteConnection>>,
    client: reqwest::Client,
    state: Mutex<HashMap<u32, Refresh>>,
}

impl Refresher {
    pub fn new(db: Arc<Mutex<SqliteConnection>>) -> Arc<Self> {
        Arc::new(Refresher {
            db,
            client: reqwest::Client::new(),
            state: Mutex::new(HashMap::new()),
        })
    }

    /// Start a refresh unless one is running or the last one was too recent.
    /// Returns whether a refresh is in flight afterwards.
    pub async fn refresh(self: &Arc<Self>, tournament_id: u32) -> bool {
        {
            let mut state = self.state.lock().await;
            let refresh = state.entry(tournament_id).or_default();
            if refresh.running {
                return true;
            }
            if refresh
                .last
                .is_some_and(|last| last.elapsed() < REFRESH_INTERVAL)
            {
                return false;
            }
            refresh.running = true;
        }

        let refresher = self.clone();
        tokio::spawn(async move {
            if let Err(err) = refresher.load(tournament_id).await {
                log::error!("refreshing tournament {tournament_id} failed: {err}");
            }
            let mut state = refresher.state.lock().await;
            let refresh = state.entry(tournament_id).or_default();
            refresh.running = false;
            refresh.last = Some(Instant::now());
        });

        true
    }

    async fn load(&self, tournament_id: u32) -> Result<()> {
        let toornament_id = sqlx::query_scalar::<_, Option<String>>(
            "SELECT ToornamentId FROM tournaments WHERE TournamentID = ?",
        )
        .bind(tournament_id)
        .fetch_optional(self.db.lock().await.deref_mut())
        .await?
        .flatten();

        let Some(toornament_id) = toornament_id else {
            return Ok(());
        };
        log::info!("Refreshing tournament {tournament_id}");
        load_tournament(&self.db, &self.client, tournament_id as i64, &toornament_id).await
    }
}
