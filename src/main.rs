// ups (c) Nikolas Wipper 2024

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

mod account;
mod endpoints;
mod error;
mod image_cache;
mod loader;
mod matches;
mod migrate;
mod predictions;
mod structures;

use crate::error::*;
use crate::structures::{Bracket, Matches, ProxyQuery};
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

const DB_PATH: &str = "db.sqlite3";

/// Where the HTTP server sends a request: the same host and path over HTTPS. None for
/// a request without a Host header, which has nowhere to be sent.
fn https_redirect(host: Option<&warp::host::Authority>, path: &str) -> Option<warp::http::Uri> {
    format!("https://{}{path}", host?).parse().ok()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    pretty_env_logger::init();

    let mut connection = SqliteConnection::connect(DB_PATH).await?;
    migrate::migrate(&mut connection, DB_PATH)
        .await
        .map_err(|e| e.to_string())?;
    let db = Arc::new(Mutex::new(connection));
    db.lock().await.execute("PRAGMA foreign_keys = ON;").await?;
    let refresher = loader::Refresher::new(db.clone());
    let refresh = warp::any().map(move || refresher.clone());

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

    let tournaments = warp::path!("api" / "tournaments")
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and_then(endpoints::tournaments);

    let tournament = warp::path!("api" / "tournament")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(conn.clone())
        .and(warp::header("Authorization"))
        .and(warp::body::json())
        .and_then(endpoints::tournament);

    let refresh_interval = warp::path!("api" / "tournament" / u64 / "refresh")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(conn.clone())
        .and(warp::header("Authorization"))
        .and(warp::body::json())
        .and_then(endpoints::refresh_interval);

    let stages = warp::path!("api" / "stages" / u32)
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and_then(endpoints::stages);

    let stage_pick_count = warp::path!("api" / "stage" / "picks")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(conn.clone())
        .and(warp::header("Authorization"))
        .and(warp::body::json())
        .and_then(endpoints::stage_pick_count);

    let stage_force_open = warp::path!("api" / "stage" / "open")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(conn.clone())
        .and(warp::header("Authorization"))
        .and(warp::body::json())
        .and_then(endpoints::stage_force_open);

    let matches = warp::path!("api" / "matches" / u32)
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and(refresh.clone())
        .and_then(endpoints::matches);

    let match_ = warp::path!("api" / "match")
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and(warp::query::<Matches>())
        .and_then(endpoints::match_);

    let add_match = warp::path!("api" / "match")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(conn.clone())
        .and(warp::header("Authorization"))
        .and(warp::body::json())
        .and_then(endpoints::add_match);

    let brackets = warp::path!("api" / "brackets" / u32)
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and_then(endpoints::brackets);

    let bracket = warp::path!("api" / "bracket")
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and(warp::query::<Bracket>())
        .and_then(endpoints::bracket);

    let standings = warp::path!("api" / "standings" / u32)
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and(refresh.clone())
        .and_then(endpoints::standings);

    let teams = warp::path!("api" / "teams" / u32)
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and(refresh.clone())
        .and_then(endpoints::teams);

    let players = warp::path!("api" / "players" / u32)
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and(refresh.clone())
        .and_then(endpoints::players);

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

    let standing_predictions = warp::path!("api" / "standings" / "predictions" / u32)
        .and(rate_limit.clone())
        .and(warp::get())
        .and(conn.clone())
        .and_then(endpoints::standing_predictions);

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

    let logout = warp::path!("api" / "logout")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(warp::header("Authorization"))
        .and(conn.clone())
        .and_then(endpoints::logout);

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

    let account_release = warp::path!("api" / "account" / "release")
        .and(rate_limit.clone())
        .and(warp::post())
        .and(warp::header("Authorization"))
        .and(warp::body::json())
        .and(conn.clone())
        .and_then(endpoints::account_release);

    let image_cache = image_cache::ImageCache::shared();
    let images = warp::any().map(move || image_cache.clone());

    let proxy = warp::path!("api" / "proxy")
        .and(warp::get())
        .and(warp::query::<ProxyQuery>())
        .and(images)
        .and_then(endpoints::proxy);

    // Boxed every few routes: each `.or` nests the filter's type one level deeper, and
    // past a couple of dozen the compiler gives up on it ("overflow evaluating the
    // requirement"). A box starts the nesting over.
    let routes = me
        .or(tournaments)
        .or(tournament)
        .or(refresh_interval)
        .or(stages)
        .or(stage_pick_count)
        .or(stage_force_open)
        .or(matches)
        .or(match_)
        .or(add_match)
        .or(brackets)
        .or(bracket)
        .boxed()
        .or(standings)
        .or(teams)
        .or(players)
        .or(single_prediction)
        .or(multi_prediction)
        .or(user_predictions)
        .or(standing_predictions)
        .boxed()
        .or(submit)
        .or(login)
        .or(logout)
        .or(delete)
        .or(password)
        .or(account_release)
        .or(proxy)
        .or(warp::fs::dir("web"))
        .boxed();

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
                match https_redirect(host.as_ref(), path.as_str()) {
                    Some(uri) => warp::redirect::permanent(uri).into_response(),
                    None => warp::http::StatusCode::BAD_REQUEST.into_response(),
                }
            },
        );

    let http_server = warp::serve(redirect).run(([0, 0, 0, 0], 80));

    tokio::join!(http_server, https_server);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority(host: &str) -> warp::host::Authority {
        host.parse().unwrap()
    }

    #[test]
    fn redirect_keeps_host_and_path() {
        let uri = https_redirect(Some(&authority("pulow.cc")), "/me.html?x=1").unwrap();
        assert_eq!(uri, "https://pulow.cc/me.html?x=1");
    }

    #[test]
    fn redirect_without_a_host_is_refused() {
        // An HTTP/1.0 request (or a scanner) may send no Host header at all.
        assert_eq!(https_redirect(None, "/"), None);
    }
}
