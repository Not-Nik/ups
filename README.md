# ups

ups is a service for hosting predictions for sports matches or anything resembling them. It was originally written
for the german "Uniliga"'s (University League) Overwatch division. The name PULOW ("Predictions für die Uniliga
Overwatch"/"Predictions for the Uniliga Overwatch") comes from TULOW ("Talk zur Uniliga Overwatch"/"Talk regarding
Uniliga Overwatch"), a popular podcast within the community.

## Stack

The service is written as a Rust app that serves plain HTML, CSS and JS alongside a REST API. The backend stores
data in a single SQLite database. While this approach is not very scalable, for small leagues like Uniliga with
roughly 400 individual participants, the site won't see more than 1000 visitors in a week, so probably at most one
(1) request per second. It has the upside of being easily deployable, maintainable and readable. At least the Rust
code is carefully written, to be decently hackable. If you can't make sense of the web side, ask a coding AI of your
choice for help.

## Self-hosting

With a simple stack comes simple self-hosting. The only complicated thing about the server is TLS. You'll need
`fullchain.pem` and `privkey.pem` from your SSL certificate provider. If you are using certbot, these will likely be
at `/etc/letsencrypt/live/yourdomain/`. Both files need to be put into certs.

Apart from that, these commands should be enough to get an empty instance up and running:

```
sqlite3 db.sqlite3 < src/init.sql

cargo run --release
```

An empty instance is not very useful, obviously, so you'll have to add match data into the database manually. The
provided script `scrape_matches.py` gathers data from toornament to insert into the database. It filters based on
some specific conditions of the league it was written for. It also replaces each stage that starts with a plain
"Stage" to "Day". Uniliga Overwatch uses Swiss Format for it's fourth division only, because it can't be created
with "Day". Alternatively, you can write your own script to write data based on `scrape_matches.py` and `src/init.sql`.

## What to change for your league

If you're not hosting for Uniliga Overwatch, there are some specific things you'll have to edit besides the scraper
script. In `src/app.js` the `sectionOrder()` function is specific to the way Uniliga matches are organised, which
might not work for your league. Specifically the german words for first, second and third are used for sorting. If
you have a simple (i.e. single-division with Days) toornament to pull data from, the code will likely still work,
because it sorts by toornaments 'Day x' parameter.
