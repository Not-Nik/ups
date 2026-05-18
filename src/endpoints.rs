// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::account::{create_account, delete_account, exists_account, verify_session};
use crate::error::{AccessDenied, AccountExists, BadRequest, InternalError};
use crate::structures::*;

use crate::predictions::{get_matches, get_predictions, get_user_predictions, submit_prediction};
use log::debug;
use sqlx::SqliteConnection;
use std::sync::Arc;
use tokio::sync::Mutex;

pub async fn matches(
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let matches = get_matches(&mut conn_lock)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::json(&matches))
}

pub async fn predictions(
    id: u32,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let predictions = get_predictions(&mut conn_lock, id)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::json(&predictions))
}

pub async fn user_predictions(
    token: Token,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let name = verify_session(&mut conn_lock, &token.token)
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
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    debug!("Submission: {:#?}", submission);
    let mut conn_lock = conn.lock().await;

    let (name, token) = if let Some(token) = submission.token {
        let name = verify_session(&mut conn_lock, &token)
            .await
            .map_err(|_| warp::reject::custom(InternalError))?;
        let Some(name) = name else {
            Err(warp::reject::custom(AccessDenied))?
        };

        (name, token)
    } else if let Some(name) = submission.name {
        if exists_account(&mut conn_lock, &name).await.unwrap_or(false) == true {
            Err(warp::reject::custom(AccountExists))?
        }
        let token = create_account(&mut conn_lock, &name)
            .await
            .map_err(|_| warp::reject::custom(InternalError))?;

        (name, token)
    } else {
        Err(warp::reject::custom(BadRequest))?
    };

    for pred in submission.predictions {
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

    Ok(warp::reply::json(&Token { token }))
}

pub async fn delete(
    token: Token,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let name = verify_session(&mut conn_lock, &token.token)
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
