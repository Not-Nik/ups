// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
use crate::account::{
    create_account, create_session, delete_account, delete_session, exists_account, is_admin,
    login_account, release_account, set_password, take_over_account, touch_account, verify_session,
};
use crate::error::{AccessDenied, AccountExists, BadRequest, InternalError};
use crate::image_cache::{Image, SharedImageCache};
use crate::loader::{Refresher, BRACKET_TYPES};
use crate::matches::{
    add_group, add_round, add_stage, add_team, add_tournament, get_bracket_nodes, get_brackets,
    get_group_id, get_matches, get_matches_filter, get_players, get_round_id, get_stage_id,
    get_stages, get_standings, get_team_id, get_teams, get_tournaments, set_refresh_interval,
    set_stage_force_open, set_stage_pick_count,
};
use crate::predictions::{
    count_group_tournament_teams, get_group_picking, get_predictions, get_standing_predictions,
    get_user_predictions, set_prediction, set_standing_prediction,
};
use crate::structures::*;

use crate::matches;
use log::debug;
use sqlx::{Connection, SqliteConnection};
use std::collections::HashSet;
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

pub async fn stages(
    tournament_id: u32,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let stages = get_stages(&mut conn_lock, tournament_id)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::json(&stages))
}

/// The most places a stage can ask users to predict.
const MAX_PICK_COUNT: u64 = 32;

pub async fn stage_pick_count(
    conn: Arc<Mutex<SqliteConnection>>,
    auth: String,
    update: StagePickCount,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    verify_admin(&mut conn_lock, auth.clone()).await?;

    if update.pick_count < 1 || update.pick_count > MAX_PICK_COUNT {
        Err(warp::reject::custom(BadRequest))?
    }

    if !set_stage_pick_count(&mut conn_lock, update.stage_id, update.pick_count)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?
    {
        Err(warp::reject::custom(BadRequest))?
    }

    Ok(warp::reply())
}

/// Keeps a stage's groups taking standing predictions even after one of their matches has
/// been scored. Locking them again is left to the auto rule once this is turned off.
pub async fn stage_force_open(
    conn: Arc<Mutex<SqliteConnection>>,
    auth: String,
    update: StageForceOpen,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    verify_admin(&mut conn_lock, auth.clone()).await?;

    if !set_stage_force_open(&mut conn_lock, update.stage_id, update.force_open)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?
    {
        Err(warp::reject::custom(BadRequest))?
    }

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

    matches::add_match(
        &mut tx,
        tournament_id,
        group_id,
        round_id,
        team_a,
        team_b,
        match_,
    )
    .await?;
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

pub async fn standings(
    tournament_id: u32,
    conn: Arc<Mutex<SqliteConnection>>,
    refresher: Arc<Refresher>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let refreshing = refresher.refresh(tournament_id).await;

    let mut conn_lock = conn.lock().await;

    let standings = get_standings(&mut conn_lock, tournament_id)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::with_header(
        warp::reply::json(&standings),
        "X-Refreshing",
        if refreshing { "1" } else { "0" },
    ))
}

pub async fn teams(
    tournament_id: u32,
    conn: Arc<Mutex<SqliteConnection>>,
    refresher: Arc<Refresher>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let refreshing = refresher.refresh(tournament_id).await;

    let mut conn_lock = conn.lock().await;

    let teams = get_teams(&mut conn_lock, tournament_id)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::with_header(
        warp::reply::json(&teams),
        "X-Refreshing",
        if refreshing { "1" } else { "0" },
    ))
}

pub async fn players(
    tournament_id: u32,
    conn: Arc<Mutex<SqliteConnection>>,
    refresher: Arc<Refresher>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let refreshing = refresher.refresh(tournament_id).await;

    let mut conn_lock = conn.lock().await;

    let players = get_players(&mut conn_lock, tournament_id)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::with_header(
        warp::reply::json(&players),
        "X-Refreshing",
        if refreshing { "1" } else { "0" },
    ))
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

    // Checked before the account is created, so a bad request doesn't leave one behind.
    let mut open_standings = Vec::new();
    for standing in &submission.standings {
        if check_standing_prediction(&mut conn_lock, standing).await? {
            open_standings.push(standing);
        }
    }

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
        // An unknown name creates the account below; a claimable one (expired and
        // passwordless) is handed over instead: its old sessions went with the take-over,
        // its predictions stay, so the claimer only needs a session of their own.
        match take_over_account(&mut conn_lock, &name)
            .await
            .map_err(|_| warp::reject::custom(InternalError))?
        {
            Some(stored) => {
                let token = create_session(&mut conn_lock, &stored)
                    .await
                    .map_err(|_| warp::reject::custom(InternalError))?;

                (stored, token)
            }
            None => {
                if exists_account(&mut conn_lock, &name)
                    .await
                    .map_err(|_| warp::reject::custom(InternalError))?
                {
                    Err(warp::reject::custom(AccountExists))?;
                }
                let Some(token) = create_account(&mut conn_lock, &name)
                    .await
                    .map_err(|_| warp::reject::custom(InternalError))?
                else {
                    return Err(warp::reject::custom(BadRequest))?;
                };

                (name, token)
            }
        }
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

    let mut wrote = false;
    for (pred, mat) in submission.predictions.iter().zip(matches) {
        if mat.score_a.is_some() || mat.score_b.is_some() {
            continue;
        }
        set_prediction(
            &mut conn_lock,
            &name,
            pred.id as u32,
            pred.score_a as u32,
            pred.score_b as u32,
        )
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;
        wrote = true;
    }

    for standing in open_standings {
        set_standing_prediction(&mut conn_lock, &name, standing.group_id, &standing.teams)
            .await
            .map_err(|_| warp::reject::custom(InternalError))?;
        wrote = true;
    }

    // A prediction made with the account restarts its claim window.
    if wrote {
        touch_account(&mut conn_lock, &name)
            .await
            .map_err(|_| warp::reject::custom(InternalError))?;
    }

    Ok(warp::reply::json(&Token { token }))
}

pub async fn standing_predictions(
    tournament_id: u32,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    let predictions = get_standing_predictions(&mut conn_lock, tournament_id)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    Ok(warp::reply::json(&predictions))
}

/// Reject a malformed standing prediction; `Ok(false)` when it's fine but a match of its
/// group already has a score, so it's skipped like a prediction for that match would be.
async fn check_standing_prediction(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    submission: &StandingPredictionSubmission,
) -> Result<bool, warp::Rejection> {
    let teams = &submission.teams;
    let distinct: HashSet<_> = teams.iter().collect();
    if distinct.len() != teams.len() {
        Err(warp::reject::custom(BadRequest))?
    }

    let Some((open, pick_count)) = get_group_picking(conn, submission.group_id)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?
    else {
        Err(warp::reject::custom(BadRequest))?
    };

    if teams.len() as i64 > pick_count {
        Err(warp::reject::custom(BadRequest))?
    }

    if !teams.is_empty()
        && count_group_tournament_teams(conn, submission.group_id, teams)
            .await
            .map_err(|_| warp::reject::custom(InternalError))?
            != teams.len() as i64
    {
        Err(warp::reject::custom(BadRequest))?
    }

    Ok(open)
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

/// Bounds of a tournament's refresh interval, in seconds: a minute to a week.
const MIN_REFRESH_INTERVAL: u64 = 60;
const MAX_REFRESH_INTERVAL: u64 = 7 * 24 * 60 * 60;

pub async fn account_release(
    auth: String,
    login: Name,
    conn: Arc<Mutex<SqliteConnection>>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    verify_admin(&mut conn_lock, auth).await?;

    let Some(name) = release_account(&mut conn_lock, &login.name)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?
    else {
        Err(warp::reject::custom(BadRequest))?
    };

    Ok(warp::reply::json(&User { name }))
}

pub async fn refresh_interval(
    tournament_id: u64,
    conn: Arc<Mutex<SqliteConnection>>,
    auth: String,
    secs: u64,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut conn_lock = conn.lock().await;

    verify_admin(&mut conn_lock, auth.clone()).await?;

    if !(MIN_REFRESH_INTERVAL..=MAX_REFRESH_INTERVAL).contains(&secs) {
        Err(warp::reject::custom(BadRequest))?
    }

    if !set_refresh_interval(&mut conn_lock, tournament_id, secs)
        .await
        .map_err(|_| warp::reject::custom(InternalError))?
    {
        Err(warp::reject::custom(BadRequest))?
    }

    Ok(warp::reply())
}

pub async fn proxy(
    query: ProxyQuery,
    cache: SharedImageCache,
) -> Result<impl warp::Reply, warp::Rejection> {
    // Checked on the parsed URL, so `..` segments or a look-alike host can't get past it.
    let url = reqwest::Url::parse(&query.url).map_err(|_| warp::reject::custom(BadRequest))?;
    if url.scheme() != "https"
        || url.host_str() != Some(PROXY_HOST)
        || url.port().is_some()
        || !url.path().starts_with(PROXY_PATH)
    {
        return Err(warp::reject::custom(AccessDenied))?;
    }

    // The lock is never held across an await. Two requests for an image that isn't
    // cached yet both fetch it; the second one's copy simply replaces the first.
    let cached = cache.lock().unwrap().get(url.as_str());
    if let Some(image) = cached {
        return Ok(proxy_reply(image));
    }
    let key = url.to_string();

    // No redirects: one could lead away from the host checked above.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| warp::reject::custom(InternalError))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| warp::reject::custom(InternalError))?;

    // The body is served from our own origin, so only pass on images that can't carry
    // script (no SVG, no HTML), under the type from this list rather than upstream's.
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .and_then(|v| PROXY_TYPES.iter().copied().find(|t| *t == v));
    let Some(content_type) = content_type else {
        return Err(warp::reject::custom(AccessDenied))?;
    };
    if !response.status().is_success() {
        return Err(warp::reject::custom(AccessDenied))?;
    }
    let body = response.bytes().await.map_err(|_| warp::reject::reject())?;

    let image = Image { content_type, body };
    cache.lock().unwrap().insert(&key, image.clone());
    Ok(proxy_reply(image))
}

fn proxy_reply(image: Image) -> warp::reply::Response {
    let mut reply = warp::reply::Response::new(image.body.into());
    let headers = reply.headers_mut();
    headers.insert(
        warp::http::header::CONTENT_TYPE,
        warp::http::HeaderValue::from_static(image.content_type),
    );
    headers.insert(
        warp::http::header::X_CONTENT_TYPE_OPTIONS,
        warp::http::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        warp::http::header::CONTENT_SECURITY_POLICY,
        warp::http::HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    // Every page loads its team logos through here; let the browser keep them for a
    // day. A changed logo comes with a new `?v=` in its URL, so it is fetched anew.
    headers.insert(
        warp::http::header::CACHE_CONTROL,
        warp::http::HeaderValue::from_static("public, max-age=86400"),
    );

    reply
}

const PROXY_HOST: &str = "play.toornament.com";
const PROXY_PATH: &str = "/media/file/";
const PROXY_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::CLAIM_WINDOW_SECS;
    use warp::reply::Reply as _;

    async fn db() -> Arc<Mutex<SqliteConnection>> {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("init.sql"))
            .execute(&mut conn)
            .await
            .unwrap();
        Arc::new(Mutex::new(conn))
    }

    /// Submits nothing for `name`. Whether the account behind the name is created, handed
    /// over or refused is what the three outcomes here are about; what is predicted is not.
    async fn submit_name(db: &Arc<Mutex<SqliteConnection>>, name: &str) -> bool {
        let submission = Submission {
            name: Some(name.into()),
            predictions: Vec::new(),
            standings: Vec::new(),
        };
        match submit(submission, None, db.clone()).await {
            Ok(reply) => {
                assert_eq!(reply.into_response().status(), warp::http::StatusCode::OK);
                true
            }
            Err(rejection) => {
                assert!(rejection.find::<AccountExists>().is_some(), "{rejection:?}");
                false
            }
        }
    }

    async fn sign_up(db: &Arc<Mutex<SqliteConnection>>, name: &str) -> String {
        let mut conn = db.lock().await;
        create_account(&mut conn, &name.into())
            .await
            .unwrap()
            .unwrap()
    }

    /// Lets `name`'s claim window run out.
    async fn expire(db: &Arc<Mutex<SqliteConnection>>, name: &str) {
        let mut conn = db.lock().await;
        sqlx::query("UPDATE users SET LastActivity = datetime('now', '-' || ? || ' seconds') WHERE Name = ?")
            .bind(CLAIM_WINDOW_SECS + 1)
            .bind(name)
            .execute(&mut *conn)
            .await
            .unwrap();
    }

    async fn predict(db: &Arc<Mutex<SqliteConnection>>, name: &str) {
        let mut conn = db.lock().await;
        sqlx::query("INSERT INTO predictions (Name, MatchID, ScoreA, ScoreB) VALUES (?, 1, 3, 1)")
            .bind(name)
            .execute(&mut *conn)
            .await
            .unwrap();
    }

    async fn rows(db: &Arc<Mutex<SqliteConnection>>, table: &str, name: &str) -> i64 {
        let mut conn = db.lock().await;
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE Name = ?"))
            .bind(name)
            .fetch_one(&mut *conn)
            .await
            .unwrap()
    }

    async fn token_of(db: &Arc<Mutex<SqliteConnection>>, name: &str) -> String {
        let mut conn = db.lock().await;
        sqlx::query_scalar("SELECT Token FROM sessions WHERE Name = ?")
            .bind(name)
            .fetch_one(&mut *conn)
            .await
            .unwrap()
    }

    async fn signed_in(db: &Arc<Mutex<SqliteConnection>>, token: &str) -> bool {
        let mut conn = db.lock().await;
        verify_session(&mut conn, token).await.unwrap().is_some()
    }

    #[tokio::test]
    async fn an_expired_passwordless_account_is_handed_to_whoever_submits_its_name() {
        let db = db().await;
        let old = sign_up(&db, "Alice").await;
        predict(&db, "Alice").await;
        expire(&db, "Alice").await;

        assert!(submit_name(&db, "alice").await);

        // The old owner is signed out, the new one holds the only session, and the
        // predictions came with the name.
        assert!(!signed_in(&db, &old).await);
        assert_eq!(rows(&db, "sessions", "Alice").await, 1);
        let fresh = token_of(&db, "Alice").await;
        assert_ne!(fresh, old);
        assert!(signed_in(&db, &fresh).await);
        assert_eq!(rows(&db, "predictions", "Alice").await, 1);
        // The name keeps its new owner: the take-over restarted its claim window.
        assert!(!submit_name(&db, "alice").await);
        assert_eq!(rows(&db, "users", "Alice").await, 1);
    }

    #[tokio::test]
    async fn an_account_that_is_still_in_use_cannot_be_claimed() {
        let db = db().await;
        let token = sign_up(&db, "alice").await;

        assert!(!submit_name(&db, "alice").await);

        // Being refused a name must not disturb whoever owns it.
        assert!(signed_in(&db, &token).await);
        assert_eq!(rows(&db, "sessions", "alice").await, 1);
    }

    #[tokio::test]
    async fn an_unknown_name_gets_its_account_and_a_second_submission_does_not() {
        let db = db().await;

        assert!(submit_name(&db, "bob").await);
        assert_eq!(rows(&db, "sessions", "bob").await, 1);
        assert!(!submit_name(&db, "bob").await);
        assert_eq!(rows(&db, "users", "bob").await, 1);
    }
}
