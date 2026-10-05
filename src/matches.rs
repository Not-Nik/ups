// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::structures::{Bracket, BracketNode, Match, Player, Standing, Team, Tournament};
use futures_util::stream::BoxStream;
use futures_util::TryStreamExt;
use sqlx::{QueryBuilder, SqliteConnection};
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
        sqlx::query_as::<_, Tournament>("SELECT TournamentID, Name, ToornamentId FROM tournaments")
            .fetch(conn.deref_mut());

    let mut tournaments = Vec::new();

    while let Some(tour) = tournament_query.try_next().await? {
        tournaments.push(tour);
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
    let match_query = sqlx::query_as::<_, Match>(&sql)
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
    let match_query = qb.build_query_as::<Match>().fetch(conn.deref_mut());

    fetch_matches(match_query).await
}

pub async fn fetch_matches(
    mut match_query: BoxStream<'_, sqlx::Result<Match>>,
) -> sqlx::Result<Vec<Match>> {
    let mut matches = Vec::new();

    while let Some(mat) = match_query.try_next().await? {
        matches.push(mat);
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
    let mut bracket_query = sqlx::query_as::<_, BracketNode>(
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

    while let Some(bq) = bracket_query.try_next().await? {
        matches.push(bq);
    }

    Ok(matches)
}

pub async fn get_brackets(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    tournament_id: u32,
) -> sqlx::Result<Vec<Bracket>> {
    let mut bracket_query = sqlx::query_as::<_, Bracket>(
        "SELECT DISTINCT b.TournamentID, s.Name AS Stage, g.Name AS \"Group\"
         FROM bracket_nodes b
                  JOIN groups g ON g.GroupID = b.GroupID
                  JOIN stages s ON s.StageID = g.StageID
         WHERE b.TournamentID = ?",
    )
    .bind(tournament_id)
    .fetch(conn.deref_mut());

    let mut matches = Vec::new();

    while let Some(brack) = bracket_query.try_next().await? {
        matches.push(brack);
    }

    Ok(matches)
}

pub async fn get_standings(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    tournament_id: u32,
) -> sqlx::Result<Vec<Standing>> {
    let mut standings_query = sqlx::query_as::<_, Standing>(
        "SELECT s.Name AS StageName, s.Number AS StageNumber, s.Type AS StageType,
                g.Name AS GroupName, g.Number AS GroupNumber, st.Position, st.Rank, t.TeamID,
                t.Name AS Team, t.ShortName, t.Logo, st.Points, st.Played, st.Wins, st.Draws,
                st.Losses, st.Forfeits, st.ScoreFor, st.ScoreAgainst,
                st.ScoreFor - st.ScoreAgainst AS ScoreDifference, st.Dropped
         FROM standings st
                  JOIN groups g ON g.GroupID = st.GroupID
                  JOIN stages s ON s.StageID = g.StageID
                  JOIN teams t ON t.TeamID = st.TeamID
         WHERE s.TournamentID = ?
         ORDER BY s.Number, g.Number, st.Position",
    )
    .bind(tournament_id)
    .fetch(conn.deref_mut());

    let mut standings = Vec::new();

    while let Some(stand) = standings_query.try_next().await? {
        standings.push(stand);
    }

    Ok(standings)
}

pub async fn get_teams(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    tournament_id: u32,
) -> sqlx::Result<Vec<Team>> {
    let mut teams_query = sqlx::query_as::<_, Team>(
        "SELECT TeamID, Name, ShortName, Logo, ToornamentId FROM teams WHERE TournamentID = ?
         ORDER BY Name COLLATE NOCASE, TeamID",
    )
    .bind(tournament_id)
    .fetch(conn.deref_mut());

    let mut teams = Vec::new();

    while let Some(team) = teams_query.try_next().await? {
        teams.push(team);
    }

    Ok(teams)
}

pub async fn get_players(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    tournament_id: u32,
) -> sqlx::Result<Vec<Player>> {
    let mut players_query = sqlx::query_as::<_, Player>(
        "SELECT t.TeamID, t.Name AS Team, t.ShortName, t.Logo, p.Position, p.Name, p.BattleTag,
                p.ToornamentUserId
         FROM players p
                  JOIN teams t ON t.TeamID = p.TeamID
         WHERE t.TournamentID = ?
         ORDER BY t.Name COLLATE NOCASE, t.TeamID, p.Position",
    )
    .bind(tournament_id)
    .fetch(conn.deref_mut());

    let mut players = Vec::new();

    while let Some(player) = players_query.try_next().await? {
        players.push(player);
    }

    Ok(players)
}
