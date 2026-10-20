// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
use serde_derive::{Deserialize, Serialize};
use sqlx::FromRow;
use std::str::FromStr;

#[derive(Serialize)]
pub struct User {
    pub name: String,
}

#[derive(Deserialize, Serialize, Debug, FromRow)]
pub struct Tournament {
    #[sqlx(rename = "TournamentID")]
    pub tournament_id: u64,
    #[sqlx(rename = "Name")]
    pub name: String,
    #[sqlx(rename = "ToornamentId")]
    pub toornament_id: Option<String>,
    /// Seconds between toornament refreshes. Ignored when creating a tournament, which
    /// starts at the column's default.
    #[sqlx(rename = "RefreshInterval")]
    #[serde(default)]
    pub refresh_interval: u64,
}

#[derive(Deserialize, Serialize, Debug, FromRow)]
pub struct Match {
    #[sqlx(rename = "MatchID")]
    pub id: u64,
    #[sqlx(rename = "TournamentID")]
    pub tournament_id: u64,
    #[sqlx(rename = "TeamA")]
    pub team_a: String,
    #[sqlx(rename = "TeamB")]
    pub team_b: String,
    #[sqlx(rename = "LogoA")]
    pub logo_a: String,
    #[sqlx(rename = "LogoB")]
    pub logo_b: String,
    #[sqlx(rename = "ScoreA")]
    pub score_a: Option<u64>,
    #[sqlx(rename = "ScoreB")]
    pub score_b: Option<u64>,
    #[sqlx(rename = "ToornamentId")]
    pub toornament_id: Option<String>,
    #[sqlx(rename = "StageType")]
    pub stage_type: Option<String>,
    #[sqlx(rename = "StageNumber")]
    pub stage_number: Option<u64>,
    #[sqlx(rename = "StageName")]
    pub stage_name: String,
    #[sqlx(rename = "GroupName")]
    pub group_name: String,
    #[sqlx(rename = "RoundName")]
    pub round_name: String,
}

#[derive(Deserialize, Serialize, Debug, FromRow)]
pub struct BracketNode {
    #[sqlx(rename = "NodeId")]
    pub node_id: String,
    #[sqlx(rename = "TournamentID")]
    pub tournament_id: u32,
    #[sqlx(rename = "StageId")]
    pub stage_id: String,
    #[sqlx(rename = "StageName")]
    pub stage_name: String,
    #[sqlx(rename = "StageNumber")]
    pub stage_number: u64,
    #[sqlx(rename = "StageType")]
    pub stage_type: String,
    #[sqlx(rename = "GroupName")]
    pub group_name: String,
    #[sqlx(rename = "Branch")]
    pub branch: Option<String>,
    #[sqlx(rename = "RoundNumber")]
    pub round_number: u64,
    #[sqlx(rename = "Position")]
    pub position: u64,
    #[sqlx(rename = "Depth")]
    pub depth: u64,
    #[sqlx(rename = "TeamA")]
    pub team_a: Option<String>,
    #[sqlx(rename = "TeamB")]
    pub team_b: Option<String>,
    #[sqlx(rename = "LogoA")]
    pub logo_a: Option<String>,
    #[sqlx(rename = "LogoB")]
    pub logo_b: Option<String>,
    #[sqlx(rename = "ScoreA")]
    pub score_a: Option<u64>,
    #[sqlx(rename = "ScoreB")]
    pub score_b: Option<u64>,
    #[sqlx(rename = "SourceTypeA")]
    pub source_type_a: Option<String>,
    #[sqlx(rename = "SourceA")]
    pub source_a: Option<String>,
    #[sqlx(rename = "SourceTypeB")]
    pub source_type_b: Option<String>,
    #[sqlx(rename = "SourceB")]
    pub source_b: Option<String>,
    #[sqlx(rename = "MatchID")]
    pub match_id: Option<u64>,
}

#[derive(Serialize, Debug, FromRow)]
pub struct Standing {
    #[sqlx(rename = "StageName")]
    pub stage_name: String,
    #[sqlx(rename = "StageNumber")]
    pub stage_number: u64,
    #[sqlx(rename = "StageType")]
    pub stage_type: String,
    #[sqlx(rename = "GroupID")]
    pub group_id: u64,
    #[sqlx(rename = "GroupName")]
    pub group_name: String,
    #[sqlx(rename = "GroupNumber")]
    pub group_number: u64,
    #[sqlx(rename = "Position")]
    pub position: u64,
    #[sqlx(rename = "Rank")]
    pub rank: u64,
    #[sqlx(rename = "TeamID")]
    pub team_id: u64,
    #[sqlx(rename = "Team")]
    pub team: String,
    #[sqlx(rename = "ShortName")]
    pub short_name: Option<String>,
    #[sqlx(rename = "Logo")]
    pub logo: String,
    #[sqlx(rename = "Points")]
    pub points: Option<i64>,
    #[sqlx(rename = "Played")]
    pub played: u64,
    #[sqlx(rename = "Wins")]
    pub wins: u64,
    #[sqlx(rename = "Draws")]
    pub draws: u64,
    #[sqlx(rename = "Losses")]
    pub losses: u64,
    #[sqlx(rename = "Forfeits")]
    pub forfeits: u64,
    #[sqlx(rename = "ScoreFor")]
    pub score_for: Option<u64>,
    #[sqlx(rename = "ScoreAgainst")]
    pub score_against: Option<u64>,
    #[sqlx(rename = "ScoreDifference")]
    pub score_difference: Option<i64>,
    #[sqlx(rename = "Dropped")]
    pub dropped: bool,
    /// Whether the group still takes standing predictions: none of its matches has a score,
    /// or its stage is forced open.
    #[sqlx(rename = "Open")]
    pub open: bool,
    /// How many places of the group users predict, set per stage.
    #[sqlx(rename = "PickCount")]
    pub pick_count: u64,
}

#[derive(Serialize, Debug, FromRow)]
pub struct Stage {
    #[sqlx(rename = "StageID")]
    pub stage_id: u64,
    #[sqlx(rename = "Number")]
    pub number: u64,
    #[sqlx(rename = "Name")]
    pub name: String,
    #[sqlx(rename = "Type")]
    pub stage_type: String,
    #[sqlx(rename = "PickCount")]
    pub pick_count: u64,
    /// Whether the stage keeps taking standing predictions after one of its matches has
    /// been scored.
    #[sqlx(rename = "ForceOpen")]
    pub force_open: bool,
}

#[derive(Deserialize, Debug)]
pub struct StagePickCount {
    pub stage_id: u64,
    pub pick_count: u64,
}

#[derive(Deserialize, Debug)]
pub struct StageForceOpen {
    pub stage_id: u64,
    pub force_open: bool,
}

#[derive(Serialize, Debug, FromRow)]
pub struct Team {
    #[sqlx(rename = "TeamID")]
    pub id: u64,
    #[sqlx(rename = "Name")]
    pub name: String,
    #[sqlx(rename = "ShortName")]
    pub short_name: Option<String>,
    #[sqlx(rename = "Logo")]
    pub logo: String,
    #[sqlx(rename = "ToornamentId")]
    pub toornament_id: Option<String>,
}

#[derive(Serialize, Debug, FromRow)]
pub struct Player {
    #[sqlx(rename = "TeamID")]
    pub team_id: u64,
    #[sqlx(rename = "Team")]
    pub team: String,
    #[sqlx(rename = "ShortName")]
    pub short_name: Option<String>,
    #[sqlx(rename = "Logo")]
    pub logo: String,
    #[sqlx(rename = "Position")]
    pub position: u64,
    #[sqlx(rename = "Name")]
    pub name: String,
    #[sqlx(rename = "BattleTag")]
    pub battle_tag: Option<String>,
    #[sqlx(rename = "ToornamentUserId")]
    pub toornament_user_id: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, FromRow)]
pub struct Prediction {
    #[sqlx(rename = "Name")]
    pub name: String,
    #[sqlx(rename = "MatchID")]
    pub id: u64,
    #[sqlx(rename = "ScoreA")]
    pub score_a: u64,
    #[sqlx(rename = "ScoreB")]
    pub score_b: u64,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct PredictionSubmission {
    pub id: u64,
    pub score_a: u64,
    pub score_b: u64,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct Submission {
    pub name: Option<String>,
    #[serde(default)]
    pub predictions: Vec<PredictionSubmission>,
    #[serde(default)]
    pub standings: Vec<StandingPredictionSubmission>,
}

#[derive(Serialize, Debug, FromRow)]
pub struct StandingPrediction {
    #[sqlx(rename = "Name")]
    pub name: String,
    #[sqlx(rename = "GroupID")]
    pub group_id: u64,
    #[sqlx(rename = "Position")]
    pub position: u64,
    #[sqlx(rename = "TeamID")]
    pub team_id: u64,
}

/// One of the user's own standing picks, with the names the me page shows.
#[derive(Serialize, Debug, FromRow)]
pub struct UserStandingPrediction {
    #[sqlx(rename = "GroupID")]
    pub group_id: u64,
    #[sqlx(rename = "Position")]
    pub position: u64,
    #[sqlx(rename = "TeamID")]
    pub team_id: u64,
    #[sqlx(rename = "Team")]
    pub team: String,
    #[sqlx(rename = "ShortName")]
    pub short_name: Option<String>,
    #[sqlx(rename = "Logo")]
    pub logo: String,
    #[sqlx(rename = "TournamentID")]
    pub tournament_id: u64,
    #[sqlx(rename = "Tournament")]
    pub tournament: String,
    #[sqlx(rename = "StageName")]
    pub stage_name: String,
    #[sqlx(rename = "GroupName")]
    pub group_name: String,
    /// The team's place in the group's standings now; None while it has none.
    #[sqlx(rename = "CurrentPosition")]
    pub current_position: Option<u64>,
    /// Same rule as Standing::open: the group still takes picks.
    #[sqlx(rename = "Open")]
    pub open: bool,
}

#[derive(Serialize, Debug)]
pub struct UserPredictions {
    pub matches: Vec<Prediction>,
    pub standings: Vec<UserStandingPrediction>,
}

/// A user's top N for one group (N is the stage's PickCount): `teams[0]` is the predicted 1st place, and so on.
/// Replaces the user's previous prediction for that group; an empty list clears it.
#[derive(Deserialize, Serialize, Debug)]
pub struct StandingPredictionSubmission {
    pub group_id: u64,
    pub teams: Vec<u64>,
}

#[derive(Serialize, Debug)]
pub struct Token {
    pub token: String,
}

#[derive(Deserialize, Debug)]
pub struct Login {
    pub name: String,
    pub password: String,
}

#[derive(Deserialize, Debug)]
pub struct Password {
    pub password: String,
}

#[derive(Serialize, Deserialize)]
pub struct ProxyQuery {
    pub url: String,
}

#[derive(Serialize, Deserialize, FromRow)]
pub struct Bracket {
    #[sqlx(rename = "TournamentID")]
    pub tournament_id: u64,
    #[sqlx(rename = "Stage")]
    pub stage: String,
    #[sqlx(rename = "Group")]
    pub group: String,
}

#[derive(Serialize, Deserialize)]
pub struct Matches {
    pub ids: String,
}

impl Matches {
    pub fn get_ids(&self) -> Result<Vec<u32>, warp::Rejection> {
        let ids: Result<Vec<u32>, <u32 as FromStr>::Err> =
            self.ids.split(",").map(|id| id.parse::<u32>()).collect();
        ids.map_err(|_| warp::reject::reject())
    }
}
