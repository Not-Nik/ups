// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Brings the database up to the schema this binary expects, on startup.
//!
//! The database stores the number of the last migration it has seen in SQLite's
//! `PRAGMA user_version`. Migrations newer than that are run in order, each in its own
//! transaction together with the version bump, so a failing one leaves the database at
//! the version before it. See `migration/README.md`.

use log::info;
use sqlx::{Connection, SqliteConnection};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// The last migration that has to be applied by hand. Versioning started here: older
/// databases have no version, and some of the scripts up to it aren't plain SQL.
const BASELINE: i64 = 7;

/// Every migration after BASELINE, oldest first, compiled into the binary so it always
/// carries the schema it was built for. Add new scripts at the end:
/// `(8, include_str!("../migration/008_name.sql")),`
const MIGRATIONS: &[(i64, &str)] = &[(8, include_str!("../migration/008_refresh_interval.sql"))];

pub async fn migrate(conn: &mut SqliteConnection, db_path: &str) -> Result<()> {
    let version = get_version(conn).await?;
    let pending = pending(version, MIGRATIONS)?;
    if pending.is_empty() {
        info!("database is at version {version}, nothing to migrate");
        return Ok(());
    }

    let backup = format!("{db_path}.v{version}.bak");
    let _ = std::fs::remove_file(&backup);
    sqlx::query("VACUUM INTO ?")
        .bind(&backup)
        .execute(&mut *conn)
        .await?;
    info!("database is at version {version}, backed up to {backup}");

    apply(conn, pending).await
}

async fn get_version(conn: &mut SqliteConnection) -> sqlx::Result<i64> {
    sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(conn)
        .await
}

/// The migrations a database at `version` still needs.
fn pending<'a>(version: i64, migrations: &'a [(i64, &'a str)]) -> Result<&'a [(i64, &'a str)]> {
    let latest = BASELINE + migrations.len() as i64;
    for (idx, (number, _)) in migrations.iter().enumerate() {
        if *number != BASELINE + 1 + idx as i64 {
            Err(format!("migration {number} is out of order in MIGRATIONS"))?
        }
    }
    if version < BASELINE {
        Err(format!(
            "database is at version {version}, but automatic migration starts at {BASELINE}: \
             apply the scripts up to {BASELINE:03} by hand, or create a new database from \
             src/init.sql (see migration/README.md)"
        ))?
    }
    if version > latest {
        Err(format!(
            "database is at version {version}, newer than this build (version {latest})"
        ))?
    }
    Ok(&migrations[(version - BASELINE) as usize..])
}

async fn apply(conn: &mut SqliteConnection, migrations: &[(i64, &str)]) -> Result<()> {
    // Scripts may rebuild tables; with foreign keys on, dropping the old table would
    // cascade into the rows that reference it. The check before each commit makes up
    // for it. The pragma can't be changed inside a transaction.
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await?;
    let result = apply_each(conn, migrations).await;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *conn)
        .await?;
    result
}

async fn apply_each(conn: &mut SqliteConnection, migrations: &[(i64, &str)]) -> Result<()> {
    for (number, script) in migrations {
        let mut tx = conn.begin().await?;
        sqlx::raw_sql(script)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("migration {number} failed: {e}"))?;
        let violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut *tx)
            .await?;
        if !violations.is_empty() {
            Err(format!(
                "migration {number} leaves {} foreign key violations",
                violations.len()
            ))?
        }
        // A pragma takes no bind parameters; the number is ours, not user input.
        sqlx::query(&format!("PRAGMA user_version = {number}"))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        info!("applied migration {number}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db_at(version: i64) -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(&format!(
            "CREATE TABLE parent (ID INTEGER PRIMARY KEY);
             CREATE TABLE child (ParentID INTEGER NOT NULL REFERENCES parent (ID) ON DELETE CASCADE);
             INSERT INTO parent VALUES (1);
             INSERT INTO child VALUES (1);
             PRAGMA user_version = {version};"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    async fn count(conn: &mut SqliteConnection, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(conn)
            .await
            .unwrap()
    }

    const ADD_COLUMN: (i64, &str) = (8, "ALTER TABLE parent ADD COLUMN Name TEXT;");
    // Rebuilds a table other rows point at, like 007 does.
    const REBUILD: (i64, &str) = (
        9,
        "CREATE TABLE parent_new (ID INTEGER PRIMARY KEY, Name TEXT, Extra INTEGER);
         INSERT INTO parent_new (ID, Name) SELECT ID, Name FROM parent;
         DROP TABLE parent;
         ALTER TABLE parent_new RENAME TO parent;",
    );

    #[test]
    fn registered_migrations_match_the_scripts() {
        // Every .sql script after BASELINE has to be in MIGRATIONS, and nothing else.
        let mut scripts: Vec<i64> = std::fs::read_dir("migration")
            .unwrap()
            .filter_map(|entry| {
                let name = entry.unwrap().file_name().into_string().unwrap();
                name.split('_').next()?.parse::<i64>().ok()
            })
            .filter(|number| *number > BASELINE)
            .collect();
        scripts.sort();
        let registered: Vec<i64> = MIGRATIONS.iter().map(|(number, _)| *number).collect();
        assert_eq!(scripts, registered);
        pending(BASELINE, MIGRATIONS).unwrap();
    }

    #[test]
    fn init_sql_is_at_the_latest_version() {
        // A new database must not get the migrations its schema already includes.
        let latest = BASELINE + MIGRATIONS.len() as i64;
        let init = include_str!("init.sql");
        assert!(init.contains(&format!("PRAGMA user_version = {latest};")));
    }

    #[tokio::test]
    async fn applies_only_newer_migrations_in_order() {
        let all = [ADD_COLUMN, REBUILD];
        let mut conn = db_at(8).await;
        // 8 is already in: applying it again would fail on the missing column it adds.
        sqlx::raw_sql(ADD_COLUMN.1)
            .execute(&mut conn)
            .await
            .unwrap();

        apply(&mut conn, pending(8, &all).unwrap()).await.unwrap();

        assert_eq!(get_version(&mut conn).await.unwrap(), 9);
        sqlx::query("SELECT Extra FROM parent")
            .execute(&mut conn)
            .await
            .unwrap();
        // The rebuild didn't cascade into the rows pointing at the dropped table.
        assert_eq!(count(&mut conn, "child").await, 1);
    }

    #[tokio::test]
    async fn failing_migration_keeps_the_version_before_it() {
        let all = [
            ADD_COLUMN,
            (
                9,
                "INSERT INTO parent (ID) VALUES (2); SELECT * FROM missing;",
            ),
        ];
        let mut conn = db_at(7).await;

        let err = apply(&mut conn, pending(7, &all).unwrap())
            .await
            .unwrap_err();

        assert!(err.to_string().contains("migration 9 failed"), "{err}");
        assert_eq!(get_version(&mut conn).await.unwrap(), 8);
        assert_eq!(count(&mut conn, "parent").await, 1);
    }

    #[tokio::test]
    async fn foreign_key_violation_rolls_back() {
        let all = [(8, "DELETE FROM parent;")];
        let mut conn = db_at(7).await;

        let err = apply(&mut conn, pending(7, &all).unwrap())
            .await
            .unwrap_err();

        assert!(err.to_string().contains("foreign key violations"), "{err}");
        assert_eq!(get_version(&mut conn).await.unwrap(), 7);
        assert_eq!(count(&mut conn, "parent").await, 1);
    }

    #[test]
    fn refuses_versions_it_cannot_migrate() {
        let all = [ADD_COLUMN];
        assert!(pending(0, &all)
            .unwrap_err()
            .to_string()
            .contains("by hand"));
        assert!(pending(9, &all)
            .unwrap_err()
            .to_string()
            .contains("newer than this build"));
        assert!(pending(8, &all).unwrap().is_empty());
        assert!(pending(7, &[REBUILD])
            .unwrap_err()
            .to_string()
            .contains("out of order"));
    }
}
