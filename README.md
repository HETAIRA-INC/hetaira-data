# hetaira-data

Master catalog data for multiple artists. Edited locally, deployed as static JSON.

## Layout

```
artists.json         artist registry (uuid, slug, name, idPrefix, site, defaultTag)   [shared]
tags.json            canonical tag vocabulary {slug,label,aliases,count}                [shared]
triggers.json        canonical trigger vocabulary                                       [shared]
summary-all.json     all artists' summaries merged — for cross-artist search            [generated]
<artist-uuid>/
  data.json          master records (the file you edit via the admin UI)
  summary.json       slim list for the grid                                            [generated]
  records/<uuid>.json  one file per record for the detail page                         [generated]
  backups/           automatic data.json backups + orphaned record files (git-ignored)
```

## First-time setup

```
npm install
npm run migrate      # creates artists/tags/triggers.json from existing data (safe to re-run)
```

`migrate` moves any `records/*.json` that has no matching entry in `data.json` into
`<artist-uuid>/backups/orphans/` instead of deleting it. Review those once.

## Editing data

```
npm start            # http://localhost:3000/admin/server.html  (localhost only; PORT=4000 npm start to change)
```

Pick the artist in the header dropdown. Saving validates, canonicalizes tags/triggers
through the vocabularies, backs up the previous `data.json`, and regenerates all derived files.
Then commit and push.

Media is written to `MEDIA_DIR` (default `../hetaira-c1` if present, else `./media`), using the same layout the
frontend reads:

```
<artist-uuid>/cover/<record-uuid>.<ext>
<artist-uuid>/audio/<record-uuid>.<ext>
```

A record's `cover` / `file` fields hold exactly that relative path (or a full http(s) URL). Commit the media repo separately.
Uploads go to the server as raw binary (audio up to 500 MB, covers up to 25 MB).

## Commands

| Command | What it does |
|---|---|
| `npm run check` | validate every artist's data.json and fail if generated files (summary*.json, records/, counts) are out of date; changes nothing (CI-friendly) |
| `npm run build` | validate + normalize + regenerate all derived files |
| `npm run add-artist -- "Name" --prefix EROS-XX- --site https://...` | create a new artist catalog |
| `python scrapper.py https://site.tld 2500 2501 > posts.json` | fetch WordPress posts as a JSON array for the admin's *Batch Ingest* dialog |

## Vocabularies

Records store canonical labels (e.g. `FEMDOM`). To merge variants, add them to a tag's
`aliases` in `tags.json` (e.g. `"aliases": ["Fem Dom", "Female Domination"]`) and run
`npm run build`; every record is rewritten to the canonical label.
Unknown tags/triggers entered in the admin UI are added automatically.

## Identity rules

`uuid` is the unique identity of a record (it names `records/<uuid>.json` and the media files).
`id` is a protocol/group key shared by variants (ORIGINAL, VIDEO, ...), so duplicate ids are fine.
Only a duplicate `uuid` blocks a save; the same `id` + `variant` twice is reported as a warning.

## Local preview of the public site

The site in `hetaira-db` reads its data from `DB_BASE_URL` (GitHub raw by default). To preview unpublished changes,
run `npm start` here, serve `hetaira-db` with any static server (e.g. VS Code Live Server) and open it once with
`?local=1` (e.g. `http://127.0.0.1:5500/index.html?local=1`). That points the site at `http://localhost:3000`;
`?local=0` switches back. The override only works when the page itself is served from localhost.
