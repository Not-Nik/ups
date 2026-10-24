// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::ops::DerefMut;
use tokio::sync::MutexGuard;

pub fn create_token(name: &String) -> String {
    let utc: DateTime<Utc> = Utc::now();
    let token = Sha256::digest(format!("{name}-{utc}"));
    token.iter().map(|b| format!("{:02X}", b)).collect()
}

pub fn hash_password(name: &String, password: &String) -> String {
    let password_hash = Sha256::digest(format!("{name}{password}"));
    password_hash.iter().map(|b| format!("{:02X}", b)).collect()
}

/// How long after its last prediction a passwordless account still blocks its name from
/// being claimed again. Every prediction made with the account restarts the window.
pub const CLAIM_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;

/// Restarts the claim window of `name`, called whenever a prediction is made with it.
pub async fn touch_account(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE users SET LastActivity = datetime('now') WHERE Name = ?")
        .bind(name)
        .execute(conn.deref_mut())
        .await?;

    Ok(())
}

pub async fn exists_account(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<bool> {
    let res = sqlx::query("SELECT EXISTS(SELECT 1 FROM users WHERE Name = ? COLLATE NOCASE)")
        .bind(name)
        .fetch_one(conn.deref_mut())
        .await?;

    res.try_get(0)
}

/// Hands an expired account over to whoever submits its name: all of its sessions are
/// dropped (the claimer gets a fresh one from the submit endpoint) and its claim window
/// restarts. Predictions stay with the account. `Ok(None)` when the name belongs to no
/// account, or to one with a password or a window still running, which are never
/// claimable; the returned name is the stored one.
pub async fn take_over_account(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<Option<String>> {
    let claimable: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM users
            WHERE Name = ? COLLATE NOCASE
              AND Password IS NULL
              AND LastActivity < datetime('now', '-' || ? || ' seconds')
        )",
    )
    .bind(name)
    .bind(CLAIM_WINDOW_SECS)
    .fetch_one(conn.deref_mut())
    .await?;
    if !claimable {
        return Ok(None);
    }

    let stored: String = sqlx::query_scalar("SELECT Name FROM users WHERE Name = ? COLLATE NOCASE")
        .bind(name)
        .fetch_one(conn.deref_mut())
        .await?;

    sqlx::query("DELETE FROM sessions WHERE Name = ? COLLATE NOCASE")
        .bind(&stored)
        .execute(conn.deref_mut())
        .await?;

    sqlx::query("UPDATE users SET LastActivity = datetime('now') WHERE Name = ?")
        .bind(&stored)
        .execute(conn.deref_mut())
        .await?;

    Ok(Some(stored))
}

/// Ends `name`'s claim window right away, making it claimable like one whose seven days
/// ran out. `Ok(None)` when the name belongs to no account, or to one with a password,
/// which is never claimable; the returned name is the stored one.
pub async fn release_account(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<Option<String>> {
    let rows = sqlx::query(
        "UPDATE users SET LastActivity = '1970-01-01 00:00:00' WHERE Name = ? COLLATE NOCASE AND Password IS NULL",
    )
    .bind(name)
    .execute(conn.deref_mut())
    .await?;
    if rows.rows_affected() == 0 {
        return Ok(None);
    }

    let stored: String = sqlx::query_scalar("SELECT Name FROM users WHERE Name = ? COLLATE NOCASE")
        .bind(name)
        .fetch_one(conn.deref_mut())
        .await?;

    Ok(Some(stored))
}

pub async fn create_session(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<String> {
    let token = create_token(name);

    sqlx::query("INSERT INTO sessions (Name, Token) VALUES (?, ?)")
        .bind(name)
        .bind(token.clone())
        .execute(conn.deref_mut())
        .await?;

    Ok(token)
}

pub async fn delete_session(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    token: &str,
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM sessions WHERE Token = ?")
        .bind(token)
        .execute(conn.deref_mut())
        .await?;

    Ok(())
}

pub async fn create_account(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<Option<String>> {
    if name.len() > 128 {
        return Ok(None);
    }

    sqlx::query("INSERT INTO users (Name) VALUES (?)")
        .bind(name)
        .execute(conn.deref_mut())
        .await?;

    Ok(Some(create_session(conn, name).await?))
}

pub async fn delete_account(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM users WHERE Name = ?")
        .bind(name)
        .execute(conn.deref_mut())
        .await?;

    Ok(())
}

pub async fn login_account(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
    password: &String,
) -> sqlx::Result<Option<String>> {
    let to_match: String = sqlx::query("SELECT Password FROM users WHERE Name = ?")
        .bind(name)
        .fetch_one(conn.deref_mut())
        .await?
        .try_get(0)?;

    if to_match != hash_password(name, password) {
        return Ok(None);
    }

    create_session(conn, name).await.map(Some)
}

pub async fn verify_session(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    token: &str,
) -> sqlx::Result<Option<String>> {
    let mut session_query = sqlx::query("SELECT Name FROM sessions WHERE Token = ?")
        .bind(token)
        .fetch(conn.deref_mut());

    let Some(res) = session_query.try_next().await? else {
        return Ok(None);
    };

    Ok(res.try_get("Name")?)
}

pub async fn is_admin(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<bool> {
    let admin: u32 = sqlx::query("SELECT Admin FROM users WHERE Name = ?")
        .bind(name)
        .fetch_one(conn.deref_mut())
        .await?
        .try_get(0)?;

    Ok(admin == 1)
}

pub async fn set_password(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
    password: &String,
) -> sqlx::Result<()> {
    let hash = hash_password(name, password);

    sqlx::query("UPDATE users SET Password = ? WHERE Name = ?")
        .bind(hash)
        .bind(name)
        .execute(conn.deref_mut())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;
    use tokio::sync::Mutex;

    async fn db() -> Mutex<SqliteConnection> {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("init.sql"))
            .execute(&mut conn)
            .await
            .unwrap();
        Mutex::new(conn)
    }

    async fn age(conn: &mut MutexGuard<'_, SqliteConnection>, name: &str, secs: i64) {
        sqlx::query(
            "UPDATE users SET LastActivity = datetime('now', '-' || ? || ' seconds') WHERE Name = ?",
        )
        .bind(secs)
        .bind(name)
        .execute(conn.deref_mut())
        .await
        .unwrap();
    }

    async fn count(conn: &mut MutexGuard<'_, SqliteConnection>, table: &str, name: &str) -> i64 {
        sqlx::query_scalar(&format!(
            "SELECT COUNT(*) FROM {table} WHERE Name = ? COLLATE NOCASE"
        ))
        .bind(name)
        .fetch_one(conn.deref_mut())
        .await
        .unwrap()
    }

    async fn alice(conn: &mut MutexGuard<'_, SqliteConnection>) -> String {
        create_account(conn, &"alice".into())
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn a_new_account_has_its_claim_window_running() {
        // The server never writes LastActivity when it creates an account, so the column
        // default has to start the window: a left-behind account nobody ever predicted
        // with would be claimable from the start otherwise.
        let db = db().await;
        let mut conn = db.lock().await;
        alice(&mut conn).await;

        let started: bool = sqlx::query_scalar(
            "SELECT LastActivity >= datetime('now', '-1 minute') FROM users WHERE Name = 'alice'",
        )
        .fetch_one(conn.deref_mut())
        .await
        .unwrap();

        assert!(started);
        assert!(take_over_account(&mut conn, &"alice".into())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn a_used_passwordless_account_cannot_be_taken_over() {
        let db = db().await;
        let mut conn = db.lock().await;
        let token = alice(&mut conn).await;

        assert!(take_over_account(&mut conn, &"alice".into())
            .await
            .unwrap()
            .is_none());
        assert_eq!(count(&mut conn, "sessions", "alice").await, 1);
        assert!(verify_session(&mut conn, &token).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn an_expired_passwordless_account_keeps_its_predictions() {
        let db = db().await;
        let mut conn = db.lock().await;
        alice(&mut conn).await;
        sqlx::query(
            "INSERT INTO predictions (Name, MatchID, ScoreA, ScoreB) VALUES ('alice', 1, 3, 1)",
        )
        .execute(conn.deref_mut())
        .await
        .unwrap();
        age(&mut conn, "alice", CLAIM_WINDOW_SECS + 1).await;

        let taken = take_over_account(&mut conn, &"alice".into())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(taken, "alice");
        assert_eq!(count(&mut conn, "predictions", "alice").await, 1);
        // The claim window restarted: a second takeover is blocked until it ages out.
        assert!(take_over_account(&mut conn, &"alice".into())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn a_takeover_drops_the_old_owners_sessions() {
        let db = db().await;
        let mut conn = db.lock().await;
        let token = alice(&mut conn).await;
        create_session(&mut conn, &"alice".into()).await.unwrap();
        assert_eq!(count(&mut conn, "sessions", "alice").await, 2);
        age(&mut conn, "alice", CLAIM_WINDOW_SECS + 1).await;

        take_over_account(&mut conn, &"Alice".into())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(count(&mut conn, "sessions", "alice").await, 0);
        assert!(verify_session(&mut conn, &token).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_prediction_restarts_the_claim_window() {
        let db = db().await;
        let mut conn = db.lock().await;
        alice(&mut conn).await;
        age(&mut conn, "alice", CLAIM_WINDOW_SECS + 1).await;

        touch_account(&mut conn, &"alice".into()).await.unwrap();

        assert!(take_over_account(&mut conn, &"alice".into())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn an_account_with_a_password_is_never_claimable() {
        let db = db().await;
        let mut conn = db.lock().await;
        alice(&mut conn).await;
        set_password(&mut conn, &"alice".into(), &"hunter2".into())
            .await
            .unwrap();
        age(&mut conn, "alice", CLAIM_WINDOW_SECS + 1).await;

        assert!(take_over_account(&mut conn, &"alice".into())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn releasing_makes_a_passwordless_account_claimable() {
        let db = db().await;
        let mut conn = db.lock().await;
        create_account(&mut conn, &"Alice".into())
            .await
            .unwrap()
            .unwrap();

        let released = release_account(&mut conn, &"aLiCe".into())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(released, "Alice");
        assert!(take_over_account(&mut conn, &"alice".into())
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn releasing_never_touches_passworded_accounts_or_unknown_names() {
        let db = db().await;
        let mut conn = db.lock().await;
        alice(&mut conn).await;
        set_password(&mut conn, &"alice".into(), &"hunter2".into())
            .await
            .unwrap();

        assert!(release_account(&mut conn, &"alice".into())
            .await
            .unwrap()
            .is_none());
        assert!(release_account(&mut conn, &"nobody".into())
            .await
            .unwrap()
            .is_none());
        assert_eq!(count(&mut conn, "sessions", "alice").await, 1);
    }
}
