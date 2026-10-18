// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use serde::de::DeserializeOwned;
use serde_derive::Deserialize;
use sqlx::{Connection, SqliteConnection};
use std::collections::{BTreeSet, HashMap, HashSet};
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

// Shortest gap between two refreshes of a tournament that isn't in the database (the
// column's default). Every other tournament has its own, set in the admin panel.
const DEFAULT_REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

// Stage types played as a bracket rather than a round-robin league. These get a
// row per match (incl. undecided slots) in bracket_nodes so the bracket can be drawn.
pub const BRACKET_TYPES: [&str; 4] = [
    "single_elimination",
    "double_elimination",
    "bracket_groups",
    "custom_bracket",
];

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
    // Null until the group has results to rank by.
    rank: Option<i64>,
    points: Option<i64>,
    // Null while the slot is empty: a group that has no teams placed in it yet.
    participant: Option<Participant>,
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
    let stage_ids = stages
        .iter()
        .map(|s| s.id.as_str())
        .collect::<Vec<_>>()
        .join(",");

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
            fetch_items::<RawMatch>(
                client,
                &format!("{matches_url}{filter}"),
                MATCHES_PAGE,
                "matches",
            )
            .await?,
        );
    }

    let mut nodes = Vec::new();
    for stage in stages
        .iter()
        .filter(|s| BRACKET_TYPES.contains(&s.kind.as_str()))
    {
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

/// A prediction on a match the prune deleted, held until the new matches are written so
/// it can move to the match that replaced it. The match is identified by where it sat
/// (stage, group and round numbers survive a regenerated bracket, their ids don't) and
/// who played it.
#[derive(Debug, sqlx::FromRow)]
struct HeldPrediction {
    name: String,
    stage: i64,
    group: i64,
    round: i64,
    team_a: i64,
    team_b: i64,
    score_a: i64,
    score_b: i64,
}

/// Delete the matches under one group or round, or a single match (`column` is GroupID,
/// RoundID or MatchID), with the bracket nodes there and their predictions, which are
/// added to `held`. Nodes point at matches, so they go first.
async fn delete_matches_under(
    conn: &mut SqliteConnection,
    column: &str,
    id: i64,
    held: &mut Vec<HeldPrediction>,
) -> sqlx::Result<()> {
    let predictions: Vec<HeldPrediction> = sqlx::query_as(&format!(
        "SELECT p.Name AS name, s.Number AS stage, g.Number AS \"group\", r.Number AS round, \
         m.TeamA AS team_a, m.TeamB AS team_b, p.ScoreA AS score_a, p.ScoreB AS score_b \
         FROM predictions p JOIN matches m ON m.MatchID = p.MatchID \
         JOIN rounds r ON r.RoundID = m.RoundID JOIN groups g ON g.GroupID = m.GroupID \
         JOIN stages s ON s.StageID = g.StageID WHERE m.{column} = ?"
    ))
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    held.extend(predictions);

    for sql in [
        "DELETE FROM bracket_nodes WHERE {column} = ?",
        "DELETE FROM predictions WHERE MatchID IN (SELECT MatchID FROM matches WHERE {column} = ?)",
        "DELETE FROM matches WHERE {column} = ?",
    ] {
        sqlx::query(&sql.replace("{column}", column))
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Delete what toornament no longer has. A regenerated bracket comes back with new group,
/// round and node ids but the old numbers, which clash with the old rows on
/// UNIQUE (StageID, Number) and fail the whole refresh; even without a clash, the old
/// bracket would still be drawn. So this tournament's stages, groups, rounds and bracket
/// nodes whose ToornamentId isn't in the feed go, and with them their matches and the
/// predictions on those: toornament will never score them. Those predictions are returned
/// so `restore_predictions` can move them to a new match with the same teams. Standings
/// and league picks go with their group (ON DELETE CASCADE). Rows added by hand (no
/// ToornamentId) stay. A feed without stages is more likely a hiccup than a wiped
/// tournament, so it prunes nothing.
async fn prune_tree(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    feed: &Feed,
) -> sqlx::Result<Vec<HeldPrediction>> {
    let mut held = Vec::new();
    if feed.stages.is_empty() {
        return Ok(held);
    }
    let stages: HashSet<&str> = feed.stages.iter().map(|s| s.id.as_str()).collect();
    let groups: HashSet<&str> = feed.groups.iter().map(|g| g.id.as_str()).collect();
    let rounds: HashSet<&str> = feed.rounds.iter().map(|r| r.id.as_str()).collect();
    let nodes: HashSet<&str> = feed.nodes.iter().map(|n| n.id.as_str()).collect();
    let gone = |known: &HashSet<&str>, id: &Option<String>| {
        id.as_deref().is_some_and(|id| !known.contains(id))
    };

    let tree: Vec<(
        i64,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<i64>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT s.StageID, s.ToornamentId, g.GroupID, g.ToornamentId, r.RoundID, r.ToornamentId \
             FROM stages s LEFT JOIN groups g ON g.StageID = s.StageID \
             LEFT JOIN rounds r ON r.GroupID = g.GroupID WHERE s.TournamentID = ?",
    )
    .bind(tournament_id)
    .fetch_all(&mut *conn)
    .await?;
    let (mut stale_stages, mut stale_groups, mut stale_rounds) =
        (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    for (stage, stage_tid, group, group_tid, round, round_tid) in tree {
        let stage_gone = gone(&stages, &stage_tid);
        if stage_gone {
            stale_stages.insert(stage);
        }
        let Some(group) = group else { continue };
        let group_gone = stage_gone || gone(&groups, &group_tid);
        if group_gone {
            stale_groups.insert(group);
        }
        if let Some(round) = round {
            if group_gone || gone(&rounds, &round_tid) {
                stale_rounds.insert(round);
            }
        }
    }

    // A node toornament dropped from a group that's still there.
    let stored_nodes: Vec<String> =
        sqlx::query_scalar("SELECT NodeId FROM bracket_nodes WHERE TournamentID = ?")
            .bind(tournament_id)
            .fetch_all(&mut *conn)
            .await?;
    for node in stored_nodes
        .iter()
        .filter(|id| !nodes.contains(id.as_str()))
    {
        sqlx::query("DELETE FROM bracket_nodes WHERE NodeId = ?")
            .bind(node)
            .execute(&mut *conn)
            .await?;
        let match_id: Option<i64> =
            sqlx::query_scalar("SELECT MatchID FROM matches WHERE ToornamentId = ?")
                .bind(node)
                .fetch_optional(&mut *conn)
                .await?;
        if let Some(match_id) = match_id {
            delete_matches_under(conn, "MatchID", match_id, &mut held).await?;
        }
    }

    for &round in &stale_rounds {
        delete_matches_under(conn, "RoundID", round, &mut held).await?;
        sqlx::query("DELETE FROM rounds WHERE RoundID = ?")
            .bind(round)
            .execute(&mut *conn)
            .await?;
    }
    for &group in &stale_groups {
        delete_matches_under(conn, "GroupID", group, &mut held).await?;
        sqlx::query("DELETE FROM groups WHERE GroupID = ?")
            .bind(group)
            .execute(&mut *conn)
            .await?;
    }
    for &stage in &stale_stages {
        sqlx::query("DELETE FROM stages WHERE StageID = ?")
            .bind(stage)
            .execute(&mut *conn)
            .await?;
    }
    if !(stale_stages.is_empty() && stale_groups.is_empty() && stale_rounds.is_empty()) {
        log::info!(
            "Pruned {} stages, {} groups, {} rounds toornament no longer has",
            stale_stages.len(),
            stale_groups.len(),
            stale_rounds.len()
        );
    }
    Ok(held)
}

/// Move the predictions `prune_tree` held onto the new match in the same stage, group and
/// round with the same two teams, flipping the score if the teams swapped sides. One
/// whose match has no such replacement is dropped, as is one for a user who already
/// predicted the new match.
async fn restore_predictions(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    held: &[HeldPrediction],
) -> sqlx::Result<()> {
    let mut restored = 0;
    for p in held {
        // Rounds aren't compared: a regenerated bracket can add a play-in round in front,
        // pushing the same match from round 1 to round 2. Within one group a pair only
        // meets once, except a grand final reset, so the same round wins a tie.
        let found: Option<(i64, i64)> = sqlx::query_as(
            "SELECT m.MatchID, m.TeamA FROM matches m \
             JOIN rounds r ON r.RoundID = m.RoundID JOIN groups g ON g.GroupID = m.GroupID \
             JOIN stages s ON s.StageID = g.StageID \
             WHERE m.TournamentID = ? AND s.Number = ? AND g.Number = ? \
             AND ((m.TeamA = ? AND m.TeamB = ?) OR (m.TeamA = ? AND m.TeamB = ?)) \
             ORDER BY r.Number = ? DESC, r.Number LIMIT 1",
        )
        .bind(tournament_id)
        .bind(p.stage)
        .bind(p.group)
        .bind(p.team_a)
        .bind(p.team_b)
        .bind(p.team_b)
        .bind(p.team_a)
        .bind(p.round)
        .fetch_optional(&mut *conn)
        .await?;
        let Some((match_id, team_a)) = found else {
            continue;
        };
        let (score_a, score_b) = if team_a == p.team_a {
            (p.score_a, p.score_b)
        } else {
            (p.score_b, p.score_a)
        };

        let inserted = sqlx::query(
            "INSERT INTO predictions (Name, MatchID, ScoreA, ScoreB) SELECT ?, ?, ?, ? \
             WHERE NOT EXISTS (SELECT 1 FROM predictions WHERE Name = ? AND MatchID = ?)",
        )
        .bind(&p.name)
        .bind(match_id)
        .bind(score_a)
        .bind(score_b)
        .bind(&p.name)
        .bind(match_id)
        .execute(&mut *conn)
        .await?;
        restored += inserted.rows_affected();
    }
    if !held.is_empty() {
        log::info!(
            "Moved {restored} of {} predictions to regenerated matches",
            held.len()
        );
    }
    Ok(())
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
    let mut participants: HashMap<&str, &Participant> = feed
        .participants
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();
    let opponents = feed
        .matches
        .iter()
        .flat_map(|m| &m.opponents)
        .chain(feed.nodes.iter().flat_map(|n| &n.opponents))
        .filter_map(|o| o.participant.as_ref());
    for p in opponents.chain(feed.rankings.iter().filter_map(|r| r.participant.as_ref())) {
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

/// This tournament's teams toornament no longer has, as (TeamID, Name): their id isn't
/// among the ones the feed named (`ids.teams`, filled by upsert_teams). Teams added by
/// hand have no id and are never dropped. A feed without participants is more likely a
/// hiccup than an emptied tournament, so it drops nothing.
async fn dropped_teams(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    feed: &Feed,
    ids: &Ids,
) -> sqlx::Result<Vec<(i64, String)>> {
    if feed.participants.is_empty() {
        return Ok(Vec::new());
    }
    let teams: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT TeamID, Name, ToornamentId FROM teams \
         WHERE TournamentID = ? AND ToornamentId IS NOT NULL",
    )
    .bind(tournament_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(teams
        .into_iter()
        .filter(|(_, _, toornament_id)| !ids.teams.contains_key(toornament_id))
        .map(|(team, name, _)| (team, name))
        .collect())
}

/// Hand what refers to a dropped team over to the team that replaced it: the one team
/// toornament still has under the same name, as when a team signs up again. Runs before
/// the matches are written, so a match toornament moved to the new team already has it
/// and keeps its predictions (see sync_predictions); users' league picks move along. Where
/// the new team already has a standings row or a user's pick in a group, that one stays
/// and the old team's goes.
async fn merge_replaced_teams(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    feed: &Feed,
    ids: &Ids,
) -> sqlx::Result<()> {
    let current: HashSet<i64> = ids.teams.values().copied().collect();
    for (old, name) in dropped_teams(conn, tournament_id, feed, ids).await? {
        let same_name: Vec<i64> = sqlx::query_scalar(
            "SELECT TeamID FROM teams WHERE TournamentID = ? AND Name = ? AND TeamID != ?",
        )
        .bind(tournament_id)
        .bind(&name)
        .bind(old)
        .fetch_all(&mut *conn)
        .await?;
        let replacements: Vec<i64> = same_name
            .into_iter()
            .filter(|team| current.contains(team))
            .collect();
        // None, or several to choose from: no telling which team it became.
        let [new] = replacements[..] else {
            continue;
        };

        for sql in [
            "UPDATE matches SET TeamA = ?1 WHERE TeamA = ?2",
            "UPDATE matches SET TeamB = ?1 WHERE TeamB = ?2",
            "UPDATE bracket_nodes SET TeamA = ?1 WHERE TeamA = ?2",
            "UPDATE bracket_nodes SET TeamB = ?1 WHERE TeamB = ?2",
            "UPDATE OR IGNORE standings SET TeamID = ?1 WHERE TeamID = ?2",
            "DELETE FROM standings WHERE TeamID = ?2",
            "UPDATE OR IGNORE standing_predictions SET TeamID = ?1 WHERE TeamID = ?2",
            "DELETE FROM standing_predictions WHERE TeamID = ?2",
        ] {
            sqlx::query(sql).bind(new).bind(old).execute(&mut *conn).await?;
        }
        log::info!("{name} signed up again on toornament, moved team {old} onto team {new}");
    }
    Ok(())
}

/// Delete the teams toornament dropped, with their lineups. Runs last, once this refresh
/// has rewritten what refers to teams. A dropped team still in a match, a bracket slot, a
/// standings row or a league pick stays, since those rows need it, and is logged.
async fn delete_dropped_teams(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    feed: &Feed,
    ids: &Ids,
) -> sqlx::Result<()> {
    let mut deleted = 0;
    for (team, name) in dropped_teams(conn, tournament_id, feed, ids).await? {
        let used: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM matches WHERE TeamA = ?1 OR TeamB = ?1) \
             OR EXISTS (SELECT 1 FROM bracket_nodes WHERE TeamA = ?1 OR TeamB = ?1) \
             OR EXISTS (SELECT 1 FROM standings WHERE TeamID = ?1) \
             OR EXISTS (SELECT 1 FROM standing_predictions WHERE TeamID = ?1)",
        )
        .bind(team)
        .fetch_one(&mut *conn)
        .await?;
        if used {
            log::warn!("{name} (team {team}) is gone from toornament but still in use, kept");
            continue;
        }
        // Players go explicitly: the cascade needs foreign keys on, which tests may not set.
        for sql in [
            "DELETE FROM players WHERE TeamID = ?",
            "DELETE FROM teams WHERE TeamID = ?",
        ] {
            sqlx::query(sql).bind(team).execute(&mut *conn).await?;
        }
        deleted += 1;
    }
    if deleted > 0 {
        log::info!("Deleted {deleted} teams toornament no longer has");
    }
    Ok(())
}

/// Replace the lineup of every team the participants endpoint returned. Lineup entries
/// have no id of their own and names aren't unique, so the whole lineup is rewritten.
async fn replace_players(conn: &mut SqliteConnection, feed: &Feed, ids: &Ids) -> sqlx::Result<()> {
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

/// Keep the predictions on a stored match in step with the teams the feed now has for it.
/// Swapped sides flip the predicted scores. Any other change drops the predictions: they
/// were made for a different pairing.
async fn sync_predictions(
    conn: &mut SqliteConnection,
    match_id: i64,
    old: (i64, i64),
    m: &NewMatch,
) -> sqlx::Result<()> {
    if old == (m.team_a, m.team_b) {
        return Ok(());
    }
    let swapped = old == (m.team_b, m.team_a);
    let sql = if swapped {
        "UPDATE predictions SET ScoreA = ScoreB, ScoreB = ScoreA WHERE MatchID = ?"
    } else {
        "DELETE FROM predictions WHERE MatchID = ?"
    };
    let changed = sqlx::query(sql).bind(match_id).execute(&mut *conn).await?;
    if changed.rows_affected() > 0 {
        log::info!(
            "Teams of match {} changed, {} {} predictions",
            m.toornament_id,
            if swapped { "flipped" } else { "dropped" },
            changed.rows_affected()
        );
    }
    Ok(())
}

/// Insert/update league + predictable bracket matches. An existing row is found by its
/// stable ToornamentId first, falling back to the natural (TeamA, TeamB, GroupID,
/// RoundID) key only for legacy rows without one. Keying on ToornamentId means a
/// changed field updates the row in place instead of inserting a duplicate, so MatchID
/// (and the predictions that reference it) is preserved, unless the teams changed.
async fn upsert_matches(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    matches: &[NewMatch],
) -> sqlx::Result<()> {
    for m in matches {
        let existing: Option<(i64, i64, i64)> = sqlx::query_as(
            "SELECT MatchID, TeamA, TeamB FROM matches WHERE ToornamentId = ?",
        )
        .bind(&m.toornament_id)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some((id, team_a, team_b)) = existing {
            sync_predictions(conn, id, (team_a, team_b), m).await?;
        }
        let mut match_id = existing.map(|(id, ..)| id);

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
    for g in feed
        .groups
        .iter()
        .filter(|g| ranked_stages.contains(&g.stage.id.as_str()))
    {
        if let Some(group_id) = ids.groups.get(&g.id) {
            sqlx::query("DELETE FROM standings WHERE GroupID = ?")
                .bind(group_id)
                .execute(&mut *conn)
                .await?;
        }
    }

    for item in &feed.rankings {
        // An empty slot has no team to list.
        let Some(participant) = &item.participant else {
            continue;
        };
        let (Some(&group_id), Some(&team_id)) = (
            ids.groups.get(&item.ranking.group.id),
            ids.teams.get(&participant.id),
        ) else {
            log::warn!(
                "ranking of {} has an unknown group or team",
                participant.name
            );
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
        .bind(item.rank.unwrap_or(item.position))
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

    let held = prune_tree(&mut tx, tournament_id, &feed).await?;
    upsert_tree(&mut tx, tournament_id, &feed, &mut ids).await?;
    upsert_teams(&mut tx, tournament_id, &feed, &mut ids).await?;
    merge_replaced_teams(&mut tx, tournament_id, &feed, &ids).await?;
    replace_players(&mut tx, &feed, &ids).await?;

    let mut matches: Vec<NewMatch> = feed
        .matches
        .iter()
        .filter_map(|m| build_match(m, &ids))
        .collect();
    matches.sort_by_key(|m| m.number);

    // Matches are written before the nodes so the MatchID links resolve.
    upsert_matches(&mut tx, tournament_id, &matches).await?;
    restore_predictions(&mut tx, tournament_id, &held).await?;
    upsert_bracket_nodes(&mut tx, tournament_id, &feed.nodes, &ids).await?;
    replace_standings(&mut tx, &feed, &ids).await?;
    delete_dropped_teams(&mut tx, tournament_id, &feed, &ids).await?;

    tx.commit().await?;
    Ok(())
}

#[derive(Default)]
struct Refresh {
    running: bool,
    last: Option<Instant>,
}

/// Keeps every tournament's data fresh on demand: hitting its matches endpoint
/// starts a refresh, but at most once per the tournament's RefreshInterval. Refreshes run
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
        // Read on every call, so a new interval from the admin panel applies at once.
        // Looked up before taking `state`, so the two locks are never held together.
        let interval = self.interval(tournament_id).await;
        {
            let mut state = self.state.lock().await;
            let refresh = state.entry(tournament_id).or_default();
            if refresh.running {
                return true;
            }
            if refresh.last.is_some_and(|last| last.elapsed() < interval) {
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

    async fn interval(&self, tournament_id: u32) -> Duration {
        let secs = sqlx::query_scalar::<_, i64>(
            "SELECT RefreshInterval FROM tournaments WHERE TournamentID = ?",
        )
        .bind(tournament_id)
        .fetch_optional(self.db.lock().await.deref_mut())
        .await;
        match secs {
            Ok(Some(secs)) => Duration::from_secs(secs.max(0) as u64),
            Ok(None) => DEFAULT_REFRESH_INTERVAL,
            Err(err) => {
                log::error!("reading the refresh interval of tournament {tournament_id} failed: {err}");
                DEFAULT_REFRESH_INTERVAL
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn node_ref(id: &str) -> NodeRef {
        NodeRef { id: id.into() }
    }

    // A tournament whose stage "s" holds the bracket group "g-old" (number 1), with a
    // round, a node and a predicted match in it.
    async fn db_with_old_bracket() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("init.sql"))
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(
            "PRAGMA foreign_keys = ON;
             INSERT INTO users (Name) VALUES ('fan');
             INSERT INTO tournaments (TournamentID, Name, ToornamentId) VALUES (1, 'T', 't');
             INSERT INTO teams (TeamID, TournamentID, Name) VALUES (1, 1, 'A'), (2, 1, 'B');
             INSERT INTO stages (StageID, TournamentID, Number, Name, Type, ToornamentId)
                 VALUES (1, 1, 1, 'Wildcard', 'double_elimination', 's');
             INSERT INTO groups (GroupID, StageID, Number, Name, ToornamentId) VALUES (1, 1, 1, 'WB', 'g-old');
             INSERT INTO rounds (RoundID, GroupID, Number, Name, ToornamentId) VALUES (1, 1, 1, 'R1', 'r-old');
             INSERT INTO matches (MatchID, TournamentID, GroupID, RoundID, TeamA, TeamB, ToornamentId)
                 VALUES (1, 1, 1, 1, 1, 2, 'n-old');
             INSERT INTO predictions VALUES ('fan', 1, 2, 1);
             INSERT INTO bracket_nodes (NodeId, TournamentID, GroupID, RoundID, Position, Depth, MatchID)
                 VALUES ('n-old', 1, 1, 1, 1, 1, 1);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    fn feed(groups: &[(&str, i64)]) -> Feed {
        Feed {
            stages: vec![RawStage {
                id: "s".into(),
                number: 1,
                name: "Wildcard".into(),
                kind: "double_elimination".into(),
                status: None,
            }],
            groups: groups
                .iter()
                .map(|&(id, number)| RawGroup {
                    id: id.into(),
                    number,
                    name: "WB".into(),
                    status: None,
                    stage: node_ref("s"),
                })
                .collect(),
            rounds: vec![],
            participants: vec![],
            matches: vec![],
            nodes: vec![],
            rankings: vec![],
        }
    }

    async fn count(conn: &mut SqliteConnection, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(conn)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn regenerated_bracket_replaces_the_old_one() {
        let mut conn = db_with_old_bracket().await;
        // Toornament regenerated the bracket: same stage, new group id, same number.
        let feed = feed(&[("g-new", 1)]);

        prune_tree(&mut conn, 1, &feed).await.unwrap();
        upsert_tree(&mut conn, 1, &feed, &mut Ids::default())
            .await
            .unwrap();

        let groups: Vec<String> = sqlx::query_scalar("SELECT ToornamentId FROM groups")
            .fetch_all(&mut conn)
            .await
            .unwrap();
        assert_eq!(groups, ["g-new"]);
        for table in ["rounds", "bracket_nodes", "matches", "predictions"] {
            assert_eq!(count(&mut conn, table).await, 0, "{table}");
        }
        assert_eq!(count(&mut conn, "stages").await, 1);
    }

    // Regenerate the old bracket: new group, round and node ids, the same group number,
    // and one match between `team_a` and `team_b`, pushed from round 1 to round 2 by a
    // new play-in round. Returns the predictions on the new match.
    async fn regenerate_with(
        conn: &mut SqliteConnection,
        team_a: i64,
        team_b: i64,
    ) -> Vec<(String, i64, i64)> {
        let mut feed = feed(&[("g-new", 1)]);
        feed.rounds.push(RawRound {
            id: "r-new".into(),
            number: 2,
            name: "R1".into(),
            status: None,
            group: node_ref("g-new"),
        });
        let mut ids = Ids::default();

        let held = prune_tree(conn, 1, &feed).await.unwrap();
        upsert_tree(conn, 1, &feed, &mut ids).await.unwrap();
        let new_match = NewMatch {
            team_a,
            team_b,
            score_a: None,
            score_b: None,
            group_id: ids.groups["g-new"],
            round_id: ids.rounds["r-new"],
            number: 1,
            toornament_id: "n-new".into(),
        };
        upsert_matches(conn, 1, &[new_match]).await.unwrap();
        restore_predictions(conn, 1, &held).await.unwrap();

        sqlx::query_as(
            "SELECT p.Name, p.ScoreA, p.ScoreB FROM predictions p \
             JOIN matches m ON m.MatchID = p.MatchID WHERE m.ToornamentId = 'n-new'",
        )
        .fetch_all(conn)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn regenerated_match_with_the_same_teams_keeps_its_prediction() {
        let mut conn = db_with_old_bracket().await;
        // The old match was A vs B, predicted 2-1; the new one has the sides swapped.
        let predictions = regenerate_with(&mut conn, 2, 1).await;

        assert_eq!(predictions, [("fan".to_string(), 1, 2)]);
        assert_eq!(count(&mut conn, "predictions").await, 1);
    }

    #[tokio::test]
    async fn regenerated_match_with_other_teams_drops_the_prediction() {
        let mut conn = db_with_old_bracket().await;
        sqlx::query("INSERT INTO teams (TeamID, TournamentID, Name) VALUES (3, 1, 'C')")
            .execute(&mut conn)
            .await
            .unwrap();
        let predictions = regenerate_with(&mut conn, 1, 3).await;

        assert!(predictions.is_empty());
        assert_eq!(count(&mut conn, "predictions").await, 0);
    }

    // The feed still has the old match (A vs B, predicted 2-1), now between `team_a` and
    // `team_b`. Returns its predicted scores afterwards.
    async fn update_old_match(
        conn: &mut SqliteConnection,
        team_a: i64,
        team_b: i64,
    ) -> Vec<(i64, i64)> {
        sqlx::query("INSERT INTO teams (TeamID, TournamentID, Name) VALUES (3, 1, 'C')")
            .execute(&mut *conn)
            .await
            .unwrap();
        let old_match = NewMatch {
            team_a,
            team_b,
            score_a: None,
            score_b: None,
            group_id: 1,
            round_id: 1,
            number: 1,
            toornament_id: "n-old".into(),
        };
        upsert_matches(conn, 1, &[old_match]).await.unwrap();

        sqlx::query_as("SELECT ScoreA, ScoreB FROM predictions WHERE MatchID = 1")
            .fetch_all(conn)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn match_with_the_same_teams_keeps_its_predictions() {
        let mut conn = db_with_old_bracket().await;
        assert_eq!(update_old_match(&mut conn, 1, 2).await, [(2, 1)]);
    }

    #[tokio::test]
    async fn match_with_swapped_sides_flips_its_predictions() {
        let mut conn = db_with_old_bracket().await;
        assert_eq!(update_old_match(&mut conn, 2, 1).await, [(1, 2)]);
    }

    #[tokio::test]
    async fn match_with_a_new_team_drops_its_predictions() {
        let mut conn = db_with_old_bracket().await;
        assert!(update_old_match(&mut conn, 1, 3).await.is_empty());
    }

    #[tokio::test]
    async fn keeps_what_the_feed_still_has() {
        let mut conn = db_with_old_bracket().await;
        let mut feed = feed(&[("g-old", 1)]);
        feed.rounds.push(RawRound {
            id: "r-old".into(),
            number: 1,
            name: "R1".into(),
            status: None,
            group: node_ref("g-old"),
        });
        // The node is gone from the feed, so it goes; the round it sat in stays.
        prune_tree(&mut conn, 1, &feed).await.unwrap();

        assert_eq!(count(&mut conn, "groups").await, 1);
        assert_eq!(count(&mut conn, "rounds").await, 1);
        assert_eq!(count(&mut conn, "bracket_nodes").await, 0);
        assert_eq!(count(&mut conn, "matches").await, 0);
    }

    #[tokio::test]
    async fn empty_feed_prunes_nothing() {
        let mut conn = db_with_old_bracket().await;
        let mut feed = feed(&[]);
        feed.stages.clear();

        prune_tree(&mut conn, 1, &feed).await.unwrap();

        for table in [
            "stages",
            "groups",
            "rounds",
            "bracket_nodes",
            "matches",
            "predictions",
        ] {
            assert_eq!(count(&mut conn, table).await, 1, "{table}");
        }
    }

    // Tournament 1's teams: "Mia" signed up twice (11 is gone from toornament, 12 is
    // current), 10 is gone with no replacement, 13 is current, 14 was added by hand.
    // Old Mia played 13 in match 1 (predicted 2-1), has a player, and is fan's 1st pick.
    async fn db_with_teams() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("init.sql"))
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(
            "PRAGMA foreign_keys = ON;
             INSERT INTO users (Name) VALUES ('fan');
             INSERT INTO tournaments (TournamentID, Name, ToornamentId) VALUES (1, 'T', 't');
             INSERT INTO teams (TeamID, TournamentID, Name, ToornamentId) VALUES
                 (10, 1, 'Gone', 'p-gone'), (11, 1, 'Mia', 'p-mia-old'),
                 (12, 1, 'Mia', 'p-mia-new'), (13, 1, 'Rival', 'p-rival');
             INSERT INTO teams (TeamID, TournamentID, Name) VALUES (14, 1, 'Hand');
             INSERT INTO players (TeamID, Position, Name) VALUES (11, 1, 'Moh');
             INSERT INTO stages (StageID, TournamentID, Number, Name, Type, ToornamentId)
                 VALUES (1, 1, 1, '1. Liga', 'league', 's');
             INSERT INTO groups (GroupID, StageID, Number, Name, ToornamentId) VALUES (1, 1, 1, 'D1', 'g');
             INSERT INTO rounds (RoundID, GroupID, Number, Name, ToornamentId) VALUES (1, 1, 1, 'Day 1', 'r');
             INSERT INTO matches (MatchID, TournamentID, GroupID, RoundID, TeamA, TeamB, ToornamentId)
                 VALUES (1, 1, 1, 1, 11, 13, 'm1');
             INSERT INTO predictions VALUES ('fan', 1, 2, 1);
             INSERT INTO standing_predictions VALUES ('fan', 1, 1, 11);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    fn participant(id: &str, name: &str) -> Participant {
        Participant {
            id: id.into(),
            name: name.into(),
            custom_field_values: None,
            lineup: None,
        }
    }

    // What upsert_teams leaves behind for a feed listing the new Mia and Rival.
    fn feed_with_current_teams() -> (Feed, Ids) {
        let mut feed = feed(&[]);
        feed.participants = vec![participant("p-mia-new", "Mia"), participant("p-rival", "Rival")];
        let mut ids = Ids::default();
        ids.teams.insert("p-mia-new".into(), 12);
        ids.teams.insert("p-rival".into(), 13);
        (feed, ids)
    }

    async fn team_ids(conn: &mut SqliteConnection) -> Vec<i64> {
        sqlx::query_scalar("SELECT TeamID FROM teams ORDER BY TeamID")
            .fetch_all(conn)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn team_signed_up_again_takes_over_matches_and_picks() {
        let mut conn = db_with_teams().await;
        let (feed, ids) = feed_with_current_teams();

        merge_replaced_teams(&mut conn, 1, &feed, &ids).await.unwrap();
        // Toornament's match 1 is now played by the new Mia.
        let m1 = NewMatch {
            team_a: 12,
            team_b: 13,
            score_a: None,
            score_b: None,
            group_id: 1,
            round_id: 1,
            number: 1,
            toornament_id: "m1".into(),
        };
        upsert_matches(&mut conn, 1, &[m1]).await.unwrap();
        delete_dropped_teams(&mut conn, 1, &feed, &ids).await.unwrap();

        let prediction: Vec<(i64, i64)> =
            sqlx::query_as("SELECT ScoreA, ScoreB FROM predictions WHERE MatchID = 1")
                .fetch_all(&mut conn)
                .await
                .unwrap();
        assert_eq!(prediction, [(2, 1)]);
        let pick: i64 = sqlx::query_scalar("SELECT TeamID FROM standing_predictions")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(pick, 12);
        // Old Mia and Gone are deleted, Old Mia's player with it; the hand-made team stays.
        assert_eq!(team_ids(&mut conn).await, [12, 13, 14]);
        assert_eq!(count(&mut conn, "players").await, 0);
    }

    #[tokio::test]
    async fn dropped_team_still_in_use_stays() {
        let mut conn = db_with_teams().await;
        let (feed, ids) = feed_with_current_teams();
        // Gone played a match, and nothing replaced it.
        sqlx::query(
            "INSERT INTO matches (MatchID, TournamentID, GroupID, RoundID, TeamA, TeamB) \
             VALUES (2, 1, 1, 1, 10, 13)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        merge_replaced_teams(&mut conn, 1, &feed, &ids).await.unwrap();
        delete_dropped_teams(&mut conn, 1, &feed, &ids).await.unwrap();

        assert_eq!(team_ids(&mut conn).await, [10, 12, 13, 14]);
    }

    #[tokio::test]
    async fn feed_without_participants_drops_no_team() {
        let mut conn = db_with_teams().await;
        let (mut feed, ids) = feed_with_current_teams();
        feed.participants.clear();

        merge_replaced_teams(&mut conn, 1, &feed, &ids).await.unwrap();
        delete_dropped_teams(&mut conn, 1, &feed, &ids).await.unwrap();

        assert_eq!(team_ids(&mut conn).await, [10, 11, 12, 13, 14]);
        assert_eq!(count(&mut conn, "standing_predictions").await, 1);
    }
}
