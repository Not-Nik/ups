// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::structures::{Bracket, BracketNode, Match, Tournament};
use futures_util::stream::BoxStream;
use futures_util::TryStreamExt;
use sqlx::sqlite::SqliteRow;
use sqlx::{QueryBuilder, Row, SqliteConnection};
use std::ops::DerefMut;
use tokio::sync::MutexGuard;

// A match joined back to its team, group, stage and round names, in the column
// names the Match struct has always been read from.
const MATCH_SELECT: &str = "SELECT m.MatchID, m.TournamentID, ta.Name AS TeamA, tb.Name AS TeamB, \
     ta.Logo AS LogoA, tb.Logo AS LogoB, m.ScoreA, m.ScoreB, m.ToornamentId, s.Type AS StageType, \
     s.Number AS StageNumber, COALESCE(s.Name, '') AS StageName, COALESCE(g.Name, '') AS GroupName, \
     COALESCE(r.Name, '') AS RoundName \
     FROM matches m \
     JOIN teams ta ON ta.TeamID = m.TeamA \
     JOIN teams tb ON tb.TeamID = m.TeamB \
     LEFT JOIN groups g ON g.GroupID = m.GroupID \
     LEFT JOIN stages s ON s.StageID = g.StageID \
     LEFT JOIN rounds r ON r.RoundID = m.RoundID";

pub async fn get_tournaments(
    conn: &mut MutexGuard<'_, SqliteConnection>,
) -> sqlx::Result<Vec<Tournament>> {
    let mut tournament_query =
        sqlx::query("SELECT TournamentID, Name, ToornamentId FROM tournaments")
            .fetch(conn.deref_mut());

    let mut tournaments = Vec::new();

    while let Some(row) = tournament_query.try_next().await? {
        // map the row into a user-defined domain type
        let tournament_id: u64 = row.try_get("TournamentID")?;
        let name: String = row.try_get("Name")?;
        let toornament_id: Option<String> = row.try_get("ToornamentId")?;

        tournaments.push(Tournament {
            tournament_id,
            name,
            toornament_id,
        });
    }

    Ok(tournaments)
}

pub async fn add_tournament(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    tournament: Tournament,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO tournaments (name, tournament) VALUES (?, ?)")
        .bind(tournament.name)
        .bind(tournament.toornament_id)
        .execute(conn.deref_mut())
        .await?;

    Ok(())
}

pub async fn get_matches(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    tournament_id: u32,
) -> sqlx::Result<Vec<Match>> {
    let sql = format!("{MATCH_SELECT} WHERE m.TournamentID = ?");
    let match_query = sqlx::query(&sql)
        .bind(tournament_id)
        .fetch(conn.deref_mut());

    fetch_matches(match_query).await
}

pub async fn get_matches_filter(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    ids: Vec<u32>,
) -> sqlx::Result<Vec<Match>> {
    let mut qb = QueryBuilder::new(MATCH_SELECT);
    if !ids.is_empty() {
        qb.push(" WHERE m.MatchID IN (");
        for (idx, id) in ids.iter().enumerate() {
            if idx > 0 {
                qb.push(", ");
            }
            qb.push_bind(id);
        }
        qb.push(")");
    }
    let match_query = qb.build().fetch(conn.deref_mut());

    fetch_matches(match_query).await
}

pub async fn fetch_matches(
    mut match_query: BoxStream<'_, sqlx::Result<SqliteRow>>,
) -> sqlx::Result<Vec<Match>> {
    let mut matches = Vec::new();

    while let Some(row) = match_query.try_next().await? {
        // map the row into a user-defined domain type
        let id: u64 = row.try_get("MatchID")?;
        let tournament_id: u64 = row.try_get("TournamentID")?;
        let team_a: String = row.try_get("TeamA")?;
        let team_b: String = row.try_get("TeamB")?;
        let logo_a: String = row.try_get("LogoA")?;
        let logo_b: String = row.try_get("LogoB")?;
        let score_a: Option<u64> = row.try_get("ScoreA")?;
        let score_b: Option<u64> = row.try_get("ScoreB")?;
        let toornament_id: Option<String> = row.try_get("ToornamentId")?;
        let stage_type: Option<String> = row.try_get("StageType")?;
        let stage_number: Option<u64> = row.try_get("StageNumber")?;
        let stage_name: String = row.try_get("StageName")?;
        let group_name: String = row.try_get("GroupName")?;
        let round_name: String = row.try_get("RoundName")?;

        matches.push(Match {
            id,
            tournament_id,
            team_a,
            team_b,
            logo_a,
            logo_b,
            score_a,
            score_b,
            toornament_id,
            stage_type,
            stage_number,
            stage_name,
            group_name,
            round_name,
        });
    }

    Ok(matches)
}

/// The team with this name, preferring one that exists on toornament over a manual one.
pub async fn get_team_id(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    name: &str,
) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar(
        "SELECT TeamID FROM teams WHERE TournamentID = ? AND Name = ? \
         ORDER BY ToornamentId IS NULL LIMIT 1",
    )
    .bind(tournament_id)
    .bind(name)
    .fetch_optional(conn)
    .await
}

pub async fn add_team(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    name: &str,
    logo: &str,
) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "INSERT INTO teams (TournamentID, Name, Logo) VALUES (?, ?, ?) RETURNING TeamID",
    )
    .bind(tournament_id)
    .bind(name)
    .bind(logo)
    .fetch_one(conn)
    .await
}

pub async fn get_stage_id(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    name: &str,
) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT StageID FROM stages WHERE TournamentID = ? AND Name = ?")
        .bind(tournament_id)
        .bind(name)
        .fetch_optional(conn)
        .await
}

/// Insert a stage numbered after the tournament's last one.
pub async fn add_stage(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    name: &str,
    kind: &str,
) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "INSERT INTO stages (TournamentID, Number, Name, Type) \
         SELECT ?, COALESCE(MAX(Number), 0) + 1, ?, ? FROM stages WHERE TournamentID = ? \
         RETURNING StageID",
    )
    .bind(tournament_id)
    .bind(name)
    .bind(kind)
    .bind(tournament_id)
    .fetch_one(conn)
    .await
}

pub async fn get_group_id(
    conn: &mut SqliteConnection,
    stage_id: i64,
    name: &str,
) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT GroupID FROM groups WHERE StageID = ? AND Name = ?")
        .bind(stage_id)
        .bind(name)
        .fetch_optional(conn)
        .await
}

/// Insert a group numbered after the stage's last one.
pub async fn add_group(
    conn: &mut SqliteConnection,
    stage_id: i64,
    name: &str,
) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "INSERT INTO groups (StageID, Number, Name) \
         SELECT ?, COALESCE(MAX(Number), 0) + 1, ? FROM groups WHERE StageID = ? \
         RETURNING GroupID",
    )
    .bind(stage_id)
    .bind(name)
    .bind(stage_id)
    .fetch_one(conn)
    .await
}

pub async fn get_round_id(
    conn: &mut SqliteConnection,
    group_id: i64,
    name: &str,
) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT RoundID FROM rounds WHERE GroupID = ? AND Name = ?")
        .bind(group_id)
        .bind(name)
        .fetch_optional(conn)
        .await
}

/// Insert a round numbered after the group's last one.
pub async fn add_round(
    conn: &mut SqliteConnection,
    group_id: i64,
    name: &str,
) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "INSERT INTO rounds (GroupID, Number, Name) \
         SELECT ?, COALESCE(MAX(Number), 0) + 1, ? FROM rounds WHERE GroupID = ? \
         RETURNING RoundID",
    )
    .bind(group_id)
    .bind(name)
    .bind(group_id)
    .fetch_one(conn)
    .await
}

pub async fn add_match(
    conn: &mut SqliteConnection,
    tournament_id: i64,
    group_id: Option<i64>,
    round_id: Option<i64>,
    team_a: i64,
    team_b: i64,
    match_: Match,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO matches (TournamentID, GroupID, RoundID, TeamA, TeamB, ScoreA, ScoreB, \
         ToornamentId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(tournament_id)
    .bind(group_id)
    .bind(round_id)
    .bind(team_a)
    .bind(team_b)
    .bind(match_.score_a.map(|a| a as u32))
    .bind(match_.score_b.map(|a| a as u32))
    .bind(match_.toornament_id)
    .execute(conn)
    .await?;

    Ok(())
}

pub async fn get_bracket_nodes(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    tournament_id: u32,
    stage: String,
    group: String,
) -> sqlx::Result<Vec<BracketNode>> {
    let mut bracket_query = sqlx::query(
        "SELECT b.NodeId, b.TournamentID, COALESCE(s.ToornamentId, '') AS StageId,
                s.Name AS StageName, s.Number AS StageNumber, s.Type AS StageType,
                g.Name AS GroupName, b.Branch, r.Number AS RoundNumber, b.Position, b.Depth,
                ta.Name AS TeamA, tb.Name AS TeamB, ta.Logo AS LogoA, tb.Logo AS LogoB, b.ScoreA,
                b.ScoreB, b.SourceTypeA, b.SourceA, b.SourceTypeB, b.SourceB, b.MatchID
         FROM bracket_nodes b
                  JOIN groups g ON g.GroupID = b.GroupID
                  JOIN stages s ON s.StageID = g.StageID
                  JOIN rounds r ON r.RoundID = b.RoundID
                  LEFT JOIN teams ta ON ta.TeamID = b.TeamA
                  LEFT JOIN teams tb ON tb.TeamID = b.TeamB
         WHERE b.TournamentID = ? AND s.Name = ? AND g.Name = ?",
    )
    .bind(tournament_id)
    .bind(stage)
    .bind(group)
    .fetch(conn.deref_mut());

    let mut matches = Vec::new();

    while let Some(row) = bracket_query.try_next().await? {
        let node_id: String = row.try_get("NodeId")?;
        let tournament_id: u32 = row.try_get("TournamentID")?;
        let stage_id: String = row.try_get("StageId")?;
        let stage_name: String = row.try_get("StageName")?;
        let stage_number: u64 = row.try_get("StageNumber")?;
        let stage_type: String = row.try_get("StageType")?;
        let group_name: String = row.try_get("GroupName")?;
        let branch: Option<String> = row.try_get("Branch")?;
        let round_number: u64 = row.try_get("RoundNumber")?;
        let position: u64 = row.try_get("Position")?;
        let depth: u64 = row.try_get("Depth")?;
        let team_a: Option<String> = row.try_get("TeamA")?;
        let team_b: Option<String> = row.try_get("TeamB")?;
        let logo_a: Option<String> = row.try_get("LogoA")?;
        let logo_b: Option<String> = row.try_get("LogoB")?;
        let score_a: Option<u64> = row.try_get("ScoreA")?;
        let score_b: Option<u64> = row.try_get("ScoreB")?;
        let source_type_a: Option<String> = row.try_get("SourceTypeA")?;
        let source_a: Option<String> = row.try_get("SourceA")?;
        let source_type_b: Option<String> = row.try_get("SourceTypeB")?;
        let source_b: Option<String> = row.try_get("SourceB")?;
        let match_id: Option<u64> = row.try_get("MatchID")?;

        matches.push(BracketNode {
            node_id,
            tournament_id,
            stage_id,
            stage_name,
            stage_number,
            stage_type,
            group_name,
            branch,
            round_number,
            position,
            depth,
            team_a,
            team_b,
            logo_a,
            logo_b,
            score_a,
            score_b,
            source_type_a,
            source_a,
            source_type_b,
            source_b,
            match_id,
        });
    }

    Ok(matches)
}

pub async fn get_brackets(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    tournament_id: u32,
) -> sqlx::Result<Vec<Bracket>> {
    let mut bracket_query = sqlx::query(
        "SELECT DISTINCT s.Name AS StageName, g.Name AS GroupName
         FROM bracket_nodes b
                  JOIN groups g ON g.GroupID = b.GroupID
                  JOIN stages s ON s.StageID = g.StageID
         WHERE b.TournamentID = ?",
    )
    .bind(tournament_id)
    .fetch(conn.deref_mut());

    let mut matches = Vec::new();

    while let Some(row) = bracket_query.try_next().await? {
        let stage: String = row.try_get("StageName")?;
        let group: String = row.try_get("GroupName")?;

        matches.push(Bracket {
            tournament_id: tournament_id as u64,
            stage,
            group,
        });
    }

    Ok(matches)
}
