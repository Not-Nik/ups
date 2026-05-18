// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::error::InternalError;
use crate::structures::{Match, Prediction};
use futures_util::TryStreamExt;
use sqlx::{Row, SqliteConnection};
use std::ops::DerefMut;
use tokio::sync::MutexGuard;

pub async fn get_matches(conn: &mut MutexGuard<'_, SqliteConnection>) -> sqlx::Result<Vec<Match>> {
    let mut match_query =
        sqlx::query("SELECT MatchID, TeamA, TeamB, Section FROM matches").fetch(conn.deref_mut());

    let mut matches = Vec::new();

    while let Some(row) = match_query.try_next().await? {
        // map the row into a user-defined domain type
        let id: u64 = row.try_get("MatchID")?;
        let team_a: String = row.try_get("TeamA")?;
        let team_b: String = row.try_get("TeamB")?;
        let section: String = row.try_get("Section")?;

        matches.push(Match {
            id,
            team_a,
            team_b,
            section,
        });
    }

    Ok(matches)
}

pub async fn get_predictions(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    id: u32,
) -> sqlx::Result<Vec<Prediction>> {
    let mut pred_query =
        sqlx::query("SELECT Name, ScoreA, ScoreB FROM prediction WHERE MatchID = ?")
            .bind(id)
            .fetch(conn.deref_mut());

    let mut predictions = Vec::new();

    while let Some(row) = pred_query.try_next().await? {
        // map the row into a user-defined domain type
        let name: String = row.try_get("Name")?;
        let score_a: u64 = row.try_get("ScoreA")?;
        let score_b: u64 = row.try_get("ScoreB")?;

        predictions.push(Prediction {
            name,
            id: id as u64,
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
        sqlx::query("SELECT MatchID, ScoreA, ScoreB FROM prediction WHERE Name = ?")
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

pub async fn submit_prediction(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
    id: u32,
    score_a: u32,
    score_b: u32,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO prediction (Name, MatchID, ScoreA, ScoreB) VALUES (?, ?, ?, ?)")
        .bind(name)
        .bind(id)
        .bind(score_a)
        .bind(score_b)
        .execute(conn.deref_mut())
        .await
        .map(|_| ())
}
