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

pub async fn get_matches(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    tournament_id: u32,
) -> sqlx::Result<Vec<Match>> {
    let match_query = sqlx::query(
        "SELECT MatchID, TournamentID, TeamA, TeamB, LogoA, LogoB, ScoreA, ScoreB, ToornamentId, StageType,\
                     StageNumber, StageName, GroupName, RoundName FROM matches WHERE TournamentID = ?",
    )
        .bind(tournament_id)
        .fetch(conn.deref_mut());

    fetch_matches(match_query).await
}

pub async fn get_matches_filter(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    ids: Vec<u32>,
) -> sqlx::Result<Vec<Match>> {
    let mut qb = QueryBuilder::new(
        "SELECT MatchID, TournamentID, TeamA, TeamB, LogoA, LogoB, ScoreA, ScoreB, ToornamentId, StageType,\
                     StageNumber, StageName, GroupName, RoundName FROM matches",
    );
    if !ids.is_empty() {
        qb.push(" WHERE MatchID IN (");
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

pub async fn get_bracket_nodes(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    stage: String,
    group: String,
) -> sqlx::Result<Vec<BracketNode>> {
    let mut bracket_query = sqlx::query(
        "SELECT NodeId, StageId, StageName, StageNumber, StageType, GroupName, Branch,
                                 RoundNumber, Position, Depth, TeamA, TeamB, LogoA, LogoB, ScoreA,
                                 ScoreB, SourceTypeA, SourceA, SourceTypeB, SourceB, MatchID
                          FROM bracket_nodes WHERE StageName = ? AND GroupName = ?",
    )
    .bind(stage)
    .bind(group)
    .fetch(conn.deref_mut());

    let mut matches = Vec::new();

    while let Some(row) = bracket_query.try_next().await? {
        let node_id: String = row.try_get("NodeId")?;
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
) -> sqlx::Result<Vec<Bracket>> {
    let mut bracket_query = sqlx::query("SELECT DISTINCT StageName, GroupName FROM bracket_nodes")
        .fetch(conn.deref_mut());

    let mut matches = Vec::new();

    while let Some(row) = bracket_query.try_next().await? {
        let stage: String = row.try_get("StageName")?;
        let group: String = row.try_get("GroupName")?;

        matches.push(Bracket { stage, group });
    }

    Ok(matches)
}
