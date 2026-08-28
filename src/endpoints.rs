// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::account::{
    create_account, delete_account, delete_session, exists_account, login_account, set_password,
    verify_session,
};
use crate::error::{AccessDenied, AccountExists, BadRequest, InternalError};
use crate::loader::Refresher;
use crate::matches::{
    get_bracket_nodes, get_brackets, get_matches, get_matches_filter, get_tournaments,
};
use crate::predictions::{
    get_predictions, get_user_match_predictions, get_user_predictions, submit_prediction,
    update_prediction,
};
use crate::structures::*;

use log::debug;
use sqlx::SqliteConnection;
use std::sync::Arc;
use tokio::sync::Mutex;

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

pub async fn matches(
    tournament_id: u32,
    conn: Arc<Mutex<SqliteConnection>>,
    refresher: Arc<Refresher>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let refreshing = refresher.refresh(tournament_id).await;

    let mut conn_lock = conn.lock().await;

    let matches = get_matches(&mut conn_lock, tournament_id)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::with_header(
        warp::reply::json(&matches),
        "X-Refreshing",
        if refreshing { "1" } else { "0" },
    ))
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
