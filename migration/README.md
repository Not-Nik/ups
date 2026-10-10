# Migrations

Scripts that take an existing `db.sqlite3` to the schema the code expects. A new
database doesn't need them: `src/init.sql` always describes the current schema.

They are numbered in the order they must be applied. There is no record in the
database of which ones have run, so work out the starting point from the schema
(`sqlite3 db.sqlite3 .schema`) or from the commit the deployment was built from:
apply every script that is newer than that commit, in order.

## Applying

From the repository root, with the server stopped:

```sh
cp db.sqlite3 db.sqlite3.bak                      # always back up first

sqlite3 db.sqlite3 < migration/NNN_name.sql       # .sql scripts
uv run python migration/NNN_name.py db.sqlite3    # .py scripts

# afterwards: must print nothing but "ok"
sqlite3 db.sqlite3 "PRAGMA foreign_key_check; PRAGMA integrity_check;"
```

- `.sql` scripts are not re-runnable; they fail if already applied.
- `.py` scripts say in their docstring what they do, whether they can be re-run, and
  what they need (some read from toornament, so they need network access).

## Adding one

1. Name it with the next number: `NNN_what_it_does.sql`, or `.py` when plain SQL isn't
   enough.
2. Make the same change in `src/init.sql`, so a fresh database ends up identical to a
   migrated one.
3. Say in a comment at the top what it does and anything to do by hand afterwards.
