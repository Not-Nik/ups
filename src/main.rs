// ups (c) Nikolas Wipper 2024

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

mod account;
mod endpoints;
mod error;
mod predictions;
mod structures;

use crate::error::*;
use serde_derive::Serialize;
use sqlx::{Connection, SqliteConnection};
use std::convert::Infallible;
use std::error::Error;
use std::sync::Arc;
use tokio::sync::Mutex;
use warp::{Filter, Rejection, Reply};

#[derive(Serialize)]
struct ErrorMessage {
    err: String,
}

async fn handle_rejection(err: Rejection) -> Result<impl Reply, Infallible> {
    let code;
    let message;

    if let Some(_) = err.find::<InternalError>() {
        code = warp::http::StatusCode::INTERNAL_SERVER_ERROR;
        message = "InternalServerError";
    } else if let Some(_) = err.find::<BadRequest>() {
        code = warp::http::StatusCode::BAD_REQUEST;
        message = "BadRequest";
    } else if let Some(_) = err.find::<AccessDenied>() {
        code = warp::http::StatusCode::FORBIDDEN;
        message = "AccessDenied";
    } else if let Some(_) = err.find::<AccountExists>() {
        code = warp::http::StatusCode::UNAUTHORIZED;
        message = "AccountExists";
    } else {
        code = warp::http::StatusCode::INTERNAL_SERVER_ERROR;
        message = "InternalError";
    }

    let json = warp::reply::json(&ErrorMessage {
        err: message.into(),
    });

    Ok(warp::reply::with_status(json, code))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    pretty_env_logger::init();

    let db = Arc::new(Mutex::new(SqliteConnection::connect("db.sqlite3").await?));
    let conn = warp::any().map(move || db.clone());

    let matches = warp::path!("api" / "matches")
        .and(conn.clone())
        .and_then(endpoints::matches);

    let predictions = warp::path!("api" / "predictions" / u32)
        .and(conn.clone())
        .and_then(endpoints::predictions);

    let user_predictions = warp::path!("api" / "predictions" / "me")
        .and(warp::body::json())
        .and(conn.clone())
        .and_then(endpoints::user_predictions);

    let submit = warp::path!("api" / "submit")
        .and(warp::body::json())
        .and(conn.clone())
        .and_then(endpoints::submit);

    let get_routes = warp::get().and(matches.or(predictions).or(warp::fs::dir("web")));
    let post_routes = warp::post().and(submit.or(user_predictions));

    warp::serve(get_routes.or(post_routes).recover(handle_rejection))
        .tls()
        .cert_path("certs/cert.rest.pem")
        .key_path("certs/key.rest.pem")
        .run(([0, 0, 0, 0], 443))
        .await;

    Ok(())
}
