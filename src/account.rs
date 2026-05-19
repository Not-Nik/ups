// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use log::debug;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::ops::DerefMut;
use tokio::sync::MutexGuard;

pub fn create_token(name: &String) -> String {
    let utc: DateTime<Utc> = Utc::now();
    let token = Sha256::digest(format!("{name}-{utc}"));
    token.iter().map(|b| format!("{:02X}", b)).collect()
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

pub async fn create_account(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<String> {
    sqlx::query("INSERT INTO users (Name) VALUES (?)")
        .bind(name)
        .execute(conn.deref_mut())
        .await?;

    debug!("Created account: {name}");

    let token = create_token(name);

    sqlx::query("INSERT INTO sessions (Name, Token) VALUES (?, ?)")
        .bind(name)
        .bind(token.clone())
        .execute(conn.deref_mut())
        .await?;

    debug!("Created session: {token}");

    Ok(token)
}

pub async fn delete_account(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    name: &String,
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM sessions WHERE Name = ?")
        .bind(name)
        .execute(conn.deref_mut())
        .await?;

    sqlx::query("DELETE FROM users WHERE Name = ?")
        .bind(name)
        .execute(conn.deref_mut())
        .await?;

    sqlx::query("DELETE FROM predictions WHERE Name = ?")
        .bind(name)
        .execute(conn.deref_mut())
        .await?;

    Ok(())
}

pub async fn verify_session(
    conn: &mut MutexGuard<'_, SqliteConnection>,
    token: &String,
) -> sqlx::Result<Option<String>> {
    let mut session_query = sqlx::query("SELECT Name FROM sessions WHERE Token = ?")
        .bind(token)
        .fetch(conn.deref_mut());

    let Some(res) = session_query.try_next().await? else {
        return Ok(None);
    };

    Ok(res.try_get("Name")?)
}
