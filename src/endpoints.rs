// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
use crate::account::{
    create_account, delete_account, delete_session, exists_account, is_admin, login_account,
    set_password, verify_session,
};
use crate::error::{AccessDenied, AccountExists, BadRequest, InternalError};
use crate::loader::{Refresher, BRACKET_TYPES};
use crate::matches::{
    add_group, add_round, add_stage, add_team, add_tournament, get_bracket_nodes, get_brackets,
    get_group_id, get_matches, get_matches_filter, get_round_id, get_stage_id, get_team_id,
    get_tournaments,
};
use crate::predictions::{
    get_predictions, get_user_match_predictions, get_user_predictions, submit_prediction,
    update_prediction,
};
use crate::structures::*;

use crate::matches;
use log::debug;
use sqlx::{Connection, SqliteConnection};
use std::sync::Arc;
use tokio::sync::{Mutex, MutexGuard};

async fn verify_admin(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    auth: String,
) -> Result<(), warp::Rejection> {
    let name = verify_session(conn, auth.strip_prefix("Bearer ").ok_or(BadRequest)?)
        .await
        .map_err(|_| warp::reject::not_found())?;

    let Some(name) = name else {
        Err(warp::reject::not_found())?
    };

    if !is_admin(conn, &name)
        .await
        .map_err(|_| warp::reject::not_found())?
    {
        Err(warp::reject::not_found())?
    } else {
        Ok(())
    }
}

pub async fn me(
    auth: String,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let name = verify_session(
        &mut conn_lock,
        auth.strip_prefix("Bearer ").ok_or(BadRequest)?,
    )
    .await
    .map_err(|_| warp::reject::custom(InternalError))?;
    let Some(name) = name else {
        Err(warp::reject::custom(AccessDenied))?
    };

    Ok(warp::reply::json(&User { name }))
}

pub async fn tournaments(
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let matches = get_tournaments(&mut conn_lock)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::json(&matches))
}

pub async fn tournament(
    conn: Arc<Mutex<SqliteConnection>>,
    auth: String,
    tournament: Tournament,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    verify_admin(&mut conn_lock, auth.clone()).await?;

    add_tournament(&mut conn_lock, tournament)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply())
}

pub async fn matches(
    tournament_id: u32,
    conn: Arc<Mutex<SqliteConnection>>,
    refresher: Arc<Refresher>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let refreshing = refresher.refresh(tournament_id).await;

    let mut conn_lock = conn.lock().await;

    let mut matches = get_matches(&mut conn_lock, tournament_id)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;
    matches.iter_mut().for_each(show_day_names);

    Ok(warp::reply::with_header(
        warp::reply::json(&matches),
        "X-Refreshing",
        if refreshing { "1" } else { "0" },
    ))
}

pub async fn match_(
    conn: Arc<Mutex<SqliteConnection>>,
    matches: Matches,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let mut matches = get_matches_filter(&mut conn_lock, matches.get_ids()?)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;
    matches.iter_mut().for_each(show_day_names);

    Ok(warp::reply::json(&matches))
}

/// League/swiss matchdays read nicer as "Day N"; leave bracket round names ("Round 1",
/// "WB Round 1", …) alone so a bracket match never collides with a league day tab.
fn show_day_names(match_: &mut Match) {
    if match_
        .stage_type
        .as_deref()
        .is_some_and(|kind| BRACKET_TYPES.contains(&kind))
    {
        return;
    }
    if let Some(rest) = match_.round_name.strip_prefix("Round") {
        match_.round_name = format!("Day{rest}");
    }
}

/// Store a manual match. Teams, stage, group and round are referenced by name and
/// created (without a ToornamentId) when the tournament doesn't have them yet.
async fn store_match(conn: &mut SqliteConnection, match_: Match) -> sqlx::Result<()> {
    let tournament_id = match_.tournament_id as i64;
    let mut tx = conn.begin().await?;

    let (name_a, name_b) = (match_.team_a.trim(), match_.team_b.trim());
    let team_a = match get_team_id(&mut tx, tournament_id, name_a).await? {
        Some(id) => id,
        None => add_team(&mut tx, tournament_id, name_a, &match_.logo_a).await?,
    };
    let team_b = match get_team_id(&mut tx, tournament_id, name_b).await? {
        Some(id) => id,
        None => add_team(&mut tx, tournament_id, name_b, &match_.logo_b).await?,
    };

    let (mut group_id, mut round_id) = (None, None);
    if !match_.stage_name.is_empty() {
        let stage_id = match get_stage_id(&mut tx, tournament_id, &match_.stage_name).await? {
            Some(id) => id,
            None => {
                let kind = match_.stage_type.as_deref().unwrap_or("custom");
                add_stage(&mut tx, tournament_id, &match_.stage_name, kind).await?
            }
        };
        let group = match get_group_id(&mut tx, stage_id, &match_.group_name).await? {
            Some(id) => id,
            None => add_group(&mut tx, stage_id, &match_.group_name).await?,
        };
        group_id = Some(group);

        if !match_.round_name.is_empty() {
            // The site shows league/swiss "Round N" as "Day N"; accept either spelling.
            let mut round = get_round_id(&mut tx, group, &match_.round_name).await?;
            if let (None, Some(rest)) = (round, match_.round_name.strip_prefix("Day")) {
                round = get_round_id(&mut tx, group, &format!("Round{rest}")).await?;
            }
            round_id = Some(match round {
                Some(id) => id,
                None => add_round(&mut tx, group, &match_.round_name).await?,
            });
        }
    }

    matches::add_match(&mut tx, tournament_id, group_id, round_id, team_a, team_b, match_).await?;
    tx.commit().await
}

pub async fn add_match(
    conn: Arc<Mutex<SqliteConnection>>,
    auth: String,
    match_: Match,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    verify_admin(&mut conn_lock, auth.clone()).await?;

    store_match(&mut conn_lock, match_)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply())
}

pub async fn bracket(
    conn: Arc<Mutex<SqliteConnection>>,
    query: Bracket,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let matches = get_bracket_nodes(
        &mut conn_lock,
        query.tournament_id as u32,
        query.stage,
        query.group,
    )
    .await
    .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::json(&matches))
}

pub async fn brackets(
    tournament_id: u32,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let matches = get_brackets(&mut conn_lock, tournament_id)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::json(&matches))
}

pub async fn prediction(
    id: u32,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let predictions = get_predictions(&mut conn_lock, vec![id])
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::json(&predictions))
}

pub async fn predictions(
    ids: Vec<u32>,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let predictions = get_predictions(&mut conn_lock, ids)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::json(&predictions))
}

pub async fn user_predictions(
    auth: String,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let name = verify_session(
        &mut conn_lock,
        auth.strip_prefix("Bearer ").ok_or(BadRequest)?,
    )
    .await
    .map_err(|_| warp::reject::custom(InternalError))?;
    let Some(name) = name else {
        Err(warp::reject::custom(AccessDenied))?
    };

    let predictions = get_user_predictions(&mut conn_lock, &name)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::json(&predictions))
}

pub async fn submit(
    submission: Submission,
    auth: Option<String>,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    debug!("Submission: {:#?}", submission);
    let mut conn_lock = conn.lock().await;

    let (name, token) = if let Some(auth) = auth {
        let token = auth.strip_prefix("Bearer ").ok_or(BadRequest)?;
        let name = verify_session(&mut conn_lock, token)
            .await
            .map_err(|_| warp::reject::custom(InternalError))?;
        let Some(name) = name else {
            Err(warp::reject::custom(AccessDenied))?
        };

        (name, token.to_string())
    } else if let Some(name) = submission.name {
        if exists_account(&mut conn_lock, &name).await.unwrap_or(false) == true {
            Err(warp::reject::custom(AccountExists))?
        }
        let Some(token) = create_account(&mut conn_lock, &name)
            .await
            .map_err(|_| warp::reject::custom(InternalError))?
        else {
            return Err(warp::reject::custom(BadRequest))?;
        };

        (name, token)
    } else {
        Err(warp::reject::custom(BadRequest))?
    };

    let matches = get_matches_filter(
        &mut conn_lock,
        submission
            .predictions
            .iter()
            .map(|pred| pred.id as u32)
            .collect(),
    )
    .await
    .map_err(|_| warp::reject::custom(InternalError))?;

    for (pred, mat) in submission.predictions.iter().zip(matches) {
        if mat.score_a.is_some() || mat.score_b.is_some() {
            continue;
        }
        if get_user_match_predictions(&mut conn_lock, &name, pred.id as u32)
            .await
            .map_err(|_| warp::reject::custom(InternalError))?
            .len()
            > 0
        {
            update_prediction(
                &mut conn_lock,
                &name,
                pred.id as u32,
                pred.score_a as u32,
                pred.score_b as u32,
            )
            .await
            .map_err(|_| warp::reject::custom(InternalError))?;
        } else {
            submit_prediction(
                &mut conn_lock,
                &name,
                pred.id as u32,
                pred.score_a as u32,
                pred.score_b as u32,
            )
            .await
            .map_err(|_| warp::reject::custom(InternalError))?;
        }
    }

    Ok(warp::reply::json(&Token { token }))
}

pub async fn delete(
    auth: String,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let name = verify_session(
        &mut conn_lock,
        auth.strip_prefix("Bearer ").ok_or(BadRequest)?,
    )
    .await
    .map_err(|_| warp::reject::custom(InternalError))?;
    let Some(name) = name else {
        Err(warp::reject::custom(AccessDenied))?
    };

    delete_account(&mut conn_lock, &name)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::reply())
}

pub async fn login(
    login: Login,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let Some(token) = login_account(&mut conn_lock, &login.name, &login.password)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?
    else {
        Err(warp::reject::custom(AccessDenied))?
    };

    Ok(warp::reply::json(&Token { token }))
}

pub async fn logout(
    auth: String,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let token = auth.strip_prefix("Bearer ").ok_or(BadRequest)?;

    let name = verify_session(&mut conn_lock, token)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;
    let Some(_) = name else {
        Err(warp::reject::custom(AccessDenied))?
    };

    delete_session(&mut conn_lock, token)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::reply())
}

pub async fn password(
    auth: String,
    password: Password,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let name = verify_session(
        &mut conn_lock,
        auth.strip_prefix("Bearer ").ok_or(BadRequest)?,
    )
    .await
    .map_err(|_| warp::reject::custom(InternalError))?;
    let Some(name) = name else {
        Err(warp::reject::custom(AccessDenied))?
    };

    set_password(&mut conn_lock, &name, &password.password)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::reply())
}

pub async fn proxy(query: ProxyQuery) -> Result<impl warp::Reply, warp::Rejection> {
    if !query
        .url
        .starts_with("https://play.toornament.com/media/file")
    {
        return Err(warp::reject::custom(AccessDenied))?;
    }

    let response = reqwest::get(query.url)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    let status = response.status();
    let body = response.bytes().await.map_err(|_| warp::reject::reject())?;

    Ok(warp::reply::with_status(
        warp::reply::Response::new(body.into()),
        status,
    ))
}
