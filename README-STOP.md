# GTFS2 Stop Card

A private, stop-centric version of [gtfs2-live-card](https://github.com/Pulpyyyy/gtfs2-live-card)
(MIT, © Pulpyyyy) for [gtfs2](https://github.com/vingerha/gtfs2) **local-stop
sensors** — the per-stop sensors gtfs2 creates around a person or zone. Not
published to HACS; built for one Home Assistant instance (HAOS).

- **Departures board** from one or several local-stop sensors: realtime
  times and delays (already merged by gtfs2), the route code as the badge,
  the headsign as the destination.
- **Map** with a marker at each stop (the sensor's own coordinates),
  the vehicles running the board's departures — **joined by `trip_id`** —
  their heading (feed `bearing`, else derived from successive positions)
  and their recent path. No route shapes.

The original card stays untouched in `dist/`; this one lives in `dist/stop/`,
under its own element names, so both can coexist.

## Install (no HACS)

Deploy with the script (Terminal & SSH add-on must be running):

```powershell
.\deploy.ps1 -HaHost home.local -HaUser root
```

Then once, in Home Assistant: Settings → Dashboards → Resources → Add resource

- URL: `/local/gtfs2-stop-card/gtfs2-stop-card.js?v=<version the script prints>`
- Type: **JavaScript Module**

The script prints a `?v=` matching the card's `CARD_VERSION`; after an update,
redeploy and update that `?v=` to bust browser caches. The language files
cache-bust themselves.

## Configuration

```yaml
type: custom:gtfs2-stop-card
title: Buses nearby
stops:
  - sensor.xxx_local_stop_zone.home          # bare entity id…
  - entity: sensor.xxx_local_stop_zone.work  # …or an object
    label: Work stop
    # positions_url: /local/gtfs2/6613_0.json   # optional override
# departure route code -> gtfs2's internal route id, which the positions
# files under /config/www/gtfs2/ are named by ({route_id}_{direction}.json)
route_ids:
  "003": "6613"
  "015": "6627"
max_departures: 8
# vehicles on the map: all running a board departure (default), or also
# same-route vehicles near a stop
# max_vehicles: nearby
# nearby_radius_km: 0.5
```

Options: `title`, `stops`, `route_ids`, `positions_url` (global override),
`stop_color`, `mode_icons`, `show_departures`, `show_map`, `map_style`
(`auto`/`light`/`dark`), `map_aspect`, `latitude`/`longitude` (map-centre
fallback), `refresh` (s), `max_departures`, `max_vehicles` (`true` or
`nearby`), `nearby_radius_km`.

`route_ids` needs one entry per route you care about; find the ids in the
file names gtfs2 writes under `/config/www/gtfs2/`.

## Development

No build step. Edit `dist/stop/gtfs2-stop-card.js` or the `lang/*.js` files
beside it; reload. `python build.py --check` verifies the five language
files keep the same keys. A frozen-data test harness renders the card in a
plain browser without Home Assistant:

```powershell
uv run --no-project --with websocket-client python -I docs/stop_shots.py   # screenshots into images/stop/
# or open docs/stop-harness.html in a browser served from the repo root
```

Based on gtfs2-live-card by Pulpyyyy (MIT); the original's licence and
attribution carry over to this fork.
