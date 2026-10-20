// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::structures::{Prediction, StandingPrediction, UserPredictions, UserStandingPrediction};
use futures_util::TryStreamExt;
use sqlx::{Connection, QueryBuilder, SqliteConnection};
use std::ops::DerefMut;
use tokio::sync::MutexGuard;

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
    let mut pred_query = qb.build_query_as::<Prediction>().fetch(conn.deref_mut());

    let mut predictions = Vec::new();

    while let Some(pred) = pred_query.try_next().await? {
        predictions.push(pred);
    }

    Ok(predictions)
}

pub async fn get_user_predictions(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<UserPredictions> {
    let mut pred_query = sqlx::query_as::<_, Prediction>(
        "SELECT Name, MatchID, ScoreA, ScoreB FROM predictions WHERE Name = ?",
    )
    .bind(name)
    .fetch(conn.deref_mut());

    let mut matches = Vec::new();

    while let Some(pred) = pred_query.try_next().await? {
        matches.push(pred);
    }
    drop(pred_query);

    let mut standing_query = sqlx::query_as::<_, UserStandingPrediction>(
        "SELECT p.GroupID, p.Position, p.TeamID, t.Name AS Team, t.ShortName, t.Logo,
                tr.TournamentID, tr.Name AS Tournament, s.Name AS StageName,
                g.Name AS GroupName, st.Position AS CurrentPosition,
                s.ForceOpen OR NOT EXISTS (SELECT 1 FROM matches m
                            WHERE m.GroupID = g.GroupID
                              AND (m.ScoreA IS NOT NULL OR m.ScoreB IS NOT NULL)) AS Open
         FROM standing_predictions p
                  JOIN groups g ON g.GroupID = p.GroupID
                  JOIN stages s ON s.StageID = g.StageID
                  JOIN tournaments tr ON tr.TournamentID = s.TournamentID
                  JOIN teams t ON t.TeamID = p.TeamID
                  LEFT JOIN standings st ON st.GroupID = p.GroupID AND st.TeamID = p.TeamID
         WHERE p.Name = ?
         ORDER BY p.GroupID, p.Position",
    )
    .bind(name)
    .fetch(conn.deref_mut());

    let mut standings = Vec::new();

    while let Some(pred) = standing_query.try_next().await? {
        standings.push(pred);
    }

    Ok(UserPredictions { matches, standings })
}

/// Replace a user's prediction for one match.
pub async fn set_prediction(
    conn: &mut SqliteConnection,
    name: &String,
    id: u32,
    score_a: u32,
    score_b: u32,
) -> sqlx::Result<()> {
    let mut tx = conn.begin().await?;

    sqlx::query("DELETE FROM predictions WHERE Name = ? AND MatchID = ?")
        .bind(name)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("INSERT INTO predictions (Name, MatchID, ScoreA, ScoreB) VALUES (?, ?, ?, ?)")
        .bind(name)
        .bind(id)
        .bind(score_a)
        .bind(score_b)
        .execute(&mut *tx)
        .await?;

    tx.commit().await
}

pub async fn get_standing_predictions(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    tournament_id: u32,
) -> sqlx::Result<Vec<StandingPrediction>> {
    let mut pred_query = sqlx::query_as::<_, StandingPrediction>(
        "SELECT p.Name, p.GroupID, p.Position, p.TeamID
         FROM standing_predictions p
                  JOIN groups g ON g.GroupID = p.GroupID
                  JOIN stages s ON s.StageID = g.StageID
         WHERE s.TournamentID = ?
         ORDER BY p.Name, p.GroupID, p.Position",
    )
    .bind(tournament_id)
    .fetch(conn.deref_mut());

    let mut predictions = Vec::new();

    while let Some(pred) = pred_query.try_next().await? {
        predictions.push(pred);
    }

    Ok(predictions)
}

/// Whether a group still takes standing predictions (none of its matches has a score, or
/// its stage is forced open) and how many places its stage lets users predict. `None` when
/// the group doesn't exist.
pub async fn get_group_picking(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    group_id: u64,
) -> sqlx::Result<Option<(bool, i64)>> {
    sqlx::query_as(
        "SELECT s.ForceOpen OR NOT EXISTS (SELECT 1 FROM matches m
                            WHERE m.GroupID = g.GroupID
                              AND (m.ScoreA IS NOT NULL OR m.ScoreB IS NOT NULL)),
                s.PickCount
         FROM groups g
                  JOIN stages s ON s.StageID = g.StageID
         WHERE g.GroupID = ?",
    )
    .bind(group_id as i64)
    .fetch_optional(conn.deref_mut())
    .await
}

/// How many of `teams` belong to the tournament that `group_id` is part of.
pub async fn count_group_tournament_teams(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    group_id: u64,
    teams: &[u64],
) -> sqlx::Result<i64> {
    let mut qb = QueryBuilder::new(
        "SELECT COUNT(*) FROM teams t
                  JOIN stages s ON s.TournamentID = t.TournamentID
                  JOIN groups g ON g.StageID = s.StageID
         WHERE g.GroupID = ",
    );
    qb.push_bind(group_id as i64);
    qb.push(" AND t.TeamID IN (");
    for (idx, id) in teams.iter().enumerate() {
        if idx > 0 {
            qb.push(", ");
        }
        qb.push_bind(*id as i64);
    }
    qb.push(")");
    qb.build_query_scalar().fetch_one(conn.deref_mut()).await
}

/// Replace a user's prediction for one group; `teams[0]` is position 1.
pub async fn set_standing_prediction(
    conn: &mut SqliteConnection,
    name: &String,
    group_id: u64,
    teams: &[u64],
) -> sqlx::Result<()> {
    let mut tx = conn.begin().await?;

    sqlx::query("DELETE FROM standing_predictions WHERE Name = ? AND GroupID = ?")
        .bind(name)
        .bind(group_id as i64)
        .execute(&mut *tx)
        .await?;

    for (idx, team) in teams.iter().enumerate() {
        sqlx::query(
            "INSERT INTO standing_predictions (Name, GroupID, Position, TeamID) VALUES (?, ?, ?, ?)",
        )
        .bind(name)
        .bind(group_id as i64)
        .bind(idx as i64 + 1)
        .bind(*team as i64)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Mutex;

    /// One league stage per rule: a decided match locks its group, unless the stage is
    /// forced open.
    const SCORED_GROUPS: &str = "INSERT INTO tournaments (TournamentID, Name) VALUES (1, 'T');
        INSERT INTO stages (StageID, TournamentID, Number, Name, Type, ForceOpen)
            VALUES (1, 1, 1, 'Locked', 'league', 0), (2, 1, 2, 'Forced', 'league', 1);
        INSERT INTO groups (GroupID, StageID, Number, Name) VALUES (1, 1, 1, 'A'), (2, 2, 1, 'B');
        INSERT INTO teams (TeamID, TournamentID, Name) VALUES (1, 1, 'X'), (2, 1, 'Y');
        INSERT INTO matches (MatchID, TournamentID, GroupID, TeamA, TeamB, ScoreA, ScoreB)
            VALUES (1, 1, 1, 1, 2, 3, 0), (2, 1, 2, 1, 2, 3, 0);";

    async fn scored_groups() -> Mutex<SqliteConnection> {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("init.sql"))
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(SCORED_GROUPS)
            .execute(&mut conn)
            .await
            .unwrap();
        Mutex::new(conn)
    }

    #[tokio::test]
    async fn only_a_forced_stage_takes_picks_after_a_result() {
        let db = scored_groups().await;
        let mut conn = db.lock().await;

        let locked = get_group_picking(&mut conn, 1).await.unwrap();
        let forced = get_group_picking(&mut conn, 2).await.unwrap();

        assert_eq!((locked.unwrap().0, forced.unwrap().0), (false, true));
    }
}
