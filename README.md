# GTFS2 Stop Card

**This repository is a fork.** It started as [gtfs2-live-card](https://github.com/Pulpyyyy/gtfs2-live-card)
(MIT, © Pulpyyyy) — a Lovelace card that boards the departures of whole transit
*lines*, chains them into journeys and draws the network's route shapes — and
became a different card doing something quite different: a **stop-centric**
companion for [gtfs2](https://github.com/vingerha/gtfs2) **local-stop sensors**,
the per-stop sensors gtfs2 creates around a person or a zone.

The two cards are not interchangeable:

| | gtfs2-live-card (upstream) | gtfs2-stop-card (this repo) |
|---|---|---|
| Reads | route/line trip sensors | **local-stop sensors** (`next_departures_lines`) |
| Perspective | the line: its whole route, its shapes, journeys with changes | the stop: what leaves here, and what is rolling near it |
| Map | route shapes, all of a line's vehicles | stops as rings, the vehicles **running the board's departures**, joined by `trip_id` |
| Journey planner | yes (chained legs, changes) | no — the board and the map are the card |
| Vehicle feed | per-line realtime feeds | one agency-wide GTFS-RT protobuf file, decoded in the card |
| Distribution | HACS | private; deployed by script to one Home Assistant instance |

The fork lives in `dist/stop/` (element names `gtfs2-stop-card` /
`gtfs2-stop-card-editor`) under its own `CARD_VERSION`, so it can coexist with
the untouched original in `dist/`. The original's licence and attribution carry
over; its README and docs describe the *upstream* card and stay in
`docs/` and the upstream repo. What this fork's card does and how to configure
it: **[README-STOP.md](README-STOP.md)**.

## Install (no HACS)

Terminal & SSH add-on running, then:

```powershell
.\deploy.ps1 -HaHost <host> -HaUser root
```

The script copies `dist/stop/` (card + lang files) to `/config/www/gtfs2-stop-card/`
and prints the resource URL. Add it once as a **JavaScript module** resource
(Settings → Dashboards → Resources):

```
/local/gtfs2-stop-card/gtfs2-stop-card.js?v=<CARD_VERSION>
```

## Development

No build step: `dist/stop/` is the source and HACS deploys it as it is. After
editing, redeploy and bump `CARD_VERSION` (see pitfalls). Checks:

```powershell
python build.py --check        # the five language files keep the same keys
uv run --no-project --with websocket-client python -I docs/stop_shots.py
# frozen-data harness screenshots into images/stop/; or open
# docs/stop-harness.html in a browser served from the repo root
```

## Pitfalls (learned the hard way)

Things that have bitten more than once. Read before changing the card.

**Caching — bump the version, both places.** HA serves `/local/` files with a
cache of about a month; a stale `?v=` in the Lovelace resource keeps old code
(or old language keys) alive no matter what you redeploy. Every deploy that
touches anything must bump `CARD_VERSION` in `dist/stop/gtfs2-stop-card.js`
*and* update the resource URL's `?v=` to match. Symptom when skipped: a fix
that "does not work", or a fresh UI string showing as its raw key.

**`deploy.ps1` runs outside Claude's sandbox.** Permission rules block
`ssh`/`scp` from the agent; run the script yourself in the session with the
`!` prefix — note the `!` prompt is Git Bash, so the backslash is eaten:
`! powershell -ExecutionPolicy Bypass -File deploy.ps1 -HaHost <host> -HaUser root`.
The SSH user is `root`; the `homeassistant` user is denied. The host lives in
`~/.ssh/known_hosts`.

**`_lineColorOf` never says "no".** It falls back to the def's own colour and
returns non-null, so it cannot answer *does this stop serve this route?* Read
the `codeColors` maps directly — and across **all** defs, not just the vehicle's
own, because of the next one.

**One agency-wide feed, one claimant.** All stops read the same positions file
and a vehicle is attached to the first def (in card order) that lists it — that
def may not even serve the vehicle's route. Anything keyed on `def.idx` for a
vehicle (colour, dimming, filtering) is wrong; resolve the vehicle's **route
code** first (trip_id → board row → code, else reverse `route_ids`) and work
from the code. Header badges are the same story: one badge per route *code*,
the line pick carries the code (`_hiRoute`), not a stop index.

**TransLink feed quirks.** The positions feed carries no bearing — arrows are
derived (predicted stop-sequence path, else position history). TransLink's
static zip has no `shapes.txt` — trip paths are stop-sequence polylines from
`docs/extract_shapes.py` → `/config/www/gtfs2-static/{rid}_shapes.json`; rerun
it when the static zip updates. The localstop `.rt` files gtfs2 writes are
trip-updates only, never vehicle positions.

**Split layout (`layout: "split"`).** `#focus-panel` shares a grid row with
`#dep-body` and must keep `pointer-events: none` (children re-enabled) or it
eats wheel events; hide the map head in the stylesheet, not with inline
`display` (an inline style beats the ≤840px media query and un-stacks nothing);
`#dep-body`'s split overflow must reset to visible/auto in that media query or
the card becomes a dead scroll container on narrow screens. And the harness's
ha-card stub must not set inline `display` — it would beat the card's grid rule.

**Version regex.** `deploy.ps1` reads `CARD_VERSION` within the first 5 lines
of the card, not line 1 — the header comment grew. Keep the constant up there.

**Verify with the harness, not by faith.** `docs/stop_shots.py` renders the
card against frozen data in Edge via CDP; screenshots land in `images/stop/`
(gitignored). Page `split` shows the two-column layout.
