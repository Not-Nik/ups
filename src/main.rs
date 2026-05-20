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
use crate::structures::ProxyQuery;
use serde_derive::Serialize;
use sqlx::{Connection, SqliteConnection};
use std::convert::Infallible;
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

    let me = warp::path!("api" / "me")
        .and(warp::header("Authorization"))
        .and(conn.clone())
        .and_then(endpoints::me);

    let matches = warp::path!("api" / "matches")
        .and(conn.clone())
        .and_then(endpoints::matches);

    let predictions = warp::path!("api" / "predictions" / u32)
        .and(conn.clone())
        .and_then(endpoints::predictions);

    let user_predictions = warp::path!("api" / "predictions" / "me")
        .and(warp::header("Authorization"))
        .and(conn.clone())
        .and_then(endpoints::user_predictions);

    let submit = warp::path!("api" / "submit")
        .and(warp::body::json())
        .and(warp::header::optional("Authorization"))
        .and(conn.clone())
        .and_then(endpoints::submit);

    let delete = warp::path!("api" / "delete")
        .and(warp::header("Authorization"))
        .and(conn.clone())
        .and_then(endpoints::delete);

    let password = warp::path!("api" / "password")
        .and(warp::header("Authorization"))
        .and(warp::body::json())
        .and(conn.clone())
        .and_then(endpoints::password);

    let proxy = warp::path!("api" / "proxy")
        .and(warp::query::<ProxyQuery>())
        .and_then(endpoints::proxy);

    let get_routes = warp::get().and(
        me.or(matches)
            .or(predictions)
            .or(user_predictions)
            .or(warp::fs::dir("web"))
            .or(proxy),
    );
    let post_routes = warp::post().and(submit.or(delete).or(password));

    let https_server = warp::serve(get_routes.or(post_routes).recover(handle_rejection))
        .tls()
        .cert_path("certs/fullchain.pem")
        .key_path("certs/privkey.pem")
        .run(([0, 0, 0, 0], 443));

    // HTTP server: redirects all requests to HTTPS
    let redirect = warp::any()
        .and(warp::host::optional())
        .and(warp::path::full())
        .map(
            |host: Option<warp::host::Authority>, path: warp::path::FullPath| {
                let host = host.map(|h| h.to_string()).unwrap_or_default();
                let https_url = format!("https://{}{}", host, path.as_str());
                warp::redirect::permanent(https_url.parse::<warp::http::Uri>().unwrap())
            },
        );

    let http_server = warp::serve(redirect).run(([0, 0, 0, 0], 80));

    tokio::join!(http_server, https_server);

    Ok(())
}
