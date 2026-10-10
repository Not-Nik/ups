# Migrations

Scripts that take an existing `db.sqlite3` to the schema the code expects. A new
database doesn't need them: `src/init.sql` always describes the current schema.

They are numbered in the order they apply. The database stores the number of the last
one it has seen in SQLite's `user_version`:

```sh
sqlite3 db.sqlite3 "PRAGMA user_version"
```

## Automatic: 008 and later

The server migrates on startup (`src/migrate.rs`). It runs every script newer than the
database's version, in order, and then starts as usual. Nothing to do by hand.

- The scripts are compiled into the binary, so deploying a build is enough; the
  `migration/` directory isn't needed next to it.
- Before the first pending script the database is copied to `db.sqlite3.vN.bak`, N
  being the version it was at.
- Each script runs in one transaction together with its version bump. If it fails, or
  leaves foreign key violations, it is rolled back, the database stays at the version
  before it, and the server exits with the error.
- The server also refuses to start on a database that is newer than the build, or older
  than version 7.

## By hand: 001 to 007

These predate versioning, and two of them are Python scripts that read from toornament.
A database from before 007 has version 0. Work out where it is from its schema
(`sqlite3 db.sqlite3 .schema`) or from the commit the deployment was built from, and
apply every later script up to 007, in order, with the server stopped:

```sh
cp db.sqlite3 db.sqlite3.bak                      # always back up first

sqlite3 db.sqlite3 < migration/NNN_name.sql       # .sql scripts
uv run python migration/NNN_name.py db.sqlite3    # .py scripts

# afterwards: must print nothing but "ok"
sqlite3 db.sqlite3 "PRAGMA foreign_key_check; PRAGMA integrity_check;"
```

- The `.sql` scripts are not re-runnable; they fail if already applied.
- The `.py` scripts say in their docstring what they do, whether they can be re-run,
  and what they need (network access, `requests`).
- 007 sets the version to 7. The server takes over from there.

## Adding one

1. Name it with the next number: `NNN_what_it_does.sql`. Plain SQL only, without
   `BEGIN`/`COMMIT` (the server wraps it) and without setting `user_version`.
2. Register it at the end of `MIGRATIONS` in `src/migrate.rs`.
3. Make the same change in `src/init.sql` and raise its `PRAGMA user_version`, so a
   fresh database ends up identical to a migrated one.
4. Run `cargo test`: it fails if a script isn't registered or `init.sql` is behind.

Foreign keys are off while a script runs, so a table can be rebuilt (create new, copy,
drop, rename) without cascading into the rows that reference it.
