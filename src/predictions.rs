// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::structures::{Bracket, BracketNode, Match, Prediction};
use futures_util::TryStreamExt;
use sqlx::{QueryBuilder, Row, SqliteConnection};
use std::ops::DerefMut;
use tokio::sync::MutexGuard;

pub async fn get_matches(conn: &mut MutexGuard<'_, SqliteConnection>) -> sqlx::Result<Vec<Match>> {
    get_matches_filter(conn, vec![]).await
}

pub async fn get_matches_filter(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    ids: Vec<u32>,
) -> sqlx::Result<Vec<Match>> {
    let mut qb = QueryBuilder::new(
        "SELECT MatchID, TeamA, TeamB, LogoA, LogoB, ScoreA, ScoreB, ToornamentId, StageType,\
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
    let mut match_query = qb.build().fetch(conn.deref_mut());

    let mut matches = Vec::new();

    while let Some(row) = match_query.try_next().await? {
        // map the row into a user-defined domain type
        let id: u64 = row.try_get("MatchID")?;
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

pub async fn get_predictions(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    ids: Vec<u32>,
) -> sqlx::Result<Vec<Prediction>> {
    let mut qb = QueryBuilder::new(
        "SELECT Name, MatchID, ScoreA, ScoreB FROM predictions WHERE MatchID IN (",
    );
    for (idx, id) in ids.iter().enumerate() {
        if idx > 0 {
            qb.push(", ");
        }
        qb.push_bind(id);
    }
    qb.push(")");
    let mut pred_query = qb.build().fetch(conn.deref_mut());

    let mut predictions = Vec::new();

    while let Some(row) = pred_query.try_next().await? {
        // map the row into a user-defined domain type
        let name: String = row.try_get("Name")?;
        let id: u64 = row.try_get("MatchID")?;
        let score_a: u64 = row.try_get("ScoreA")?;
        let score_b: u64 = row.try_get("ScoreB")?;

        predictions.push(Prediction {
            name,
            id,
            score_a,
            score_b,
        });
    }

    Ok(predictions)
}

pub async fn get_user_predictions(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<Vec<Prediction>> {
    let mut pred_query =
        sqlx::query("SELECT MatchID, ScoreA, ScoreB FROM predictions WHERE Name = ?")
            .bind(name)
            .fetch(conn.deref_mut());

    let mut predictions = Vec::new();

    while let Some(row) = pred_query.try_next().await? {
        // map the row into a user-defined domain type
        let id: u64 = row.try_get("MatchID")?;
        let score_a: u64 = row.try_get("ScoreA")?;
        let score_b: u64 = row.try_get("ScoreB")?;

        predictions.push(Prediction {
            name: name.clone(),
            id,
            score_a,
            score_b,
        });
    }

    Ok(predictions)
}

pub async fn get_user_match_predictions(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
    id: u32,
) -> sqlx::Result<Vec<Prediction>> {
    let mut pred_query =
        sqlx::query("SELECT ScoreA, ScoreB FROM predictions WHERE Name = ? AND MatchID = ?")
            .bind(name)
            .bind(id)
            .fetch(conn.deref_mut());

    let mut predictions = Vec::new();

    while let Some(row) = pred_query.try_next().await? {
        // map the row into a user-defined domain type
        let score_a: u64 = row.try_get("ScoreA")?;
        let score_b: u64 = row.try_get("ScoreB")?;

        predictions.push(Prediction {
            name: name.clone(),
            id: id as u64,
            score_a,
            score_b,
        });
    }

    Ok(predictions)
}

pub async fn submit_prediction(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
    id: u32,
    score_a: u32,
    score_b: u32,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO predictions (Name, MatchID, ScoreA, ScoreB) VALUES (?, ?, ?, ?)")
        .bind(name)
        .bind(id)
        .bind(score_a)
        .bind(score_b)
        .execute(conn.deref_mut())
        .await
        .map(|_| ())
}

pub async fn update_prediction(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
    id: u32,
    score_a: u32,
    score_b: u32,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE predictions SET ScoreA = ?, ScoreB = ? WHERE Name = ? AND MatchID = ?")
        .bind(score_a)
        .bind(score_b)
        .bind(name)
        .bind(id)
        .execute(conn.deref_mut())
        .await
        .map(|_| ())
}
