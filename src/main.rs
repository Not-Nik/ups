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
use governor::clock::DefaultClock;
use governor::state::keyed::DefaultKeyedStateStore;
use governor::{Quota, RateLimiter};
use nonzero_ext::nonzero;
use serde_derive::Serialize;
use sqlx::{Connection, Executor, SqliteConnection};
use std::convert::Infallible;
use std::net::IpAddr;
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

    if err.is_not_found() {
        code = warp::http::StatusCode::NOT_FOUND;
        return Ok(warp::reply::with_status(
            warp::reply::html(std::fs::read_to_string("web/404.html").unwrap_or("404".into()))
                .into_response(),
            code,
        ));
    } else if let Some(_) = err.find::<InternalError>() {
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
    } else if err.find::<RateLimited>().is_some() {
        code = warp::http::StatusCode::TOO_MANY_REQUESTS;
        message = "RateLimited";
    } else {
        code = warp::http::StatusCode::INTERNAL_SERVER_ERROR;
        message = "InternalError";
    }

    let json = warp::reply::json(&ErrorMessage {
        err: message.into(),
    });

    Ok(warp::reply::with_status(json.into_response(), code))
}

// Keyed by client IP. Use NotKeyed if you want a single global bucket.
type IpRateLimiter = RateLimiter<IpAddr, DefaultKeyedStateStore<IpAddr>, DefaultClock>;

fn with_rate_limit(
    limiter: Arc<IpRateLimiter>,
) -> impl Filter<Extract = (), Error = Rejection> + Clone {
    warp::addr::remote()
        .and_then(move |addr: Option<std::net::SocketAddr>| {
            let limiter = limiter.clone();
            async move {
                let ip = addr
                    .map(|a| a.ip())
                    .ok_or_else(|| warp::reject::custom(error::InternalError))?;
                match limiter.check_key(&ip) {
                    Ok(_) => Ok(()),
                    Err(_) => Err(warp::reject::custom(error::RateLimited)),
                }
            }
        })
        .untuple_one()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    pretty_env_logger::init();

    let db = Arc::new(Mutex::new(SqliteConnection::connect("db.sqlite3").await?));
    db.lock().await.execute("PRAGMA foreign_keys = ON;").await?;
    let conn = warp::any().map(move || db.clone());

    let quota = Quota::per_minute(nonzero!(100u32)).allow_burst(nonzero!(50u32));
    let limiter: Arc<IpRateLimiter> = Arc::new(RateLimiter::keyed(quota));
    let rate_limit = warp::any().and(with_rate_limit(limiter.clone()));

    let me = warp::path!("api" / "me")
        .and(rate_limit.clone())
        .and(warp::get())
        .and(warp::header("Authorization"))
        .and(conn.clone())
        .and_then(endpoints::me);

    let matches = warp::path!("api" / "matches")
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and_then(endpoints::matches);

    let single_prediction = warp::path!("api" / "predictions" / u32)
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and_then(endpoints::prediction);

    let multi_prediction = warp::path!("api" / "predictions")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(warp::body::json())
        .and(conn.clone())
        .and_then(endpoints::predictions);

    let user_predictions = warp::path!("api" / "predictions" / "me")
        .and(rate_limit.clone())
        .and(warp::get())
        .and(warp::header("Authorization"))
        .and(conn.clone())
        .and_then(endpoints::user_predictions);

    let submit = warp::path!("api" / "submit")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(warp::body::json())
        .and(warp::header::optional("Authorization"))
        .and(conn.clone())
        .and_then(endpoints::submit);

    let login = warp::path!("api" / "login")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(warp::body::json())
        .and(conn.clone())
        .and_then(endpoints::login);

    let delete = warp::path!("api" / "delete")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(warp::header("Authorization"))
        .and(conn.clone())
        .and_then(endpoints::delete);

    let password = warp::path!("api" / "password")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(warp::header("Authorization"))
        .and(warp::body::json())
        .and(conn.clone())
        .and_then(endpoints::password);

    let proxy = warp::path!("api" / "proxy")
        .and(warp::get())
        .and(warp::query::<ProxyQuery>())
        .and_then(endpoints::proxy);

    let routes = me
        .or(matches)
        .or(single_prediction)
        .or(multi_prediction)
        .or(user_predictions)
        .or(submit)
        .or(login)
        .or(delete)
        .or(password)
        .or(proxy)
        .or(warp::fs::dir("web"));

    let https_server = warp::serve(routes.recover(handle_rejection))
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
