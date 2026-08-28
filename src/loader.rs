// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use serde::de::DeserializeOwned;
use serde_derive::Deserialize;
use sqlx::SqliteConnection;
use std::collections::HashMap;
use std::ops::DerefMut;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const BASE_URL: &str = "https://play.toornament.com";
const PAST_MATCHES: &str = "statuses=running,completed&sort=latest_results";
const UPCOMING_MATCHES: &str = "statuses=pending&sort=scheduled_asc";
const PAGE_SIZE: usize = 100;

// Shortest gap between two refreshes of the same tournament.
const REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

// Stage types played as a bracket rather than a round-robin league. These get a
// row per match (incl. undecided slots) in bracket_nodes so the bracket can be drawn.
const BRACKET_TYPES: [&str; 3] = ["single_elimination", "double_elimination", "bracket_groups"];

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
    logo: Option<Logo>,
}

#[derive(Deserialize)]
struct Participant {
    id: String,
    name: String,
    #[serde(rename = "customFieldValues")]
    custom_field_values: Option<CustomFieldValues>,
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

#[derive(Clone, Deserialize)]
struct Stage {
    id: String,
    name: String,
    number: i64,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct Group {
    name: String,
}

#[derive(Deserialize)]
struct Round {
    name: String,
    number: i64,
}

#[derive(Deserialize)]
struct RawMatch {
    id: String,
    number: i64,
    opponents: Vec<Opponent>,
    stage: Stage,
    group: Group,
    round: Round,
}

#[derive(Deserialize)]
struct RawNode {
    id: String,
    number: i64,
    depth: i64,
    branch: Option<String>,
    opponents: Vec<Opponent>,
    group: Group,
    round: Round,
}

struct NewMatch {
    team_a: String,
    team_b: String,
    logo_a: String,
    logo_b: String,
    score_a: Option<i64>,
    score_b: Option<i64>,
    stage: String,
    group: String,
    round: String,
    number: i64,
    toornament_id: String,
    stage_type: String,
    stage_number: i64,
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
    label: &str,
) -> Result<Vec<T>> {
    let mut items = Vec::new();
    let mut offset = 0;

    loop {
        let page: Page<T> = client
            .get(format!("{url}&offset={offset}&limit={PAGE_SIZE}"))
            .send()
            .await?
            .json()
            .await?;

        let len = page.items.len();
        items.extend(page.items);
        log::info!("Loaded {label} {offset}-{}", offset + len);

        if len < PAGE_SIZE {
            return Ok(items);
        }
        offset += PAGE_SIZE;
    }
}

/// A NewMatch for the predictable (both teams known) `matches` table, or None.
fn build_match(raw: &RawMatch) -> Option<NewMatch> {
    let (o_a, o_b) = (raw.opponents.first()?, raw.opponents.get(1)?);
    // a TBD slot — not predictable; lives only in bracket_nodes
    let (p_a, p_b) = (o_a.participant.as_ref()?, o_b.participant.as_ref()?);

    // League/swiss matchdays read nicer as "Day N"; leave bracket round names ("Round 1",
    // "WB Round 1", …) alone so a bracket match never collides with a league day tab.
    let mut round = raw.round.name.trim().to_string();
    if !BRACKET_TYPES.contains(&raw.stage.kind.as_str()) {
        if let Some(rest) = round.strip_prefix("Round") {
            round = format!("Day{rest}");
        }
    }

    Some(NewMatch {
        team_a: p_a.name.trim().to_string(),
        team_b: p_b.name.trim().to_string(),
        logo_a: participant_logo(p_a),
        logo_b: participant_logo(p_b),
        score_a: o_a.score,
        score_b: o_b.score,
        stage: raw.stage.name.trim().to_string(),
        group: raw.group.name.trim().to_string(),
        round,
        number: raw.number,
        toornament_id: raw.id.clone(),
        stage_type: raw.stage.kind.clone(),
        stage_number: raw.stage.number,
    })
}

/// Insert/update league + predictable bracket matches. An existing row is found by its
/// stable ToornamentId first, falling back to the natural (TeamA, TeamB, StageName,
/// GroupName, RoundName) key only for legacy rows without one. Keying on ToornamentId
/// means a changed field — e.g. a bracket round renamed "Day 1" -> "Round 1" — updates
/// the row in place instead of inserting a duplicate, so MatchID (and the predictions
/// that reference it) is preserved.
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
                 AND StageName = ? AND GroupName = ? AND RoundName = ?",
            )
            .bind(tournament_id)
            .bind(&m.team_a)
            .bind(&m.team_b)
            .bind(&m.stage)
            .bind(&m.group)
            .bind(&m.round)
            .fetch_optional(&mut *conn)
            .await?;
        }

        // A NULL MatchID inserts a fresh row; a known one updates that row in place. Metadata
        // and section parts always converge, but scores are only overwritten when the feed
        // actually has them (don't wipe a stored score if a match briefly reports null).
        sqlx::query(
            "INSERT INTO matches (MatchID, TournamentID, TeamA, TeamB, LogoA, LogoB, ScoreA, \
             ScoreB, ToornamentId, StageType, StageNumber, StageName, GroupName, RoundName) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(MatchID) DO UPDATE SET TeamA = excluded.TeamA, TeamB = excluded.TeamB, \
             LogoA = excluded.LogoA, LogoB = excluded.LogoB, \
             ScoreA = COALESCE(excluded.ScoreA, matches.ScoreA), \
             ScoreB = COALESCE(excluded.ScoreB, matches.ScoreB), \
             ToornamentId = excluded.ToornamentId, StageType = excluded.StageType, \
             StageNumber = excluded.StageNumber, StageName = excluded.StageName, \
             GroupName = excluded.GroupName, RoundName = excluded.RoundName",
        )
        .bind(match_id)
        .bind(tournament_id)
        .bind(&m.team_a)
        .bind(&m.team_b)
        .bind(&m.logo_a)
        .bind(&m.logo_b)
        .bind(m.score_a)
        .bind(m.score_b)
        .bind(&m.toornament_id)
        .bind(&m.stage_type)
        .bind(m.stage_number)
        .bind(&m.stage)
        .bind(&m.group)
        .bind(&m.round)
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

/// (name, logo) for a known opponent, else (None, None) for a TBD slot.
fn node_team(
    opponent: &Opponent,
    logos: &HashMap<String, String>,
) -> (Option<String>, Option<String>) {
    let Some(participant) = opponent.participant.as_ref() else {
        return (None, None);
    };
    let logo = logos.get(&participant.id).cloned().unwrap_or_default();
    (Some(participant.name.trim().to_string()), Some(logo))
}

/// Store every bracket node of `stage` (incl. TBD slots and the winner/loser source
/// edges). MatchID is linked when both teams are known.
async fn upsert_bracket_nodes(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    stage: &Stage,
    nodes: &[RawNode],
    logos: &HashMap<String, String>,
) -> sqlx::Result<()> {
    for n in nodes {
        let (Some(o_a), Some(o_b)) = (n.opponents.first(), n.opponents.get(1)) else {
            continue;
        };
        let (team_a, logo_a) = node_team(o_a, logos);
        let (team_b, logo_b) = node_team(o_b, logos);
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
            "INSERT OR REPLACE INTO bracket_nodes (NodeId, TournamentID, StageId, StageName, \
             StageNumber, StageType, GroupName, Branch, RoundNumber, Position, Depth, TeamA, \
             TeamB, LogoA, LogoB, ScoreA, ScoreB, SourceTypeA, SourceA, SourceTypeB, SourceB, \
             MatchID) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&n.id)
        .bind(tournament_id)
        .bind(&stage.id)
        .bind(stage.name.trim())
        .bind(stage.number)
        .bind(&stage.kind)
        .bind(n.group.name.trim())
        .bind(n.branch.as_deref())
        .bind(n.round.number)
        .bind(n.number)
        .bind(n.depth)
        .bind(team_a)
        .bind(team_b)
        .bind(logo_a)
        .bind(logo_b)
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

async fn load_tournament(
    db: &Mutex<SqliteConnection>,
    client: &reqwest::Client,
    tournament_id: i64,
    toornament_id: &str,
) -> Result<()> {
    let matches_url = format!("{BASE_URL}/api/matches?tournament_ids={toornament_id}&");

    let mut raw: Vec<RawMatch> = Vec::new();
    for filter in [PAST_MATCHES, UPCOMING_MATCHES] {
        raw.extend(
            fetch_items::<RawMatch>(client, &format!("{matches_url}{filter}"), "matches").await?,
        );
    }

    // participant id -> logo, built from the raw feed (covers every named team, including
    // those that only appear in an otherwise-TBD bracket slot), plus the distinct bracket
    // stages (deduped by id) seen in that same feed.
    let mut logos = HashMap::new();
    let mut bracket_stages: HashMap<String, Stage> = HashMap::new();
    for raw_match in &raw {
        for opponent in &raw_match.opponents {
            if let Some(participant) = opponent.participant.as_ref() {
                logos.insert(participant.id.clone(), participant_logo(participant));
            }
        }
        if BRACKET_TYPES.contains(&raw_match.stage.kind.as_str()) {
            bracket_stages.insert(raw_match.stage.id.clone(), raw_match.stage.clone());
        }
    }

    let mut matches: Vec<NewMatch> = raw.iter().filter_map(build_match).collect();
    matches.sort_by_key(|m| m.number);

    // Matches are written before the nodes so the MatchID links below resolve.
    upsert_matches(db.lock().await.deref_mut(), tournament_id, &matches).await?;

    for stage in bracket_stages.values() {
        let url = format!("{BASE_URL}/api/bracket-nodes?stage_ids={}", stage.id);
        let nodes: Vec<RawNode> = fetch_items(client, &url, "bracket-nodes").await?;
        upsert_bracket_nodes(
            db.lock().await.deref_mut(),
            tournament_id,
            stage,
            &nodes,
            &logos,
        )
        .await?;
    }

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
