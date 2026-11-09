// Based on gtfs2-live-card by Pulpyyyy (MIT), modified for gtfs2
// local-stop sensors. See LICENSE.
const CARD_VERSION = "0.1.7";

console.info(
    `%c 🚏 GTFS2 Stop Card %c v${CARD_VERSION} %c`,
    "background:#2196F3;color:white;padding:2px 8px;border-radius:3px 0 0 3px;font-weight:bold",
    "background:#4CAF50;color:white;padding:2px 8px;border-radius:0 3px 3px 0",
    "background:none"
);

/* ═══════════════════════════════════════════════════════════════════════════
 * GTFS2 Stop Card: two collapsible panes,
 *   1. departures merged from one or several gtfs2 local-stop sensors
 *      (the per-stop sensors gtfs2 makes around a tracked device; realtime
 *      delays already merged by the integration, departures keyed by trip)
 *   2. a slippy map (OpenStreetMap tiles, Web-Mercator) of the stops and of
 *      the vehicles running the departures on the board, joined by trip_id
 *      from the per-route realtime positions files gtfs2 writes
 *
 * Minimal config: a list of local-stop sensors; the stop's own coordinates,
 * name and departures all come from the sensor attributes, with explicit
 * YAML values always overriding. route_ids maps a departure's route code
 * ("003") to the gtfs2 route id its positions file is named by ("6613").
 *
 * i18n: all user-facing strings exist in en, fr, de, es and pt (the gtfs2
 * project languages), in the language of the user's Home Assistant
 * profile. A visual editor is provided for the simple, sensors-list
 * configuration.
 *
 * LAYOUT: this file plus one module per language in ./lang/, card and editor
 * strings together, loaded at runtime from wherever this file was installed.
 * There is no build step: edit either and reload.
 * ═══════════════════════════════════════════════════════════════════════════ */

const DEFAULTS = {
    title: null,
    stop_color: "#0072bc",
    positions_url: null,      // optional global override; per stop wins
    // the agency-wide GTFS-RT vehicle-positions feed gtfs2 saves locally
    // (protobuf). When set, it is the one source of vehicles: complete
    // for every route and direction, no per-route files needed. The
    // per-route geojson stays as the fallback when it is not set.
    positions_feed: null,
    stops: null,              // list of local-stop sensor entity_ids and/or {entity?, positions_url?, label?}
    route_ids: null,          // {routeCode: gtfs2RouteId} - the positions files are named by the latter
    mode_icons: true,         // mode chip (mdi) on the route badges
    // A pane can be COLLAPSED, which the card remembers per user, or hidden
    // outright, which is the dashboard's decision and sticks for everyone:
    // a departures-only card in a column, a map-only card next to it.
    show_departures: true,    // the departures pane, its header included
    show_map: true,           // the map pane, its header included
    map_style: "auto",        // auto | light | dark | custom template with {z}/{x}/{y}
    map_aspect: null,         // e.g. "4/3", overrides the responsive default
    latitude: null,           // optional map-center fallback (the stop markers use the sensor's own)
    longitude: null,
    refresh: 60,
    max_departures: 8,
    group_by: "stop",         // one section per stop on the board; "none" merges them
    // Which vehicles the map shows: true, only those running a departure on
    // the board (joined by trip_id); "nearby", also same-route vehicles
    // within nearby_radius_km of a configured stop
    max_vehicles: true,
    nearby_radius_km: 0.5,
};

// The keys a stop entry takes for its overrides
const LINE_KEYS = ["positions_url", "label"];

// the colours of lines their feed gives none, taken in turn: two such lines
// never share one. Dark enough for white text, far from the usual red
const FALLBACK_COLORS = ["#0072bc", "#7b3fa0", "#00897b", "#c2185b", "#6d4c41", "#455a64"];

// A gtfs2 local-stop sensor: the departures of one stop around a tracked
// device, realtime delays already merged by the integration, each departure
// carrying its trip_id - what the map's vehicles are joined by.
const isStopSensor = (id, st) => String(id).startsWith("sensor.") && !!st?.attributes
    && ("device_tracker_id" in st.attributes)
    && ("next_departures_lines" in st.attributes || "next_departures" in st.attributes);

// Every stop of a card, [{entity, positions_url?, label?, idx}], in the
// order given: a local-stop sensor entity_id, or an object naming one with
// its settings (LINE_KEYS). A card of one sensor, entity:, is a list of one.
const cardEntries = (config) => {
    const out = [];
    const stops = Array.isArray(config?.stops) && config.stops.length ? config.stops
        : config?.entity || config?.positions_url
            ? [{ entity: config.entity, positions_url: config.positions_url }]
            : [];
    for (const e of stops) {
        const o = typeof e === "string" ? { entity: e } : e && typeof e === "object" ? e : null;
        if (!o || !o.entity) continue;
        const over = {};
        for (const k of LINE_KEYS) if (o[k] != null && o[k] !== "") over[k] = o[k];
        out.push({ entity: String(o.entity), idx: out.length, ...over });
    }
    return out;
};


const WORLD = 1 << 28;        // Web-Mercator world size, in "world units"
// Chrome caps every SVG length - cx, x, width, a transform's translate -
// at 2^25, only path data escapes it. Drawn in world units, a card whose
// lines span two continents had its stops pinned against that wall,
// thousands of kilometres from where they belong, and the vehicles stuck in
// the middle of the map. One SVG unit is this many world units: the whole
// world then stays under 2^24, at about a centimetre.
const SVG_UNIT = 16;
const vehTransform = (v) => `translate(${v.x.toFixed(3)}px, ${v.y.toFixed(3)}px)`;
// the overlay's numbers, at the precision SVG_UNIT asks for
const vbAttr = (vb) => vb.map((v) => (v / SVG_UNIT).toFixed(3)).join(" ");
const EARTH_CIRC = 40075016.686;
const HIST_MAX = 30;
// a departure rides the board this long past its time, then leaves - and
// its vehicle with it
const DEPART_GRACE_MS = 2 * 60000;
// the scheduled paths drawn around the card's stops: a trip's path only
// shows within this distance of a stop, so a run that started across town
// does not drag its whole morning across the map
const PATH_RADIUS_M = 2000;
// the fitted view reaches this far past the stops; a vehicle farther out
// is still drawn, off screen until the user pans there
const FIT_RADIUS_M = 3000;
const HIST_TTL = 15 * 60000;  // forget vehicles gone from the feed this long
const STALE_FEED = 8 * 60000;  // a positions file not rewritten this long = the source has gone quiet
// realtime a sensor has not refreshed this long is no longer live: three of
// gtfs2's default quarter hours missed
const RT_STALE = 45 * 60000;

// One geometry for every corner mark a badge can carry, because a badge can
// carry four of them and marks of different sizes in different corners would
// read as an accident. Only the contents and the colour change.
//
// 28 / 7 / 14 is the largest that clears the number. The dimensioning label is
// NOT the longest one: the badge is a fixed 60 square and the number shrinks to
// fit its 40 usable pixels, so "999B" drops to 17px and its short ink clears
// the corners easily. "40" keeps its full 28px and decides, with 0.7px to
// spare. The gap has to be twice the overhang: with four corners in use, one
// badge's right-hand pip faces the next badge's left-hand pip.
const PIP = 28;                // diameter
// Ink radius: the disc less an optical ring. 1px was the geometric maximum and
// looked wrong - a glyph whose furthest point is a long edge rather than a
// spike (the cable bar, the funicular diagonal, the tram body) reads as
// bursting out of its disc. 2.5px is where every glyph in the set stops
// touching; past 3px they start looking a size too small again.
const PIP_INK = PIP / 2 - 2.5;
// The badge's own corner mark. Kept apart from PIP, which is also the unit
// the glyph viewBox is drawn in: shrinking PIP would take a few per cent off
// every glyph of the card, medallions and plates included, for a change that
// only concerns the badge.
const BADGE_PIP = 22;
const PIP_GAP = 11;            // between badges, = 2 x the 5.5px overhang
// the narrowest the header's text zone is allowed to get before it stops
// sharing a row with the badges and takes one of its own
const TITLES_MIN = 96;

// A badge is a fixed square, and the number shrinks to fit it (badgeFontSize).
// 44 is the smallest square that still answers a finger, and it puts seven
// lines on one row of a 470px card where 60 put six. The padding goes down
// with it, to 6, so the number keeps the 32px of room it had at 60/10 - the
// square shrinks, the digits do not.
const BADGE_W = 44, BADGE_PAD = 6, BADGE_FS = 21;

// Map text sized in world units: Chrome caps a computed font-size at
// 10000px, which a view a hundred kilometres wide reaches (a 10 px label is
// then some 60000 units), and the label shrinks to a dash. The text is set
// at its pixel size and scaled by the units per pixel instead.
const svgText = (x, y, px, u, attrs, body) =>
    `<text transform="translate(${x.toFixed(3)} ${y.toFixed(3)}) scale(${u})" font-size="${px}" ${attrs}>${body}</text>`;
const BADGE_FS_MIN = 11;

// Font size the number takes so it fits the badge without the badge moving.
// Measured against the real family rather than counted in characters: a per
// character estimate holds for digits, which all share one advance, and comes
// apart on letters - "WWW" is half again as wide as "111" at the same size.
// Falls back on the full size if the canvas is unavailable, in which case the
// badge clips rather than growing, which is still the lesser wrong.
const _fitCtx = (() => {
    try { return document.createElement("canvas").getContext("2d"); }
    catch (e) { return null; }
})();
const badgeFontSize = (label, family) => {
    const usable = BADGE_W - 2 * BADGE_PAD;
    if (!_fitCtx || !label) return BADGE_FS;
    _fitCtx.font = `700 ${BADGE_FS}px ${family || "Roboto, sans-serif"}`;
    const w = _fitCtx.measureText(String(label)).width;
    if (!w || w <= usable) return BADGE_FS;
    return Math.max(BADGE_FS_MIN, Math.floor(BADGE_FS * usable / w * 10) / 10);
};
const LABEL_SPAN = 3000;      // stop names label themselves under this map width (metres)
const MARKER_SPAN_MIN = 600;  // at or under this map width, vehicle markers are full size
const MARKER_SPAN_MAX = 12000;// at or over it, they sit at their smallest
const FAR_PX = 48;            // the network under this many css px across: zoomed out past it
const DBL_MS = 500;           // a click this soon after one that tracked a vehicle is its double
const FOLLOW_MS = 700;        // vehicle glide: CSS transition of .bus, popup glide and camera follow

// cubic-bezier easing, the same curve as the CSS timing functions, so a JS
// animation can run in lockstep with a CSS transition
const bezier = (x1, y1, x2, y2) => {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t;
    const sy = (t) => ((ay * t + by) * t + cy) * t;
    const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let t = x;
        for (let i = 0; i < 8; i++) {
            const d = dx(t);
            if (Math.abs(d) < 1e-6) break;
            t -= (sx(t) - x) / d;
        }
        return sy(Math.max(0, Math.min(1, t)));
    };
};
const EASE_OUT = bezier(0, 0, 0.58, 1);   // CSS "ease-out"
// The base map is MapLibre GL, loaded once per page from a CDN, drawing the
// VersaTiles styles on their public vector tiles (Shortbread schema,
// OpenStreetMap data, CORS open, no key): gray in the light theme,
// gray-dark in the dark one. The card keeps its own camera (the SVG viewBox)
// and MapLibre follows it, so the overlay's geometry, gestures and
// animations are untouched: the canvas only replaced the raster tiles.
const MAPLIBRE_VERSION = "6.9.0";
const MAPLIBRE_JS = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.mjs`;
const MAPLIBRE_CSS = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
const MAP_STYLES = {
    light: "https://tiles.versatiles.org/assets/styles/gray/style.json",
    dark: "https://tiles.versatiles.org/assets/styles/gray-dark/style.json",
};
const MAP_CREDIT = "© OpenStreetMap contributors";
// source layers left out of the styles: building footprints load the picture
// at street zooms without helping to read a line
const MAP_HIDE_LAYERS = new Set(["buildings"]);
let MAPLIBRE = null;          // promise of the module namespace, shared by every card on the page
function loadMapLibre() {
    if (!MAPLIBRE) {
        MAPLIBRE = import(MAPLIBRE_JS).then((m) => m.default || m);
        // a failed load (offline, blocked CDN) is retried by the next map build
        MAPLIBRE.catch(() => { MAPLIBRE = null; });
    }
    return MAPLIBRE;
}

/* ── i18n ───────────────────────────────────────────────────────────────── */

/* Every language is a file of its own in ./lang/, edited straight there and
 * fetched the first time it is needed. There is no build step and no language
 * baked into this file: en.js is simply the one to copy when adding a new one.
 *
 * `tr()` stays synchronous because every render path calls it, the 30-second
 * countdown tick included, and none of them can await. What makes that safe is
 * that the card does not render at all until its language has landed: see the
 * `_langReady()` guard in _update(). So by the time anything calls `tr()`, the
 * strings are already in.
 *
 * Adding a language: copy ./lang/en.js, translate the values, and add its code
 * to LANGS below. */

const LANGS = ["en", "fr", "de", "es", "pt"];   // the gtfs2 project languages

const LANG = {};

/* Resolved against this file's own URL, so the same code works under
 * /hacsfiles/gtfs2-live-card/ (HACS) and /local/ (manual install) without
 * having to know which one it is. The card's version goes with it: the
 * files are served for a month from the browser's cache, and asked for by
 * their bare name they stayed the last release's after an update, its new
 * strings shown as their keys ("view_keep"). Each release asks for its own */
const LANG_URL = (code) => new URL(`./lang/${code}.js?v=${CARD_VERSION}`, import.meta.url).href;

const LANG_PENDING = new Map();   // code → promise, so five cards fetch once
const LANG_WAITING = new Set();   // elements to notify when a language lands

/* Fetches one language, then tells everything that asked for it to render.
 *
 * A failure is recorded rather than retried: `LANG[code]` is filled with an
 * empty set of tables, which makes `tr()` fall back to the keys themselves. A
 * card showing "departures" is poor, but it is on screen and it says why in
 * the console, where a card blocked forever on a missing file would just be
 * blank. */
const loadLang = (code) => {
    if (LANG[code] || !LANGS.includes(code) || LANG_PENDING.has(code)) return;
    LANG_PENDING.set(code, import(LANG_URL(code))
        .then((mod) => {
            const data = mod?.default;
            if (!data?.strings) throw new Error("no default export with strings");
            LANG[code] = data;
        })
        .catch((err) => {
            console.error(`gtfs2-live-card: could not load ${LANG_URL(code)}, the card `
                + `will show its string keys instead of ${code} text`, err);
            LANG[code] = { strings: {}, modes: {}, editor: {} };
        })
        .finally(() => {
            for (const el of [...LANG_WAITING]) el._langArrived(code);
        }));
};

const tr = (lang, key, vars) => {
    let s = LANG[lang]?.strings?.[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    return s;
};

const modeWords = (lang) => LANG[lang]?.modes || {};

const editorLabels = (lang) => LANG[lang]?.editor || {};

const modeWord = (lang, key, plural) => {
    const w = modeWords(lang);
    return (w[key] || w.vehicle || [key, key])[plural ? 1 : 0];
};

// GTFS route_type (incl. extended codes) → mode key
const modeKey = (rt) => {
    const n = parseInt(rt, 10);
    if (!isNaN(n)) {
        if (n === 0 || n === 5 || (n >= 900 && n < 1000)) return "tram";
        if (n === 1 || (n >= 400 && n < 500)) return "metro";
        if (n === 2 || (n >= 100 && n < 200)) return "train";
        // 200 to 209 is Coach Service in the GTFS extended types: a long
        // distance bus, not a train. It rode along as a train for as long as
        // the two glyphs were the same rounded box.
        if (n === 3 || (n >= 200 && n < 300) || (n >= 700 && n < 800)) return "bus";
        if (n === 4 || n === 1000 || n === 1200 || n === 1502) return "ferry";   // 1000 is water transport, 1502 a water taxi
        if (n === 11 || n === 800) return "trolleybus";
        if (n === 6 || n === 1300) return "cable";
        if (n === 7 || n === 1400) return "funicular";
        if (n === 12) return "monorail";
        if (n === 1100) return "air";
        if (n >= 1500 && n < 1600) return "taxi";
        if (n >= 1700 && n < 1800) return "vehicle";   // "miscellaneous", the codes that name nothing
        return "bus";
    }
    const s = String(rt || "").toLowerCase();
    for (const k of ["tram", "metro", "train", "ferry", "trolleybus", "funicular", "monorail", "taxi"]) if (s.includes(k)) return k;
    if (s.includes("métro")) return "metro";
    if (s.includes("rail")) return "train";
    return "bus";
};


// One glyph table for the whole card, drawn for this card rather than taken
// from mdi. mdi draws bus, metro, train and monorail as the same rounded box
// with two windows: legible at 24px, a single blob at the 10px an unfocused
// map marker gets. Here each mode carries its signature on its silhouette,
// where low resolution cannot rub it out: a pantograph over the tram, a beam
// under the monorail, a tunnel arch for the metro, two coupled cars for the
// train. No glyph has a counter either. Window bands are gaps of at least two
// grid units between solid masses, so they close cleanly as the glyph shrinks
// instead of filling in and turning the whole thing grey.
//
// Rendered at 10px, the closest pair of the set sits at 0.21 of average pixel
// distance; the mdi outlines it replaces sat at 0.06 (metro against train),
// and mdi:bus was byte for byte the same path as the fallback vehicle.
//
// The map SVG cannot host an <ha-icon> HTML element, so the badges draw from
// this same table rather than from ha-icon, and a mode looks identical
// wherever it shows up.
const GLYPH_PATHS = {
    bus: "M4.6 6H19.4A1.6 1.6 0 0 1 21 7.6V9.4H3V7.6A1.6 1.6 0 0 1 4.6 6ZM3 11.4H21V15.6A1.6 1.6 0 0 1 19.4 17.2H4.6A1.6 1.6 0 0 1 3 15.6ZM5 17.4A2.4 2.4 0 0 0 9.8 17.4A2.4 2.4 0 0 0 5 17.4ZM14.2 17.4A2.4 2.4 0 0 0 19 17.4A2.4 2.4 0 0 0 14.2 17.4Z",
    trolleybus: "M3.2 1.6H20.8A1.2 1.2 0 0 1 20.8 4H3.2A1.2 1.2 0 0 1 3.2 1.6ZM13.4 8.2H16L9.4 4H6.8ZM4.6 8H19.4A1.6 1.6 0 0 1 21 9.6V11.4H3V9.6A1.6 1.6 0 0 1 4.6 8ZM3 13.4H21V17.4A1.6 1.6 0 0 1 19.4 19H4.6A1.6 1.6 0 0 1 3 17.4ZM5.2 19.2A2.2 2.2 0 0 0 9.6 19.2A2.2 2.2 0 0 0 5.2 19.2ZM14.4 19.2A2.2 2.2 0 0 0 18.8 19.2A2.2 2.2 0 0 0 14.4 19.2Z",
    tram: "M12 2.4L16.6 5.2L12 7.4L7.4 5.2ZM8.2 6.6H15.8A1.6 1.6 0 0 1 17.4 8.2V10.4H6.6V8.2A1.6 1.6 0 0 1 8.2 6.6ZM6.6 12.4H17.4V17.4A1.4 1.4 0 0 1 16 18.8H8A1.4 1.4 0 0 1 6.6 17.4Z",
    metro: "M3 21V13A9 9 0 0 1 21 13V21H17V13A5 5 0 0 0 7 13V21ZM10.6 14H13.4A1.6 1.6 0 0 1 15 15.6V21H9V15.6A1.6 1.6 0 0 1 10.6 14Z",
    train: "M3.2 7.6H11V10.4H2V8.8A1.2 1.2 0 0 1 3.2 7.6ZM2 12.4H11V16.4H3.2A1.2 1.2 0 0 1 2 15.2ZM12.4 7.6H18.8L21.2 10.4H12.4ZM12.4 12.4H22V15.2A1.2 1.2 0 0 1 20.8 16.4H12.4Z",
    monorail: "M9 3.6H15A3.6 3.6 0 0 1 18.6 7.2V7.6H5.4V7.2A3.6 3.6 0 0 1 9 3.6ZM5.4 9.6H18.6V14.4A1.2 1.2 0 0 1 17.4 15.6H6.6A1.2 1.2 0 0 1 5.4 14.4ZM3.2 16.8H20.8A1.4 1.4 0 0 1 22.2 18.2V18.8A1.4 1.4 0 0 1 20.8 20.2H3.2A1.4 1.4 0 0 1 1.8 18.8V18.2A1.4 1.4 0 0 1 3.2 16.8Z",
    ferry: "M2.4 13.6H21.6L18.8 20.4H5.2ZM9 7.6H15A1.4 1.4 0 0 1 16.4 9V11.6H7.6V9A1.4 1.4 0 0 1 9 7.6ZM11.2 3.8H12.8V7.6H11.2Z",
    cable: "M1.8 3.6L22.2 7.8L21.8 9.6L1.4 5.4ZM11.2 6.2H12.8V11.6H11.2ZM9.6 10.6H14.4A3.6 3.6 0 0 1 18 14.2V16.8A3.6 3.6 0 0 1 14.4 20.4H9.6A3.6 3.6 0 0 1 6 16.8V14.2A3.6 3.6 0 0 1 9.6 10.6Z",
    funicular: "M2.4 19.6L20.4 6.4V9.2L2.4 22.4ZM7.1 14.8L14.4 9.5L10.8 4.6L3.6 9.9Z",
    vehicle: "M12 3.2L20.6 21.6L12 18L3.4 21.6Z",
    taxi: "M8.2 3H15.8A1.2 1.2 0 0 1 17 4.2V6.6H7V4.2A1.2 1.2 0 0 1 8.2 3ZM8.4 8.6H15.6L19 12.8H5ZM3.4 12.8H20.6A1.4 1.4 0 0 1 22 14.2V16.6A1.4 1.4 0 0 1 20.6 18H3.4A1.4 1.4 0 0 1 2 16.6V14.2A1.4 1.4 0 0 1 3.4 12.8ZM4.9 18.2A2.2 2.2 0 0 0 9.3 18.2A2.2 2.2 0 0 0 4.9 18.2ZM14.7 18.2A2.2 2.2 0 0 0 19.1 18.2A2.2 2.2 0 0 0 14.7 18.2Z",
    air: "M12 2A2 2 0 0 1 14 4V9.2L22 14V16.6L14 14.2V19.2L16.8 21.2V22.8L12 21.4L7.2 22.8V21.2L10 19.2V14.2L2 16.6V14L10 9.2V4A2 2 0 0 1 12 2Z",
    // Not a mode: the state of a source that has stopped reporting. Drawn to
    // the same rules as the modes so it can share their geometry - two solid
    // masses, no counter, a 4.5 unit gap that stays open as the glyph shrinks.
    // On the axis opposite the resting stroke, which runs "/": two marks that
    // mean different things must not rhyme.
    mute: "M2.97 6.23 L8.77 12.03 L12.03 8.77 L6.23 2.97ZM11.97 15.23 L17.77 21.03 L21.03 17.77 L15.23 11.97Z",
    // Not modes either: when a line that is not running today runs again.
    // Three silhouettes, round / square with tabs / cross, because a
    // silhouette is what survives shrinking - counting masses does not.
    //
    // tomorrow: a filled dial with an open quadrant. Hands would be thin
    // strokes and a rim would be a counter; both close up at this size.
    // days: page, header band and tabs. The 2.6 unit gap between band and
    // page is what holds it away from the vehicle glyphs, which are rounded
    // rectangles too and whose masses touch.
    // never: solid at the centre, which is what separates it from `mute`
    // (two masses with a gap) and from the resting stroke (one thin diagonal
    // across the whole badge).
    tomorrow: "M12 12L12 2.4A9.6 9.6 0 1 0 18.79 18.79Z",
    days: "M7 2.2H9.4V6.8H7ZM14.6 2.2H17V6.8H14.6ZM5.2 5.2H18.8A1.6 1.6 0 0 1 20.4 6.8V9H3.6V6.8A1.6 1.6 0 0 1 5.2 5.2ZM3.6 11.6H20.4V19.8A1.6 1.6 0 0 1 18.8 21.4H5.2A1.6 1.6 0 0 1 3.6 19.8Z",
    never: "M2.8 5.2L18.8 21.2L21.2 18.8L5.2 2.8ZM18.8 2.8L2.8 18.8L5.2 21.2L21.2 5.2Z",
    // Nor are these: what the operator says is going on, top-right corner.
    // Only `alert` is drawn from a sentence; the other two need gtfs2 to
    // publish the alert's GTFS-RT cause, so a network that never fills it in
    // always gets the generic mark and never a cone that would be a lie.
    //
    // alert: an exclamation, upright, no diagonal anywhere, so it cannot rhyme
    // with the quiet-source bars or the resting stroke.
    // incident: a bolt, one mass.
    // works: a cone, its stripe left as an open gap rather than a counter, and
    // its foot merged into the body so the shape survives at 23 px.
    alert: "M9.7 2.8H14.3L13.5 15.6H10.5ZM9.5 19.4A2.5 2.5 0 1 0 14.5 19.4A2.5 2.5 0 1 0 9.5 19.4Z",
    incident: "M13.8 2.2L5.2 13.6H10.4L9.2 21.8L18.6 10.0H13.0Z",
    works: "M10.4 3.0H13.6L15.6 10.2H8.4ZM7.7 13.4H16.3L17.6 18.0H19.6V21.6H4.4V18.0H6.4Z",
};

// the mdi icons that merely restate a mode, first one canonical. The card
// does not draw from these any more, but it still needs to tell an icon the
// integration picked for a route_type from one a user really chose: only the
// second is a decision, and only it deserves to override the mode glyph. One
// name per mode was not enough: the integration emits up to four of them for
// a single mode, which is how 34 route types out of 82 kept rendering an mdi
// outline instead of the glyph they were entitled to.
const MDI_DEFAULTS = {
    bus: ["mdi:bus", "mdi:bus-school"],
    trolleybus: ["mdi:bus-electric", "mdi:bus"],
    tram: ["mdi:tram", "mdi:train-variant"],
    metro: ["mdi:subway-variant", "mdi:subway"],
    train: ["mdi:train", "mdi:train-car", "mdi:train-variant"],
    monorail: ["mdi:train-variant"],
    ferry: ["mdi:ferry"],
    cable: ["mdi:gondola"],
    funicular: ["mdi:stairs-up", "mdi:stairs"],
    taxi: ["mdi:taxi", "mdi:train-variant", "mdi:bicycle-basket", "mdi:car-multiple"],
    air: ["mdi:airplane"],
    vehicle: ["mdi:bus", "mdi:train-car", "mdi:horse-variant"],
};

// Centre of the ink and the distance from it to the furthest painted point,
// per glyph, in the 24-unit grid: [cx, cy, r].
//
// A box was the wrong shape to measure with. Fitting the longest SIDE of the
// box to the disc inscribes the glyph in a square, and a square inside a
// circle leaves the four corners of the disc unused - measured on this set,
// between nothing and 27% of the glyph's size thrown away, the flatter the
// glyph the more. A radius says how far the drawing actually reaches, so the
// glyph can be grown until it touches the disc and no further.
//
// The centre stays the centre of the ink box, exactly where it was: only the
// scale changes, so no glyph shifts inside its pip. Measured by flattening
// each path, arcs included, and taking the extreme point - not by eye.
const GLYPH_FIT = {
    bus: [12.00, 12.90, 10.70],
    trolleybus: [12.00, 11.50, 13.57],
    tram: [12.00, 10.60, 9.29],
    metro: [12.00, 12.50, 12.38],
    train: [12.00, 12.00, 10.56],
    monorail: [12.00, 11.90, 12.58],
    ferry: [12.00, 12.10, 10.73],
    cable: [11.80, 12.00, 13.06],
    funicular: [11.40, 13.50, 12.66],
    vehicle: [12.00, 12.40, 12.59],
    taxi: [12.00, 11.70, 11.30],
    air: [12.00, 12.40, 11.45],
    mute: [12.00, 12.00, 10.72],
    // The one glyph whose centre is NOT its ink box: a slice of disc has lost
    // ink on one side, so the box centre sits at 10.6 and the dial would be
    // pushed off inside its pip - the very thing the rule exists to prevent.
    // Centred on the disc instead, and the reach from there is the radius.
    // Measured either way; this is the one where the rule had to be argued
    // with, and doing so also took the set's floor from 0.445 to 0.509.
    tomorrow: [12.00, 12.00, 9.60],
    days: [12.00, 11.80, 12.10],
    never: [12.00, 12.00, 11.44],
    alert: [12.00, 12.35, 9.82],
    incident: [11.90, 12.00, 10.17],
    works: [12.00, 12.30, 12.01],
};

// Which mark the top-right corner carries, from the alert's own cause and
// effect (gtfs2 publishes them as their GTFS-RT names). Anything unlisted,
// and anything with no cause at all, falls to the generic mark: a cone shown
// for a strike would be worse than a shrug.
const ALERT_WORKS = ["CONSTRUCTION", "MAINTENANCE"];
const ALERT_INCIDENT = ["ACCIDENT", "TECHNICAL_PROBLEM", "POLICE_ACTIVITY", "MEDICAL_EMERGENCY"];
const alertKind = (cause, effect) => (ALERT_WORKS.includes(cause) ? "works"
    : (ALERT_INCIDENT.includes(cause) || effect === "NO_SERVICE") ? "incident"
    : "alert");

// Whether an alert gtfs2 publishes applies to the ride ahead, from now to
// the next departure of its sensor (at, its attributes): one of its periods
// covers that span, or it has none (no period is the spec's "current").
// Anything else is not said at all. IDFM announces works weeks ahead, and a
// closure for next Saturday shown as tonight's turned metro 6 red on a
// quiet evening; one over is gone even when the sensor has not caught up.
const alertNow = (it, at, now = Date.now()) => {
    const periods = Array.isArray(it?.periods) ? it.periods : [];
    if (!periods.length) return true;
    const leaves = Date.parse(at?.next_departure_realtime || at?.origin_stop_departure_time || "");
    const until = Number.isNaN(leaves) ? now : Math.max(now, leaves);
    return periods.some((p) => {
        const s = p?.start ? Date.parse(p.start) : NaN;
        const e = p?.end ? Date.parse(p.end) : NaN;
        return (Number.isNaN(s) || s <= until) && (Number.isNaN(e) || e >= now);
    });
};

// glyph as a plain SVG path, centred on 0,0 and scaled so its ink reaches
// exactly r and no further. Returns null for a key we carry no outline for.
const modeGlyph = (mode, r, fill) => {
    const d = GLYPH_PATHS[mode];
    if (!d) return null;
    const [cx, cy, ri] = GLYPH_FIT[mode] || [12, 12, 12];
    const sc = r / ri;
    return `<path d="${d}" fill="${fill}" transform="scale(${sc.toFixed(4)}) translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)})"></path>`;
};


// the language of the user's Home Assistant profile, English when the card
// does not speak it: a dashboard is read in its reader's language, never in
// one its author picked
const resolveLang = (hass) => {
    const two = String(hass?.locale?.language || hass?.language || "en").toLowerCase().slice(0, 2);
    return LANGS.includes(two) ? two : "en";
};

/* ── helpers ────────────────────────────────────────────────────────────── */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// the text back from esc, for a message built as HTML and read again as words
const unesc = (s) => String(s ?? "").replace(/&(amp|lt|gt|quot|#39);/g, (m, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[k]));

// a board reads the same clocks over and over - every chip, every leg file
// stop, every run of a chain - and parsing a date string is not free: kept
// by their text, the Date shared (nothing here ever sets one)
const TS_CACHE = new Map();
const parseTs = (v) => {
    if (v == null || v === "-" || v === "") return null;
    const k = String(v);
    let d = TS_CACHE.get(k);
    if (d === undefined) {
        if (TS_CACHE.size > 20000) TS_CACHE.clear();
        d = new Date(k.replace(" ", "T"));
        if (isNaN(d.getTime())) d = null;
        TS_CACHE.set(k, d);
    }
    return d;
};

// A clock is read where the bus runs and written the way its reader wants.
// Its zone is the line's (the feed's agency_timezone, which every gtfs2
// publishes), else Home Assistant's: someone in New York looking at a bus
// in Caen sees 16:01, not 10:01. Its form is the reader's profile: Home
// Assistant's time format, 12 or 24 hours, else the convention of the
// profile's language, else the browser's. Every card of the page shares
// that profile, so the form is the page's, set by each card from its hass.
const CLOCK = { lang: undefined, tf: "language", zone: undefined };
const setClock = (hass) => {
    const tf = hass?.locale?.time_format || "language";
    const lang = tf === "system" ? undefined : hass?.locale?.language || hass?.language || undefined;
    const zone = hass?.config?.time_zone || undefined;
    if (lang === CLOCK.lang && tf === CLOCK.tf && zone === CLOCK.zone) return false;
    Object.assign(CLOCK, { lang, tf, zone });
    return true;
};

// one formatter per zone and form: toLocaleTimeString builds a new one at
// each call, and a board prints a clock some forty times. A zone or a
// language the browser does not know falls back on what it does
const FMTS = new Map();
const clockFmt = (zone, opts) => {
    const z = zone || CLOCK.zone;
    const key = `${z || ""}|${CLOCK.lang || ""}|${CLOCK.tf}|${JSON.stringify(opts)}`;
    let f = FMTS.get(key);
    if (f) return f;
    const o = { ...opts };
    if ("hour" in o) {
        if (CLOCK.tf === "12") o.hour12 = true;
        else if (CLOCK.tf === "24") o.hourCycle = "h23";
    }
    for (const [lang, timeZone] of [[CLOCK.lang, z], [undefined, z], [CLOCK.lang, CLOCK.zone], [undefined, undefined]]) {
        try { f = new Intl.DateTimeFormat(lang || [], { ...o, ...(timeZone ? { timeZone } : {}) }); break; } catch (e) { f = null; }
    }
    FMTS.set(key, f);
    return f;
};
// named: the zone said after the clock, in the reader's words ("PST" in
// American English, "UTC−8" in French), for a card whose lines run in
// zones of their own (see _hm)
const fmtHM = (d, zone, named) => clockFmt(zone, { hour: "2-digit", minute: "2-digit", ...(named ? { timeZoneName: "short" } : {}) }).format(d);
// the calendar day a moment falls on in a zone, as a day count: two of them
// subtract into "tomorrow" or "in three days" without a midnight of the
// browser's own in between
const dayNum = (d, zone) => {
    const p = clockFmt(zone, { year: "numeric", month: "numeric", day: "numeric", calendar: "gregory", numberingSystem: "latn" })
        .formatToParts(d).reduce((o, x) => ({ ...o, [x.type]: Number(x.value) }), {});
    return Math.round(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
};

// journey time, the way a timetable prints it: "1 h 04", "12 min"
const fmtDur = (min) => {
    if (!Number.isFinite(min) || min < 0) return "";
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
};

// minutes between two clocks as the board prints them, to the minute with
// the seconds dropped: "20:58 → 21:38" reads 40 min, never 41
const clockMins = (a, b) => Math.floor(b.getTime() / 60000) - Math.floor(a.getTime() / 60000);

const fmtCountdown = (lang, d, now) => {
    const mins = Math.round((d.getTime() - now.getTime()) / 60000);
    if (mins <= 0) return tr(lang, "due");
    if (mins < 60) return tr(lang, "in_min", { n: mins });
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? tr(lang, "in_h_min", { h, m: String(m).padStart(2, "0") }) : tr(lang, "in_h", { h });
};

const fmtAgo = (lang, ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return tr(lang, "ago_s", { n: s });
    const min = Math.round(s / 60);
    // "9 h 12 ago" reads where "552 min ago" has to be worked out
    return min < 60 ? tr(lang, "ago_min", { n: min }) : tr(lang, "ago_dur", { t: fmtDur(min) });
};

// read the first usable value among several attribute spellings; gtfs2
// slugifies its Route/Trip table dumps ("route_route_id"), stringifies
// missing values to "None", and the fork may add unprefixed attributes
const attrVal = (at, ...names) => {
    for (const n of names) {
        const v = at?.[n];
        if (v != null && v !== "" && v !== "None") return v;
    }
    return null;
};

// a route or direction id, spelled the way gtfs2 spells it in a file name.
// Both geojson files are named after ids that come out of the datasource, so
// the integration keeps letters, digits, dot, dash and underscore, replaces
// every run of the rest with a single underscore and lowercases the result
// (safe_file_part, gtfs2 0.5.9.8). A url derived here has to follow the same
// rule or it 404s on any feed whose route_id carries a colon: "ORLEANS:Line:A"
// direction 0 is served as "orleans_line_a_0.json".
const safeFilePart = (v) => String(v).toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/\.\.+/g, "_");

// lighten a #rrggbb color towards white (used to tell the two directions
// of a line apart when both derive the same GTFS route_color)
const lighten = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const mix = (x) => Math.round(x + (255 - x) * Math.min(0.7, f));
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
};

// ink that stays readable on a given background: dark glyph on a light line
// colour, light glyph on a dark one. Picked from the disc's own colour, since
// the theme background says nothing about what the marker is filled with.
const inkOn = (hex) => (/^#[0-9a-fA-F]{6}$/.test(hex || "") && luminance(hex) > 0.62 ? "#1b1b1b" : "#ffffff");

// Drain a colour of its chroma while holding its lightness, for a line whose
// sensor is out of service: gone from Home Assistant, or unavailable. Veiling it towards the card background was the first
// attempt and it broke the badge: on TAO's grey line the number fell to 1.3:1,
// unreadable, because lightening a dark colour under white ink destroys the
// contrast the ink was chosen for. Taking the saturation out instead leaves
// the lightness alone, so inkOn still answers correctly for the result, and a
// drained colour reads as "no longer live" just as well.
// Towards the grey of the SAME luminance, the one inkOn measures, not towards
// a neutral of the same HSL lightness. HSL lightness is a poor stand-in for how
// light a colour looks: desaturating TAO's yellow that way flipped it from dark
// ink to light ink and landed it at 2.97:1, worse than where it started. Held
// at constant luminance the ink can never flip, and every line keeps very
// nearly the contrast it had.
const drain = (hex, amount = 0.75) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex || "")) return hex;
    const n = parseInt(hex.slice(1), 16);
    const g = Math.round(luminance(hex) * 255);
    return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
        .map((v) => Math.round(v * (1 - amount) + g * amount).toString(16).padStart(2, "0"))
        .join("");
};

const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

// "tomorrow" / weekday tag for departures beyond today (include_tomorrow)
// counted in the line's zone, like its clocks: a BART run is "tomorrow"
// after midnight in San Francisco, not after midnight in Paris
const dayTag = (lang, d, now, zone) => {
    const diff = dayNum(d, zone) - dayNum(now, zone);
    if (diff <= 0) return "";
    if (diff === 1) return tr(lang, "tomorrow");
    try { return d.toLocaleDateString(lang, { weekday: "long", timeZone: zone || CLOCK.zone }); } catch (e) { return d.toLocaleDateString(lang, { weekday: "long" }); }
};

const haversine = (a, b) => {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(s));
};

// shared fetch de-duplication: several card instances polling the same URL
// within maxAge share one request and one payload
const FETCH_SHARED = new Map(); // url → {at, promise}
// A forced read still de-duplicates, but only across the burst that a mount
// produces: three cards appearing together share one request, while anything
// the tab has been holding since an earlier view is read again. Without this
// window a dashboard with several cards would fire one request per card.
const FETCH_BURST_MS = 1000;
// the editor's preview draws again once the typing has paused this long
const CONFIG_SETTLE_MS = 600;
function fetchJsonShared(url, maxAgeMs) {
    const cached = FETCH_SHARED.get(url);
    const now = Date.now();
    if (cached && now - cached.at < maxAgeMs) return cached.promise;
    // entries hold a parsed GeoJSON body; without this sweep a url nobody
    // fetches any more (a view the user navigated away from) is retained for
    // the lifetime of the tab
    if (FETCH_SHARED.size > 24) {
        for (const [k, v] of FETCH_SHARED) if (now - v.at > 30 * 60000) FETCH_SHARED.delete(k);
    }
    // no-cache (not no-store): the browser revalidates with If-Modified-Since
    // / ETag and HA answers 304 when the file has not changed, so route
    // shapes and unchanged position files cost nothing on the wire
    const promise = fetch(url, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const lm = Date.parse(r.headers.get("last-modified") || "");
        return r.json().then((j) => {
            // non-enumerable: the body is handed to JSON-agnostic code and
            // spread in places, this must not show up as a feature
            if (j && typeof j === "object" && Number.isFinite(lm)) {
                Object.defineProperty(j, "__lastModified", { value: lm, enumerable: false, configurable: true });
            }
            return j;
        });
    });
    FETCH_SHARED.set(url, { at: now, promise });
    promise.catch(() => {
        const cur = FETCH_SHARED.get(url);
        if (cur && cur.promise === promise) FETCH_SHARED.delete(url);
    });
    return promise;
}

// ── GTFS-RT vehicle positions, decoded off the wire ────────────────────
// A minimal decoder for the one message the card reads, no library. Field
// numbers are the official gtfs-realtime proto's: FeedMessage 1 header /
// repeated 2 entity; FeedEntity 1 id / 4 vehicle; VehiclePosition 1 trip /
// 2 position / 3 current_stop_sequence / 8 vehicle; TripDescriptor 1
// trip_id / 5 route_id / 6 direction_id; Position 1 lat / 2 lon / 3
// bearing; VehicleDescriptor 1 id / 2 label. Unknown fields are skipped by
// their length (or their group end), so a feed carrying more than this
// decodes all the same.
const RT = (() => {
    // one reader over the current buffer; decodeVehiclePositions is not
    // reentrant anyway, and this keeps every helper one argument lighter
    let buf = null, dv = null, p = 0;
    const varint = () => {
        let shift = 0, val = 0n;
        for (;;) {
            const b = buf[p++];
            val |= BigInt(b & 0x7f) << BigInt(shift);
            if (!(b & 0x80)) return val;
            shift += 7;
        }
    };
    const text = (n) => new TextDecoder().decode(buf.subarray(p, p + n));
    const f32 = (at) => dv.getFloat32(at, true);
    const skip = (wt) => {
        if (wt === 0) varint();
        else if (wt === 1) p += 8;
        else if (wt === 2) { const n = Number(varint()); p += n; }
        else if (wt === 5) p += 4;
        else if (wt === 3) {  // deprecated start-group: run to its end-group
            for (;;) {
                const t = varint();
                if (Number(t & 7n) === 4) break;
                skip(Number(t & 7n));
            }
        }
        else throw new Error("gtfs2-stop-card: protobuf wire type " + wt);
    };
    const lenField = () => { const n = Number(varint()); const e = p + n; return e; };
    function trip() {
        const o = {};
        const e = lenField();
        while (p < e) {
            const t = varint(); const wt = Number(t & 7n), fn = Number(t >> 3n);
            if (fn === 1 && wt === 2) { const n = Number(varint()); o.trip_id = text(n); p += n; }
            else if (fn === 5 && wt === 2) { const n = Number(varint()); o.route_id = text(n); p += n; }
            else if (fn === 6 && wt === 0) o.direction_id = Number(varint());
            else skip(wt);
        }
        p = e;
        return o;
    }
    function position() {
        const o = {};
        const e = lenField();
        while (p < e) {
            const t = varint(); const wt = Number(t & 7n), fn = Number(t >> 3n);
            if (fn === 1 && wt === 5) { o.latitude = f32(p); p += 4; }
            else if (fn === 2 && wt === 5) { o.longitude = f32(p); p += 4; }
            else if (fn === 3 && wt === 5) { o.bearing = f32(p); p += 4; }
            else skip(wt);
        }
        p = e;
        return o;
    }
    function vehDesc() {
        const o = {};
        const e = lenField();
        while (p < e) {
            const t = varint(); const wt = Number(t & 7n), fn = Number(t >> 3n);
            if (fn === 1 && wt === 2) { const n = Number(varint()); o.id = text(n); p += n; }
            else if (fn === 2 && wt === 2) { const n = Number(varint()); o.label = text(n); p += n; }
            else skip(wt);
        }
        p = e;
        return o;
    }
    function vehicle() {
        const o = { trip: null, pos: null, seq: null, vehicle: null };
        const e = lenField();
        while (p < e) {
            const t = varint(); const wt = Number(t & 7n), fn = Number(t >> 3n);
            if (fn === 1 && wt === 2) { o.trip = trip(); }
            else if (fn === 2 && wt === 2) { o.pos = position(); }
            else if (fn === 3 && wt === 0) o.seq = Number(varint());
            else if (fn === 8 && wt === 2) { o.vehicle = vehDesc(); }
            else skip(wt);
        }
        p = e;
        return o;
    }
    return {
        decode(u8) {
            buf = u8;
            dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
            p = 0;
            const out = [];
            const end = u8.length;
            while (p < end) {
                const t = varint(); const wt = Number(t & 7n), fn = Number(t >> 3n);
                if (fn !== 2 || wt !== 2) { skip(wt); continue; }   // header, unknowns
                const e = lenField();
                let veh = null, id = null;
                while (p < e) {
                    const t2 = varint(); const w2 = Number(t2 & 7n), f2 = Number(t2 >> 3n);
                    if (f2 === 1 && w2 === 2) { const n = Number(varint()); id = text(n); p += n; }
                    else if (f2 === 4 && w2 === 2) { veh = vehicle(); }
                    else skip(w2);
                }
                p = e;
                if (veh && veh.pos && Number.isFinite(veh.pos.latitude)) {
                    out.push({
                        id: veh.vehicle?.id || id || "bus",
                        label: veh.vehicle?.label || null,
                        tripId: veh.trip?.trip_id || null,
                        routeId: veh.trip?.route_id || null,
                        directionId: veh.trip?.direction_id,
                        lat: veh.pos.latitude,
                        lon: veh.pos.longitude,
                        bearing: veh.pos.bearing,
                        seq: veh.seq,
                    });
                }
            }
            return out;
        },
    };
})();

// shared read of the raw feed: bytes this time, not JSON, de-duplicated
// like fetchJsonShared and stamped with the file's Last-Modified the same
// non-enumerable way
const FETCH_RTT_SHARED = new Map();
function fetchFeedShared(url, maxAgeMs) {
    const cached = FETCH_RTT_SHARED.get(url);
    const now = Date.now();
    if (cached && now - cached.at < maxAgeMs) return cached.promise;
    if (FETCH_RTT_SHARED.size > 8) {
        for (const [k, v] of FETCH_RTT_SHARED) if (now - v.at > 30 * 60000) FETCH_RTT_SHARED.delete(k);
    }
    const promise = fetch(url, { cache: "no-cache" }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const lm = Date.parse(r.headers.get("last-modified") || "");
        const buf = new Uint8Array(await r.arrayBuffer());
        buf.__lastModified = Number.isFinite(lm) ? lm : undefined;
        return buf;
    });
    FETCH_RTT_SHARED.set(url, { at: now, promise });
    promise.catch(() => {
        const cur = FETCH_RTT_SHARED.get(url);
        if (cur && cur.promise === promise) FETCH_RTT_SHARED.delete(url);
    });
    return promise;
}

const ICONS = {
    // the map's padlock: shut, a view is kept for what is picked; open, the
    // map frames itself and a click keeps the view it shows
    lock: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>`,
    lockOpen: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 7.8-1.3"></path></svg>`,
    chevronDown: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>`,
    chevronRight: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg>`,
    live: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 11a9 9 0 0 1 9 9"></path><path d="M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1.8" fill="currentColor" stroke="none"></circle></svg>`,
    pin: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"></path><circle cx="12" cy="11" r="2.2"></circle></svg>`,
    alert: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l10 18H2L12 3z"></path><path d="M12 10v5"></path><circle cx="12" cy="17.6" r="0.4" fill="currentColor"></circle></svg>`,
    // mdi:walk
    walk: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.12,10H19V8.2H15.38L13.38,4.87C13.08,4.37 12.54,4.03 11.92,4.03C11.74,4.03 11.58,4.06 11.42,4.11L6,5.8V11H7.8V7.33L9.91,6.67L6,22H7.8L10.67,13.89L13,17V22H14.8V15.59L12.31,11.05L13.04,8.18M14,3.8C15,3.8 15.8,3 15.8,2C15.8,1 15,0.2 14,0.2C13,0.2 12.2,1 12.2,2C12.2,3 13,3.8 14,3.8Z"></path></svg>`,
};

class Gtfs2StopCard extends HTMLElement {

    /* ── SETUP & CONFIG ─────────────────────────────────────────────────── */

    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        // the shadow root outlives every shell a new config builds in it:
        // listened to once, or each edit in the card editor's preview would
        // add a handler, and an even number of them cancels a toggle out
        this.shadowRoot.addEventListener("click", (ev) => {
            if (this._suppressClick) { this._suppressClick = false; return; }
            const t = ev.composedPath().find((n) => n.dataset && n.dataset.action);
            if (t) this._activate(t);
        });
        this.shadowRoot.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter" && ev.key !== " ") return;
            const t = ev.composedPath().find((n) => n.dataset && n.dataset.action);
            if (t) { ev.preventDefault(); this._activate(t); }
        });
        // a title opens on hover and a finger cannot hover: on touch, the tap
        // that selects a line also prints that badge's sentence under it
        this.shadowRoot.addEventListener("pointerup", (ev) => {
            if (ev.pointerType === "mouse") return;
            const b = ev.composedPath().find((n) => n.dataset && n.dataset.tip);
            if (b) this._showBadgeTip(b); else this._hideBadgeTip();
        });
        this._hass = null;
        this._config = null;
        this._collapsed = { dep: false, map: false };
        this._focus = null;               // {li, vid} of the tracked vehicle, or null
        this._trackAt = 0;                // when a click last started tracking one
        this._hiLine = null;              // line idx highlighted from its header badge
        // the destination header of a card of journeys: the departure picked
        // (its placeKey), the arrival picked (its group key) and the way to
        // leave picked (a sensor, or "direct:" and a sensor), remembered per
        // user with the collapsed panes
        this._from = null;
        this._dest = null;
        this._way = null;
        this._ld = [];                    // per-line runtime: {geo, geoAt, err, route, routeAt, sig, sigAt}
        this._hist = new Map();           // "li:vid" → [{lat, lon, ts}]
        this._histSeen = new Map();       // "li:vid" → last time seen in the feed
        // per-entity derived metadata (positions file, label, color, origin
        // stop), persisted in localStorage: a line out of service loses its
        // Route/Trip attributes (sensor.remove_keys), and a page reload at
        // night must still know everything the sensor taught us earlier
        this._emeta = new Map();
        try {
            const saved = JSON.parse(localStorage.getItem("gtfs2-live-card:meta") || "{}");
            for (const [k, v] of Object.entries(saved)) this._emeta.set(k, v);
        } catch (e) { /* localStorage unavailable */ }
        this._viewBox = null;             // [x, y, w, h] in world units (origin-shifted)
        this._origin = null;              // world-unit offset subtracted before rendering
        this._manual = false;             // user panned/zoomed: auto-fit stops overriding
        this._views = {};                 // views kept with the padlock: selection → [w, s, e, n]
        this._profileKey = null;          // the profile entry they are read from (see _loadProfileViews)
        this._pointers = new Map();       // active pointers on the map (pan/pinch)
        this._pinch = null;               // {dist, mid, vb} at pinch start
        this._multi = false;              // two fingers touched the map: the release is not a tap
        this._moved = 0;
        this._suppressClick = false;
        this._downAction = null;         // [data-action] element under the last pointerdown
        this._rerenderTimer = null;
        this._updateFrame = null;         // a hass waiting for the next frame (see set hass)
        this._rowsCache = new WeakMap();  // sensor state → its rows, read a few seconds ago (see _sourceRows)
        this._mPerUNow = 1;
        this._mapDomReady = false;
        this._map = null;                 // the MapLibre instance under the SVG, while the pane is built
        this._mapGen = 0;                 // bumped at every teardown: a module that lands late builds nothing
        this._mapStyleKey = null;         // style MapLibre was last asked to draw (theme, or the custom value)
        this._mapCredit = null;           // attribution read from the loaded style's sources
        this._mapError = null;            // why there is no base map, for the footer
        this._lastW = 0;
        this._scaleW = 0;                 // cached svg box (avoids a layout read on every animation frame)
        this._scaleH = 0;
        this._scalePx = null;             // last scale bar width written
        this._scaleTxt = null;            // last scale bar label written
        this._popSize = null;             // cached popup box, measured when its content changes
        this._ro = null;
        this._tick30 = null;
        this._visHandler = null;
        this._keyHandler = null;          // document-level Escape while tracking
        this._hintT = null;
        this._tipT = null;                // stop tooltip auto-hide timer
        this._badgeTipT = null;           // badge tooltip auto-hide timer (touch)
        this._vehEls = new Map();         // "li:vid" → persistent vehicle <g> node
        this._angCache = new Map();       // "li:vid" → {pos, angle}, spares a polyline walk per render
        this._popKey = null;              // vehicle the popup is attached to
        this._popAnim = null;             // popup glide animation frame
        this._stopLinks = new Map();      // stop name -> Map(line label -> color), rebuilt per render
        this._shownLabels = new Set();    // stop names drawn in full on the map, rebuilt per render
        this._shapes = new Map();         // route id → its static trip-paths doc (see _tripPath)
        this._shapeProj = new Map();      // "tripId@x,y" → projected prefix path, per render cycle
        this._panHover = false;           // a view change just closed the tip: hover waits for a real move
        this._timer = null;
        this._anim = null;
        this._lastEntityState = null;
        this._defsCache = null;
        this._hintCounts = {};
        this._built = false;
        this._preview = false;            // shown in the card editor (see set preview)
        this._pendingConfig = null;       // the editor's last config, waiting for a pause in the typing
        this._configTimer = null;
        this._configJson = null;          // the config drawn, as the editor handed it
    }

    // Home Assistant says so on the card it shows beside the editor. That
    // one is only there to show what the settings give: it reads its files
    // once and never polls, has no vehicles, and waits for the typing to
    // stop before drawing again
    set preview(v) {
        this._preview = !!v;
        if (this._preview && this._timer) this._stopPolling();
    }

    get preview() {
        return this._preview;
    }

    setConfig(config) {
        const hasStops = Array.isArray(config?.stops) && config.stops.length > 0;
        if (!config || (!config.entity && !hasStops)) {
            throw new Error("gtfs2-stop-card : « entity » ou une liste « stops » est requis / set “entity” or a “stops” list");
        }
        // the editor hands its config over at every key typed, and each one
        // drew the whole card again, map included. The same config twice
        // draws nothing; in the preview, only the last one of a burst does
        const json = JSON.stringify(config);
        if (this._configTimer) { clearTimeout(this._configTimer); this._configTimer = null; }
        if (json === this._configJson) { this._pendingConfig = null; return; }
        if (this._preview && this._config) {
            this._pendingConfig = config;
            this._configTimer = setTimeout(() => {
                this._configTimer = null;
                const c = this._pendingConfig;
                this._pendingConfig = null;
                if (c) this._applyConfig(c, JSON.stringify(c));
            }, CONFIG_SETTLE_MS);
            return;
        }
        this._applyConfig(config, json);
    }

    _applyConfig(config, json) {
        this._configJson = json;
        this._rawConfig = config;
        this._jCache = null;
        // a card already on screen given a new config - every edit in the
        // card editor's preview - keeps what it has read of the lines it
        // still shows, and reads nothing again before its own pace says so
        const oldDefs = this._config ? this._lineDefs() : [];
        const oldLd = this._ld;
        this._rebuilt = !!this._built;
        this._config = { ...DEFAULTS, ...config };
        this._modeAuto = "lines";
        const srcKey = (d) => [d.entity, d.positions_url, d.route_url, d.leg_url].join("|");
        const kept = new Map(oldDefs.map((d) => [srcKey(d), oldLd[d.idx]]));
        this._ld = this._lineDefs().map((d) => {
            const k = srcKey(d);
            const slot = kept.get(k);
            kept.delete(k);
            return slot || { geo: null, geoAt: 0, err: null, route: null, routeAt: 0, leg: null, legAt: 0, sig: null, sigAt: 0 };
        });
        this._from = null;
        this._dest = null;
        this._way = null;
        this._views = {};
        // another card's lines: their views are read from the profile again
        if (this._profileKey !== this._storageKey()) { this._dropProfileViews(); this._profileKey = null; }
        try {
            const saved = JSON.parse(localStorage.getItem(this._storageKey()) || "{}");
            // the browser's copy of the views the profile keeps, for the
            // first frame: the profile's own answer replaces it
            if (saved.views && typeof saved.views === "object" && !Array.isArray(saved.views)) this._views = saved.views;
            if (typeof saved.dep === "boolean") this._collapsed.dep = saved.dep;
            if (typeof saved.map === "boolean") this._collapsed.map = saved.map;
            // what the destination header showed last: checked against the
            // journeys when drawn (_destView), a pick that no longer exists
            // simply shows nothing picked
            if (typeof saved.from === "string") this._from = saved.from;
            if (typeof saved.dest === "string") this._dest = saved.dest;
            if (typeof saved.way === "string") this._way = saved.way;
            if (saved.mode === "lines" || saved.mode === "trips") this._modePick = saved.mode;
        } catch (e) { /* localStorage unavailable: keep defaults */ }
        this._built = false;
        // the new shell starts empty: the board is drawn again even though
        // no sensor moved
        this._lastEntityState = null;
        this._dropBasemap();
        this._mapDomReady = false;
        if (this._hass) this._update();
    }

    set hass(hass) {
        const prev = this._hass;
        this._hass = hass;
        setClock(hass);
        // the padlock's views, read from the profile once the card has a
        // connection (and again after a new config or a return to the page)
        if (this._profileKey == null && this._config && hass?.connection) this._loadProfileViews();
        // hass is reassigned on every state change in the whole HA instance:
        // skip all work unless one of our entities, the theme or the locale
        // actually changed
        if (prev && this._built && this._config) {
            const themeFlip = !!prev.themes?.darkMode !== !!hass.themes?.darkMode;
            // the clock's form or Home Assistant's zone changed: every
            // clock of the card is written again, as for a language
            const langFlip = (prev.locale?.language || "") !== (hass.locale?.language || "")
                || (prev.locale?.time_format || "") !== (hass.locale?.time_format || "")
                || (prev.config?.time_zone || "") !== (hass.config?.time_zone || "");
            if (!themeFlip && !langFlip
                && this._watchedEntities().every((id) => prev.states?.[id] === hass.states?.[id])) {
                // nothing we derive from has changed: carry the memoized line
                // defs over to the new hass object rather than dropping them
                if (this._defsCache) this._defsCache.hass = hass;
                return;
            }
            if (themeFlip) this._scheduleRerender();
            if (langFlip) this._lastEntityState = null;
            // gtfs2 refreshes its sensors together, and Home Assistant hands
            // each one over in a hass of its own: drawn one by one, a card of
            // sixty sensors drew its board sixty times in a row, seconds of
            // a frozen page. One drawing per frame, with the last hass.
            if (!this._updateFrame) {
                this._updateFrame = requestAnimationFrame(() => { this._updateFrame = null; this._update(); });
            }
            return;
        }
        this._update();
    }

    // entity ids this card depends on, straight from the config. Memoized:
    // this runs on the hass hot path, which fires on any state change in the
    // whole instance.
    _watchedEntities() {
        if (this._watchCache && this._watchCache.config === this._config) return this._watchCache.ids;
        const out = new Set();
        const c = this._config || {};
        if (c.entity) out.add(c.entity);
        if (Array.isArray(c.stops)) {
            for (const l of c.stops) {
                const e = typeof l === "string" ? l : l?.entity;
                if (e) out.add(e);
            }
        }
        const ids = [...out];
        this._watchCache = { config: this._config, ids };
        return ids;
    }

    _t(key, vars) {
        return tr(this._lang(), key, vars);
    }

    _lang() {
        return resolveLang(this._hass);
    }

    // A clock as the card writes it, in its line's zone. A card whose lines
    // keep different hours right now (BART and Paris; not Paris and
    // Brussels) names the zone after every clock: its board is sorted by
    // the moment, and 07:01 beside 16:01 would read as a mistake
    _hm(d, zone) {
        return fmtHM(d, zone, this._mixedZones());
    }

    _mixedZones() {
        const defs = this._lineDefs();
        const now = new Date();
        const key = `${CLOCK.zone}|${CLOCK.lang}|${defs.map((d) => d.zone || "").join(",")}|${Math.floor(now / 3600000)}`;
        if (this._zonesKey === key) return this._zonesMixed;
        const said = new Set(defs.map((d) => fmtHM(now, d.zone, true).replace(fmtHM(now, d.zone), "")));
        this._zonesKey = key;
        this._zonesMixed = said.size > 1;
        return this._zonesMixed;
    }

    // the zone of a journey's clocks (see fmtHM): its first line's. The
    // lines a journey changes between run in one place, so in one zone
    _jZone(j) {
        return j?.plan?.legs?.[0]?.def?.zone || undefined;
    }

    /* True once this card's strings are in, and the gate every render waits
     * behind. On a miss it starts the fetch and registers for the callback,
     * so asking is also what gets the language moving. */
    _langReady() {
        const lang = this._lang();
        if (LANG[lang]) return true;
        LANG_WAITING.add(this);
        loadLang(lang);
        return false;
    }

    /* Called by loadLang() once the strings are in (or have failed). Nothing
     * has been drawn yet, so this is the first real render. */
    _langArrived(code) {
        if (code !== this._lang()) return;   // a different card's language
        LANG_WAITING.delete(this);
        this._update();
    }

    _storageKey() {
        const id = this._config.entity
            || this._lineDefs().map((d) => d.entity || d.positions_url || "").join(",")
            || "default";
        return `gtfs2-live-card:${id}`;
    }

    // the collapsed panes and the destination header's picks, per user
    _persistCollapsed() {
        const view = { ...this._collapsed, from: this._from, dest: this._dest, way: this._way,
                       mode: this._modePick, views: this._views };
        try { localStorage.setItem(this._storageKey(), JSON.stringify(view)); } catch (e) { /* ignore */ }
    }

    /* The padlock. A view kept is kept for what is picked, since the map
     * frames each pick its own way: nothing, a line, a departure and an
     * arrival, a way. With none kept for it, the map frames itself as it
     * always did. A view is kept as the ground it shows, west, south, east
     * and north, and framed again at the card's width: a phone and a wide
     * screen show the same streets. */
    _viewSel() {
        const d = this._hiLine != null ? this._lineDefs().find((x) => x.idx === this._hiLine) : null;
        const line = d ? d.entity || d.positions_url || String(d.idx) : "";
        if (this._modeOf() !== "trips") return `lines|${line}`;
        const v = this._destView();
        return ["trips", v?.from ?? "", v?.dest ?? "", v?.way ?? "", line].join("|");
    }

    // what the padlock's words say the view is kept for
    _viewScope() {
        const d = this._hiLine != null ? this._lineDefs().find((x) => x.idx === this._hiLine) : null;
        if (d) return this._t("view_line", { l: this._lineLabelOf(d) });
        const v = this._modeOf() === "trips" ? this._destView() : null;
        return this._t(v && (this._from || v.dest || v.way) ? "view_pick" : "view_none");
    }

    // the ground the map shows, [west, south, east, north] to a metre or so
    _visibleBox() {
        const vb = this._viewBox, O = this._origin;
        const svg = this.shadowRoot.querySelector(".map-wrap svg");
        if (!vb || !O || !svg) return null;
        const W = svg.clientWidth || vb[2], H = svg.clientHeight || vb[3];
        // the viewBox covers the frame, its overflow cut (slice): what shows
        const s = Math.max(W / vb[2], H / vb[3]);
        const cx = O.x + vb[0] + vb[2] / 2, cy = O.y + vb[1] + vb[3] / 2;
        const hw = W / s / 2, hh = H / s / 2;
        const lon = (x) => (x / WORLD) * 360 - 180;
        const r = (v) => Math.round(v * 1e5) / 1e5;
        const box = [r(lon(cx - hw)), r(this._latOf(cy + hh)), r(lon(cx + hw)), r(this._latOf(cy - hh))];
        return box.every(Number.isFinite) ? box : null;
    }

    // The views live in the user's Home Assistant profile, so they follow
    // the user from the phone to the wall tablet and outlive a browser's
    // data; the browser keeps a copy for the first frame. Read once per
    // card, and kept current where Home Assistant says when they change.
    // Views kept in this browser before the profile held any are handed to
    // it, not dropped
    _loadProfileViews() {
        const conn = this._hass?.connection;
        const key = this._storageKey();
        if (!conn || this._profileKey === key) return;
        this._profileKey = key;
        const take = (value) => {
            if (this._profileKey !== key) return;
            if (value == null) {
                if (Object.keys(this._views).length) this._writeProfileViews(() => this._views);
                return;
            }
            const views = typeof value === "object" && !Array.isArray(value) ? value : {};
            if (JSON.stringify(views) === JSON.stringify(this._views)) return;
            this._views = views;
            this._persistCollapsed();
            if (!this._manual && !this._focus) this._scheduleRerender();
        };
        const get = () => conn.sendMessagePromise({ type: "frontend/get_user_data", key })
            .then((r) => take(r?.value)).catch(() => {});
        // an older Home Assistant cannot be listened to: read once
        conn.subscribeMessage((ev) => take(ev?.value), { type: "frontend/subscribe_user_data", key })
            .then((unsub) => {
                if (this._profileKey === key) this._profileUnsub = unsub;
                else unsub();
            })
            .catch(get);
    }

    _dropProfileViews() {
        if (this._profileUnsub) {
            try { this._profileUnsub(); } catch (e) { /* the connection is gone */ }
            this._profileUnsub = null;
        }
    }

    // the profile's views read again just before writing, so a view kept
    // meanwhile on another device is not written over
    _writeProfileViews(change) {
        const conn = this._hass?.connection;
        if (!conn) return;
        const key = this._storageKey();
        conn.sendMessagePromise({ type: "frontend/get_user_data", key })
            .then((r) => {
                const cur = r?.value && typeof r.value === "object" && !Array.isArray(r.value) ? { ...r.value } : {};
                return conn.sendMessagePromise({ type: "frontend/set_user_data", key, value: change(cur) });
            })
            .catch(() => {});
    }

    // Shown only when it has something to do: after a move by hand, open,
    // to keep the view; on a view kept, shut, to go back to the map's own
    // framing. Hidden while a vehicle is tracked
    _paintLock(btn) {
        const kept = !!this._views[this._viewSel()];
        const shut = kept && !this._manual;
        btn.hidden = !!this._focus || (!this._manual && !kept);
        if (btn.hidden) return;
        btn.classList.toggle("on", shut);
        btn.setAttribute("aria-pressed", String(shut));
        const label = this._t(shut ? "view_auto" : "view_keep", { s: this._viewScope() });
        btn.title = label;
        btn.setAttribute("aria-label", label);
        const icon = shut ? "lock" : "lockOpen";
        if (btn.dataset.icon !== icon) { btn.dataset.icon = icon; btn.innerHTML = ICONS[icon]; }
    }

    _remember(entity, patch) {
        const cur = this._emeta.get(entity) || {};
        const next = { ...cur, ...patch };
        if (JSON.stringify(cur) === JSON.stringify(next)) return;
        this._emeta.set(entity, next);
        try { localStorage.setItem("gtfs2-live-card:meta", JSON.stringify(Object.fromEntries(this._emeta))); } catch (e) { /* ignore */ }
    }

    _lineDefs() {
        // memoized per (hass, config) pair: this sits on hot paths and is
        // called several times per render pass
        const mc = this._defsCache;
        if (mc && mc.hass === this._hass && mc.config === this._config) return mc.defs;
        const defs = this._computeLineDefs();
        this._defsCache = { hass: this._hass, config: this._config, defs };
        return defs;
    }

    _computeLineDefs() {
        const c = this._config;
        const stops = cardEntries(c);
        if (!stops.length) return [];
        // every route code the card's stops serve: each gets a colour of its
        // own, drawn in turn, so two badges never share one and the colours
        // stay stable across the card and across reloads
        const routes = new Set();
        for (const s of stops) {
            const at = s.entity && this._hass ? this._hass.states?.[s.entity]?.attributes : null;
            for (const d of (Array.isArray(at?.next_departures_lines) ? at.next_departures_lines : [])) {
                if (d?.route != null && String(d.route).trim()) routes.add(String(d.route).trim());
            }
        }
        const routeColor = new Map();
        let ri = 0;
        for (const r of [...routes].sort()) routeColor.set(r, FALLBACK_COLORS[ri++ % FALLBACK_COLORS.length]);
        return stops.map((s, i) => {
            const st = s.entity && this._hass ? this._hass.states?.[s.entity] || null : null;
            const at = st?.attributes || null;
            // the stop's own coordinates: the sensor carries the platform's
            // position, not the tracked zone's
            const lat = at && Number.isFinite(Number(at.latitude)) ? Number(at.latitude) : null;
            const lon = at && Number.isFinite(Number(at.longitude)) ? Number(at.longitude) : null;
            const deps = Array.isArray(at?.next_departures_lines) ? at.next_departures_lines : [];
            const stopName = at?.stop_name || deps.find((d) => d?.stop_name)?.stop_name || null;
            // label: the entry's, else the stop's own name (the friendly_name
            // is gtfs2's sensor name, not a place a rider would say)
            const label = s.label ?? stopName ?? (at ? attrVal(at, "friendly_name") : null) ?? null;
            // the routes the stop serves now, for the header badges
            const codes = [...new Set(deps.map((d) => (d?.route == null ? "" : String(d.route).trim())).filter(Boolean))];
            // per-route colours: the ones the integration told (line_colors),
            // else the card's own, one per route code
            const told = at?.line_colors && typeof at.line_colors === "object" ? at.line_colors : {};
            const codeColors = new Map();
            for (const code of codes) {
                const toldCol = told[code] != null ? String(told[code]).replace(/^#?/, "#") : null;
                const col = toldCol && /^#[0-9a-fA-F]{6}$/.test(toldCol) && luminance(toldCol) <= 0.82
                    ? toldCol : routeColor.get(code) || null;
                if (col) codeColors.set(code, col);
            }
            // the clock the departures read in: Home Assistant's own - the
            // *_datetime fields are UTC ISO, so only the display has a zone
            // to pick
            return {
                idx: i,
                entity: s.entity || null,
                positions_url: s.positions_url || c.positions_url || null,
                label,
                // the disc and the badges wear the first route's colour
                color: codes.length ? codeColors.get(codes[0]) || null : null,
                codes: codes.length ? codes : null,
                codeColors,
                mode: "bus",
                icon: deps.find((d) => d?.icon)?.icon || "mdi:bus",
                zone: null,
                lat,
                lon,
                stopName,
                nextIn: null,
                nextDate: null,
            };
        });
    }

    // the family the badges actually render in, so the fitting measures what
    // the user sees rather than a guess. Read once: it cannot change without
    // the whole theme changing, which re-renders the card anyway.
    _badgeFamily() {
        if (this._bFamily) return this._bFamily;
        try {
            const card = this.shadowRoot?.querySelector("ha-card");
            const f = card && getComputedStyle(card).fontFamily;
            if (f) this._bFamily = f;
        } catch (e) { /* rendu hors document */ }
        return this._bFamily || "Roboto, sans-serif";
    }

    // the badge of one departure: its own line on a sensor that mixes
    // several, the sensor's otherwise
    // and its colour: its own line's where the feed gives one
    _rowColor(row, def = row?.def) {
        return this._lineColorOf(def, row?.line);
    }

    _rowLabel(row, def = row?.def) {
        return row?.line || this._lineLabelOf(def);
    }

    // the labels a line's squares and plates show: one per line a sensor
    // riding several of them names, else its own
    _lineLabelsOf(def) {
        return def.codes || [this._lineLabelOf(def)];
    }

    // the colour of one of a sensor's lines, its own where the feed gives
    // it (K8+ purple, P8 green on one SNCF sensor), else the sensor's
    _lineColorOf(def, code) {
        return (code && def?.codeColors?.get(code)) || def?.color;
    }

    _lineLabelOf(def) {
        // a stop's badge is its route code; the stop's own name is the
        // title's business, not a badge
        if (def.codes?.length) return def.codes[0];
        if (def.label) return def.label;
        const routeId = this._ld[def.idx]?.geo?.features?.[0]?.properties?.route_id;
        return routeId ? String(routeId).split(":").pop() : "•";
    }

    _stationColor() {
        return this._config.station_color || "var(--gtfs2-station-color, var(--accent-color, #ff9800))";
    }

    // the longest wait a change may take, in minutes (max_transfer_wait)
    _maxWait() {
        const mw = Number(this._config.max_transfer_wait);
        return mw > 0 ? Math.max(5, mw) : DEFAULTS.max_transfer_wait;
    }

    // the line filter a tracking put in place goes with it: the board the
    // user had comes back
    _restoreTrackedLine() {
        if (this._trackPrev === undefined) return;
        const prev = this._trackPrev;
        this._trackPrev = undefined;
        if (this._hiLine === prev) return;
        this._hiLine = prev;
        this._renderHeader();
        this._renderDepartures();
    }

    /* ── DOM LIFECYCLE ──────────────────────────────────────────────────── */

    connectedCallback() {
        if (this._pendingConfig) {
            const c = this._pendingConfig;
            this._pendingConfig = null;
            this._applyConfig(c, JSON.stringify(c));
        }
        // the base map was released when the view went away (see below):
        // a pane still standing in the cached DOM gets it back
        if (this._mapDomReady && !this._map) this._buildBasemap();
        this._startPolling();
        if (!this._tick30) this._tick30 = setInterval(() => this._tickRelative(), 30000);
        // Home Assistant re-attaches a view's elements as they were left, and
        // the hass setter redraws nothing unless the sensor changed meanwhile:
        // the countdowns, expired rows and footer catch up now, not 30 s later
        if (this._built) this._tickRelative();
        if (!this._visHandler) {
            this._visHandler = () => { if (!document.hidden) this._fetchAll(); };
            document.addEventListener("visibilitychange", this._visHandler);
        }
        if (!this._keyHandler) {
            // Escape ends the tracking wherever the focus is: a click on a
            // marker re-renders the overlay and drops the focus to the page
            this._keyHandler = (ev) => { if (ev.key === "Escape" && this._focus) this._act("untrack", {}); };
            document.addEventListener("keydown", this._keyHandler);
        }
        this._observeResize();
    }

    disconnectedCallback() {
        LANG_WAITING.delete(this);
        // a config still waiting is drawn when the card is back, not off screen
        if (this._configTimer) { clearTimeout(this._configTimer); this._configTimer = null; }
        // a WebGL context is a scarce thing (a browser holds a dozen or so):
        // a view Home Assistant keeps cached off-screen must not sit on one
        this._dropBasemap();
        this._stopPolling();
        if (this._tick30) { clearInterval(this._tick30); this._tick30 = null; }
        if (this._visHandler) { document.removeEventListener("visibilitychange", this._visHandler); this._visHandler = null; }
        if (this._keyHandler) { document.removeEventListener("keydown", this._keyHandler); this._keyHandler = null; }
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
        if (this._anim) cancelAnimationFrame(this._anim);
        if (this._rerenderTimer) { clearTimeout(this._rerenderTimer); this._rerenderTimer = null; }
        if (this._boardTimer) { clearTimeout(this._boardTimer); this._boardTimer = null; }
        // read again, and listened to again, when the card is back
        this._dropProfileViews();
        this._profileKey = null;
        if (this._hintT) { clearTimeout(this._hintT); this._hintT = null; }
        if (this._tipT) { clearTimeout(this._tipT); this._tipT = null; }
        if (this._badgeTipT) { clearTimeout(this._badgeTipT); this._badgeTipT = null; }
        if (this._popAnim) { cancelAnimationFrame(this._popAnim); this._popAnim = null; }
    }

    _startPolling(force = true) {
        this._stopPolling();
        // an entity without url may expose its attributes later: keep polling
        // armed as long as a source is possible, positions or route alone
        if (!this._config || !this._lineDefs().some((d) => d.positions_url || d.route_url || d.entity)) return;
        this._fetchAll(force);
        // the editor's preview reads once: nothing on it needs to keep up
        if (this._preview) return;
        this._timer = setInterval(() => this._fetchAll(), Math.max(15, this._config.refresh) * 1000);
    }

    _stopPolling() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    // force means the card has just been put on screen. Home Assistant is a
    // single page app: coming back to a view reuses the element and the tab
    // still holds the payloads read the last time, so without this the first
    // thing the user sees can be an hour old. A forced read goes past every
    // cache, its own and the shared one, and reads the files again.
    _fetchAll(force) {
        if (document.hidden && !force) return;
        const period = Math.max(15, this._config.refresh) * 1000;
        for (const def of this._lineDefs()) {
            const slot = this._ld[def.idx];
            // no vehicles in the editor's preview: it shows the settings,
            // not the traffic
            if (this._preview) continue;
            // a stop with no feed, no explicit positions_url and no route_ids
            // mapping for any of its routes has no vehicles to read
            if (!this._config.positions_feed && !def.positions_url && !this._positionsUrls(def).length) continue;
            // collapsed map only needs the count: poll five times slower
            const mapOff = this._collapsed.map || this._config.show_map === false;
            if (!force && mapOff && slot && Date.now() - (slot.geoAt || 0) < period * 5) continue;
            this._fetchPositions(def, force);
        }
    }

    _observeResize() {
        if (!("ResizeObserver" in window)) return;
        if (this._ro) this._ro.disconnect();
        const body = this.shadowRoot.getElementById("map-body");
        if (!body) return;
        this._ro = new ResizeObserver(() => {
            const w = body.clientWidth;
            if (w && Math.abs(w - this._lastW) > 4) {
                this._lastW = w;
                this._scaleW = 0;              // cached map box, re-measured on the next render
                this._scaleH = 0;
                if (!this._collapsed.map && this._mapDomReady) this._scheduleRerender();
            }
        });
        this._ro.observe(body);
    }

    // 30 s heartbeat keeping relative texts honest between data refreshes
    _tickRelative() {
        if (document.hidden || !this._built) return;
        // expanded board: refresh the countdown texts in place; a full
        // re-render only when a row expired (or the board is collapsed and
        // its one-line summary is cheap to rebuild)
        const now = new Date(), lang = this._lang();
        const spans = [...this.shadowRoot.querySelectorAll(this._collapsed.dep ? "#header .countdown[data-ts]" : ".countdown[data-ts]")];
        let expired = false, headExpired = false, board = 0;
        for (const el of spans) {
            const inHead = !!el.closest("#header");
            if (!inHead) board++;
            const t = new Date(Number(el.dataset.ts));
            if (t.getTime() < now.getTime() - 60000) {
                if (inHead) headExpired = true; else expired = true;
            } else el.textContent = fmtCountdown(lang, t, now);
        }
        if (headExpired) this._renderHeader();
        if (expired || !board) this._renderDepartures();
        this._renderFooter();
        // a line crosses the 8-minute line without any fetch happening: the
        // file is still answering, its date simply stopped moving
        this._repaintHeaderIfMuteChanged();
        this._updateAttrib();
    }

    // the map's credit line: what the loaded style's sources ask for (OSM's
    // due, by default), or why there is no base map at all
    _attribText(newestAt) {
        const upd = this._t("map_updated", { t: newestAt ? fmtAgo(this._lang(), Date.now() - newestAt) : "…" });
        if (this._mapError) return `${this._t("map_no_base")} · ${upd}`;
        const credit = this._mapCredit ?? (this._mapStyleSpec().own ? MAP_CREDIT : "");
        return credit ? `${credit} · ${upd}` : upd;
    }

    /* ── LOVELACE API ───────────────────────────────────────────────────── */

    getCardSize() {
        return 1
            + (this._config.show_departures === false ? 0 : (this._collapsed.dep ? 1 : 3))
            + (this._config.show_map === false ? 0 : (this._collapsed.map ? 1 : 4));
    }

    static getConfigElement() {
        return document.createElement("gtfs2-stop-card-editor");
    }

    // Home Assistant hands over the entities picked before the card, in the
    // order they were picked: those are the stops wanted, and taking the
    // first stop sensor of the house instead would build someone else's card.
    // Only when nothing usable was picked do we look for one ourselves.
    static getStubConfig(hass, entities, entitiesFallback) {
        const states = hass?.states || {};
        const stop = (id) => isStopSensor(id, states[id]);
        const picked = [...(entities || []), ...(entitiesFallback || [])].filter(stop);
        const stops = picked.length ? [...new Set(picked)] : Object.keys(states).filter(stop).slice(0, 1);
        return stops.length ? { stops } : { entity: "sensor.gtfs2_local_stop" };
    }

    /* ── UPDATE PIPELINE ────────────────────────────────────────────────── */

    _entity() {
        return this._hass?.states?.[this._config?.entity] || null;
    }

    // departure sources: one per line def carrying its own gtfs2 sensor
    // (line 0 inherits the card's top-level entity). Falls back on the
    // top-level entity alone when no line def carries one.
    _depSources() {
        const seen = new Set();
        const out = [];
        for (const def of this._lineDefs()) {
            if (!def.entity || seen.has(def.entity)) continue;
            seen.add(def.entity);
            const st = this._hass?.states?.[def.entity];
            if (st) out.push({ def, st });
        }
        if (!out.length) {
            const st = this._entity();
            if (st) out.push({ def: null, st });
        }
        return out;
    }

    _update() {
        if (!this._config || !this._hass) return;
        // Nothing is drawn in a language the card does not have yet: rendering
        // now would put string keys on screen and swap them a moment later.
        if (!this._langReady()) return;
        if (!this._built) {
            this._buildShell();
            this._built = true;
            this._startPolling(!this._rebuilt);
            this._rebuilt = false;
        }
        const stamp = this._depSources()
            .map((s) => `${s.st.entity_id}|${s.st.state}|${s.st.last_updated}`)
            .join(";") || "missing";
        if (stamp !== this._lastEntityState) {
            this._lastEntityState = stamp;
            this._renderHeader();
            this._renderDepartures();
            this._renderFooter();
        }
    }

    /* ── SHELL ──────────────────────────────────────────────────────────── */

    _buildShell() {
        this._dropBasemap();              // its container goes with the old shell
        // card-mod puts its <card-mod> element in this shadow root once,
        // when the card is created. The shell is built after it, once the
        // strings are in, and again at every change of config: wiped with
        // the old shell, it took the dashboard's card_mod style with it
        const cardMod = [...this.shadowRoot.children].filter((el) => el.localName === "card-mod");
        this.shadowRoot.innerHTML = `
        <link rel="stylesheet" href="${MAPLIBRE_CSS}">
        <style>${this._styles()}</style>
        <ha-card>
            <div id="header" class="header"></div>
            <div id="dep-head" class="sect-head" data-action="toggle-dep" role="button" tabindex="0"></div>
            <div id="dep-body"></div>
            <div id="map-head" class="sect-head" data-action="toggle-map" role="button" tabindex="0"></div>
            <div id="map-body" class="map-body"></div>
            <div id="focus-panel"></div>
            <div id="footer" class="footer"></div>
            <div class="badge-tip" hidden></div>
        </ha-card>`;
        // put back after the card's own styles, which card_mod's override
        this.shadowRoot.append(...cardMod);
        this._footerHtml = null;          // the shell above just emptied it
        this._renderHeader();
        this._renderDepartures();
        this._renderMapSection();
        this._renderFooter();
        this._observeResize();
    }

    _activate(t) {
        this._act(t.dataset.action, t.dataset);
    }

    // A badge carries a sentence in its title: the destination, why it is
    // struck through, what the operator is reporting, how long its source has
    // been quiet. A title only opens on hover, and a phone has none - so on
    // touch the tap prints it under the badge for a few seconds instead. It
    // hangs off the card, not off the header, because selecting a line
    // re-renders the header and would take the bubble with it.
    _showBadgeTip(el) {
        const card = this.shadowRoot.querySelector("ha-card");
        const tip = this.shadowRoot.querySelector(".badge-tip");
        if (!card || !tip || !el.dataset.tip) return;
        tip.textContent = el.dataset.tip;
        tip.hidden = false;
        const c = card.getBoundingClientRect(), r = el.getBoundingClientRect();
        const w = tip.offsetWidth;
        // centred under the badge, then pushed back inside the card
        tip.style.left = `${Math.max(8, Math.min(c.width - w - 8, r.left - c.left + r.width / 2 - w / 2))}px`;
        // clear of the corner pips, which overhang the badge by half a gap,
        // and never past the bottom of the card, which clips its overflow:
        // both sections collapsed leaves the header barely a card tall
        tip.style.top = `${Math.max(4, Math.min(c.height - tip.offsetHeight - 6, r.bottom - c.top + 8))}px`;
        if (this._badgeTipT) clearTimeout(this._badgeTipT);
        this._badgeTipT = setTimeout(() => this._hideBadgeTip(), 4000);
    }

    _hideBadgeTip() {
        const tip = this.shadowRoot.querySelector(".badge-tip");
        if (tip) tip.hidden = true;
        if (this._badgeTipT) { clearTimeout(this._badgeTipT); this._badgeTipT = null; }
    }

    _act(action, ds) {
        if (action !== "stop") this._dbg(`action ${action}`, { ds: { ...ds } });
        if (action === "toggle-dep") {
            this._collapsed.dep = !this._collapsed.dep;
            this._persistCollapsed();
            this._renderDepartures();
        } else if (action === "toggle-journey") {
            // one journey open on the card; the open one closes on its own
            // tap. The map numbers the points of the journey last opened
            this._jOpen = this._jOpenNow === ds.key ? "" : ds.key;
            const ji = Number(String(ds.key).split(":")[0]);
            if (Number.isFinite(ji)) this._activeJourney = ji;
            this._renderDepartures();
            this._scheduleRerender();
        } else if (action === "toggle-map") {
            this._collapsed.map = !this._collapsed.map;
            this._persistCollapsed();
            this._renderMapSection();
            if (!this._collapsed.map) this._fetchAll(true);
        } else if (action === "row") {
            // a departure tapped on the board: track the bus running it and
            // zoom the map on it, the same as tapping the bus itself. Tapped
            // again, or its vehicle gone from the feed, it lets go
            const li = Number(ds.li);
            const slot = this._ld[li];
            const f = (slot?.geo?.features || [])
                .find((x) => x.properties?.trip_id != null && String(x.properties.trip_id) === String(ds.trip || ""));
            if (this._focus && this._focus.li === li
                && f && this._vid(f) === this._focus.vid) {
                this._focus = null;
                this._manual = false;
                this._restoreTrackedLine();
                this._renderHeader();
                this._renderDepartures();
                this._renderMap(false);
                return;
            }
            if (!f) return;   // not running right now: nothing to zoom on
            this._trackAt = performance.now();
            this._focus = { li, vid: this._vid(f) };
            this._manual = false;
            if (this._hiLine !== li) {
                if (this._trackPrev === undefined) this._trackPrev = this._hiLine;
                this._hiLine = li;
                this._renderHeader();
            }
            this._renderDepartures();
            this._renderMap(true);
        } else if (action === "bus") {
            const li = Number(ds.li);
            this._trackAt = performance.now();
            this._focus = { li, vid: ds.vid || "" };
            this._manual = false;
            // tracking a vehicle selects its line everywhere: header badge,
            // departures filter and map, one consistent context
            if (this._hiLine !== li) {
                // the filter the tracking replaces, given back when it ends
                if (this._trackPrev === undefined) this._trackPrev = this._hiLine;
                this._hiLine = li;
                this._renderHeader();
                this._renderDepartures();
            }
            this._renderMap(true);
            const svg = this.shadowRoot.querySelector(".map-wrap svg");
            if (svg) svg.focus({ preventScroll: true });
        } else if (action === "untrack") {
            // popup closed: stop tracking but keep the current view where it
            // is (the recenter button brings the fitted view back)
            this._focus = null;
            this._manual = true;
            this._restoreTrackedLine();
            this._renderMap(false);
        } else if (action === "unfocus") {
            // the overview button is the full reset: tracking released, the
            // destination and the way picked dropped (the direction is kept:
            // it is where the rider is going), manual pan/zoom forgotten,
            // fitted view
            this._focus = null;
            this._manual = false;
            this._trackPrev = undefined;
            const picked = this._dest != null || this._way != null;
            if (this._hiLine != null || picked) {
                this._hiLine = null;
                if (picked) {
                    this._dest = null;
                    this._way = null;
                    this._persistCollapsed();
                }
                this._renderHeader();
                this._renderDepartures();
            }
            this._renderMap(true);
        } else if (action === "recenter") {
            this._manual = false;
            this._renderMap(true);
        } else if (action === "view-lock") {
            // shut: the view kept for what is picked is let go, and the map
            // frames itself again. Open: the view shown is kept, in place of
            // one kept before for the same pick
            const sel = this._viewSel();
            const views = { ...this._views };
            if (views[sel] && !this._manual) {
                delete views[sel];
                this._views = views;
                this._writeProfileViews((cur) => { delete cur[sel]; return cur; });
                this._renderMap(true);
            } else {
                const box = this._visibleBox();
                if (!box) return;
                views[sel] = box;
                this._views = views;
                this._manual = false;
                this._writeProfileViews((cur) => ({ ...cur, [sel]: box }));
                this._renderMap(false);
            }
            this._persistCollapsed();
        } else if (action === "mode") {
            // changing the reading drops what the other reading had picked:
            // a destination means nothing on a board of lines, and a line
            // picked means nothing among journeys
            const m = ds.mode === "lines" ? "lines" : "trips";
            if (m === this._modeOf()) return;
            this._modePick = m;
            this._hiLine = null;
            this._dest = null;
            this._way = null;
            this._activeJourney = null;
            this._trackPrev = undefined;
            this._focus = null;
            this._manual = false;
            this._persistCollapsed();
            this._renderHeader();
            this._renderDepartures();
            if (!this._collapsed.map) this._renderMap(true);
        } else if (action === "line") {
            const li = Number(ds.li);
            this._hiLine = this._hiLine === li ? null : li;
            this._trackPrev = undefined;   // the user's own pick now
            // a badge click (select or deselect) always resets the map: the
            // tracking is released, a manual pan/zoom is forgotten, and the
            // view glides back to the fitted one. Closing the popup (cross,
            // Escape, tap on the background) keeps the map where it is.
            this._focus = null;
            this._manual = false;
            this._renderHeader();
            this._renderDepartures();
            if (!this._collapsed.map) this._renderMap(true);
        } else if (action === "dest-from" || action === "dest" || action === "dest-way" || action === "dest-clear") {
            // the destination header: the departure, an arrival, a way to
            // leave. Each is the user's own choice, the last two toggles, each
            // narrows the board and the map the way a line's badge did, and
            // all three are remembered
            const v = this._destView();
            if (!v) return;
            if (action === "dest-from") {
                // the lit departure tapped again drops the pick
                this._from = ds.from === v.from ? "" : ds.from;
                this._dest = null;
                this._way = null;
            } else if (action === "dest") {
                if (!v.solo) this._dest = v.dest === ds.key ? null : ds.key;
                this._way = null;
            } else if (action === "dest-way") {
                this._way = v.way === ds.way ? null : ds.way;
            } else if (v.way) {
                this._way = null;
            } else {
                this._dest = null;
            }
            this._persistCollapsed();
            this._hiLine = null;
            this._trackPrev = undefined;
            this._focus = null;
            this._manual = false;
            this._activeJourney = null;
            this._renderHeader();
            this._renderDepartures();
            if (!this._collapsed.map) this._renderMap(true);
        } else if (action === "stop") {
            // tap on a stop: name and connections for two seconds, unless the
            // map already says it all - the tip would print the same words
            // twice, one above the other
            if (!this._labelIsRedundant(ds)) this._showTip(ds, 2000);
        } else if (action === "zoom-in") {
            this._zoomBy(1 / 1.5);
        } else if (action === "zoom-out") {
            this._zoomBy(1.5);
        }
    }

    /* ── HEADER & FOOTER ────────────────────────────────────────────────── */

    // What the operator is reporting on this line, or null. gtfs2 writes
    // "no info" both when its alerts feed says nothing about this journey and
    // when no alerts feed is configured at all, so there is nothing to tell
    // apart: either way there is no alert, and no mark. An alert with a cause
    // but no readable sentence still counts - the feed said something.
    // A realtime departure of TODAY still ahead of us. After the last scheduled
    // departure the sensor already says "resumes tomorrow", but as long as a
    // late bus of today is still coming the line is not at rest.
    _rtToday(d) {
        const rta = d.entity ? this._hass?.states?.[d.entity]?.attributes?.next_departures_realtime : null;
        const nowMs = Date.now();
        return Array.isArray(rta) && rta.some((v) => {
            const t = parseTs(v);
            return t && t.getTime() > nowMs - 60000
                && dayNum(t, d.zone) === dayNum(new Date(nowMs), d.zone);
        });
    }

    // "Nothing today, and nothing until then", in words. The badge says it in
    // marks - a diagonal stroke and a corner pip - and the empty board says it
    // as a sentence. One reading behind all three, so they cannot disagree.
    _restingNote(d) {
        const nIn = d.nextIn;
        if (!Number.isFinite(nIn) || nIn === 0 || this._rtToday(d)) return "";
        return nIn < 0 ? this._t("resting_never")
            : nIn === 1 ? this._t("resting_tomorrow")
            : this._t("resting_days", { n: nIn });
    }

    // An alert's sentence as the card prints it: the stops gtfs2 says it is
    // addressed to (stops, their stations' names) first, unless the
    // sentence names them already. IDFM closes a station under the header
    // "Travaux" and says which one only there, and the rider cannot tell
    // whether it is a stop they use or one their train only passes.
    _alertSay(it) {
        const raw = String(it?.text ?? "").trim();
        const text = raw === "None" || raw === "no info" ? "" : raw;
        const low = text.toLowerCase();
        const stops = (Array.isArray(it?.stops) ? it.stops : [])
            .map((x) => String(x).trim()).filter((x) => x && !low.includes(x.toLowerCase()));
        if (!stops.length) return text;
        return text ? this._t("line_prefix", { l: stops.join(", ") }) + text : stops.join(", ");
    }

    // The stops gtfs2 names on its alerts, by the line that publishes them:
    // {line idx -> {stop name -> [items]}}. An alert with no stops is the
    // line's own and is already said under the board; one with stops is
    // about a place, and a place is somewhere the card can point at.
    _stopAlerts() {
        if (this._saAt === this._hass) return this._saMap;
        const byLine = new Map();
        for (const src of this._depSources()) {
            if (!src.def) continue;
            const at = src.st?.attributes || {};
            for (const k of ["origin_stop_alerts", "destination_stop_alerts"]) {
                for (const it of Array.isArray(at[k]) ? at[k] : []) {
                    // a stop closed next week is open tonight
                    if (!alertNow(it, at)) continue;
                    for (const nm of Array.isArray(it?.stops) ? it.stops : []) {
                        const key = String(nm).trim().toLowerCase();
                        if (!key) continue;
                        if (!byLine.has(src.def.idx)) byLine.set(src.def.idx, new Map());
                        const m = byLine.get(src.def.idx);
                        if (!m.has(key)) m.set(key, []);
                        // the same alert is published on both ends of a
                        // sensor, as two objects of the same words: told
                        // apart by identity, it was kept twice and every
                        // tooltip and mark said it twice over
                        const said = (x) => `${x?.cause}|${x?.effect}|${String(x?.text ?? "").trim()}`;
                        if (!m.get(key).some((x) => said(x) === said(it))) m.get(key).push(it);
                    }
                }
            }
        }
        this._saAt = this._hass;
        this._saMap = byLine;
        return byLine;
    }

    // What is said of this stop of this line, if anything. The name gtfs2
    // puts on an alert is the station's, the one on a shape is the platform's:
    // where they are not the same word, one holding the other is close enough
    // ("Saint-Michel Notre-Dame" against "Saint-Michel").
    _stopAlertsAt(li, name) {
        const byLine = this._stopAlerts();
        if (!byLine.size || li == null) return null;
        const m = byLine.get(Number(li));
        if (!m) return null;
        const nm = String(name ?? "").trim().toLowerCase();
        if (!nm) return null;
        const hit = m.get(nm);
        if (hit) return hit;
        if (nm.length < 4) return null;
        for (const [other, v] of m) {
            if (other.length >= 4 && (other.includes(nm) || nm.includes(other))) return v;
        }
        return null;
    }

    // a list of alerts as the mark the card prints beside a time or a name:
    // the glyph of the worst kind, the sentences in the tooltip
    _alertMarkHtml(items) {
        if (!items?.length) return "";
        const kind = alertKind(items[0].cause, items[0].effect);
        const say = items.map((x) => this._alertSay(x)).filter(Boolean).join(" · ")
            || this._t("alert_" + kind);
        return `<span class="row-alert" role="img" title="${esc(say)}" data-tip="${esc(say)}" aria-label="${esc(say)}">`
            + `<svg viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">${modeGlyph(kind, PIP_INK, "currentColor")}</svg></span>`;
    }

    // the same mark on the map: a small disc over the stop's own, up and to
    // the right of it, where it covers neither the dot nor its label
    // base is the radius of the marker the mark sits on, in the same units
    // the marker is drawn with: a stop's dot (4), a station's disc (10).
    // The mark is read before the marker under it - it is why the eye was
    // sent there - so it is drawn a station's size whatever it sits on, and
    // follows the marker where that is bigger still. Half of a station, it
    // was lost on one and hard to see on a stop at any zoom.
    _alertPipSvg(items, x, y, u, base = 10) {
        if (!items?.length) return "";
        const kind = alertKind(items[0].cause, items[0].effect);
        const r = Math.max(9.5, base) * u;
        return `<g pointer-events="none" transform="translate(${(x + r).toFixed(3)} ${(y - r).toFixed(3)})">`
            + `<circle r="${r.toFixed(3)}" fill="var(--gtfs2-late-color, #e65100)" stroke="var(--card-background-color, #fff)" stroke-width="${(1.4 * u).toFixed(3)}"></circle>`
            + modeGlyph(kind, r * (PIP_INK / (PIP / 2)), "var(--card-background-color, #fff)") + `</g>`;
    }

    _alertOf(d) {
        const at = d.entity ? this._hass?.states?.[d.entity]?.attributes : null;
        if (!at) return null;
        // the head of the stack is the sentence of the string, with the
        // stops it names; the string alone on a gtfs2 without the stack
        // an alert not under way does not colour the badge: the line runs
        const head = ["origin_stop_alerts", "destination_stop_alerts"]
            .map((k) => (Array.isArray(at[k]) ? at[k].find((it) => it && alertNow(it, at)) : null)).find(Boolean);
        const text = head ? this._alertSay(head) : ["origin_stop_alert", "destination_stop_alert"]
            .map((k) => attrVal(at, k))
            .find((v) => v && v !== "no info") || "";
        const cause = attrVal(at, "alert_cause") || "";
        const effect = attrVal(at, "alert_effect") || "";
        if (!text && !cause && !effect) return null;
        return { kind: alertKind(cause, effect), text };
    }

    _renderHeader() {
        // the shell only exists once the strings are in: a fetch that lands
        // first must not draw anything
        if (!this._built) return;
        // a redraw replaces the control under a keyboard user's focus: the
        // one focused is found again by its key
        const fk = this.shadowRoot.activeElement?.dataset?.fk;
        this._renderBadgeHeader();
        if (fk) {
            const again = [...this.shadowRoot.querySelectorAll("[data-fk]")].find((n) => n.dataset.fk === fk);
            if (again) again.focus({ preventScroll: true });
        }
    }

    // The lines of the card, one badge each, the picked one filtering the
    // board and raising its shape on the map. Same frame as the destination
    // header - title above, content, caption row - so switching between the
    // two moves nothing but the middle.
    _renderBadgeHeader() {
        const defs = this._lineDefs();
        const many = defs.length > 1;
        // no auto-derived title: with nothing selected the header is badges
        // only. An explicit title: in the config still shows.
        const title = this._config.title != null ? String(this._config.title) : "";
        // one badge per route the stops serve, not one per stop: two stops
        // on the 003 are one badge, and tapping it filters the board to that
        // route across them all. The first stop serving a route stands for
        // it (its rest and mute state, its position data for the map)
        const routeOf = new Map();   // code → the def standing for it
        for (const d of defs) {
            for (const label of (d.codes || [d.label || "•"])) {
                if (!routeOf.has(label)) routeOf.set(label, d);
            }
        }
        const picked = this._hiLine != null ? defs.find((x) => x.idx === this._hiLine) : null;
        const badges = [...routeOf.entries()]
            .map(([label, d]) => {
                const s = this._badgeState(d);
                const sel = !!picked && ((picked.codes || [picked.label]).includes(label));
                const dim = this._hiLine != null && !sel;
                const a11y = many ? ` data-action="line" data-li="${d.idx}" data-fk="line:${d.idx}" role="button" tabindex="0" aria-pressed="${sel}"` : "";
                const bfs = badgeFontSize(label, this._badgeFamily());
                const marks = s.restSr + s.chip + s.mutePip + s.alertPip + s.rest;
                // the route's own colour, drained like the stop's when it is out of service
                const own = d.codeColors?.get(label) || d.color;
                const bg = s.hs ? drain(own) : own;
                const bink = inkOn(bg);
                const chipBg = `color-mix(in srgb, ${bink === "#ffffff" ? "#000" : "#fff"} 40%, ${esc(bg)})`;
                const opp = bink === "#ffffff" ? "#1b1b1b" : "#ffffff";
                return `<div class="badge ${many ? "clickable" : ""} ${sel ? "sel" : ""} ${dim ? "dim" : ""} ${s.resting ? "resting" : ""} ${s.mute ? "mute" : ""}" style="background:${esc(bg)};color:${bink};--chip-bg:${chipBg};--opp-ink:${opp}${bfs !== BADGE_FS ? `;font-size:${bfs}px` : ""}"${a11y} title="${esc(s.btitle)}"${s.btitle ? ` data-tip="${esc(s.btitle)}"` : ""}><span class="badge-num">${esc(label)}</span>${marks}</div>`;
            })
            .join("");
        this.shadowRoot.getElementById("header").innerHTML = `<div class="dhead">`
            + (title ? `<div class="dtitle">${esc(title)}</div>` : "")
            + `<div class="badges">${badges}</div>`
            + this._capRow("") + `</div>`;
    }

    // Everything a line's badge says, worked out once for its own badge and
    // for its half of a journey's double badge: the colour and the ink on
    // it, the mode glyph, the operator's alert, the rest - and the
    // sentence of the tooltip.
    _badgeState(d) {
        const bdest = d.entity ? (this._hass?.states?.[d.entity]?.attributes?.destination_station_stop_name || "") : "";
        // same table as the map markers: a mode draws the identical
        // shape on the badge and on the vehicle. A sensor naming an
        // icon of its own (not its mode's) keeps that one, via ha-icon.
        let chipInner = "";
        if (this._config.mode_icons !== false) {
            const own = d.icon && !(MDI_DEFAULTS[d.mode || "bus"] || []).includes(d.icon) ? d.icon : null;
            const g = own ? null : modeGlyph(d.mode || "bus", PIP_INK, "currentColor");
            chipInner = g
                ? `<svg class="badge-glyph" viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">${g}</svg>`
                : `<ha-icon icon="${esc(own || d.icon || "mdi:bus")}"></ha-icon>`;
        }
        const chip = chipInner ? `<span class="badge-pip mode br">${chipInner}</span>` : "";
        // A source that has stopped reporting and a line with nothing
        // out look identical: no marker either way, and a plain badge
        // in the header. The card already holds the difference - the
        // positions file carries a Last-Modified, and the integration
        // rewrites it on every cycle whether it found a vehicle or not,
        // so its date only ages when nobody is writing any more. That
        // signal was used to DROP the vehicles of a stale line, in
        // silence. Here it gets said.
        //
        // Three ways to fall quiet, one mark: the entity is gone from
        // Home Assistant, it is there but unavailable, or it is fine
        // and the positions file has frozen. The user does not have to
        // tell them apart on a badge; the tooltip says which, and how
        // long it has been.
        // Nothing runs on this line right now. Mark it on the badge
        // itself, opposite the mode chip, so a line resting for the
        // weekend is told apart at a glance from one that is simply
        // between two buses. The date goes in the title, where the
        // destination already is.
        // How far off the next service is, in days. 0 means the line
        // did run today and its departures are simply behind us, which
        // is not the same thing as a line resting: it starts again
        // tomorrow morning, so the badge is left alone. The stroke is
        // for a line with nothing today AND nothing until later.
        const nIn = d.nextIn;
        // A late bus still on its way outranks the timetable: after
        // the last scheduled departure the sensor already says
        // "resumes tomorrow", but as long as a realtime departure of
        // TODAY is still ahead, the line is not at rest and the
        // stroke waits. Same window as the board's own filter, so
        // the badge and the rows change together, not one by one.
        const rtToday = this._rtToday(d);
        // -1 means the feed has no service left for this journey at all,
        // which deserves the mark as much as a long rest does
        const restTitle = this._restingNote(d);
        const resting = !!restTitle;
        const slot = this._ld[d.idx];
        const st = d.entity ? this._hass?.states?.[d.entity] : null;
        const gone = !!d.entity && !st;
        // "unknown" is the NORMAL state of a line with no departure to
        // show: on a resting line, or one whose late realtime is still
        // on the board, it must not read as a fault. Only
        // "unavailable", or "unknown" outside those two, says the
        // source itself has a problem.
        const down = !!st && (st.state === "unavailable" || (st.state === "unknown" && !resting && !rtToday));
        // a source that has already spoken gets the benefit of the
        // doubt until it has been silent a full STALE_FEED: one failed
        // request is a hiccup, not an outage, and a mark that blinks on
        // and off teaches the user to ignore it. One that has never
        // spoken and errors has nothing to wait for.
        // a resting line's positions file is legitimately silent for
        // days: that silence is explained by the rest, not news
        const frozen = !!d.positions_url && !!slot && !resting
            && (slot.sigAt ? Date.now() - slot.sigAt > STALE_FEED : !!slot.err);
        const mute = gone || down || frozen;
        // out of service: nothing it shows is current any more
        const hs = gone || down;
        const muteTitle = !mute ? ""
            : gone ? this._t("mute_gone")
            : down ? this._t("mute_unavailable")
            : slot.err ? this._t("mute_unreachable")
            : this._t("mute_since", { t: fmtDur(Math.round((Date.now() - slot.sigAt) / 60000)) });
        // opposite corner from the mode, and drawn on the opposite
        // diagonal from the resting stroke: three marks can share one
        // badge without any two being taken for each other
        // top-right: the operator's own word on this line. It is the
        // only mark that comes from outside the card's own reading of
        // the data, so it sits opposite the mode and keeps its own ink.
        const alert = this._alertOf(d);
        const alertTitle = alert ? (alert.text || this._t("alert_" + alert.kind)) : "";
        const alertPip = alert
            ? `<span class="badge-pip alert tr"><svg class="badge-glyph" `
              + `viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">`
              + `${modeGlyph(alert.kind, PIP_INK, "currentColor")}</svg></span>`
            : "";
        const mutePip = mute
            ? `<span class="badge-pip mute tl"><svg class="badge-glyph" `
              + `viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">`
              + `${modeGlyph("mute", PIP_INK, "currentColor")}</svg></span>`
            : "";
        let rest = "";
        if (resting) {
            // A single diagonal, not a cross: one stroke leaves the
            // number far more readable, and a line must still show its
            // number when it is not running.
            //
            // The stroke is the badge's own ink at 65%, which alone
            // measures as low as 2.2:1 on a mid green or a grey line.
            // The halo underneath is the opposite ink, which lifts it
            // past 10:1 on every line colour without making the stroke
            // any heavier. Drawn in SVG because a gradient cannot take
            // a halo.
            rest = `<svg class="badge-slash" viewBox="0 0 60 60" preserveAspectRatio="none" aria-hidden="true">`
                + `<path class="slash-halo" d="M10 50 L50 10" fill="none" stroke-linecap="round"/>`
                + `<path d="M10 50 L50 10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>`
                + `</svg>`;
            // The stroke says "not today" and says it for all three
            // cases. Which of the three is the bottom-left corner's
            // job: a dial for tomorrow, a calendar for a rest of
            // several days, a cross for a line with no service left
            // at all. Until this pip, only the tooltip told them
            // apart, and a tooltip is not hovered on a phone.
            //
            // The stroke ends under this pip. The slash is drawn in a
            // 60-unit box stretched to the badge, so both scale together:
            // at BADGE_W 44 the disc lands on 7.5,52.5 with a radius of
            // 15 in that box, and the stroke's end at 10,50 still falls
            // inside it - it emerges from beneath the pip rather than
            // crossing it.
            rest += `<span class="badge-pip svc bl"><svg class="badge-glyph" `
                + `viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">`
                + `${modeGlyph(nIn < 0 ? "never" : nIn === 1 ? "tomorrow" : "days", PIP_INK, "currentColor")}`
                + `</svg></span>`;
        }
        // the label reads against its own line colour, the same rule
        // the map markers follow: a light line colour takes dark text
        // A sensor out of service (gone, unavailable) drains its line of its
        // chroma, its lightness kept so the ink rule below still holds:
        // nothing the badge says is current. One whose positions file alone
        // has gone quiet keeps its colour - its timetable still stands, and
        // greyed, three lines of one operator read as one - its pip says it
        const bg = hs ? drain(d.color || this._config.line_color) : (d.color || this._config.line_color);
        const bink = inkOn(bg);
        // the mode chip's disc goes the other way round from the ink,
        // so the glyph keeps its contrast on light and dark lines alike
        // mixed INTO the line colour rather than left translucent: the
        // chip now overflows the badge, and a see-through disc would
        // pick up the card behind it and read as a cut-off half moon
        const chipBg = `color-mix(in srgb, ${bink === "#ffffff" ? "#000" : "#fff"} 40%, ${esc(bg)})`;
        const btitle = [bdest, restTitle, alertTitle, muteTitle].filter(Boolean).join(" · ");
        // the halo takes the ink the other way round, so it separates
        // the stroke from the badge whichever way the contrast runs
        const opp = bink === "#ffffff" ? "#1b1b1b" : "#ffffff";
        // the stroke says it visually and title says it on hover, but
        // neither reaches a screen reader: state it in the text layer
        const restSr = [restTitle, alertTitle, muteTitle].filter(Boolean)
            .map((s) => `<span class="sr-only">${esc(s)}</span>`).join("");
        const blabel = this._lineLabelOf(d);
        const bfs = badgeFontSize(blabel, this._badgeFamily());
        // the stroke alone, for a half of a double badge: its rest pip has
        // no corner there, the stroke on its half says it
        const slash = resting ? rest.slice(0, rest.indexOf('<span class="badge-pip svc')) : "";
        const alertGlyph = alert ? alertPip.replace(/^<span class="badge-pip alert tr">/, "").replace(/<\/span>$/, "") : "";
        return { bg, bink, chipBg, opp, mute, hs, muteTitle, resting, restTitle, btitle, restSr, blabel, bfs, chip, chipInner, mutePip, alertPip, alertGlyph, rest, slash, bdest };
    }

    /* ── The destination header ──────────────────────────────────────────
     * A card of journeys says where, not how: a chip per destination, the
     * ways to leave for the one picked, and the direction shown, which is
     * the user's choice and never the clock's. The board below says how,
     * run by run. */

    /* The stop card has no journeys: a board of departures and a map. The
     * journey reading is gone; what the shared code still asks for is
     * stubbed to its no-journey answer. */

    get _journeys() { return []; }

    _destEntries() { return []; }

    _destView() { return null; }

    _destLines() { return new Set(); }

    _destTopLi() { return null; }

    _canTrips() { return false; }

    _isTable() { return true; }

    _modeOf() { return "lines"; }

    _modeSwap() { return ""; }

    _capRow(inner) { return inner ? `<div class="caprow"><span class="capleft">${inner}</span></div>` : ""; }

    _lineVias() { return []; }

    _rowVias() { return []; }

    _viasHtml() { return ""; }

    _rowEnds() { return { on: null, off: null }; }

    _rowEndsNote() { return ""; }

    _legSlice() { return { route: null, oi: 0, di: 0, oname: null, dname: null }; }

    _legRows() { return null; }

    _subRoute() { return null; }

    _journeyGeometry() { return null; }

    _visiblePlans() { return []; }

    _renderFooter() {
        if (!this._built) return;   // no shell yet: see _renderHeader
        // consider every departure sensor, not just the primary one: one line
        // ending its service must not relabel the whole card as schedule-only
        const lang = this._lang();
        const srcs = this._depSources();
        const rtTimes = srcs.map((s) => parseTs(s.st.attributes?.gtfs_updated_at ?? s.st.attributes?.gtfs_rt_updated_at)).filter(Boolean).map((d) => d.getTime());
        const newest = rtTimes.length ? Math.max(...rtTimes) : 0;
        const unavailable = srcs.filter((s) => s.st.state === "unavailable").length;
        let left = srcs.length
            ? (newest ? this._t("updated", { t: fmtAgo(lang, Date.now() - newest) }) : this._t("schedule_only"))
            : this._t("rt_positions");
        if (unavailable) left += ` · ${this._t("sensors_unavailable", { n: unavailable })}`;
        const html = `<span>${esc(left)}</span><span>gtfs2</span>`;
        if (this._footerHtml !== html) {
            this.shadowRoot.getElementById("footer").innerHTML = html;
            this._footerHtml = html;
        }
    }

    /* ── PANE 1: DEPARTURES ─────────────────────────────────────────────── */

    // All rows the card's stops list, filtered and sorted, uncapped: the
    // board, the grouping and the vehicle join all read from this
    _allRows() {
        let rows = [];
        for (const src of this._depSources()) rows.push(...this._sourceRows(src));
        // a route picked by tapping its badge filters the board to that
        // route, across every stop the card holds
        if (this._hiLine != null) {
            const hd = this._lineDefs().find((x) => x.idx === this._hiLine);
            const want = hd ? (hd.codes || [hd.label]) : null;
            if (want) rows = rows.filter((r) => want.includes(r.line));
        }
        // a row rides a couple of minutes past its time - the bus the rider
        // came for is often still sitting at the stop - and leaves then:
        // the vehicle join drops with it
        const now = Date.now(), cutoff = now - DEPART_GRACE_MS;
        const upcoming = rows.filter((r) => Math.max(r.time.getTime(), r.theo ? r.theo.getTime() : 0) > cutoff);
        upcoming.sort((x, y) => x.time.getTime() - y.time.getTime());
        return upcoming;
    }

    _departureRows() {
        const upcoming = this._allRows();
        return { rows: upcoming.slice(0, this._config.max_departures), multi: this._depSources().length > 1 };
    }

    // The trip of the vehicle tracked on the map, when it has one: its row
    // on the board is highlighted while it is tracked
    _focusTrip() {
        if (!this._focus) return null;
        const slot = this._ld[this._focus.li];
        const f = slot?.geo?.features?.find((x) => this._vid(x) === this._focus.vid);
        return f?.properties?.trip_id != null ? String(f.properties.trip_id) : null;
    }

    // A departure ridden by another mode than its line's, a replacement
    // coach listed by a train line: its glyph beside the time, the same one
    // the badge draws for a bus. Nothing when the modes agree, so a board of
    // one mode reads as it always did.
    _rowModeHtml(r) {
        if (r.rtype == null || !r.def || this._config.mode_icons === false) return "";
        const mode = modeKey(r.rtype);
        if (mode === (r.def.mode || "bus")) return "";
        const word = modeWord(this._lang(), mode, false);
        return `<span class="row-mode" title="${esc(word)}" aria-label="${esc(word)}">`
            + `<svg viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">${modeGlyph(mode, PIP_INK, "currentColor")}</svg></span>`;
    }

    // one sensor's departures as rows {time, theo, rt, delayMin, durMin,
    // rtype, tripId, def}, realtime paired with its schedule slot; after
    // them the runs the feed struck out (struck: "cancelled", or "skipped"
    // when the run does not call at the origin), timed as the sensor last
    // listed them; an alert naming a run rides on its row (alerts). Neither
    // filtered nor sorted, the board and the journey chain do that their
    // own way
    // The header asks for the same sensor's rows once per chip and the board
    // once more: on a card of sixty sensors that was two hundred readings of
    // the same lists for one drawing. Kept per state object, which Home
    // Assistant replaces whenever the sensor changes, for a few seconds (the
    // rows lean on the clock: a feed going stale, a struck run expiring).
    // Handed out as copies, the board trims the alerts of its own rows.
    _sourceRows(src) {
        const now = Date.now();
        const hit = this._rowsCache.get(src.st);
        if (hit && now - hit.at < 5000) return hit.rows.map((r) => ({ ...r, def: src.def }));
        const rows = this._readSourceRows(src);
        this._rowsCache.set(src.st, { at: now, rows });
        return rows.map((r) => ({ ...r }));
    }

    // One stop's departures as rows, straight from the local-stop sensor's
    // next_departures_lines: gtfs2 has already merged the realtime into
    // each entry and named its trip - what the map's vehicles are joined
    // by. Each entry is self-contained: no parallel lists, no pairing, no
    // struck-run memory (a cancelled run simply stops being listed, and the
    // sensor does not say it was).
    _readSourceRows(src) {
        const rows = [];
        const a = src.st.attributes || {};
        const deps = Array.isArray(a.next_departures_lines) ? a.next_departures_lines : [];
        // A feed gone quiet leaves its last predictions behind: past RT_STALE
        // they are not live any more, and the schedule stands in
        const rtAt = parseTs(a.gtfs_updated_at);
        const rtStale = !!rtAt && Date.now() - rtAt.getTime() > RT_STALE;
        for (const d of deps) {
            if (!d || typeof d !== "object") continue;
            const theo = parseTs(d.departure_datetime);
            const rtT = parseTs(d.departure_realtime_datetime);
            const time = (!rtStale && rtT) || theo;
            if (!time) continue;
            const rt = !rtStale && !!rtT;
            // delay_realtime is seconds; delay_realtime_derived is its
            // "H:MM:SS" spelling. The gap from the theoretical time stands in
            const delaySec = typeof d.delay_realtime === "number" ? d.delay_realtime : null;
            const delayMin = rt
                ? (delaySec != null ? Math.round(delaySec / 60)
                    : theo ? Math.round((time.getTime() - theo.getTime()) / 60000) : null)
                : null;
            rows.push({
                time, theo, rt, delayMin, durMin: null, rtype: null,
                tripId: d.trip_id != null ? String(d.trip_id) : null,
                oid: d.stop_id != null ? String(d.stop_id) : null,
                did: d.stop_id != null ? String(d.stop_id) : null,
                line: d.route != null ? String(d.route) : null,
                headsign: d.headsign != null ? String(d.headsign) : null,
                dirId: d.direction_id,
                date: d.date != null ? String(d.date) : null,
                def: src.def,
            });
        }
        // the alerts naming a run of the board, on its row
        const alerts = this._tripAlerts(a);
        if (alerts.size) for (const r of rows) if (r.tripId && alerts.has(r.tripId)) r.alerts = alerts.get(r.tripId);
        return rows;
    }

    // The operator's alerts that name departures of the board, by the trip
    // they name: {trip id → [items]}, each worst first as gtfs2 ranks them.
    // gtfs2 lists on every item of the stack the trips it names (trips),
    // head first; an alert on the second train of the board is there too,
    // with later_only, where the one sentence of origin_stop_alert never
    // takes it.
    _tripAlerts(a) {
        const out = new Map();
        for (const it of Array.isArray(a.origin_stop_alerts) ? a.origin_stop_alerts : []) {
            if (!alertNow(it, a)) continue;
            for (const t of Array.isArray(it?.trips) ? it.trips : []) {
                const k = String(t);
                if (!out.has(k)) out.set(k, []);
                out.get(k).push(it);
            }
        }
        return out;
    }

    // What the operator says of this run, when an alert names it: the mark
    // of its kind beside the time, the badge's own glyph, the sentence in
    // the tooltip - printed under the mark on a tap, a finger cannot hover
    _rowAlertHtml(r) {
        return this._alertMarkHtml(r?.alerts);
    }

    /* ── JOURNEY: legs chained on the board, slices numbered on the map ── */

    // Where a leg starts and ends on its route shape: indexes into
    // route.stops, or null while the shape is not read yet. The sensor names
    // its two ends three ways, tried from the surest to the loosest: the
    // stop_sequence (only trains carry it today), the stop id (the record
    // the user picked, which on a grouped stop is not always the platform
    // the trip serves), then the name. The destination is looked for AFTER
    // the origin: a loop line calls at a stop twice. An end not found falls
    // back on the shape's own end, so the slice still draws.
    // The stops a sensor's runs really call at, in riding order, as a route
    // the slice and the trips read: from the leg file of a gtfs2 that lists
    // every call of every run it times (stops). What a train sensor needs
    // when the shape gtfs2 draws is one run that skips one of its stations
    // (a K6+ from Tours through Les Aubrais, never Orléans, on a sensor
    // boarding at both). The order merges the runs' own, each sorted by
    // its stop_sequence; a stop's clock is the runs' own gap from the stop
    _renderDepartures() {
        if (!this._built) return;   // no shell yet: see _renderHeader
        const head = this.shadowRoot.getElementById("dep-head");
        const body = this.shadowRoot.getElementById("dep-body");
        // hidden by configuration, or a map-only card with no departure
        // sensor anywhere: no pane, no header, not even its divider
        if (this._config.show_departures === false || !this._depSources().length) {
            head.style.display = "none";
            body.innerHTML = "";
            return;
        }
        head.style.display = "";
        head.setAttribute("aria-expanded", String(!this._collapsed.dep));
        const lang = this._lang();
        const now = new Date();
        const hiDef = this._hiLine != null ? this._lineDefs().find((d) => d.idx === this._hiLine) : null;
        // the picked line in the section head is also how to drop the pick:
        // a second tap on the header badge was the only way back, unsaid
        const clear = esc(this._t("clear_filter"));
        const filterBadge = hiDef ? ` <span class="mini-badge filter" style="background:${esc(hiDef.color)};color:${inkOn(hiDef.color)}" data-action="line" data-li="${hiDef.idx}"`
            + ` role="button" tabindex="0" title="${clear}" aria-label="${clear}">${esc(this._lineLabelOf(hiDef))}<span class="x" aria-hidden="true">×</span></span>`
            : "";
        const { rows, multi } = this._departureRows();
        // the run of the vehicle tracked on the map lights up on the board
        const focusTrip = this._focusTrip();
        if (focusTrip) for (const r of rows) r.hit = r.tripId === focusTrip;
        // the line of each row: needed among several sensors, and on one
        // sensor whose runs ride different lines (a train sensor on K8+, K6+
        // and P8). The destinations stay a matter of several sensors
        const lined = multi || rows.some((r) => r.line);
        // an alert naming every run of its line on the board singles none
        // out: the strip under the board says it, the rows carry no mark.
        // One naming some of them marks those, and the marks say which
        const runsOf = new Map();
        for (const r of rows) if (!r.struck) runsOf.set(r.def, [...(runsOf.get(r.def) || []), r]);
        for (const [, rs] of runsOf) {
            const all = new Set(rs.flatMap((r) => r.alerts || []).filter((it) => rs.every((r) => r.alerts?.includes(it))));
            if (!all.size) continue;
            for (const r of rs) {
                const left = r.alerts.filter((it) => !all.has(it));
                if (left.length) r.alerts = left; else delete r.alerts;
            }
        }
        const hasRt = rows.some((r) => r.rt);
        // the next departure is the next one that runs
        const nextRow = rows.find((r) => !r.struck);

        if (this._collapsed.dep) {
            const nextLine = lined && nextRow?.def ? ` <span class="mini-badge" style="background:${esc(this._rowColor(nextRow))};color:${inkOn(this._rowColor(nextRow))}">${esc(this._rowLabel(nextRow))}</span>` : "";
            const nextDay = nextRow ? dayTag(lang, nextRow.time, now, nextRow.def?.zone) : "";
            const summary = nextRow
                ? `${this._t("next")}${nextLine} <b>${nextDay ? esc(nextDay) + " " : ""}${this._hm(nextRow.time, nextRow.def?.zone)}</b>${nextRow.rt && nextRow.delayMin ? ` · ${nextRow.delayMin > 0 ? "+" : ""}${nextRow.delayMin} min` : ""}`
                : this._t("no_departure");
            head.innerHTML = `
                <span class="chev">${ICONS.chevronRight}</span>
                <span class="sect-title">${this._t("departures")}</span>${filterBadge}
                <span class="spacer"></span>
                ${hasRt ? `<span class="live-dot"></span>` : ""}
                <span class="summary">${summary}</span>`;
            body.innerHTML = "";
            return;
        }

        head.innerHTML = `
            <span class="chev">${ICONS.chevronDown}</span>
            <span class="sect-title">${this._t("departures")}</span>${filterBadge}
            <span class="spacer"></span>
            ${hasRt ? `<span class="live-dot"></span><span class="summary">${this._t("realtime")}</span>` : `<span class="summary">${this._t("scheduled")}</span>`}`;

        // the board: one section per stop when the card holds several and
        // the config asks for it (the default) - two stops on the same
        // route, one each way, read far better apart - else one merged list
        const group = this._config.group_by !== "none" && this._lineDefs().length > 1;
        const rowsHtml = group
            ? this._lineDefs().map((d) => {
                const rs = this._allRows().filter((r) => r.def?.idx === d.idx)
                    .slice(0, this._config.max_departures);
                if (focusTrip) for (const r of rs) r.hit = r.tripId === focusTrip;
                if (!rs.length) return "";
                // the headsign in the heading only when the stop's upcoming
                // departures all go the same way; a stop serving several
                // routes or directions lets its rows say where each goes
                const heads = [...new Set(rs.map((r) => r.headsign).filter(Boolean))];
                return `<div class="jsec">${esc(d.label || this._lineLabelOf(d))}`
                    + (heads.length === 1 ? `<span class="jsec-sub">→ ${esc(heads[0])}</span>` : "")
                    + `</div>`
                    + this._departuresTableHtml(rs, false, rs.find((r) => !r.struck), lang, now);
            }).join("")
            : this._isTable()
            ? this._departuresTableHtml(rows, multi, nextRow, lang, now)
            : rows.map((r) => {
            const strike = r.rt && r.theo && Math.abs(r.time - r.theo) >= 60000;
            // the sub-line says only what the big line does not: the schedule
            // slot when it MOVED (struck through). The realtime icon and the
            // right-hand chip carry the rest, so a row with nothing
            // exceptional is a single line.
            const bits = [];
            if (strike) bits.push(`<span class="sub strike">${this._t("scheduled_at", { t: this._hm(r.theo, r.def?.zone) })}</span>`);
            const subLine = bits.length ? `<span class="sub-line">${bits.join("")}</span>` : "";
            const chip = this._statusChip(r.rt, r.delayMin, r.struck);
            const badge = lined && r.def
                ? `<span class="row-badge" style="background:${esc(this._rowColor(r))};color:${inkOn(this._rowColor(r))}">${esc(this._rowLabel(r))}</span>`
                : "";
            const destSub = multi && r.def
                ? this._hass?.states?.[r.def.entity]?.attributes?.destination_station_stop_name || ""
                : "";
            const tag = dayTag(lang, r.time, now, r.def?.zone);
            // a struck run: its time struck through, no countdown to a bus
            // that does not come, the chip saying which of the two it is
            return `
            <div class="row${r.struck ? " struck" : ""}${r.hit ? " hit" : ""}"${r.tripId ? ` data-action="row" data-li="${r.def?.idx ?? 0}" data-trip="${esc(r.tripId)}" role="button" tabindex="0"` : ""}>
                ${badge}
                <div class="times">
                    <div class="time-line">
                        <span class="time${r.struck ? " struck" : ""}">${this._hm(r.time, r.def?.zone)}</span>
                        ${e.on ? `<span class="sub end-at">${esc(e.on)}</span>` : ""}
                        ${this._rowModeHtml(r)}
                        ${tag ? `<span class="day-tag">${esc(tag)}</span>` : ""}
                        ${r.rt ? `<span class="rt-icon">${ICONS.live}</span>` : ""}
                        ${this._rowAlertHtml(r)}
                        ${destSub ? `<span class="sub dest-inline">${esc(destSub)}</span>` : ""}
                    </div>
                    ${subLine}
                </div>
                <span class="spacer"></span>
                <div class="right">
                    ${r.struck ? "" : `<span class="countdown" data-ts="${r.time.getTime()}">${fmtCountdown(lang, r.time, now)}</span>`}
                    ${chip}
                </div>
            </div>`;
        }).join("");

        const chips = [];
        const seenAlerts = new Set();
        const alertSrcs = hiDef ? this._depSources().filter((s) => s.def && s.def.idx === hiDef.idx) : this._depSources();
        for (const src of alertSrcs) {
            // the line picked needs no naming: the board is its alone
            const prefix = src.def && !hiDef && this._depSources().length > 1 ? this._t("line_prefix", { l: this._lineLabelOf(src.def) }) : "";
            if (src.st.state === "unavailable") {
                chips.push(`<span class="info-chip info-alert">${ICONS.alert}${esc(prefix + this._t("chip_unavailable"))}</span>`);
                continue;
            }
            // the operator's alerts: the whole stack when gtfs2 publishes it
            // (worst first, one naming a later departure only after the
            // rest), its one sentence else. An alert naming departures of
            // the board says which, by their times: the rows carry its mark
            const at = src.st.attributes || {};
            const stack = Array.isArray(at.origin_stop_alerts) ? at.origin_stop_alerts : [{ text: at.origin_stop_alert }];
            for (const it of stack) {
                // announced for a later day, or over: not this ride's
                if (!alertNow(it, at)) continue;
                const text = this._alertSay(it);
                if (!text) continue;
                const label = prefix + text;
                if (seenAlerts.has(label)) continue;
                seenAlerts.add(label);
                chips.push(`<span class="info-chip info-alert">${ICONS.alert}${esc(label)}</span>`);
            }
        }

        const hiSt = hiDef?.entity ? this._hass?.states?.[hiDef.entity] : null;
        // "No upcoming departure" is a dead end: it is true, and it leaves the
        // user with nowhere to go. When the stop is at rest the card already
        // knows when it runs again - it is on the badge, in a tooltip a finger
        // can barely reach. The board is where they are looking, so it says the
        // date instead. Only the stops shown here are asked: with a line
        // selected the board is that line's, and its rest is the whole answer.
        const restDefs = hiDef ? [hiDef] : this._depSources().map((s) => s.def).filter(Boolean);
        const notes = restDefs.map((d) => [d, this._restingNote(d)]).filter(([, n]) => n);
        const uniq = [...new Set(notes.map(([, n]) => n))];
        // one date for every line at rest: say it once, unprefixed
        const restMsg = !notes.length ? ""
            : uniq.length === 1 ? uniq[0]
            : notes.map(([d, n]) => this._t("line_prefix", { l: esc(this._lineLabelOf(d)) }) + n).join(" · ");
        const emptyMsg = (hiSt && hiSt.state === "unavailable" ? this._t("sensor_unavailable")
            : (restMsg || this._t("none_upcoming")));
        body.innerHTML = (rowsHtml || `<div class="empty${restMsg ? " rest" : ""}">${emptyMsg}</div>`)
            + (chips.length ? `<div class="info-strip">${chips.join("")}</div>` : "");
    }

    // The status right of a countdown: what the feed struck out, else
    // scheduled when no realtime rides the run, else its delay; nothing
    // when the feed gives no schedule to measure against.
    _statusChip(rt, delay, struck) {
        if (struck) return `<span class="chip chip-struck">${this._t(struck === "cancelled" ? "cancelled" : "not_stopping")}</span>`;
        if (!rt) return `<span class="chip chip-theo">${this._t("scheduled")}</span>`;
        if (delay == null) return "";
        if (Math.abs(delay) < 1) return `<span class="chip chip-ok">${this._t("on_time")}</span>`;
        if (delay > 0) return `<span class="chip chip-late">+${delay} min</span>`;
        return `<span class="chip chip-early">${delay} min</span>`;
    }

    // One section's rows, one per journey run, as dense as the journey asks.
    // Every row has a head line: departure and arrival at the same size,
    // since door to door both are the answer, the total time beside them,
    // the countdown and the status of the arrival at the right. A journey of
    // one sensor and no via has nothing more to say: the head is the row.
    // One with vias or changes opens into a timeline - one line per point,
    // each leg a stretch of rail in its line's colour with its badge at the
    // top, the points ringed in that colour with the numbers of the map,
    // their clocks in one column, a feed time in bold; a change says its
    // wait, or its walk and its wait. Closed, a journey with changes keeps
    // one line of its legs, badges and times. The next openable run is open
    // until another is tapped. The runs of every journey share one list, by
    // departure; where the card holds several journeys (labelled), each row
    // says which under its head: a lone line's badge, the journey's title.
    _departuresTableHtml(rows, multi, nextRow, lang, now, vias = new Map()) {
        if (!rows.length) return "";
        // journeys are comparable when they end at the same place: durations
        // are graded against the fastest run TO THE SAME DESTINATION, so two
        // lines to Paris rate each other (the slow one reads warm even at its
        // own usual pace) while lines to different places never do. A sensor
        // naming no destination falls back to its own line's best.
        // A run ending short of the destination is graded among the runs to
        // where it does end, or the 13 to Chèques Postaux would read fast
        const ends = new Map(rows.map((r) => [r, this._rowEnds(r)]));
        const keyOf = (r) => {
            const dest = ends.get(r).off || (r.def?.entity && this._hass?.states?.[r.def.entity]?.attributes?.destination_station_stop_name);
            return dest ? "d:" + String(dest).trim().toLowerCase() : "l:" + (r.def ? r.def.idx : -1);
        };
        const best = new Map();
        for (const r of rows) {
            if (!Number.isFinite(r.durMin)) continue;
            const k = keyOf(r);
            if (!best.has(k) || r.durMin < best.get(k)) best.set(k, r.durMin);
        }
        // a destination column only when it tells rows apart
        const destOf = (r) => String(r.headsign || r.def?.stopName || "");
        const showDest = rows.some((r) => destOf(r));
        const lined = multi || rows.some((r) => r.line);
        // a via column only when a line of the board has stops on the way
        const showVia = rows.some((r) => (vias.get(r.def?.idx) || []).length);
        const ncol = 4 + (lined ? 1 : 0) + (showVia ? 1 : 0);
        // a run leaving past the origin, or ending short of the destination,
        // names the place beside its time: the times then start the cells,
        // read from the left, whatever follows them
        const named = rows.some((r) => ends.get(r).on || ends.get(r).off);
        let lastTag = "";
        const cells = rows.map((r) => {
            const tag = dayTag(lang, r.time, now, r.def?.zone);
            const sep = tag && tag !== lastTag ? `<tr class="day-sep"><td colspan="${ncol}"><span class="day-tag">${esc(tag)}</span></td></tr>` : "";
            lastTag = tag;
            // the realtime icon sits LEFT of the time: the right edge belongs
            // to the digits, so times align whether a row carries it or not.
            // The delay follows the time it moves; the tooltip says the rest
            // in a narrow column of its own, so the times stay aligned
            // a struck run takes the delay column for its word, its time
            // struck through, and no arrival
            const dly = r.struck ? this._statusChip(true, null, r.struck)
                : r.rt && r.delayMin != null && Math.abs(r.delayMin) >= 1
                ? `<span class="dly ${r.delayMin > 0 ? "st-late" : "st-early"}">${r.delayMin > 0 ? "+" : ""}${r.delayMin} min</span>` : "";
            // a coach on a train line says so on the same left side, for the
            // same reason, and so does the operator's alert on the run
            const e = ends.get(r);
            const moved = r.rt && r.theo && Math.abs(r.time - r.theo) >= 60000;
            // the schedule slot under the realtime time it moved from: quiet,
            // in parentheses, aligned with the digits - the feed's answer is
            // the loud one, the timetable the reference it moved away from
            const dep = (r.rt ? `<span class="rt-icon">${ICONS.live}</span>` : "") + this._rowModeHtml(r) + this._rowAlertHtml(r)
                + `<span class="dep-stack">${r.struck
                    ? `<span class="struck">${this._hm(r.time, r.def?.zone)}</span>`
                    : this._hm(r.time, r.def?.zone)
                        + (moved ? `<span class="sched-at">(${esc(this._hm(r.theo, r.def?.zone))})</span>` : "")}</span>`
                + (e.on ? ` <span class="end-at">${esc(e.on)}</span>` : "");
            const depTitle = r.struck ? this._t(r.struck === "cancelled" ? "cancelled" : "not_stopping")
                : r.rt && r.theo && Math.abs(r.time - r.theo) >= 60000
                ? this._t("scheduled_at", { t: this._hm(r.theo, r.def?.zone) })
                : this._t(r.rt ? "realtime" : "no_rt_yet");
            const line = lined
                ? `<td class="fit">${r.def ? `<span class="row-badge" style="background:${esc(this._rowColor(r))};color:${inkOn(this._rowColor(r))}">${esc(this._rowLabel(r))}</span>` : "-"}</td>`
                : "";
            // the last column is where the run goes: its headsign
            const last = showDest ? `<td class="dest-c">${esc(destOf(r)) || "-"}</td>` : `<td></td>`;
            const rv = this._rowVias(r, vias);
            const via = showVia ? `<td class="fit vias">${rv.length ? this._viasHtml(rv) : "-"}</td>` : "";
            // the same words again, under the times, for a narrow card: on a
            // phone seven columns left the stops on the way two letters of
            // width ("Ras / pail / 06:0 / 3"). There the two columns of words
            // go and this row says them whole; wide, it is never shown
            const words = [showDest && destOf(r) ? `<span class="sub-dest">→ ${esc(destOf(r))}</span>` : "",
                rv.length ? `<span class="sub-via">${this._t("col_via")} ${this._viasHtml(rv)}</span>` : ""].filter(Boolean);
            const sub = words.length ? `<tr class="row-sub">${lined ? "<td></td>" : ""}<td colspan="${ncol - (lined ? 1 : 0)}">${words.join("")}</td></tr>` : "";
            const num = named ? "num at" : "num";
            // a row is a button: tapping it tracks the bus running the run
            // and zooms the map on it (see _act, action "row")
            const rowAttrs = r.tripId
                ? ` data-action="row" data-li="${r.def?.idx ?? 0}" data-trip="${esc(r.tripId)}" role="button" tabindex="0"`
                : "";
            const inCell = r.struck ? `<td class="fit"></td>`
                : `<td class="fit"><span class="countdown" data-ts="${r.time.getTime()}">${fmtCountdown(lang, r.time, now)}</span></td>`;
            return sep + `<tr${r.hit ? ` class="hit"` : ""}${rowAttrs}>${line}${inCell}<td class="${num} dep fit" title="${esc(depTitle)}">${dep}</td><td class="dly-c fit">${dly}</td>${via}${last}</tr>` + sub;
        }).join("");
        const summary = nextRow ? `<div class="board-next">${this._t("next_dep_in", {
            c: `<span class="countdown" data-ts="${nextRow.time.getTime()}">${fmtCountdown(lang, nextRow.time, now)}</span>`,
            t: `<b>${this._hm(nextRow.time, nextRow.def?.zone)}</b>`,
        })}</div>` : "";
        return summary
            + `<div class="board-wrap"><table class="board"><thead><tr>`
            + (lined ? `<th class="fit">${this._t("col_line")}</th>` : "")
            + `<th class="fit">${this._t("col_in")}</th>`
            + `<th class="${named ? "num at" : "num"} fit">${this._t("col_departure")}</th><th class="fit"></th>`
            + (showVia ? `<th class="fit vias">${this._t("col_via")}</th>` : "") + `<th${showDest ? ` class="dest-c"` : ""}>${showDest ? this._t("col_destination") : ""}</th>`
            + `</tr></thead><tbody>${cells}</tbody></table></div>`;
    }

    /* A journey board laid out as a timetable, the departures table's own
     * shape: one row per journey sorted by departure, and one column per
     * point in riding order - the start, each stop listed on the way, where
     * each leg is left and, after the wait of the change, where the next one
     * is boarded - then the door-to-door time. The lines ride a header row
     * of their own, each badge over its leg's columns, which says where the
     * changes are and makes a line column needless. The departure column
     * stays in place when a long journey scrolls sideways; a day is said
     * once, on a row of its own; the delay at the arrival follows the
     * arrival's time. */
    _ptLabel(p) {
        return p.kind === "start" ? this._t("pt_start") : p.kind === "end" ? this._t("pt_end") : String(p.n);
    }

    // a point's clock: a feed time in bold, a scheduled or derived one
    // plain, each saying which in its tooltip; a run that skips the place
    // said so, in bold when it is the feed's word for today, and a run that
    // calls with its door shut where the rider gets on, or off, said so too
    _clockHtml(when, zone) {
        if (when?.unserved) {
            return when.skipped ? `<b class="jbroken" title="${esc(this._t("realtime"))}">${this._t("not_stopping")}</b>`
                : `<span class="jbroken">${this._t(when.noBoard ? "no_boarding" : when.noAlight ? "no_alighting" : "not_served")}</span>`;
        }
        if (!when?.t) return "";
        return when.rt ? `<b title="${esc(this._t("realtime"))}">${this._hm(when.t, zone)}</b>`
            : `<span title="${esc(this._t("scheduled"))}">${this._hm(when.t, zone)}</span>`;
    }

    /* ── PANE 2: MAP data ───────────────────────────────────────────────── */

    // Which lines currently read as quiet, as one comparable string. The badge
    // carries that mark, and nothing else would redraw the header for it:
    // hassChanged only fires when a sensor moves, and a frozen positions file
    // is precisely the case where the sensor may be the only thing still
    // moving - or, for a deleted entity, where nothing moves at all.
    _muteKey() {
        const now = Date.now();
        return this._ld.map((s) => !s ? "-"
            : (s.err ? "e" : "") + (s.sigAt ? (now - s.sigAt > STALE_FEED ? "s" : "f") : "n")).join("");
    }

    _repaintHeaderIfMuteChanged() {
        const key = this._muteKey();
        if (key === this._lastMuteKey) return;
        this._lastMuteKey = key;
        if (this._built) this._renderHeader();
    }

    // The positions files a stop reads: one per (route, direction) its
    // departures ride, named the way gtfs2 names them - by the internal
    // route id (route_ids maps the departure's route code to it), not by
    // the code. An explicit positions_url on the stop stands in for them
    // all. A route with no mapping, or a file gone empty, contributes
    // nothing and is never an error.
    _positionsUrls(def) {
        if (def.positions_url) return [def.positions_url];
        const map = this._config.route_ids && typeof this._config.route_ids === "object" ? this._config.route_ids : {};
        const at = def.entity ? this._hass?.states?.[def.entity]?.attributes : null;
        const out = [];
        const seen = new Set();
        for (const d of (Array.isArray(at?.next_departures_lines) ? at.next_departures_lines : [])) {
            const rid = d?.route != null ? map[String(d.route).trim()] : null;
            const dir = d?.direction_id;
            if (rid == null || dir == null) continue;
            const url = `/local/gtfs2/${safeFilePart(rid)}_${safeFilePart(dir)}.json`;
            if (!seen.has(url)) { seen.add(url); out.push(url); }
        }
        return out;
    }

    // The raw GTFS-RT feed, read by every stop def at once: decoded once
    // per refresh, then each stop keeps only the routes its board rides.
    // Returns null when no feed is configured.
    async _fetchFeedAll(force) {
        const url = this._config.positions_feed;
        if (!url) return null;
        const maxAge = force ? FETCH_BURST_MS : Math.max(15, this._config.refresh) * 500;
        const buf = await fetchFeedShared(url, maxAge);
        const vehs = RT.decode(buf);
        this._feedAt = Date.now();
        this._feedLm = buf.__lastModified;
        return vehs;
    }

    async _fetchPositions(def, force) {
        const slot = this._ld[def.idx];
        if (!slot) return;
        try {
            const maxAge = force ? FETCH_BURST_MS : Math.max(15, this._config.refresh) * 500;
            let feats = [];
            let ok = false;
            let lm = Infinity;
            // the raw feed first: complete for every route and direction,
            // cut down here to the routes this stop's board rides (the same
            // route_ids mapping the geojson files are named by)
            const vehs = await this._fetchFeedAll(force).catch(() => null);
            if (vehs) {
                const map = this._config.route_ids && typeof this._config.route_ids === "object" ? this._config.route_ids : {};
                const want = new Set(Object.values(map).map(String));
                const routes = new Set();
                for (const r of this._allRows()) if (r.line != null) routes.add(String(r.line));
                for (const v of vehs) {
                    if (want.size && !want.has(String(v.routeId))) continue;
                    routes.add(String(v.routeId));   // keep mapped routes even off-board
                    feats.push({
                        type: "Feature",
                        geometry: { type: "Point", coordinates: [v.lon, v.lat] },
                        properties: {
                            id: `${v.routeId}_${v.directionId}_${v.id}`,
                            vehicle_id: v.id,
                            vehicle_label: v.label,
                            trip_id: v.tripId,
                            route_id: v.routeId,
                            direction_id: v.directionId,
                            bearing: v.bearing,
                            current_stop_sequence: v.seq,
                        },
                    });
                    const g = this._feedLm;
                    if (Number.isFinite(g)) lm = Math.min(lm, g);
                    ok = true;
                }
            } else {
                // no feed configured: the per-route files, merged. Complete
                // for the directions gtfs2 writes files for
                const urls = this._positionsUrls(def);
                const parts = await Promise.all(urls.map((u) => fetchJsonShared(u, maxAge).catch(() => null)));
                for (const gj of parts) {
                    if (!gj) continue;
                    ok = true;
                    feats.push(...(gj.features || []));
                    const g = gj.__lastModified;
                    if (Number.isFinite(g)) lm = Math.min(lm, g);
                }
            }
            slot.geo = ok ? { type: "FeatureCollection", features: feats } : null;
            slot.geoAt = Date.now();
            slot.err = ok ? null : "empty";
            const now = Date.now();
            // Freshness comes from the files' own Last-Modified when the
            // server sends one: the integration rewrites the positions file
            // on every update, so its date ages even while a parked vehicle
            // keeps the contents identical. The position signature is the
            // fallback for servers that send no date; on its own it cannot
            // tell "no update since end of service" from "everyone is
            // standing still".
            lm = Number.isFinite(lm) ? lm : undefined;
            const sig = feats.map((f) => `${this._vid(f)}@${f.geometry?.coordinates}`).join("|");
            if (Number.isFinite(lm)) {
                slot.sig = sig;
                slot.sigAt = Math.min(now, lm);
            } else if (sig !== slot.sig) { slot.sig = sig; slot.sigAt = now; }
            // entity-less cards derive badge labels from the feed: refresh them
            if (!this._depSources().length) this._renderHeader();
            for (const f of slot.geo.features || []) {
                const key = `${def.idx}:${this._vid(f)}`;
                const [lon, lat] = f.geometry?.coordinates || [];
                if (lat == null || lon == null) continue;
                this._histSeen.set(key, now);
                const h = this._hist.get(key) || [];
                const last = h[h.length - 1];
                if (!last || last.lat !== lat || last.lon !== lon) {
                    h.push({ lat, lon, ts: now });
                    if (h.length > HIST_MAX) h.shift();
                    this._hist.set(key, h);
                }
            }
        } catch (e) {
            slot.geo = slot.geo || { features: [] };
            if (slot.err !== String(e)) console.warn(`gtfs2-stop-card: positions fetch failed for ${def.entity || def.idx}`, e,
                this._config.positions_feed ? `(feed ${this._config.positions_feed})` : "");
            slot.err = String(e);
        }
        // forget vehicles gone from this line's feed for a while. Outside the
        // try: a line whose feed stays unreachable must release its history
        // too, otherwise it is retained for as long as the card lives.
        const cutoff = Date.now() - HIST_TTL;
        for (const key of [...this._hist.keys()]) {
            if (key.startsWith(`${def.idx}:`) && (this._histSeen.get(key) || 0) < cutoff) {
                this._hist.delete(key);
                this._histSeen.delete(key);
            }
        }
        this._scheduleRerender();
        this._renderFooter();
        this._repaintHeaderIfMuteChanged();
    }

    // The leg file: for every run the sensor lists, when its trip calls at
    // every stop, scheduled and, where the feed says, expected. Kept as the
    // integration wrote it, keyed by trip id; a file that is missing or
    // unreadable leaves the slot empty and the card on the shape's clocks,
    // which is not an error: a stock gtfs2 writes none.
    // The timetable of a line (see gtfs2's write_timetable_file): read only
    // when a journey needs a run past the ones its sensor lists, then kept
    // for the day - it changes with the service day, not with the minute.
    // {rows: runs as the board reads them, next, until, days: last service
    // date}, or null until it lands, false when there is none to read
    _vid(feature) {
        const p = feature.properties || {};
        return String(p.vehicle_id || p.vehicle_label || p.id || "").trim() || "bus";
    }

    /* ── PANE 2: MAP projection helpers ─────────────────────────────────── */

    _world(lat, lon) {
        const x = ((lon + 180) / 360) * WORLD;
        const s = Math.sin((lat * Math.PI) / 180);
        const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD;
        return { x, y };
    }

    // inverse Web-Mercator on the y axis: world units back to a latitude
    _latOf(y) {
        return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD))) * 180) / Math.PI;
    }

    _mPerU(lat) {
        return (EARTH_CIRC * Math.cos((lat * Math.PI) / 180)) / WORLD;
    }

    // The static trip paths of one route, as gtfs2's own feed source ships
    // them (docs/extract_shapes.py wrote them from the GTFS zip: each trip's
    // ordered stops, TransLink's feed carrying no shapes.txt). Fetched on
    // first need and kept for the session. Null while loading, false when
    // the route has no such file.
    _tripPath(routeId) {
        if (!routeId) return null;
        if (this._shapes.has(routeId)) return this._shapes.get(routeId);
        this._shapes.set(routeId, null);   // loading
        fetchJsonShared(`/local/gtfs2-static/${safeFilePart(routeId)}_shapes.json`, 60 * 60000)
            .then((doc) => {
                this._shapes.set(routeId, doc?.trips ? doc : false);
                this._scheduleRerender();
            })
            .catch(() => this._shapes.set(routeId, false));
        return null;
    }

    // A vehicle's "path so far" along its trip's stop polyline: the vehicle
    // projected onto the sequence, the prefix drawn solid, the remainder
    // dotted - the schedule's promise ahead, the run's progress behind.
    // Cached per (trip, position) so a render only projects each vehicle once.
    _pathSoFar(routeId, tripId, w) {
        const doc = this._tripPath(routeId);
        if (!doc || doc === true) return null;
        const t = doc.trips?.[tripId];
        if (!t?.pts?.length) return null;
        const key = `${tripId}@${Math.round(w.x)},${Math.round(w.y)}`;
        if (this._shapeProj.has(key)) return this._shapeProj.get(key);
        // project the vehicle onto the polyline: the nearest leg, the point
        // on it, and how far along the whole sequence that lands
        const pts = t.pts.map((c) => this._world(c[1], c[0]));
        let best = null;
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len2 = dx * dx + dy * dy;
            const u = len2 ? Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2)) : 0;
            const px = a.x + u * dx, py = a.y + u * dy;
            const d2 = (w.x - px) ** 2 + (w.y - py) ** 2;
            if (!best || d2 < best.d2) best = { d2, i, u, px, py };
        }
        if (!best) return null;
        // the prefix: every vertex up to the projection, then the projected
        // point itself (and the vehicle snaps to its path there when drawn)
        const pre = pts.slice(0, best.i);
        pre.push({ x: best.px, y: best.py });
        const rest = pts.slice(best.i + 1);
        const out = { pre, rest, stops: t.names || [] };
        this._shapeProj.set(key, out);
        if (this._shapeProj.size > 400) this._shapeProj.clear();
        return out;
    }

    // Where a vehicle is drawn, and which way it heads. No route shape to
    // project on: the heading is the feed's own bearing when it exports one,
    // else the direction of the last two fixes once the bus has really moved.
    _placeVeh(e) {
        const vid = this._vid(e.f);
        const raw = this._world(e.f.geometry.coordinates[1], e.f.geometry.coordinates[0]);
        const key = `${e.def.idx}:${vid}`;
        e.key = key;
        e.w = raw;
        const pos = `${Math.round(raw.x)},${Math.round(raw.y)}`;
        const hit = this._angCache.get(key);
        if (hit && hit.pos === pos) { e.angle = hit.a; return; }
        let angle = null;
        // the feed's own bearing, when gtfs2 exports one (compass degrees,
        // north = 0, and the heading is drawn that way too)
        const br = Number(e.f.properties?.bearing);
        if (Number.isFinite(br)) angle = ((br % 360) + 360) % 360;
        if (angle == null) {
            // from the last two fixes: only once the bus has really moved,
            // else a vehicle idling at the stop sprays arrows at every jitter
            const h = this._hist.get(key) || [];
            const prev = h.length > 1 ? h[h.length - 2] : null;
            if (prev && haversine(prev, { lat: e.f.geometry.coordinates[1], lon: e.f.geometry.coordinates[0] }) >= 20) {
                const a1 = this._world(prev.lat, prev.lon);
                angle = (Math.atan2(raw.x - a1.x, -(raw.y - a1.y)) * 180) / Math.PI;
            } else {
                // no move yet: keep the last heading it had, if any
                angle = this._angCache.get(key)?.a ?? null;
            }
        }
        this._angCache.set(key, { pos, a: angle });
        e.angle = angle;
    }

    // The vehicles the map shows: those running a departure on the board,
    // joined by trip_id. The board is rebuilt on every update and lists
    // only upcoming runs (a two-minute grace past the time), so expired
    // trips drop out by themselves and a vehicle sitting at the stop past
    // its departure still shows. A vehicle whose trip matches is taken; its
    // direction must agree with the departure's where both are known, and
    // its route_id must map back to the departure's route code - trip ids
    // recur across service dates, and the files are named by gtfs2's
    // internal route ids, not the codes the departures read. With
    // max_vehicles: "nearby", a vehicle of a board route near a configured
    // stop is shown too, though nobody is boarding it. Null keeps every
    // vehicle the files carry (nothing on the board).
    _stopVehicleFilter() {
        const rows = this._departureRows().rows;
        const want = new Map();
        for (const r of rows) {
            if (!r.tripId) continue;
            if (!want.has(r.tripId)) want.set(r.tripId, []);
            want.get(r.tripId).push(r);
        }
        if (!want.size) return null;
        const map = this._config.route_ids && typeof this._config.route_ids === "object" ? this._config.route_ids : {};
        const ridOf = (code) => (code != null && map[code] != null ? String(map[code]) : null);
        const rev = new Map();
        for (const [code, rid] of Object.entries(map)) rev.set(String(rid), code);
        const nearby = this._config.max_vehicles === "nearby";
        const radius = Number(this._config.nearby_radius_km) > 0 ? Number(this._config.nearby_radius_km) : DEFAULTS.nearby_radius_km;
        const stops = this._lineDefs().filter((d) => d.lat != null && d.lon != null).map((d) => ({ lat: d.lat, lon: d.lon }));
        const codes = new Set(rows.map((r) => r.line).filter(Boolean));
        const warned = new Set();
        return (e) => {
            const p = e.f.properties || {};
            const tid = p.trip_id != null ? String(p.trip_id) : null;
            const cand = tid != null ? want.get(tid) : null;
            if (cand) {
                for (const r of cand) {
                    // a trip id of another service day: its route and
                    // direction must be the ones the departure says
                    const wantRid = ridOf(r.line);
                    if (wantRid != null && p.route_id != null && String(p.route_id) !== wantRid) continue;
                    if (r.dirId != null && p.direction_id != null && Number(p.direction_id) !== Number(r.dirId)) continue;
                    r.veh = e;    // the joined vehicle, for the popup
                    return true;
                }
                if (p.route_id != null && !warned.has(tid)) {
                    warned.add(tid);
                    console.debug("gtfs2-stop-card: trip", tid, "on the board, but no vehicle matches its route/direction");
                }
                return false;
            }
            // not a boarded trip: layover, deadhead, gone. The nearby
            // fallback alone keeps it, and only on a board route, near a stop
            if (!nearby) return false;
            const code = p.route_id != null ? rev.get(String(p.route_id)) : null;
            if (!code || !codes.has(code)) return false;
            const co = e.f.geometry?.coordinates;
            if (!co) return false;
            return stops.some((s) => haversine({ lat: co[1], lon: co[0] }, s) / 1000 < radius);
        };
    }

    // what MapLibre is asked to draw: the theme's style, or the user's own -
    // a MapLibre style URL, or a raster {z}/{x}/{y} template wrapped into a
    // one-layer style (shown as it comes: no theme, no credit of ours)
    _mapStyleSpec() {
        const style = this._config.map_style;
        if (!style || style === "auto" || style === "light" || style === "dark") {
            const dark = style === "dark" || (style !== "light" && !!this._hass?.themes?.darkMode);
            return { key: dark ? "dark" : "light", style: dark ? MAP_STYLES.dark : MAP_STYLES.light, own: true };
        }
        if (/\{z\}/.test(style)) {
            const tiles = [style.replace("{r}", "")];
            return { key: style, own: false, style: { version: 8, sources: { raster: { type: "raster", tiles, tileSize: 256 } }, layers: [{ id: "raster", type: "raster", source: "raster" }] } };
        }
        return { key: style, own: false, style };
    }

    // the MapLibre canvas under the SVG. Built once the module is in (a
    // moment on a cold cache), and only if the pane still stands by then.
    _buildBasemap() {
        const wrap = this.shadowRoot.querySelector(".map-wrap");
        const host = wrap?.querySelector(".map-gl");
        if (!host || this._map) return;
        const gen = ++this._mapGen;
        loadMapLibre().then((ML) => {
            if (gen !== this._mapGen || !host.isConnected || this._map) return;
            const spec = this._mapStyleSpec();
            let map;
            try {
                map = new ML.Map({
                    container: host, style: spec.style, interactive: false, attributionControl: false,
                    renderWorldCopies: false, fadeDuration: 150,
                });
            } catch (e) {
                // no WebGL: a browser flag, or an exhausted context pool
                this._mapError = e?.message || "webgl";
                this._updateAttrib();
                return;
            }
            this._map = map;
            this._mapStyleKey = spec.key;
            this._mapError = null;
            this._mapCredit = null;
            wrap.dataset.basemap = "loading";
            map.on("style.load", () => this._basemapStyled(map));
            map.on("error", (e) => {
                // a tile missing here or there is MapLibre's business; a
                // style that never comes is what leaves the map blank
                if (!map.isStyleLoaded() && !this._mapError) {
                    this._mapError = e?.error?.message || "style";
                    this._updateAttrib();
                }
            });
            map.on("dataloading", () => { wrap.dataset.basemap = "loading"; });
            map.on("idle", () => { wrap.dataset.basemap = "idle"; });
            this._syncBasemap();
        }).catch((e) => {
            if (gen !== this._mapGen) return;
            this._mapError = e?.message || "import";
            this._updateAttrib();
        });
    }

    // a style just landed (first one, or a theme flip): drop the layers the
    // card does without, and read the credit its sources ask for. The SVG
    // above is flat Web-Mercator: a style asking for the globe (VersaTiles
    // does) would curl the land away from the stops and lines at low zoom.
    _basemapStyled(map) {
        if (map.getProjection?.()?.type !== "mercator") map.setProjection({ type: "mercator" });
        const st = map.getStyle();
        for (const l of st?.layers || []) if (MAP_HIDE_LAYERS.has(l["source-layer"])) map.removeLayer(l.id);
        const credits = [];
        for (const [id, src] of Object.entries(st?.sources || {})) {
            const a = String(map.getSource(id)?.attribution ?? src.attribution ?? "").replace(/<[^>]*>/g, "").trim();
            if (a && !credits.includes(a)) credits.push(a);
        }
        this._mapCredit = credits.join(" · ");
        this._mapError = null;
        this._updateAttrib();
    }

    _dropBasemap() {
        this._mapGen++;
        if (this._map) {
            try { this._map.remove(); } catch (e) { /* its container is already gone */ }
            this._map = null;
        }
        this._mapStyleKey = null;
        this._mapCredit = null;
    }

    // the pane's body replaced by something that is not a map
    _clearMap(body, html) {
        this._dropBasemap();
        body.innerHTML = html;
        this._mapDomReady = false;
    }

    // theme flips and an edited map_style land here on the next render
    _applyBasemapStyle() {
        const map = this._map;
        if (!map) return;
        const spec = this._mapStyleSpec();
        if (spec.key === this._mapStyleKey) return;
        this._mapStyleKey = spec.key;
        this._mapCredit = null;
        map.setStyle(spec.style);
    }

    // MapLibre follows the SVG camera: the viewBox, sliced to the element's
    // box (preserveAspectRatio xMidYMid slice), is a centre and a zoom.
    // MapLibre counts 512 px tiles: the world is 512 * 2^zoom css px wide.
    // A console trace of the map's moves, for a report: off unless asked,
    //   localStorage.setItem("gtfs2-live-card:debug", "1")   then reload;
    //   localStorage.removeItem("gtfs2-live-card:debug")     to stop.
    // Each line says what moved the view, where the card thinks it is
    // (centre, width) and where the base map is, and how many pixels apart
    // the two centres are: anything past a pixel is the bug.
    _dbg(what, extra) {
        let on = false;
        try { on = !!localStorage.getItem("gtfs2-live-card:debug"); } catch (e) { /* storage blocked */ }
        if (!on) return;
        const vb = this._viewBox, O = this._origin, map = this._map;
        const info = { ...extra };
        if (vb && O) {
            const cx = O.x + vb[0] + vb[2] / 2, cy = O.y + vb[1] + vb[3] / 2;
            info.center = [+((cx / WORLD) * 360 - 180).toFixed(5), +this._latOf(cy).toFixed(5)];
            info.widthKm = +((vb[2] * this._mPerUNow) / 1000).toFixed(3);
            info.viewBox = vb.map((v) => Math.round(v));
            info.origin = [O.x, O.y];
            if (map) {
                const c = map.getCenter(), el = map.getContainer();
                const p = map.project(info.center);
                info.basemap = { center: [+c.lng.toFixed(5), +c.lat.toFixed(5)], zoom: +map.getZoom().toFixed(3) };
                info.offsetPx = +Math.hypot(p.x - el.clientWidth / 2, p.y - el.clientHeight / 2).toFixed(1);
            }
        }
        info.manual = this._manual;
        if (this._focus) info.focus = this._focus;
        const svg = this.shadowRoot.querySelector(".map-wrap svg");
        if (svg?.classList.contains("far")) info.far = true;
        console.log(`gtfs2-live-card map: ${what}`, info);
    }

    _syncBasemap() {
        const map = this._map;
        const vb = this._viewBox, O = this._origin;
        if (!map || !vb || !O) return;
        if (!this._scaleW || !this._scaleH) {
            const svg = this.shadowRoot.querySelector(".map-wrap svg");
            this._scaleW = svg?.clientWidth || 408;
            this._scaleH = svg?.clientHeight || 204;
        }
        const s = Math.max(this._scaleW / vb[2], this._scaleH / vb[3]);   // css px per world unit
        const cx = O.x + vb[0] + vb[2] / 2, cy = O.y + vb[1] + vb[3] / 2;
        const center = [(cx / WORLD) * 360 - 180, this._latOf(cy)], zoom = Math.log2((s * WORLD) / 512);
        // MapLibre cannot invert a camera handed a zoom that is not a number,
        // and throws on every frame after: better a base map left where it was
        if (!Number.isFinite(zoom) || !center.every(Number.isFinite)) return;
        map.jumpTo({ center, zoom });
    }

    _updateAttrib() {
        const at = this.shadowRoot.querySelector(".map-attrib");
        if (!at) return;
        const newestAt = Math.max(0, ...this._ld.map((s) => s.sigAt || 0));
        at.textContent = this._attribText(newestAt);
    }

    _liveBusCount() {
        // a journey map counts the vehicles it keeps, as drawn last
        if (this._shownBus != null && !this._focus) return this._shownBus;
        const now = Date.now();
        return this._ld.reduce((n, s) => n + ((s.sigAt && now - s.sigAt > STALE_FEED) ? 0 : (s.geo?.features?.length || 0)), 0);
    }

    // "16 trams running" when every line shares a mode, "22 vehicles" otherwise
    _busCountText(count) {
        const lang = this._lang();
        const mk = this._shownMode();
        // {m} the mode's singular, {mp} its plural: each language takes the one it says it with
        if (!count) return this._t("no_vehicle", { m: modeWord(lang, mk, false), mp: modeWord(lang, mk, true) });
        return count === 1
            ? this._t("bus_running", { m: modeWord(lang, mk, false) })
            : this._t("buses_running", { n: count, m: modeWord(lang, mk, true) });
    }

    // the mode of the lines the map is about: the line picked, else the
    // one every line shares, else "vehicle"
    _shownMode() {
        const defs = this._lineDefs();
        const top = this._hiLine != null ? this._hiLine : this._destTopLi();
        const d = top != null ? defs.find((x) => x.idx === top) : null;
        if (d) return d.mode || "bus";
        const modes = new Set(defs.map((x) => x.mode || "bus"));
        return modes.size === 1 ? [...modes][0] : "vehicle";
    }

    /* ── PANE 2: MAP rendering ──────────────────────────────────────────── */

    _renderMapSection() {
        if (!this._built) return;   // no shell yet: see _renderHeader
        const head = this.shadowRoot.getElementById("map-head");
        const body = this.shadowRoot.getElementById("map-body");
        if (this._config.show_map === false) {
            head.style.display = "none";
            this._clearMap(body, "");
            this.shadowRoot.getElementById("focus-panel").innerHTML = "";
            return;
        }
        head.style.display = "";
        head.setAttribute("aria-expanded", String(!this._collapsed.map));
        if (this._collapsed.map) {
            const count = this._liveBusCount();
            const stale = this._feedStaleAge();
            const summary = stale
                ? `<span class="summary warn">${this._t("feed_stale", { t: fmtAgo(this._lang(), stale) })}</span>`
                : `<span class="summary">${this._mapSummary(count)}</span>`;
            head.innerHTML = `
                <span class="chev">${ICONS.chevronRight}</span>
                <span class="sect-title">${this._t("line_map")}</span>
                <span class="spacer"></span>
                ${summary}`;
            this._clearMap(body, "");
            this.shadowRoot.getElementById("focus-panel").innerHTML = "";
            return;
        }
        // positions are optional: a stop with neither a feed, an explicit
        // positions_url nor a route_ids mapping shows its stops alone once
        // it has coordinates
        const defs = this._lineDefs();
        if (!this._config.positions_feed && !defs.some((d) => d.positions_url)
            && !defs.some((d) => this._positionsUrls(d).length)
            && !defs.some((d) => d.lat != null && d.lon != null)) {
            this._renderMapHead();
            this._clearMap(body, `<div class="empty">${this._t("no_source")}</div>`);
            return;
        }
        this._renderMap(false);
    }

    // collapsed pane, no vehicle to count: an endless ellipsis is the wrong
    // answer for a line that simply publishes no positions and is showing
    // its route below
    _mapSummary(count) {
        if (count) return this._busCountText(count);
        const posOk = this._ld.some((s) => s.geoAt && !s.err);
        if (!posOk && this._ld.some((s) => s.route)) return this._t("route_only");
        // positions read and none to draw - a quiet night, or a journey map
        // keeping none of its lines' vehicles: said, not left as the dots of
        // a wait
        if (posOk) return this._busCountText(0);
        return "…";
    }

    _ensureMapDom(body) {
        if (this._mapDomReady && body.querySelector(".map-wrap")) return;
        const aspect = this._config.map_aspect && /^[\d\s./]+$/.test(String(this._config.map_aspect))
            ? ` style="aspect-ratio: ${esc(String(this._config.map_aspect))};"` : "";
        body.innerHTML = `
            <div class="map-wrap">
                <div class="map-gl"></div>
                <svg preserveAspectRatio="xMidYMid slice" tabindex="0"${aspect}>
                    <g class="l-overlay"></g>
                    <g class="l-veh"></g>
                </svg>
                <button class="map-btn" data-action="unfocus" hidden>${this._t("line_view")}</button>
                <div class="map-ctrl">
                    <button class="map-ctrl-btn" data-action="zoom-in" aria-label="${esc(this._t("zoom_in"))}">+</button>
                    <button class="map-ctrl-btn" data-action="zoom-out" aria-label="${esc(this._t("zoom_out"))}">−</button>
                    <button class="map-ctrl-btn" data-action="recenter" aria-label="${esc(this._t("recenter"))}" title="${esc(this._t("recenter"))}" hidden>⌖</button>
                    <button class="map-ctrl-btn map-lock" data-action="view-lock" aria-pressed="false" hidden></button>
                </div>
                <div class="map-foot">
                    <div class="map-scale"><i></i><span></span></div>
                    <span class="map-attrib"></span>
                </div>
                <div class="map-hint"></div>
                <div class="map-pop" hidden></div>
                <div class="map-tip" hidden></div>
            </div>`;
        this._mapDomReady = true;
        this._scaleW = 0;
        this._scaleH = 0;
        this._popSize = null;
        this._vehEls.clear();
        this._attachMapEvents();
        this._buildBasemap();
    }

    _renderMap(animate) {
        if (this._config.show_map === false) return;
        const body = this.shadowRoot.getElementById("map-body");
        const panel = this.shadowRoot.getElementById("focus-panel");
        const defs = this._lineDefs();
        const lang = this._lang();

        // flatten features with their line def; a feed frozen for a while
        // means the buses are ghosts (end of service): hide them. Two stops
        // sharing a route read the same file: a vehicle is drawn once, for
        // the first stop that lists it
        const all = [];
        const nowMs = Date.now();
        const seenVeh = new Set();
        for (const def of defs) {
            const slot = this._ld[def.idx];
            if (slot?.sigAt && nowMs - slot.sigAt > STALE_FEED) continue;
            for (const f of slot?.geo?.features || []) {
                if (!Array.isArray(f.geometry?.coordinates)) continue;
                const vk = `${f.properties?.route_id ?? ""}|${this._vid(f)}`;
                if (seenVeh.has(vk)) continue;
                seenVeh.add(vk);
                all.push({ f, def });
            }
        }
        // where each vehicle is drawn, and which way it heads: see _placeVeh.
        // Everything below reads e.w - the view, the label boxes, the marker,
        // the tracking - so the vehicle is in one place for all of them
        for (const e of all) this._placeVeh(e);

        // the tracked vehicle: on its own def first, else anywhere - two
        // stops sharing a route read one feed, and the map draws the vehicle
        // once, for the first stop that lists it
        let focusEntry = this._focus
            ? (all.find((e) => e.def.idx === this._focus.li && this._vid(e.f) === this._focus.vid)
                || all.find((e) => this._vid(e.f) === this._focus.vid))
            : null;
        if (this._focus && !focusEntry) {
            // tracked vehicle left the feed (end of trip): glide back to the
            // fitted view and say why, instead of jumping silently
            this._focus = null;
            this._manual = false;
            this._restoreTrackedLine();
            animate = true;
            this._showHint(this._t("tracking_ended"));
        }

        // the "top" line: the focused bus's line, else the line picked by
        // tapping its badge; the lines it leaves out step back
        const topLi = focusEntry ? focusEntry.def.idx : (this._hiLine ?? this._destTopLi());
        const dset = this._destLines();
        // the stop card shows the vehicles of the departures on the board
        // and no others (see _stopVehicleFilter); a tracked vehicle shows
        // its line whole, as it always did
        this._shownBus = null;
        if (!focusEntry) {
            const keep = this._stopVehicleFilter();
            if (keep) {
                all.splice(0, all.length, ...all.filter(keep));
                this._shownBus = all.length;
            }
        }
        // the count in the head is the vehicles drawn
        this._renderMapHead();
        // the stop card draws no route shapes: the ground is the stops
        // themselves and the vehicles running the board's departures
        const anyStop = defs.some((d) => d.lat != null && d.lon != null);
        const posTried = this._ld.some((s) => s.geoAt);
        if (!all.length && !anyStop && !posTried) {
            const posErr = this._ld.some((s) => s.err);
            const msg = posErr ? this._t("unreachable")
                : posTried ? this._busCountText(0)
                : this._t("loading");
            this._clearMap(body, `<div class="empty">${msg}</div>`);
            panel.innerHTML = "";
            return;
        }
        this._ensureMapDom(body);
        const svg = body.querySelector(".map-wrap svg");
        // one layout read for the whole render: the element cannot resize
        // between these statements, and re-reading it after a DOM write is
        // what forces a synchronous re-layout
        const svgW = svg.clientWidth, svgH = svg.clientHeight;
        const frameAspect = svgW ? Math.max(0.3, Math.min(1.4, svgH / svgW)) : 0.5;

        const refLat = all.length ? all[0].f.geometry.coordinates[1]
            : (this._lineDefs().find((d) => d.lat != null)?.lat
                ?? (this._config.latitude != null ? Number(this._config.latitude) : 47));
        const mPerU = this._mPerU(refLat);
        this._mPerUNow = mPerU;

        // target viewBox in ABSOLUTE world units; a manual pan/zoom wins
        // over auto-fit until the recenter button
        let target;
        if (this._manual && this._viewBox && this._origin) {
            target = [this._viewBox[0] + this._origin.x, this._viewBox[1] + this._origin.y, this._viewBox[2], this._viewBox[3]];
        } else if (focusEntry) {
            const c = focusEntry.w;
            const w = 900 / mPerU, h = w * frameAspect;
            target = [c.x - w / 2, c.y - h * 0.6, w, h];
        } else {
            // the ground the view covers: the stops and the vehicles near
            // them. A vehicle farther out is still drawn, off screen until
            // the user pans there - the board already says it is coming
            const stopDefs = defs.filter((d) => d.lat != null && d.lon != null);
            const stopPts = stopDefs.map((d) => this._world(d.lat, d.lon));
            const near = (e) => !stopDefs.length || stopDefs.some((d) =>
                haversine({ lat: d.lat, lon: d.lon },
                    { lat: e.f.geometry.coordinates[1], lon: e.f.geometry.coordinates[0] }) <= FIT_RADIUS_M);
            const pts = [...stopPts, ...all.filter(near).map((e) => e.w)];
            let minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
            let minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
            const padX = Math.max((maxX - minX) * 0.12, 300 / mPerU);
            const padY = Math.max((maxY - minY) * 0.15, 250 / mPerU);
            minX -= padX; maxX += padX; minY -= padY; maxY += padY;
            let w = maxX - minX, h = maxY - minY;
            if (h < w * frameAspect) { const g = (w * frameAspect - h) / 2; minY -= g; h = w * frameAspect; }
            else if (w < h / frameAspect) { const g = (h / frameAspect - w) / 2; minX -= g; w = h / frameAspect; }
            target = [minX, minY, w, h];
            // a view kept with the padlock for what is picked replaces the
            // map's own framing: its ground, whole, at the card's width
            const kept = this._views[this._viewSel()];
            if (Array.isArray(kept) && kept.length === 4 && kept.every(Number.isFinite)) {
                const nw = this._world(kept[3], kept[0]), se = this._world(kept[1], kept[2]);
                let kx = nw.x, ky = nw.y, kw = se.x - nw.x, kh = se.y - nw.y;
                if (kw > 0 && kh > 0) {
                    if (kh < kw * frameAspect) { ky -= (kw * frameAspect - kh) / 2; kh = kw * frameAspect; }
                    else { kx -= (kh / frameAspect - kw) / 2; kw = kh / frameAspect; }
                    target = [kx, ky, kw, kh];
                }
            }
        }

        // stable origin keeps SVG coordinates small (float precision) without
        // invalidating cached geometry on every pan
        if (!this._origin || Math.abs(target[0] - this._origin.x) > 2e6 || Math.abs(target[1] - this._origin.y) > 2e6) {
            const old = this._origin;
            this._origin = { x: Math.floor(target[0]), y: Math.floor(target[1]) };
            // the boxes still held are relative to the old origin: moved into
            // the new one, or the glide below starts hundreds of km off, and a
            // pinch under way jumps there on its next move. A running glide
            // aims at a box of the old origin too: this render starts its own
            if (old) {
                const dx = old.x - this._origin.x, dy = old.y - this._origin.y;
                const shift = (vb) => { vb[0] += dx; vb[1] += dy; };
                if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
                if (this._viewBox) shift(this._viewBox);
                if (this._pinch) shift(this._pinch.vb);
                this._dbg("origin moved", { from: [old.x, old.y] });
            }
            // new origin: every relative coordinate changes, the vehicle
            // nodes must reappear in place rather than glide across the map
            this._vehEls.clear();
            const vl = svg.querySelector(".l-veh");
            if (vl) vl.innerHTML = "";
        }
        const O = this._origin;
        // world -> SVG units (see SVG_UNIT); targetRel and the view stay in world units
        const rel = (p) => ({ x: (p.x - O.x) / SVG_UNIT, y: (p.y - O.y) / SVG_UNIT });
        const targetRel = [target[0] - O.x, target[1] - O.y, target[2], target[3]];

        // animate explicit transitions, and follow the tracked vehicle
        // smoothly on data refreshes too; skip imperceptible moves (which
        // also breaks the animate → final render → animate recursion)
        if (this._viewBox && (animate || focusEntry)) {
            const vb0 = this._viewBox;
            const dMax = Math.max(Math.abs(vb0[0] - targetRel[0]), Math.abs(vb0[1] - targetRel[1]),
                Math.abs(vb0[2] - targetRel[2]), Math.abs(vb0[3] - targetRel[3]));
            // a follow move (data refresh while tracking) shares the duration
            // and the curve of the marker transition: the tracked vehicle and
            // its popup stay pinned on screen, the map slides underneath
            if (dMax > targetRel[2] * 0.004) this._animateViewBox(vb0, targetRel, animate ? 280 : FOLLOW_MS, animate ? null : EASE_OUT);
            else this._setViewBox(targetRel);
        } else this._setViewBox(targetRel);
        const vb = this._viewBox;

        const clientW = svgW || body.clientWidth || 408;
        this._lastW = body.clientWidth || this._lastW;
        const u = vb[2] / clientW / SVG_UNIT;          // SVG units per css px
        const spanM = vb[2] * mPerU;                   // map span in metres
        this._markFar(svg);
        // vehicle disc radius, in css px, eased between a close-up view where
        // the mode glyph must read and a whole-network view where markers
        // would otherwise pile onto each other
        const markerR = 14 - 5 * Math.max(0, Math.min(1,
            (Math.log(Math.max(1, spanM)) - Math.log(MARKER_SPAN_MIN)) /
            (Math.log(MARKER_SPAN_MAX) - Math.log(MARKER_SPAN_MIN))));

        // ── base map: a theme flip or an edited map_style lands here
        this._applyBasemapStyle();

        // ── the vehicles' paths: each run's scheduled stop sequence (from
        // gtfs2's static feed source) drawn as the path so far - solid up to
        // the vehicle, dotted ahead - with the live breadcrumbs dotted under.
        // Only the stretch near the card's stops draws at all: a run that
        // boarded across town does not drag its morning here, and what is
        // drawn is loud for the vehicle being read, quiet for the rest
        let routeSvg = "";
        let nextStopName = null;
        const stopW = defs.filter((d) => d.lat != null && d.lon != null)
            .map((d) => this._world(d.lat, d.lon));
        const inRadius = (w) => !stopW.length || stopW.some((s) =>
            Math.hypot(s.x - w.x, s.y - w.y) * this._mPerUNow <= PATH_RADIUS_M);
        const runs = (pts) => {
            const out = [];
            let run = null;
            for (const w of pts) {
                if (inRadius(w)) {
                    if (!run) run = [];
                    run.push(w);
                } else if (run) { out.push(run); run = null; }
            }
            if (run) out.push(run);
            return out.filter((r) => r.length > 1);
        };
        for (const e of all) {
            const color = e.def.color || "#0072bc";
            const active = focusEntry ? focusEntry === e : (topLi == null || e.def.idx === topLi);
            // the scheduled path of this trip, when its route's static file
            // has landed: solid behind, dotted ahead
            const tid = e.f.properties?.trip_id;
            const rid = e.f.properties?.route_id;
            const soFar = tid != null ? this._pathSoFar(String(rid), String(tid), e.w) : null;
            if (soFar) {
                const line = (pts, dash, op) => `<path d="${pts.map((w, i) => {
                    const q = rel(w);
                    return `${i ? "L" : "M"}${q.x.toFixed(3)} ${q.y.toFixed(3)}`;
                }).join(" ")}" fill="none" stroke="${esc(color)}" stroke-width="${4 * u}"${dash} opacity="${op}" stroke-linecap="round" stroke-linejoin="round"></path>`;
                for (const run of runs(soFar.pre)) routeSvg += line(run, "", active ? 0.85 : 0.28);
                for (const run of runs([soFar.pre[soFar.pre.length - 1], ...soFar.rest])) {
                    routeSvg += line(run, ` stroke-dasharray="${6 * u} ${7 * u}"`, active ? 0.3 : 0.12);
                }
            }
            // the live trail: what the bus was actually seen along
            const key = `${e.def.idx}:${this._vid(e.f)}`;
            const h = this._hist.get(key) || [];
            if (h.length > 1) {
                const d = h.map((pt, i) => {
                    const q = rel(this._world(pt.lat, pt.lon));
                    return `${i ? "L" : "M"}${q.x.toFixed(3)} ${q.y.toFixed(3)}`;
                }).join(" ");
                routeSvg += `<path d="${d}" fill="none" stroke="${esc(color)}" stroke-width="${3 * u}" stroke-dasharray="${6 * u} ${6 * u}" opacity="${active ? 0.45 : 0.15}" stroke-linecap="round"></path>`;
            }
        }

        // ── the stops: a ring in the route's colour at the sensor's own
        // coordinates, its name beside it on the clearest of four sides -
        // kept clear of the vehicles and of the tracked popup's footprint
        let stationSvg = "";
        const placed = [];
        this._shownLabels.clear();
        if (focusEntry) {
            const pw = this._popSize?.w || 200;
            const ph = this._popSize?.h || 64;
            const bc = rel(focusEntry.w);
            placed.push({ x: bc.x - (pw / 2) * u, y: bc.y - (24 + ph) * u, w: pw * u, h: ph * u });
        }
        const vehBoxes = all.map((e) => {
            const q = rel(e.w);
            const r = (markerR + 3) * u;
            return { x: q.x - r, y: q.y - r, w: 2 * r, h: 2 * r };
        });
        const overlap = (bx, list) => list.reduce((sum, o) => sum
            + Math.max(0, Math.min(bx.x + bx.w, o.x + o.w) - Math.max(bx.x, o.x))
            * Math.max(0, Math.min(bx.y + bx.h, o.y + o.h) - Math.max(bx.y, o.y)), 0);
        for (const def of defs) {
            if (def.lat == null || def.lon == null) continue;
            const c = rel(this._world(def.lat, def.lon));
            const color = def.color || "#0072bc";
            stationSvg += `<circle cx="${c.x.toFixed(3)}" cy="${c.y.toFixed(3)}" r="${13 * u}" fill="${esc(color)}" opacity="0.2"></circle>`
                + `<circle cx="${c.x.toFixed(3)}" cy="${c.y.toFixed(3)}" r="${9 * u}" fill="var(--card-background-color, #fff)" stroke="${esc(color)}" stroke-width="${3.5 * u}"></circle>`
                + `<circle cx="${c.x.toFixed(3)}" cy="${c.y.toFixed(3)}" r="${3.2 * u}" fill="${esc(color)}"></circle>`;
            const nm = String(def.label || def.stopName || "").trim();
            if (nm) {
                const text = nm.length <= 30 ? nm : nm.slice(0, 29).trimEnd() + "…";
                const w = (text.length * 5.6 + 12) * u, h = 15 * u, gap = 13 * u;
                const sides = [
                    { x: c.x + gap, y: c.y - h / 2, w, h },
                    { x: c.x - gap - w, y: c.y - h / 2, w, h },
                    { x: c.x - w / 2, y: c.y - gap - h, w, h },
                    { x: c.x - w / 2, y: c.y + gap, w, h },
                ];
                let box = sides[0], least = Infinity;
                for (const bx of sides) {
                    const pen = overlap(bx, placed) + overlap(bx, vehBoxes);
                    if (pen < least) { least = pen; box = bx; }
                    if (!pen) break;
                }
                placed.push(box);
                stationSvg += `<g pointer-events="none"><rect x="${box.x.toFixed(3)}" y="${box.y.toFixed(3)}" width="${box.w.toFixed(3)}" height="${box.h.toFixed(3)}" rx="${(7.5 * u).toFixed(3)}" fill="var(--card-background-color, #fff)" stroke="${esc(color)}" stroke-width="${(1.2 * u).toFixed(3)}" opacity="0.95"></rect>`
                    + svgText(box.x + 6 * u, box.y + box.h / 2 + 3.4 * u, 9.5, u, 'font-weight="700" fill="var(--primary-text-color, #212121)"', esc(text)) + "</g>";
            }
        }
        // ── buses: top line's buses above the others, focused bus on top.
        // Vehicles live in persistent SVG nodes keyed by line + vehicle id
        // (see _syncVehicles): position and heading changes glide through a
        // CSS transition instead of jumping at every refresh
        const busOrder = topLi == null ? all
            : [...all].sort((a, b) =>
                ((a.def.idx === topLi ? 1 : 0) + (a === focusEntry ? 1 : 0)) -
                ((b.def.idx === topLi ? 1 : 0) + (b === focusEntry ? 1 : 0)));
        const vehicles = [];
        for (const e of busOrder) {
            const def = e.def;
            const vid = this._vid(e.f);
            const c = rel(e.w);
            let angle = e.angle;
            // a trip whose scheduled path is on the map says its heading
            // outright: the way the path runs at the vehicle's projection -
            // correct on the first frame, where the feed (TransLink's carries
            // no bearing) and the fix history would need minutes to answer
            const tid = e.f.properties?.trip_id;
            const soFar = tid != null
                ? this._pathSoFar(String(e.f.properties?.route_id), String(tid), e.w) : null;
            if (soFar && soFar.pre.length > 1) {
                const a = soFar.pre[soFar.pre.length - 2], b = soFar.pre[soFar.pre.length - 1];
                if (Math.hypot(b.x - a.x, b.y - a.y) * this._mPerUNow > 10
                    && Math.hypot(b.x - e.w.x, b.y - e.w.y) * this._mPerUNow < 150) {
                    angle = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
                }
            }
            const focused = focusEntry === e;
            const dim = !focused && topLi != null && def.idx !== topLi;
            // labels only where they stay readable: tracked bus, highlighted
            // line, or an overview span tight enough not to turn into soup
            const showLabel = focused || (topLi != null ? def.idx === topLi : spanM < 6000);
            // the disc carries an upright mode glyph, the heading rides on a
            // separate arrow orbiting its rim: a rotating glyph would read
            // upside down as soon as the vehicle runs southwards.
            // Its radius follows the visible span: full size when tracking one
            // vehicle a few hundred metres across, smaller on a whole-network
            // view where a dozen markers would otherwise clot together. The
            // tracked vehicle keeps the full size, it is the one being read.
            const R = (focused ? 16 : markerR) * u;
            const ink = inkOn(def.color);
            const body = (this._config.mode_icons !== false
                    // r is now the ink radius, not half the longest side: 0.638
                    // is the factor that leaves the marker glyphs the average
                    // size they had under the old rule, so the map does not
                    // silently resize when the badges gain their pixels
                    && modeGlyph(def.mode || "bus", R * 0.638, ink))
                || `<path d="M0 ${-5 * u} L${4.2 * u} ${3.5 * u} L0 ${1.6 * u} L${-4.2 * u} ${3.5 * u} Z" fill="${ink}"></path>`;
            // heading arrow: only when a heading is known, and only on the
            // markers big enough to carry it without turning into a blob
            const beak = angle != null && (focused || !dim)
                ? `<g class="hd"><path d="M0 ${(-R - 10 * u).toFixed(3)} L${(6.6 * u).toFixed(3)} ${(-R + 1.4 * u).toFixed(3)} L${(-6.6 * u).toFixed(3)} ${(-R + 1.4 * u).toFixed(3)} Z" fill="${esc(def.color)}" stroke="var(--card-background-color, #fff)" stroke-width="${(1.6 * u).toFixed(3)}" stroke-linejoin="round"></path></g>`
                : "";
            const inner = `
                <circle r="${Math.max(22, R / u + 9) * u}" fill="transparent" stroke="none"></circle>
                ${focused ? `<circle r="${23 * u}" fill="${esc(def.color)}" opacity="0.15"></circle>` : ""}
                ${beak}
                <g>
                    <circle r="${R}" fill="${esc(def.color)}" stroke="var(--card-background-color, #fff)" stroke-width="${2.5 * u}"></circle>
                    ${body}
                </g>
                ${showLabel ? `<rect x="${-20 * u}" y="${18 * u}" width="${40 * u}" height="${16 * u}" rx="${8 * u}" fill="var(--card-background-color, #fff)" opacity="0.95"></rect>
                ${svgText(0, 29.5 * u, 10, u, 'font-weight="600" fill="var(--primary-text-color, #212121)" text-anchor="middle"', esc(vid))}` : ""}`;
            vehicles.push({ key: `${def.idx}:${vid}`, li: def.idx, vid, x: c.x, y: c.y, angle: angle || 0, dim, inner,
                aria: `${modeWord(lang, def.mode || "bus", false)} ${vid}` });
        }

        svg.setAttribute("viewBox", vbAttr(vb));
        this._syncBasemap();
        svg.querySelector(".l-overlay").innerHTML = routeSvg + stationSvg;
        this._syncVehicles(svg.querySelector(".l-veh"), vehicles);

        const btnUnfocus = body.querySelector('.map-btn[data-action="unfocus"]');
        if (btnUnfocus) btnUnfocus.hidden = !this._focus;
        const btnRecenter = body.querySelector('.map-ctrl-btn[data-action="recenter"]');
        if (btnRecenter) btnRecenter.hidden = !this._manual;
        const btnLock = body.querySelector('.map-ctrl-btn[data-action="view-lock"]');
        if (btnLock) this._paintLock(btnLock);
        const attrib = body.querySelector(".map-attrib");
        if (attrib) {
            const newestAt = Math.max(0, ...this._ld.map((s) => s.sigAt || 0));
            attrib.textContent = this._attribText(newestAt);
        }

        // vehicle popup anchored on the tracked marker (replaces the old
        // bottom panel)
        const pop = body.querySelector(".map-pop");
        if (pop) {
            if (focusEntry) {
                const popKey = `${focusEntry.def.idx}:${this._vid(focusEntry.f)}`;
                const popW = focusEntry.w;
                const html = this._popHtml(focusEntry, nextStopName);
                if (pop.innerHTML !== html) { pop.innerHTML = html; this._popSize = null; }
                pop.hidden = false;
                // measured once per content change and reused by the label
                // collision list, which runs before this point on the next
                // render: reading it there forced a layout mid-render
                if (!this._popSize && pop.offsetWidth) {
                    this._popSize = { w: pop.offsetWidth, h: pop.offsetHeight };
                }
                this._popGlide(popW, popKey);
            } else {
                pop.hidden = true;
                this._popWorld = null;
                this._popKey = null;
                if (this._popAnim) { cancelAnimationFrame(this._popAnim); this._popAnim = null; }
            }
        }
        panel.innerHTML = "";
        this._updateScale();
    }

    // graphic scale, bottom left: the largest round length under ~90 px
    _updateScale() {
        const body = this.shadowRoot.getElementById("map-body");
        const el = body?.querySelector(".map-scale");
        const svg = body?.querySelector(".map-wrap svg");
        if (!el || !svg || !this._viewBox) return;
        if (!this._scaleW) this._scaleW = svg.clientWidth || 408;
        const mPerPx = (this._viewBox[2] * this._mPerUNow) / this._scaleW;
        const nice = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
        let len = nice[0];
        for (const v of nice) if (v / mPerPx <= 90) len = v;
        // skip the DOM write when nothing changed: this runs on every frame
        const px = `${Math.round(len / mPerPx)}px`;
        const txt = len >= 1000 ? `${len / 1000} km` : `${len} m`;
        if (this._scalePx !== px) { el.querySelector("i").style.width = px; this._scalePx = px; }
        if (this._scaleTxt !== txt) { el.querySelector("span").textContent = txt; this._scaleTxt = txt; }
    }

    // keyed reconciliation of the vehicle nodes: an existing node keeps its
    // identity (so the CSS transition animates its move), a new one appears
    // in place, a gone one is removed, paint order follows the list
    _syncVehicles(layer, vehicles) {
        if (!layer) return;
        const seen = new Set();
        let idx = 0;
        for (const v of vehicles) {
            seen.add(v.key);
            let g = this._vehEls.get(v.key);
            const fresh = !g || g.parentNode !== layer;
            if (fresh) {
                g = document.createElementNS("http://www.w3.org/2000/svg", "g");
                g.setAttribute("data-action", "bus");
                g.setAttribute("data-li", String(v.li));
                g.setAttribute("data-vid", v.vid);
                g.setAttribute("role", "button");
                g.setAttribute("tabindex", "0");
                g.style.transform = vehTransform(v);
                g._inner = null;
                g._ang = null;
                this._vehEls.set(v.key, g);
            }
            g.setAttribute("class", `bus${v.dim ? " dim" : ""}`);
            g.setAttribute("aria-label", v.aria);
            if (g._inner !== v.inner) { g.innerHTML = v.inner; g._inner = v.inner; g._ang = null; }
            // heading unwrapped so the arrow always turns the short way round
            let a = v.angle;
            if (g._ang != null) {
                while (a - g._ang > 180) a -= 360;
                while (a - g._ang < -180) a += 360;
            }
            const hd = g.querySelector(".hd");
            if (hd) { g._ang = a; hd.style.transform = `rotate(${a.toFixed(1)}deg)`; }
            else g._ang = null;
            if (!fresh) g.style.transform = vehTransform(v);
            const at = layer.children[idx];
            if (at !== g) layer.insertBefore(g, at || null);
            idx++;
        }
        for (const [key, g] of this._vehEls) {
            if (!seen.has(key)) { g.remove(); this._vehEls.delete(key); this._angCache.delete(key); }
        }
    }

    // the popup follows its marker with the same glide as the CSS transition
    _popGlide(w, key) {
        const from = this._popWorld;
        const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (this._popAnim) { cancelAnimationFrame(this._popAnim); this._popAnim = null; }
        if (!from || key !== this._popKey || reduced || (from.x === w.x && from.y === w.y)) {
            this._popKey = key;
            this._popWorld = w;
            this._positionPop();
            return;
        }
        const start = performance.now(), dur = FOLLOW_MS;
        const step = (now) => {
            const t = Math.min(1, (now - start) / dur);
            const e = EASE_OUT(t);
            this._popWorld = { x: from.x + (w.x - from.x) * e, y: from.y + (w.y - from.y) * e };
            this._positionPop();
            if (t < 1) this._popAnim = requestAnimationFrame(step); else this._popAnim = null;
        };
        this._popAnim = requestAnimationFrame(step);
    }

    _positionPop() {
        const body = this.shadowRoot.getElementById("map-body");
        const pop = body?.querySelector(".map-pop");
        const svg = body?.querySelector(".map-wrap svg");
        if (!pop || pop.hidden || !svg || !this._popWorld || !this._viewBox || !this._origin) return;
        const vb = this._viewBox;
        // cached box: re-measured by the resize observer and on a map rebuild
        if (!this._scaleW) this._scaleW = svg.clientWidth || 408;
        if (!this._scaleH) this._scaleH = svg.clientHeight || 204;
        const w = this._scaleW, h = this._scaleH;
        const sx = ((this._popWorld.x - this._origin.x) - vb[0]) / vb[2] * w;
        const sy = ((this._popWorld.y - this._origin.y) - vb[1]) / vb[3] * h;
        // clamp inside the map even on very narrow cards, top and bottom too
        const mx = Math.max(8, Math.min(80, (w - 16) / 2));
        pop.style.left = `${Math.max(mx, Math.min(w - mx, sx))}px`;
        pop.style.top = `${Math.max(10, Math.min(h - 6, sy - 24))}px`;
    }

    // ms since the newest feed change once every line with data has frozen
    // (end of service), else 0
    _feedStaleAge() {
        const now = Date.now();
        // scoped to the selected line when there is one: with several lines on
        // the card, one ending its service is real news, and waiting for the
        // last one to stop would hide it behind the others
        const hi = this._hiLine;
        const withData = this._ld.filter((s, i) => s.sigAt && (hi == null || i === hi));
        if (!withData.length || withData.some((s) => now - s.sigAt <= STALE_FEED)) return 0;
        return now - Math.max(...withData.map((s) => s.sigAt));
    }

    _renderMapHead() {
        const head = this.shadowRoot.getElementById("map-head");
        head.setAttribute("aria-expanded", "true");
        const count = this._liveBusCount();
        let summary;
        if (this._focus) {
            const def = this._lineDefs()[this._focus.li];
            const mw = modeWord(this._lang(), def?.mode || "bus", false);
            summary = `<span class="summary accent">${this._t("tracking", { m: mw, v: esc(this._focus.vid) })}${def ? ` · ${this._t("line_label", { l: esc(this._lineLabelOf(def)) })}` : ""}</span>`;
        } else {
            const stale = this._feedStaleAge();
            summary = stale
                ? `<span class="summary warn">${this._t("feed_stale", { t: fmtAgo(this._lang(), stale) })}</span>`
                : `<span class="summary">${this._mapSummary(count)}</span>`;
        }
        head.innerHTML = `
            <span class="chev">${ICONS.chevronDown}</span>
            <span class="sect-title">${this._t("line_map")}</span>
            <span class="spacer"></span>
            ${summary}`;
    }

    _popHtml(entry, nextStopName) {
        const vid = this._vid(entry.f);
        const h = this._hist.get(`${entry.def.idx}:${vid}`) || [];
        let speed = null;
        if (h.length > 1) {
            const a = h[h.length - 2], b = h[h.length - 1];
            const dt = (b.ts - a.ts) / 1000;
            if (dt > 5) speed = Math.round((haversine(a, b) / dt) * 3.6);
        }
        const mw = modeWord(this._lang(), entry.def.mode || "bus", false);
        const veh = mw.charAt(0).toUpperCase() + mw.slice(1);
        const sigAt = this._ld[entry.def.idx]?.sigAt || 0;
        const upd = sigAt ? fmtAgo(this._lang(), Date.now() - sigAt) : "";
        // the run the vehicle is on: its headsign is the terminus, its route
        // code the badge - the join the map's filter made (see
        // _stopVehicleFilter). A vehicle nothing on the board rides (the
        // nearby fallback) wears the stop's badge alone
        const row = entry.f.properties?.trip_id != null
            ? this._departureRows().rows.find((r) => r.veh === entry
                || (r.tripId === String(entry.f.properties.trip_id) && !r.veh)) || null
            : null;
        const terminus = row?.headsign || "";
        const badgeLabel = row?.line ?? this._lineLabelOf(entry.def);
        const badgeColor = this._rowColor(row || { def: entry.def }, entry.def) || entry.def.color || "#777";
        const showNext = nextStopName && nextStopName !== terminus;
        // speed only once measured (two positions seen): no placeholder
        const tele = [speed != null ? `${speed} km/h` : null, upd ? esc(upd) : null].filter(Boolean).join(" · ");
        return `
            <div class="pop-head">
                <span class="mini-badge" style="background:${esc(badgeColor)};color:${inkOn(badgeColor)}">${esc(badgeLabel)}</span>
                <b>${veh} ${esc(vid)}</b>
                <span class="spacer"></span>
                <button class="pop-close" data-action="untrack" aria-label="${esc(this._t("close"))}">✕</button>
            </div>
            ${terminus ? `<div class="pop-dest">→ ${esc(terminus)}</div>` : ""}
            ${showNext ? `<div class="pop-row">${this._t("next_stop", { s: esc(nextStopName) })}</div>` : ""}
            ${tele ? `<div class="pop-row">${tele}</div>` : ""}`;
    }

    _stopHover(e, on) {
        const g = e.composedPath().find((n) => n.classList && n.classList.contains("stop"));
        if (!g) return;
        if (!on && g.contains(e.relatedTarget)) return;   // moving between the stop's own circles
        if (on) {
            // a pressed pointer means a pan, not a visit: stops sliding under
            // the cursor mid-drag must not resurrect the tip that pointerdown
            // just hid - THAT tip would then sit still while the map moves
            if (this._pointers.size) return;
            // and the pan is not over at pointerup: releasing the capture, and
            // the deferred re-render, both replay pointerover on the stop still
            // under the cursor - it travelled with the drag. The tip the move
            // had just closed came straight back, as if nothing had moved.
            if (this._panHover) return;
            // the map already names this stop in full and it serves no other
            // line: a tooltip would just print the same words twice over
            if (this._labelIsRedundant(g.dataset)) return;
            this._showTip(g.dataset, 0);
        } else this._hideTip();
    }

    // true when the tooltip would add nothing to what the map already shows
    _labelIsRedundant(ds) {
        if (!ds.name) return true;
        const key = String(ds.name).trim().toLowerCase();
        // the mark says there is something to read here, and the tooltip is
        // where it is written: never mute it
        if (this._stopAlertsAt(Number(ds.li), ds.name)) return false;
        if (!this._shownLabels.has(key)) return false;    // name not drawn, or truncated
        const own = this._lineDefs()[Number(ds.li)];
        const ownLabel = own ? this._lineLabelOf(own) : null;
        const m = this._stopLinks.get(key);
        const others = m ? [...m].filter(([l]) => l !== ownLabel) : [];
        return others.length === 0;                       // no connections to add either
    }

    // stop tooltip: name plus the other configured lines serving it
    _showTip(ds, ms) {
        const body = this.shadowRoot.getElementById("map-body");
        const tip = body?.querySelector(".map-tip");
        const svg = body?.querySelector(".map-wrap svg");
        if (!tip || !svg || !this._viewBox || !ds.name) return;
        const own = this._lineDefs()[Number(ds.li)];
        const ownLabel = own ? this._lineLabelOf(own) : null;
        const m = this._stopLinks.get(String(ds.name).trim().toLowerCase());
        const others = m ? [...m].filter(([l]) => l !== ownLabel) : [];
        // what the line never does here, on any run: said only from the
        // line's word (the route file's boards / alights), never from the
        // drawn run's own call, which another run may make otherwise
        const stop = own ? this._ld[own.idx]?.route?.stops.find((s) => s.name.trim().toLowerCase() === String(ds.name).trim().toLowerCase()) : null;
        // said only where it matters: a line's first stop, or where a
        // journey boards it, is no place to get off anyway; its last, or
        // where a journey leaves it, no place to get on
        const lc = (x) => String(x || "").trim().toLowerCase();
        const nm = lc(ds.name), stops = own ? this._ld[own.idx]?.route?.stops || [] : [];
        let on = stops.length > 0 && lc(stops[0].name) === nm, off = stops.length > 0 && lc(stops[stops.length - 1].name) === nm;
        for (const pl of stop ? this._visiblePlans() : []) {
            pl.legs.forEach((leg, k) => {
                if (leg.def.idx !== own.idx) return;
                if (lc(k === 0 ? pl.points[0]?.name : leg.board?.name) === nm) on = true;
                if (lc(leg.end?.name) === nm) off = true;
            });
        }
        const never = [stop?.noBoard && !off ? this._t("tip_no_board") : "", stop?.noAlight && !on ? this._t("tip_no_alight") : ""].filter(Boolean);
        // what the operator says of this stop, under the name and the rest:
        // the sentence itself, wrapped, since it is the reason the mark is
        // there and a tooltip that only repeated the name would say nothing
        const said = this._stopAlertsAt(Number(ds.li), ds.name);
        const sayAl = said ? said.map((x) => this._alertSay(x)).filter(Boolean).join(" · ") : "";
        tip.innerHTML = `<b>${esc(ds.name)}</b>`
            + (others.length ? `<span class="tip-links">${others.map(([l, c]) => `<span class="mini-badge" style="background:${esc(c)};color:${inkOn(c)}">${esc(l)}</span>`).join("")}</span>` : "")
            + (never.length ? `<span class="tip-note">${never.map(esc).join(", ")}</span>` : "")
            + (sayAl ? `<span class="tip-alert">${esc(sayAl)}</span>` : "");
        tip.classList.toggle("tip-wrap", !!sayAl);
        const vb = this._viewBox, w = svg.clientWidth || 408, h = svg.clientHeight || 204;
        const sx = ((Number(ds.x) * SVG_UNIT - vb[0]) / vb[2]) * w, sy = ((Number(ds.y) * SVG_UNIT - vb[1]) / vb[3]) * h;
        tip.hidden = false;
        // Placed from its own size: an alert's sentence makes it tall, and a
        // tall tip over a stop near the top drew itself clean out of the
        // map, over the board above. It goes under the stop instead, and its
        // sides are held by its width, not by a margin guessed at.
        // Twice, because the first size a tip just opened gives is the one
        // it had before its words were wrapped: a line short, and the tip
        // placed as if it fitted. The second pass reads the size it has and
        // costs nothing once it stops changing.
        const place = () => {
            const tw = tip.offsetWidth, th = tip.offsetHeight;
            const below = sy - 10 - th < 4;
            tip.classList.toggle("below", below);
            const half = Math.min(tw / 2 + 4, w / 2);
            tip.style.left = `${Math.max(half, Math.min(w - half, sx))}px`;
            tip.style.top = below
                ? `${Math.max(4, Math.min(sy + 14, h - th - 4))}px`
                : `${Math.max(th + 4, Math.min(h - 4, sy - 10))}px`;
            return th;
        };
        if (place() !== tip.offsetHeight) place();
        if (this._tipT) clearTimeout(this._tipT);
        this._tipT = ms ? setTimeout(() => this._hideTip(), ms) : null;
    }

    _hideTip() {
        const tip = this.shadowRoot.querySelector(".map-tip");
        if (tip) tip.hidden = true;
        if (this._tipT) { clearTimeout(this._tipT); this._tipT = null; }
    }

    // any direct write wins over a running animation: leaving it alive would
    // let it keep interpolating towards a target captured in another origin
    _setViewBox(vb) {
        if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
        this._viewBox = vb;
    }

    _animateViewBox(from, to, dur = 280, ease = null) {
        if (this._anim) cancelAnimationFrame(this._anim);
        // every animated view change (zoom buttons, recenter, overview,
        // tracking glide) strands a screen-anchored tip: close it up front
        this._hideTip();
        // a degenerate box would be rejected by the SVG and strand the map:
        // jump rather than animate through invalid geometry
        if (!(from?.[2] > 0) || !(from[3] > 0) || !(to?.[2] > 0) || !(to[3] > 0)) {
            this._anim = null;
            this._viewBox = to;
            return;
        }
        // reduced motion: jump straight to the target (the caller renders it)
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            this._anim = null;
            this._viewBox = to;
            return;
        }
        this._dbg("glide start", { to: to.map((v) => Math.round(v)) });
        const start = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / dur);
            const e = ease ? ease(t) : 1 - Math.pow(1 - t, 3);
            this._viewBox = from.map((v, i) => v + (to[i] - v) * e);
            const svg = this.shadowRoot.querySelector(".map-wrap svg");
            if (svg) svg.setAttribute("viewBox", vbAttr(this._viewBox));
            this._syncBasemap();
            this._positionPop();
            this._updateScale();
            if (t < 1) this._anim = requestAnimationFrame(step);
            else { this._anim = null; this._viewBox = to; this._renderMap(false); this._dbg("glide end"); }
        };
        this._anim = requestAnimationFrame(step);
    }

    /* ── PANE 2: MAP pan & zoom ─────────────────────────────────────────── */

    _attachMapEvents() {
        const svg = this.shadowRoot.querySelector(".map-wrap svg");
        if (!svg) return;
        svg.addEventListener("pointerdown", (e) => this._mapDown(e, svg));
        svg.addEventListener("pointermove", (e) => this._mapMove(e, svg));
        svg.addEventListener("pointerup", (e) => this._mapUp(e, svg));
        svg.addEventListener("pointercancel", (e) => this._mapUp(e, svg));
        svg.addEventListener("wheel", (e) => this._mapWheel(e, svg), { passive: false });
        // touch-action: pan-y hands ONE finger to the page, which is what the
        // card wants. It has no way to say "and two fingers are mine": the
        // browser reads a two-finger vertical drag as a page scroll as well,
        // takes it, and cancels the pointers mid-gesture - the dashboard
        // scrolled and the map never moved. Refusing the touch stream as soon
        // as a second finger lands is what keeps the gesture on the map.
        const holdMulti = (e) => { if (e.touches.length >= 2) e.preventDefault(); };
        svg.addEventListener("touchstart", holdMulti, { passive: false });
        svg.addEventListener("touchmove", holdMulti, { passive: false });
        svg.addEventListener("dblclick", (e) => this._mapDblClick(e, svg));
        // instant stop tooltip on mouse hover (touch uses the tap action)
        svg.addEventListener("pointerover", (e) => { if (e.pointerType === "mouse") this._stopHover(e, true); });
        svg.addEventListener("pointerout", (e) => { if (e.pointerType === "mouse") this._stopHover(e, false); });
        // a mouse that moves on its own ends the hover blackout a view change
        // opened; pointerover will not fire again inside the stop it never
        // left, so the visit is read from the move itself
        svg.addEventListener("pointermove", (e) => {
            if (e.pointerType !== "mouse") return;
            // the tip is placed from the view it was opened in and does not
            // travel: a map moving under it leaves it pointing at nothing
            if (this._pointers.size) { this._hideTip(); return; }
            // every render replaces the overlay, the stop under the cursor
            // with it: the node that would have fired pointerout is gone,
            // and the tip it opened would sit there for good. The move says
            // where the cursor really is, which is the only word left
            if (!e.composedPath().some((n) => n.classList && n.classList.contains("stop"))) this._hideTip();
            if (!this._panHover) return;
            this._panHover = false;
            this._stopHover(e, true);
        });
        // and a cursor that leaves the map without passing over a stop on
        // its way out never says so either
        svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") this._hideTip(); });
    }

    _showHint(text, teachKind) {
        // teaching hints (wheel/touch) stop nagging after a few showings
        if (teachKind) {
            if ((this._hintCounts[teachKind] || 0) >= 3) return;
            this._hintCounts[teachKind] = (this._hintCounts[teachKind] || 0) + 1;
        }
        const hint = this.shadowRoot.querySelector(".map-hint");
        if (!hint) return;
        hint.textContent = text;
        hint.classList.add("show");
        if (this._hintT) clearTimeout(this._hintT);
        this._hintT = setTimeout(() => hint.classList.remove("show"), 1600);
    }

    _clampVB(vb) {
        // half the world at most: a card whose lines span two continents
        // fits wider than a quarter, and its first zoom out snapped in
        const minW = 100 / this._mPerUNow, maxW = WORLD / 2;
        if (vb[2] < minW || vb[2] > maxW) {
            const w = Math.max(minW, Math.min(maxW, vb[2]));
            const f = w / vb[2];
            const cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
            vb = [cx - (vb[2] * f) / 2, cy - (vb[3] * f) / 2, vb[2] * f, vb[3] * f];
        }
        // the base map stops at the antimeridian and at the poles' cut-off
        // (one world, no copies): a view let past them slid the overlay on
        // while the land stood still
        const O = this._origin;
        if (O) {
            const x = Math.max(-O.x, Math.min(WORLD - O.x - vb[2], vb[0]));
            const y = Math.max(-O.y, Math.min(WORLD - O.y - vb[3], vb[1]));
            if (x !== vb[0] || y !== vb[1]) vb = [x, y, vb[2], vb[3]];
        }
        return vb;
    }

    _applyVB(svg) {
        // the tip is anchored in screen pixels, not in the map: any view
        // change strands it over the wrong stop, so every direct view write
        // dismisses it - as _animateViewBox does for the animated ones
        this._hideTip();
        this._panHover = true;
        this._setViewBox(this._clampVB(this._viewBox));
        svg.setAttribute("viewBox", vbAttr(this._viewBox));
        this._syncBasemap();
        this._positionPop();
        this._updateScale();
        this._markFar(svg);
    }

    // Zoomed far out, the lines shrink to a speck with every vehicle and
    // stop piled on it, and a click there means "closer": a vehicle under
    // it took the click and started tracking, the second click of the
    // double-click then fell on the background mid-glide and dropped the
    // tracking, and the zoom landed where the speck no longer was. In that
    // view the markers let the clicks through to the map.
    _markFar(svg) {
        const vb = this._viewBox;
        const w = svg.clientWidth || this._scaleW || 408;
        if (!vb || !w) return;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const s of this._ld) {
            const r = s.route;
            if (!r?.line?.length) continue;
            if (r._bbLine !== r.line) {
                let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
                for (const p of r.line) { a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x); d = Math.max(d, p.y); }
                r._bb = [a, b, c, d];
                r._bbLine = r.line;
            }
            x0 = Math.min(x0, r._bb[0]); y0 = Math.min(y0, r._bb[1]);
            x1 = Math.max(x1, r._bb[2]); y1 = Math.max(y1, r._bb[3]);
        }
        const far = x0 < Infinity && Math.max(x1 - x0, y1 - y0) / (vb[2] / w) < FAR_PX;
        svg.classList.toggle("far", far);
    }

    _scheduleRerender() {
        if (this._rerenderTimer) clearTimeout(this._rerenderTimer);
        this._rerenderTimer = setTimeout(() => { this._rerenderTimer = null; this._renderMapSection(); }, 180);
    }

    // The journey board hangs on the shapes and the leg files as much as on
    // the sensors: where a leg is boarded, when a run reaches each point.
    // When one of them lands the board is drawn again; left to the sensors,
    // it kept the chain it could make without them until the next update of
    // a state, minutes later - boarding at a terminus miles from the change.
    _scheduleBoard() {
        if (!this._journeys?.length) return;
        if (this._boardTimer) clearTimeout(this._boardTimer);
        // the destination chips carry the next departure, which the same
        // files time
        this._boardTimer = setTimeout(() => { this._boardTimer = null; this._renderHeader(); this._renderDepartures(); }, 180);
    }

    _mapDown(e, svg) {
        if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
        this._hideTip();
        svg.setPointerCapture(e.pointerId);
        // with the pointer captured, recent Chromium delivers the ensuing
        // click to the svg instead of the marker under the finger, so the
        // [data-action] target is grabbed here and activated on pointerup
        this._downAction = this._pointers.size === 0
            ? (e.composedPath ? e.composedPath() : []).find((n) => n.dataset && n.dataset.action) || null
            : null;
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this._moved = 0;
        if (this._pointers.size >= 2) this._multi = true;
        if (this._pointers.size === 2 && this._viewBox) {
            const [a, b] = [...this._pointers.values()];
            const rect = svg.getBoundingClientRect();
            this._pinch = {
                dist: Math.hypot(b.x - a.x, b.y - a.y),
                mid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
                vb: [...this._viewBox],
            };
        }
    }

    _mapMove(e, svg) {
        const p = this._pointers.get(e.pointerId);
        if (!p || !this._viewBox) return;
        const u = this._viewBox[2] / (svg.clientWidth || 408);
        if (this._pointers.size === 1) {
            const dx = e.clientX - p.x, dy = e.clientY - p.y;
            this._moved += Math.abs(dx) + Math.abs(dy);
            if (e.pointerType === "touch") {
                // one finger scrolls the page; the map moves with two fingers
                if (this._moved > 12) this._showHint(this._t("hint_touch"), "touch");
            } else if (this._moved > 5) {
                this._manual = true;
                this._suppressClick = true;
                this._viewBox[0] -= dx * u;
                this._viewBox[1] -= dy * u;
                this._applyVB(svg);
            }
        }
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this._pointers.size === 2 && this._pinch) {
            const [a, b] = [...this._pointers.values()];
            const dist = Math.hypot(b.x - a.x, b.y - a.y);
            if (dist > 10) {
                const rect = svg.getBoundingClientRect();
                const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
                const f = this._pinch.dist / dist;
                const vb0 = this._pinch.vb;
                const u0 = vb0[2] / (rect.width || 408);
                const wx = vb0[0] + this._pinch.mid.x * u0;
                const wy = vb0[1] + this._pinch.mid.y * u0;
                const u1 = u0 * f;
                this._manual = true;
                this._suppressClick = true;
                this._setViewBox([wx - mid.x * u1, wy - mid.y * u1, vb0[2] * f, vb0[3] * f]);
                this._applyVB(svg);
            }
        }
    }

    _mapUp(e, svg) {
        if (!this._pointers.has(e.pointerId)) return;
        this._pointers.delete(e.pointerId);
        this._pinch = null;
        const t = this._downAction;
        this._downAction = null;
        // lifting off a two-finger pan is not a tap: without this it closed
        // the tracking popup every time the map was moved with two fingers
        if (e.type === "pointerup" && this._moved <= 5 && !this._multi && this._pointers.size === 0) {
            if (t) {
                this._suppressClick = true; // the retargeted/native click must not re-activate
                this._activate(t);
            } else if (this._focus && !(performance.now() - this._trackAt < DBL_MS)) {
                // a tap on the background closes the popup, view unchanged.
                // Not the second click of a double-click on a vehicle: the
                // map glided off under the cursor between the two, and the
                // tracking the first one started is what the user asked for
                this._suppressClick = true;
                this._act("untrack", {});
            }
        }
        if (this._pointers.size === 0) this._multi = false;
        if (this._manual && this._moved > 5) this._dbg(this._multi || e.pointerType === "touch" ? "pinch / pan end" : "drag end");
        if (this._manual) this._scheduleRerender();
        setTimeout(() => { this._suppressClick = false; }, 250);
    }

    _mapWheel(e, svg) {
        if (!this._viewBox) return;
        if (!e.ctrlKey && !e.metaKey) {
            // let the page scroll; teach the gesture
            this._showHint(this._t("hint_wheel"), "wheel");
            return;
        }
        e.preventDefault();
        const f = e.deltaY > 0 ? 1.25 : 0.8;
        const rect = svg.getBoundingClientRect();
        const u = this._viewBox[2] / (rect.width || 408);
        const wx = this._viewBox[0] + (e.clientX - rect.left) * u;
        const wy = this._viewBox[1] + (e.clientY - rect.top) * u;
        this._manual = true;
        this._setViewBox([wx - (wx - this._viewBox[0]) * f, wy - (wy - this._viewBox[1]) * f, this._viewBox[2] * f, this._viewBox[3] * f]);
        this._applyVB(svg);
        this._dbg(f < 1 ? "wheel in" : "wheel out", { at: [Math.round(e.clientX - rect.left), Math.round(e.clientY - rect.top)] });
        this._scheduleRerender();
    }

    // double-click: zoom in one step around the clicked point, which stays
    // under the pointer, as the wheel does. It used to recentre on it: the
    // map slid away from a pointer held still, the next double-click landed
    // on empty ground, and a few of them aimed beside a line pushed the line
    // off the map. Not on a bus: a single click there already focuses it.
    _mapDblClick(e, svg) {
        if (!this._viewBox) return;
        if (e.composedPath().some((n) => n.dataset && n.dataset.action === "bus")) return;
        // nor right after a click that tracked one: the vehicle has glided
        // away from under the second click, which is not a zoom of its own
        if (performance.now() - this._trackAt < DBL_MS) return;
        e.preventDefault();
        const rect = svg.getBoundingClientRect();
        const u = this._viewBox[2] / (rect.width || 408);
        const wx = this._viewBox[0] + (e.clientX - rect.left) * u;
        const wy = this._viewBox[1] + (e.clientY - rect.top) * u;
        const vb = this._viewBox, f = 0.5;
        this._manual = true;
        this._setViewBox(this._clampVB([wx - (wx - vb[0]) * f, wy - (wy - vb[1]) * f, vb[2] * f, vb[3] * f]));
        this._applyVB(svg);
        this._dbg("double-click", { at: [Math.round(e.clientX - rect.left), Math.round(e.clientY - rect.top)] });
        this._scheduleRerender();
    }

    _zoomBy(f) {
        if (!this._viewBox) return;
        // the zoom buttons sit outside the svg: no pointerdown reaches the
        // map, so this is the only place left to close the tip
        this._hideTip();
        this._panHover = true;
        const vb = this._viewBox;
        const cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
        this._manual = true;
        this._setViewBox(this._clampVB([cx - (vb[2] * f) / 2, cy - (vb[3] * f) / 2, vb[2] * f, vb[3] * f]));
        this._renderMap(false);
        this._dbg(f < 1 ? "button +" : "button -");
    }

    /* ── STYLES ─────────────────────────────────────────────────────────── */

    _styles() {
        return `
        :host { display: block; }
        ha-card { overflow: hidden; position: relative; font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
        /* The badges and the text zone sit side by side until the text zone
           would be squeezed under TITLES_MIN; then it takes a row of its own.
           Without the wrap a crowded header shrank the zone to nothing and the
           station name spilled past the card, which clips it. */
        .header { display: flex; align-items: center; gap: 12px; padding: 14px 16px 10px 16px; flex-wrap: wrap; }
        /* a floor of one badge: without it the block's max-content (every badge
           on one row) set the card's minimum width, and the card then refused
           to fit a column narrower than that */
        .badges { display: flex; gap: ${PIP_GAP}px; flex-wrap: wrap; min-width: ${BADGE_W}px; }
        /* a fixed square, never a box that grows with its label: two lines
           side by side have to be the same size, so it is the number that
           shrinks to fit the 40px between the paddings. See badgeFontSize. */
        .badge { position: relative; width: ${BADGE_W}px; height: ${BADGE_W}px; flex: none; border-radius: 10px; color: #fff; display: flex; align-items: center; justify-content: center; font-size: ${BADGE_FS}px; font-weight: 700; padding: 0 ${BADGE_PAD}px; box-sizing: border-box; }
        /* the mode chip rides on the badge itself: no disc, no outline, just
           the glyph in the badge's own ink, so it reads as part of the badge */
        /* a faint disc behind the glyph, tinted OPPOSITE to the ink: tinting it
           in the ink itself would put a white veil under a white glyph and
           swallow it. Set per badge as --chip-bg, since the ink depends on the
           line colour. */
        /* one size, one overhang, four possible corners: a mark is told apart
           by what it holds and by where it sits, never by how big it is */
        .badge-pip { position: absolute; width: ${BADGE_PIP}px; height: ${BADGE_PIP}px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: inherit; pointer-events: none; z-index: 3; --mdc-icon-size: 26px; }
        .badge-pip.br { right: ${-PIP_GAP / 2}px; bottom: ${-PIP_GAP / 2}px; }
        .badge-pip.tl { left: ${-PIP_GAP / 2}px; top: ${-PIP_GAP / 2}px; }
        .badge-pip.tr { right: ${-PIP_GAP / 2}px; top: ${-PIP_GAP / 2}px; }
        .badge-pip.bl { left: ${-PIP_GAP / 2}px; bottom: ${-PIP_GAP / 2}px; }
        .badge-pip.mode { background: var(--chip-bg, color-mix(in srgb, #000 40%, transparent)); }
        /* the state mark reads against the card, not against the line colour,
           so it says the same thing whatever line it sits on */
        .badge-pip.mute { background: var(--card-background-color, #fff); color: var(--warning-color, #b26a00); box-shadow: inset 0 0 0 1.5px currentColor; z-index: 5; }
        /* same treatment, deliberately not the same colour: a line resting
           for the weekend is not a fault, so it stays neutral and leaves the
           warning ink to the source that has gone quiet */
        .badge-pip.svc { background: var(--card-background-color, #fff); color: var(--secondary-text-color, #727272); box-shadow: inset 0 0 0 1.5px currentColor; z-index: 5; }
        /* the operator reporting a disruption outranks a stale file: this one
           takes the error ink, the quiet source keeps the warning ink, and the
           line at rest stays neutral. Three corners, three levels, one geometry */
        .badge-pip.alert { background: var(--card-background-color, #fff); color: var(--error-color, #b3261e); box-shadow: inset 0 0 0 1.5px currentColor; z-index: 5; }
        .badge-pip ha-icon { display: flex; }
        /* a line with no service is struck through by a single diagonal, at
           65% so it stays a note rather than a warning: the number underneath
           must remain readable. The halo below the stroke carries the opposite
           ink, which is what keeps the stroke visible on a mid green or grey
           line, where 65% ink alone measures barely 2.2:1. */
        /* the number sits above the stroke, so the diagonal crosses the badge
           without burying the digits */
        .badge-num { position: relative; z-index: 4; line-height: 1; }
        /* read out, never drawn: the diagonal is the visual half of this */
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
        .badge-slash { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; opacity: 0.65; border-radius: 10px; }
        .slash-halo { stroke: var(--opp-ink, #000); stroke-width: 5.5; opacity: 0.55; }
        /* the number keeps its full ink: a line still shows its number when it
           is not running. Only the badge as a whole steps back a little. */
        .badge.resting { opacity: 0.92; }
        .badge.resting.sel { opacity: 1; }
        /* A sensor out of service is drained, not dimmed: its colour is
           replaced by its desaturated twin (see drain), so nothing here fades
           the number or the mark. A positions file gone quiet alone keeps the
           colour: its pip says it. */
        .badge-glyph { width: ${BADGE_PIP}px; height: ${BADGE_PIP}px; display: block; }
        .badge.clickable { cursor: pointer; }
        .badge.sel { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .badge.dim { opacity: 0.45; }
        /* the hover title, said out loud for a finger. Same ink and shadow as
           the map tooltip, but it wraps: a badge's sentence can run to a
           destination, a rest and an alert at once. */
        .badge-tip { position: absolute; z-index: 6; max-width: min(280px, calc(100% - 16px)); background: var(--card-background-color, #fff); color: var(--primary-text-color); font-size: 12px; line-height: 1.35; padding: 6px 10px; border-radius: 8px; box-shadow: 0 1px 6px rgba(0,0,0,.35); pointer-events: none; }
        .badge:focus-visible, .sect-head:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        /* the whole frame left of the badges, however tall they stack; the
           header centres it vertically, and the text wraps instead of being
           cut - the journey name is the only thing this zone says */
        .titles { display: flex; flex-direction: column; gap: 2px; min-width: ${TITLES_MIN}px; flex: 1;
            align-items: center; text-align: center; }
        /* anywhere, not break-word: break-word leaves the min-content width at
           the longest word, so a word wider than the zone was never broken at
           all - it just hung out over the card's edge */
        .title { font-size: 16px; font-weight: 500; color: var(--primary-text-color); overflow-wrap: anywhere; }
        .subtitle, .sub, .summary { font-size: 13px; color: var(--secondary-text-color); }
        .subtitle { overflow-wrap: anywhere; }
        /* ── the destination header of a card of journeys ──
           A chip per destination opens on a 42 px medallion: the mode it is
           reached by at 26 px of ink, more than a badge's corner pip ever
           held and covered by nothing. The direction is a full-width control
           of 44 px, the ways are plates, every target a finger's size. */
        .dhead { flex: 1 1 100%; min-width: 0; display: flex; flex-direction: column; gap: 9px; }
        .dtitle { font-size: 16px; font-weight: 500; color: var(--primary-text-color); text-align: center; overflow-wrap: anywhere; }
        /* departures above arrivals on a rail: a disc and its caption, then
           the chips beside the rail, as a journey's timeline draws its points */
        .droute { display: grid; grid-template-columns: 18px minmax(0, 1fr); column-gap: 10px; row-gap: 6px; --lc: var(--secondary-text-color); }
        .droute .jnode::before { width: 2px; margin-left: -1px; top: -6px; bottom: -6px; }
        .droute .jnode.first::before { top: 50%; }
        .droute .jnode.last::before { bottom: 50%; }
        .droute .dwcap { margin: 0; align-self: center; font-weight: 600; }
        /* an even grid: two chips never stretch unevenly, a lone last one
           keeps its column */
        .drow { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 8px; }
        .dest { position: relative; display: flex; align-items: center; gap: 10px; min-width: 0; box-sizing: border-box; min-height: 58px;
            padding: 8px 12px 8px 8px; border-radius: 14px; border: 0; background: rgba(127,127,127,.12); color: var(--primary-text-color);
            text-align: left; cursor: pointer; font: inherit; }
        .dest.on { background: rgba(3,169,244,.14); background: color-mix(in srgb, var(--primary-color) 14%, transparent); box-shadow: inset 0 0 0 2px var(--primary-color); }
        .dest.solo { cursor: default; }
        .dest:focus-visible, .dway:focus-visible, .dfilter:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        /* The chip's identity: one plate per line it is reached by, the number
           full height and the mode on a band at the foot. Sized so two plates
           cost no more than the medallion they replaced. */
        .dplate.big { width: 26px; height: 34px; border-radius: 7px; }
        .dplate.big .n { font-size: 13px; letter-spacing: -0.02em; }
        .dplate.big .band { height: 12px; }
        .dmore { font-size: 11px; font-weight: 700; color: var(--secondary-text-color); align-self: center; }
        .dest .dplates { flex: none; align-items: center; gap: 3px; }
        .dtxt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .dtxt > b { font-size: 14.5px; font-weight: 600; line-height: 1.15; overflow-wrap: anywhere; }
        .dmuted { font-size: 11.5px; color: var(--secondary-text-color); }
        /* the line plates, ahead of the clock on the same line: small enough
           that the clock stays what the eye lands on, and they wrap with it
           rather than push it out of a narrow chip */
        .dnums { display: inline-flex; gap: 3px; align-items: center; flex: none; }
        .dnum { display: inline-flex; align-items: center; justify-content: center; flex: none;
            min-width: 17px; height: 15px; padding: 0 4px; border-radius: 4px;
            font-size: 10.5px; font-weight: 700; line-height: 1; }
        /* the badge's marks, in the badge's corners and inks: the operator's
           alert top right in the error ink, the quiet source top left in the
           warning ink, the rest bottom left, neutral - one size, one overhang */
        .dmark { position: absolute; width: 22px; height: 22px; border-radius: 50%; background: var(--card-background-color, #fff);
            box-shadow: inset 0 0 0 1.5px currentColor; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 2; }
        .dmark.alert { top: -7px; right: -7px; color: var(--error-color, #b3261e); }
        .dmark.mute { top: -7px; left: -7px; color: var(--warning-color, #b26a00); }
        .dmark.rest { bottom: -7px; left: -7px; color: var(--secondary-text-color, #727272); }
        .dmark svg, .dwal svg, .dplate .band svg { display: block; }
        /* The caption row closes both headers: what is left to say on the
           left, the toggle on the right. It is the only row every card has -
           a card without title: has no title row - which is why the toggle
           lives here rather than beside the title. */
        .caprow { display: flex; align-items: center; gap: 8px; min-height: 26px; }
        .caprow .capleft { flex: 1; display: flex; align-items: center; gap: 7px; min-width: 0;
            font-size: 13px; color: var(--secondary-text-color); overflow-wrap: anywhere; }
        .swap { display: inline-flex; flex: none; border: 1px solid var(--divider-color);
            border-radius: 8px; overflow: hidden; background: var(--card-background-color); }
        .swap button { border: 0; background: transparent; cursor: pointer; font: inherit;
            font-size: 10.5px; font-weight: 600; color: var(--secondary-text-color);
            padding: 4px 8px; min-height: 26px; display: inline-flex; align-items: center; gap: 4px; }
        .swap button + button { border-left: 1px solid var(--divider-color); }
        .swap button.on { background: var(--primary-text-color); color: var(--card-background-color, #fff); }
        .swap button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -3px; }
        .swap svg { display: block; }
        .dwcap { font-size: 11px; color: var(--secondary-text-color); margin-bottom: -3px; }
        .dways { display: flex; gap: 6px; flex-wrap: wrap; }
        .dway { position: relative; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; box-sizing: border-box; padding: 4px 10px 4px 4px;
            border-radius: 10px; border: 0; background: rgba(127,127,127,.12); color: var(--primary-text-color); cursor: pointer; font: inherit; }
        .dway.on { background: rgba(3,169,244,.14); background: color-mix(in srgb, var(--primary-color) 14%, transparent); box-shadow: inset 0 0 0 2px var(--primary-color); }
        .dplates { display: flex; gap: 2px; }
        .dplate { width: 24px; height: 34px; border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; font-weight: 700; flex: none; }
        .dplate .n { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1; }
        .dplate .band { height: 13px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.3); }
        .dwtxt { display: flex; flex-direction: column; line-height: 1.2; text-align: left; }
        .dwtxt .lbl { font-size: 11px; color: var(--secondary-text-color); }
        .dway.on .dwtxt .lbl { color: var(--primary-text-color); }
        .dwtxt .t { font-size: 13.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .dwtxt .why { font-size: 12px; color: var(--secondary-text-color); max-width: 190px; }
        .dwal { width: 17px; height: 17px; border-radius: 50%; background: var(--card-background-color, #fff); color: var(--error-color, #b3261e);
            box-shadow: inset 0 0 0 1.5px currentColor; display: inline-flex; align-items: center; justify-content: center; flex: none; }
        .dway .x { font-size: 16px; line-height: 1; color: var(--secondary-text-color); }
        /* the destination or way picked, in the board's head, which drops it */
        .dfilter { display: inline-flex; align-items: center; gap: 4px; height: 20px; max-width: 50%; padding: 0 7px; border-radius: 6px; cursor: pointer;
            font-size: 11.5px; font-weight: 600; color: #fff; background: var(--primary-color); vertical-align: middle; white-space: nowrap; }
        /* the cut is on the text, not on the chip: a chip that clips its own
           overflow cannot carry the touch overlay below, which sits outside it */
        .dfilter .dfl { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .dfilter .x { font-weight: 400; opacity: .85; flex: none; }
        /* Both filter chips are small on purpose: they sit in a section head,
           they are not the head. But a finger aims at the row, not at 18px of
           it, and these chips are the only way back from a filter. The chip
           keeps its size and an invisible overlay gives it the head's full
           44px, reaching 6px to each side - inside the head's 8px gap, so it
           never swallows a tap meant for the title next to it. */
        .mini-badge.filter, .dfilter { position: relative; }
        .mini-badge.filter::after, .dfilter::after {
            content: ""; position: absolute; left: -6px; right: -6px;
            top: 50%; height: 44px; transform: translateY(-50%); }
        .spacer { flex-grow: 1; }
        .sect-head { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-top: 1px solid var(--divider-color); cursor: pointer; user-select: none; }
        .sect-title { font-size: 14px; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; }
        /* a narrow card cuts the summary short rather than wrapping the head */
        .sect-head .summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        @media (hover: hover) {
            .sect-head:hover, .row.jrow:not(.flat):hover { background: rgba(127,127,127,.06); }
        }
        .chev { color: var(--secondary-text-color); display: inline-flex; }
        .summary b { color: var(--primary-text-color); font-weight: 600; }
        .summary.accent { color: var(--primary-color); font-weight: 500; }
        .summary.warn { color: var(--warning-color, #e65100); }
        /* the ring grows by transform and fades by opacity, which the
           compositor plays alone: a box-shadow pulse restyled and repainted
           the card on the main thread every frame, for as long as it showed */
        .live-dot { position: relative; width: 8px; height: 8px; border-radius: 50%; background: #4caf50; }
        .live-dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: rgba(76,175,80,.5); animation: pulse 2s infinite; will-change: transform, opacity; }
        @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 70% { transform: scale(2.5); opacity: 0; } 100% { transform: scale(2.5); opacity: 0; } }
        .row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--divider-color); }
        .row:first-child { border-top: none; }
        .row-badge { min-width: 26px; height: 24px; border-radius: 6px; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; padding: 0 5px; box-sizing: border-box; flex: none; }
        .mini-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 16px; border-radius: 4px; color: #fff; font-size: 10px; font-weight: 700; padding: 0 3px; vertical-align: middle; }
        .times { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        /* wrap, so a narrow card drops the destination onto its own line
           instead of ellipsising it down to a single letter: the row grows by
           one line rather than saying "C..." where a name belongs */
        .time-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
        .time { font-size: 20px; font-weight: 700; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
        .day-tag { font-size: 11px; color: var(--secondary-text-color); border: 1px solid var(--divider-color); border-radius: 6px; padding: 0 5px; align-self: center; flex: none; }
        .dest-inline { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* journey rows: the head line over the timeline, a four-column grid -
           badge, rail, name, clock - so the names and the clocks line up down
           the whole journey whatever the legs. The rail is the node column's
           own line, in the leg's colour, cut at the first and last disc of a
           leg; a change is the same column dotted. */
        .row.jrow { flex-direction: column; align-items: stretch; gap: 6px; cursor: pointer; }
        .jhead { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 8px; min-width: 0; }
        .jhead:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; border-radius: 4px; }
        .jarrow { font-size: 16px; color: var(--secondary-text-color); }
        .jtotal { font-size: 13px; color: var(--secondary-text-color); white-space: nowrap; }
        /* a closed journey: its legs in a row, wrapping between legs only */
        .jsum { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: 13px; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
        .jseg { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
        .jseg b { font-weight: 700; }
        /* a change in the row of legs: → walker wait → */
        .jchg { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; }
        .jchg svg { flex: none; }
        /* a picked leg's runs: the head line alone, nothing to open */
        .row.jrow.flat { cursor: default; }
        /* stacked journeys: each under its title */
        .jsec { padding: 10px 16px 2px; font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--secondary-text-color); border-top: 1px solid var(--divider-color); }
        .jsec:first-child { border-top: none; }
        .jsec + .row { border-top: none; }
        .jsec-sub { font-weight: 500; margin-left: 8px; color: var(--primary-text-color); opacity: .75; }
        /* the run of the vehicle tracked on the map, lit on the board */
        .board tr.hit > td { background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
        .board tr.hit > td:first-child { box-shadow: inset 3px 0 0 var(--primary-color); }
        .row.hit { background: color-mix(in srgb, var(--primary-color) 10%, transparent); box-shadow: inset 3px 0 0 var(--primary-color); }
        /* a row is a button: tapping it tracks its bus on the map */
        .board tr[data-action="row"], .row[data-action="row"] { cursor: pointer; }
        .board tr[data-action="row"]:hover > td { background: color-mix(in srgb, var(--primary-color) 6%, transparent); }
        .board tr[data-action="row"]:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
        .jbadges { display: inline-flex; gap: 3px; }
        /* which journey a row is, under its head: badge and title */
        .jwhere { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: -3px; font-size: 12px; color: var(--secondary-text-color); }
        .jwt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* countdown over status, then the chevron, kept to the right: the
           classic rows' stack, so a chip never makes one row taller alone */
        .jright { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; white-space: nowrap; }
        .jwhen { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 4px; }
        .chev.ph { visibility: hidden; }
        /* a day said once, over the first run it applies to, and ruled off
           from the day before */
        .jday { padding: 8px 16px 0; border-top: 1px solid var(--divider-color); }
        .jday:first-child, .jsec + .jday { border-top: none; }
        .jday + .row { border-top: none; }
        /* a direct change: no walk to draw, a thin rail across the wait */
        .jnode.walk.direct::before { border-left: 2px solid var(--divider-color); }
        /* the picked line in the section head, which is also how to drop it */
        .mini-badge.filter { gap: 3px; height: 18px; padding: 0 5px; cursor: pointer; }
        .mini-badge.filter .x { font-weight: 400; opacity: .85; }
        .mini-badge.filter:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .jtl { display: grid; grid-template-columns: auto 18px minmax(0, 1fr) auto; column-gap: 8px; font-size: 13px; line-height: 22px; color: var(--primary-text-color); }
        .jl { display: flex; align-items: center; justify-content: flex-end; }
        .jnode { position: relative; display: flex; align-items: center; justify-content: center; }
        .jnode::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 4px; margin-left: -2px; background: var(--lc); }
        .jnode.first::before { top: 50%; }
        .jnode.last::before { bottom: 50%; }
        .jnode.first.last::before { display: none; }
        .jnode.walk::before { width: 0; margin-left: -1px; background: none; border-left: 2px dotted var(--secondary-text-color); }
        /* the disc of a point: ringed in its leg's colour on the card's own
           ground, the number in the text colour - legible on any line
           colour, which a number on the station colour was not */
        .jnum { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; box-sizing: border-box; border-radius: 50%; border: 2px solid var(--lc); background: var(--card-background-color, #fff); color: var(--primary-text-color); font-size: 11px; font-weight: 700; line-height: 1; flex: none; }
        .jname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .jclock { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .jclock b { font-weight: 700; }
        .jnote { font-size: 11px; color: var(--secondary-text-color); padding: 2px 16px 8px; }
        .jmuted, .jbroken { font-size: 12px; white-space: nowrap; }
        .jmuted { color: var(--secondary-text-color); }
        /* status colours pulled a quarter towards the text colour: darker on
           a light card, lighter on a dark one, AA on both (the plain colour
           first, for a browser without color-mix) */
        .jbroken { color: var(--gtfs2-late-color, #e65100); color: color-mix(in srgb, var(--gtfs2-late-color, #e65100) 75%, var(--primary-text-color, #212121)); }
        .rt-icon { color: #4caf50; color: color-mix(in srgb, #4caf50 80%, var(--primary-text-color, #212121)); display: inline-flex; flex: none; }
        .row-mode { display: inline-flex; flex: none; align-self: center; width: 16px; height: 16px; color: var(--secondary-text-color); }
        .row-mode svg { width: 100%; height: 100%; }
        .board td .row-mode { margin-right: 4px; vertical-align: -3px; }
        .sub.strike { text-decoration: line-through; }
        .sub { font-size: 12px; }
        .via-t { white-space: nowrap; }
        .vias .jbroken { font-size: inherit; }
        .sub-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; min-width: 0; }
        /* the merged line reads as a sentence: capital on its first letter,
           whatever the language, without touching the strings used elsewhere */
        .sub-line > .sub:first-child::first-letter { text-transform: uppercase; }
        .dur { white-space: nowrap; }
        .right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
        .countdown { font-size: 14px; font-weight: 600; color: var(--primary-text-color); }
        .chip { display: inline-flex; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
        .chip-late { background: rgba(230,81,0,.14); color: var(--gtfs2-late-color, #e65100); color: color-mix(in srgb, var(--gtfs2-late-color, #e65100) 75%, var(--primary-text-color, #212121)); }
        .chip-early { background: rgba(3,105,161,.14); color: var(--gtfs2-early-color, #0369a1); color: color-mix(in srgb, var(--gtfs2-early-color, #0369a1) 70%, var(--primary-text-color, #212121)); }
        .chip-ok { background: rgba(46,125,50,.14); color: var(--gtfs2-ontime-color, #2e7d32); color: color-mix(in srgb, var(--gtfs2-ontime-color, #2e7d32) 75%, var(--primary-text-color, #212121)); }
        .chip-theo { background: rgba(127,127,127,.14); color: var(--secondary-text-color); }
        .chip-struck { background: rgba(179,38,30,.14); color: var(--error-color, #b3261e); color: color-mix(in srgb, var(--error-color, #b3261e) 80%, var(--primary-text-color, #212121)); }
        .time.struck, .board .struck { text-decoration: line-through; color: var(--secondary-text-color); }
        .row.struck .dest-inline { color: var(--secondary-text-color); }
        .row-alert { display: inline-flex; flex: none; align-self: center; width: 16px; height: 16px; color: var(--error-color, #b3261e); }
        .row-alert svg { width: 100%; height: 100%; }
        .board td .row-alert { margin-right: 4px; vertical-align: -3px; }
        /* the table layout of the board: numbers right, the sort fixed */
        .board-next { padding: 10px 16px 4px; font-size: 13px; color: var(--secondary-text-color); }
        .board-next b { color: var(--primary-text-color); }
        .board-next .countdown { font-size: 13px; }
        .board-wrap { overflow-x: auto; container-type: inline-size; }
        .board { width: 100%; border-collapse: collapse; font-size: 13px; }
        .board th { text-align: left; font-size: 12px; font-weight: 600; color: var(--secondary-text-color); padding: 8px 12px 6px; }
        .board td { padding: 7px 12px; border-top: 1px solid var(--divider-color); white-space: nowrap; }
        /* narrow, every column hugs its content (width 1% + nowrap is the
           shrink-to-fit idiom) and the last one - the destination, or an
           empty cell - takes what is left. Wide, the columns share the
           card's width in proportion to what they hold: hugged, they sat
           in a clump on the left of a half-empty card */
        .board .fit { width: 1%; }
        @container (min-width: 560px) {
            /* spread, a column right-aligned leaves its time far from
               the one before it: every column reads from its left edge,
               and the departure hugs its time so the delay stays against it */
            .board:not(.jboard) .fit:not(.dep) { width: auto; }
            .board:not(.jboard) .num { text-align: left; }
        }
        .board th:first-child, .board td:first-child { padding-left: 16px; }
        .board th:last-child, .board td:last-child { padding-right: 16px; }
        .board .num { text-align: right; }
        /* a time followed by the place a run leaves from or ends at */
        .board .num.at { text-align: left; }
        .end-at { font-weight: 500; }
        .board td.dep .end-at { font-weight: 400; }
        /* a day said once, on a row of its own */
        .board tr.day-sep td { padding: 8px 12px 2px; border-top: none; }
        .board tr.row-sub { display: none; }
        .board tr.row-sub td { border-top: none; padding-top: 0; white-space: normal; font-size: 12px; color: var(--secondary-text-color); }
        .board tr.row-sub .sub-dest, .board tr.row-sub .sub-via { display: block; }
        .board tr.row-sub .via-t { display: inline; white-space: nowrap; }
        .board tr.row-sub b:not(.jbroken) { color: var(--primary-text-color); }
        .board tr.row-sub .jbroken, .sub.jbroken { white-space: normal; }
        /* the delay follows the time it moves */
        .board .dly { font-size: 11px; font-weight: 600; }
        .board .dly-c { padding-left: 0; }
        /* the schedule slot under the realtime time it moved from */
        .dep-stack { display: inline-flex; flex-direction: column; align-items: flex-start; line-height: 1.2; vertical-align: middle; }
        .dep-stack .sched-at { font-size: 11px; font-style: italic; font-weight: 400; color: var(--secondary-text-color); }
        .board .dest { display: inline-block; max-width: 12em; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
        .board td.dep { font-weight: 700; }
        .board td .rt-icon { margin-right: 4px; }
        .board .dur-ok { color: var(--gtfs2-ontime-color, #2e7d32); color: color-mix(in srgb, var(--gtfs2-ontime-color, #2e7d32) 75%, var(--primary-text-color, #212121)); }
        .board .st-late { color: var(--gtfs2-late-color, #e65100); color: color-mix(in srgb, var(--gtfs2-late-color, #e65100) 75%, var(--primary-text-color, #212121)); }
        .board .st-early { color: var(--gtfs2-early-color, #0369a1); color: color-mix(in srgb, var(--gtfs2-early-color, #0369a1) 70%, var(--primary-text-color, #212121)); }
        /* the journey timetable: the lines over their columns, the
           departure column kept in place when a long journey scrolls */
        .jboard td { font-variant-numeric: tabular-nums; }
        .jboard .stick { position: sticky; left: 0; z-index: 1; background: var(--card-background-color, #fff); }
        .jboard tr.legs th { padding-bottom: 3px; }
        .jboard th.leg { border-bottom: 2px solid var(--lc); }
        .jboard th, .jboard td { padding-left: 6px; padding-right: 6px; }
        /* a stop's head: its disc over its name, the name wrapping on two
           or three lines rather than widening the column */
        .jboard th .jnum { display: flex; width: 16px; height: 16px; font-size: 10px; margin-bottom: 3px; }
        .jboard .jcn { display: block; max-width: 6.5em; white-space: normal; font-size: 11px; line-height: 1.25; }
        /* the discs of a row of stop heads on one line, whatever the lines
           of their names; a wide card lets the names breathe */
        .jboard thead th { vertical-align: bottom; }
        @container (min-width: 560px) {
            .jboard .jcn { max-width: 10em; }
        }
        .jboard td.jw { color: var(--secondary-text-color); font-size: 12px; }
        /* A board in a sections column has no width to spare, and a single
           arrival crossing midnight is enough to spend it: that row alone
           carries a "tomorrow" chip, every column is sized on its widest
           cell, and the line badge ends up behind a scrollbar. Narrow, the
           padding gives its slack back to the columns rather than to the
           reader's mouse. Wide, nothing changes. */
        @container (max-width: 480px) {
            .board th { padding-left: 8px; padding-right: 8px; }
            .board td { padding-left: 8px; padding-right: 8px; }
            .board th:first-child, .board td:first-child { padding-left: 12px; }
            .board th:last-child, .board td:last-child { padding-right: 12px; }
            /* no sideways scrolling on a phone: the words give way - the
               destination and the stops on the way wrap, the times never.
               They wrap on their spaces, and a word too long for the column
               breaks inside itself; overflow-wrap: anywhere broke every word
               letter by letter, and - a letter being all the column then had
               to be - squeezed the stops on the way into a ribbon one
               character wide. Those stops are the only prose of the board,
               so narrow they leave their columns for a row of their own
               under the times, where they have the card's whole width: in
               a column of their own, beside seven others, they were a
               ribbon three letters wide. */
            .board:not(.jboard) td:last-child { white-space: normal; overflow-wrap: break-word; }
            .board:not(.jboard) td.dly-c { padding-right: 4px; }
        }
        /* The words leave their columns earlier than the padding shrinks: a
           side panel of 500 px still pushed the destination past the edge
           with the stops on the way beside it. Under 640 px they take the
           row under the times. */
        @container (max-width: 640px) {
            .board:not(.jboard) .vias, .board:not(.jboard) .dest-c, .board:not(.jboard) .note-c > * { display: none; }
            .board:not(.jboard) tr.row-sub { display: table-row; }
        }
        .info-strip { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--divider-color); }
        .info-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 8px; font-size: 11px; background: rgba(127,127,127,.12); color: var(--secondary-text-color); }
        .info-chip svg { flex: none; }
        .info-alert { background: rgba(230,81,0,.12); color: var(--gtfs2-late-color, #e65100); color: color-mix(in srgb, var(--gtfs2-late-color, #e65100) 75%, var(--primary-text-color, #212121)); }
        .empty { padding: 14px 16px; font-size: 13px; color: var(--secondary-text-color); }
        /* the resting note is written for a tooltip, where it follows the
           destination in lower case; standing alone on the board it is a
           sentence and starts like one */
        .empty.rest::first-letter { text-transform: uppercase; }
        .empty code { font-size: 12px; }
        .map-body { border-top: 0; container-type: inline-size; }
        .map-wrap { position: relative; background: var(--gtfs2-map-background, rgba(127,127,127,.1)); user-select: none; }
        /* the base map canvas fills the frame under the SVG, which keeps
           every pointer: MapLibre is not interactive, the card's gestures are */
        .map-gl { position: absolute; inset: 0; }
        .map-gl canvas { outline: none; }
        .map-wrap svg { position: relative; display: block; width: 100%; aspect-ratio: 2 / 1; touch-action: pan-y; cursor: grab; }
        .map-wrap svg:active { cursor: grabbing; }
        .map-wrap svg.far .bus, .map-wrap svg.far .stop { pointer-events: none; }
        @container (max-width: 380px) { .map-wrap svg { aspect-ratio: 4 / 3; } }
        .bus { cursor: pointer; transition: transform .7s ease-out; }
        .bus .hd { transition: transform .7s ease-out; transform-origin: 0 0; }
        .bus.dim { opacity: 0.35; }
        .bus:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .stop { cursor: pointer; }
        .stop .dot { transition: transform .12s; transform-box: fill-box; transform-origin: center; }
        .stop:hover .dot { transform: scale(1.35); }
        .map-tip { position: absolute; transform: translate(-50%, -100%); pointer-events: none; display: flex; align-items: center; gap: 6px; background: var(--card-background-color, #fff); color: var(--primary-text-color); font-size: 11px; padding: 3px 8px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.3); white-space: nowrap; }
        .tip-links { display: inline-flex; gap: 3px; }
        .tip-note { color: var(--secondary-text-color); }
        /* the alert's own sentence: a full sentence, so the tooltip stops
           being one line and wraps like a note */
        .tip-alert { color: var(--gtfs2-late-color, #e65100); color: color-mix(in srgb, var(--gtfs2-late-color, #e65100) 75%, var(--primary-text-color, #212121)); white-space: normal; max-width: 16em; }
        /* a class, not :has(.tip-alert): the tip measures itself the moment
           it opens, to know whether it fits over the stop, and Chrome had
           not applied the :has() rule by then - it read the height of a tip
           as wide as its words, then drew the wrapped one, taller, over the
           board above */
        .map-tip.tip-wrap { white-space: normal; max-width: 19em; align-items: flex-start; }
        /* under the stop when there is no room over it */
        .map-tip.below { transform: translate(-50%, 0); }
        /* the class sets display, which beats the browser's own rule for
           [hidden]: without this the tip never closed, since closing it is
           setting that attribute. It also gives the height read at the next
           opening a layout of its own, instead of the one left behind */
        .map-tip[hidden] { display: none; }
        .map-btn { position: absolute; top: 8px; left: 8px; border: none; border-radius: 12px; min-height: 36px; padding: 7px 12px; font-size: 12px; font-weight: 500; font-family: inherit; background: var(--card-background-color, #fff); color: var(--primary-text-color); cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
        .map-ctrl { position: absolute; top: 8px; right: 8px; display: flex; flex-direction: column; gap: 6px; }
        .map-ctrl-btn.map-lock.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        /* the class sets display, which beats the browser's rule for
           [hidden]: the padlock and recenter showed as empty buttons */
        .map-ctrl-btn[hidden] { display: none; }
        .map-ctrl-btn { width: 36px; height: 36px; border: none; border-radius: 9px; background: var(--card-background-color, #fff); color: var(--primary-text-color); font-size: 18px; font-weight: 600; font-family: inherit; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.2); display: flex; align-items: center; justify-content: center; padding: 0; }
        .map-foot { position: absolute; left: 8px; right: 8px; bottom: 6px; display: flex; flex-wrap: wrap;
            align-items: flex-end; justify-content: space-between; gap: 4px 8px; pointer-events: none; }
        .map-scale { display: flex; align-items: center; gap: 5px; font-size: 9px; color: var(--secondary-text-color); background: color-mix(in srgb, var(--card-background-color, #fff) 75%, transparent); padding: 1px 5px; border-radius: 6px; pointer-events: none; }
        .map-scale i { display: block; height: 4px; border: 1px solid currentColor; border-top: none; box-sizing: border-box; }
        .map-attrib { margin-left: auto; font-size: 9px; color: var(--secondary-text-color); background: color-mix(in srgb, var(--card-background-color, #fff) 75%, transparent); padding: 1px 5px; border-radius: 6px; }
        .map-hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,.65); color: #fff; font-size: 12px; padding: 6px 12px; border-radius: 14px; pointer-events: none; opacity: 0; transition: opacity .25s; white-space: nowrap; }
        .map-hint.show { opacity: 1; }
        @media (prefers-reduced-motion: reduce) { .live-dot::after { animation: none; opacity: 0; } .stop .dot, .map-hint, .bus, .bus .hd { transition: none; } }
        .map-pop { position: absolute; transform: translate(-50%, -100%); min-width: 150px; max-width: min(230px, calc(100% - 16px)); background: var(--card-background-color, #fff); color: var(--primary-text-color); border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.35); padding: 8px 10px; font-size: 12px; }
        .pop-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 13px; }
        .pop-dest { color: var(--primary-text-color); font-weight: 500; line-height: 1.5; }
        .pop-row { color: var(--secondary-text-color); line-height: 1.5; }
        .pop-row::first-letter { text-transform: uppercase; }
        .pop-close { border: none; background: none; color: var(--secondary-text-color); cursor: pointer; font-size: 13px; font-family: inherit; min-width: 32px; min-height: 32px; padding: 0; margin: -6px -8px -6px 0; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; }
        .pop-close:hover { background: rgba(127,127,127,.15); }
        .footer { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px 10px 16px; border-top: 1px solid var(--divider-color); font-size: 11px; color: var(--secondary-text-color); }
        `;
    }
}

customElements.define("gtfs2-stop-card", Gtfs2StopCard);

/* ── VISUAL EDITOR ──────────────────────────────────────────────────────── */

class Gtfs2StopCardEditor extends HTMLElement {


    setConfig(config) {
        this._config = { ...(config || {}) };
        // the stops the way the card reads them: one local-stop sensor each,
        // bare id or {entity, label?, positions_url?}
        this._stops = cardEntries(this._config);
        this._dirty = !Array.isArray(this._config.stops) && !!this._config.entity;
        this._render();
    }

    // HA hands the editor a new hass on every state change of the whole
    // house. Only what the editor shows is watched: the language and which
    // stop sensors exist.
    set hass(hass) {
        const sig = this._hassSig(hass);
        this._hass = hass;
        if (sig === this._lastHassSig) return;
        this._lastHassSig = sig;
        this._render();
    }

    _hassSig(hass) {
        const st = hass?.states || {};
        const ids = Object.keys(st).filter((id) => isStopSensor(id, st[id]));
        return [resolveLang(hass), ...ids.sort()].join("|");
    }

    // the language files arrive while the editor is open: the first render
    // was held back for them, the later ones redraw labelled
    _langArrived() {
        this._render();
    }

    // the sensors the picker offers: gtfs2's local stops alone - and those
    // the card already names, known or not, so a picked one never vanishes
    // from its own field
    _stopEntities() {
        const st = this._hass?.states || {};
        return [...new Set([...Object.keys(st).filter((id) => isStopSensor(id, st[id])), ...this._allEntities()])];
    }

    // The settings in blocks: the whole card, then its stops, then each
    // pane, its switch first and its options after it, shown only while the
    // pane is
    _formSchema(id, L) {
        const c = this._config;
        if (id === "gen") return [
            { name: "title", selector: { text: {} } },
            { name: "mode_icons", selector: { boolean: {} } },
        ];
        if (id === "dep") return [
            { name: "show_departures", selector: { boolean: {} } },
            ...(c.show_departures === false ? [] : [
                { name: "max_departures", selector: { number: { min: 1, max: 20, mode: "box" } } },
                { name: "group_by", selector: { select: { mode: "dropdown", options: [
                    { value: "stop", label: "stop" }, { value: "none", label: "none" }] } } },
            ]),
        ];
        return [
            { name: "show_map", selector: { boolean: {} } },
            ...(c.show_map === false ? [] : [
                { name: "map_style", selector: { select: { mode: "dropdown", custom_value: true, options: [
                    { value: "auto", label: "auto" }, { value: "light", label: "light" }, { value: "dark", label: "dark" }] } } },
                { name: "map_aspect", selector: { text: {} } },
                { name: "stop_color", selector: { text: {} } },
                { name: "refresh", selector: { number: { min: 15, max: 600, mode: "box", unit_of_measurement: "s" } } },
                { name: "latitude", selector: { text: {} } },
                { name: "longitude", selector: { text: {} } },
            ]),
        ];
    }

    // what each block's fields read from the config, defaults filled in
    _formData(id) {
        const c = this._config;
        if (id === "gen") return {
            title: c.title ?? "",
            mode_icons: c.mode_icons !== false,
        };
        if (id === "dep") return {
            show_departures: c.show_departures !== false,
            max_departures: c.max_departures ?? DEFAULTS.max_departures,
            group_by: c.group_by ?? DEFAULTS.group_by,
        };
        return {
            show_map: c.show_map !== false,
            map_style: c.map_style ?? "auto",
            map_aspect: c.map_aspect ?? "",
            stop_color: c.stop_color ?? "",
            refresh: c.refresh ?? DEFAULTS.refresh,
            latitude: c.latitude != null ? String(c.latitude) : "",
            longitude: c.longitude != null ? String(c.longitude) : "",
        };
    }

    // what the sensor tells the card about its stop, shown so the user can
    // see why a field can be left empty
    _derivedText(entity) {
        const at = this._hass?.states?.[entity]?.attributes || {};
        const name = at.stop_name || (at.next_departures_lines || []).find((d) => d?.stop_name)?.stop_name;
        const lat = at.latitude, lon = at.longitude;
        return [name, lat != null && lon != null ? `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}` : ""].filter(Boolean).join(" \u00b7 ");
    }

    // a labelled <details> block, reused for every collapsible section
    _section(label) {
        const d = document.createElement("details");
        d.style.cssText = "margin-top: 12px; border: 1px solid var(--divider-color); border-radius: 10px; padding: 8px 12px;";
        const sum = document.createElement("summary");
        sum.textContent = label;
        sum.style.cssText = "cursor: pointer; font-weight: 500; color: var(--primary-text-color); padding: 4px 0;";
        d.appendChild(sum);
        return d;
    }

    _stopSchema() {
        return [
            // an entity selector: Home Assistant renders its own picker from
            // it (the test harness draws a plain field)
            { name: "entity", selector: { entity: { multiple: false, filter: { domain: "sensor" } } } },
            { name: "label", selector: { text: {} } },
            { name: "positions_url", selector: { text: {} } },
        ];
    }

    _render() {
        if (!this._hass || !this._config) return;
        const lang = resolveLang(this._hass);
        // like the card: nothing is drawn until the strings are in, or the
        // form would come up labelled with its own field names
        if (!LANG[lang]) { LANG_WAITING.add(this); loadLang(lang); return; }
        if (!this._built) {
            this.innerHTML = "";
            this._forms = {};
            const block = (id, open) => {
                const sec = this._section("");
                sec.open = open;
                const form = document.createElement("ha-form");
                form.addEventListener("value-changed", (ev) => this._globalChanged(ev));
                sec.appendChild(form);
                this._forms[id] = { sec, form, data: null, schema: null };
                return sec;
            };
            this.appendChild(block("gen", true));

            // the stops, the card's content: one row per sensor, open
            this._sSec = this._section("");
            this._sSec.open = true;
            this._sBox = document.createElement("div");
            this._sSec.appendChild(this._sBox);
            this.appendChild(this._sSec);

            this.appendChild(block("dep", false));
            this.appendChild(block("map", false));

            this._built = true;
            this._sKey = null;
        }
        const L = editorLabels(lang);
        this._sSec.querySelector("summary").textContent = L.sec_stops ?? "Stops";
        const titles = { gen: L.sec_general, dep: L.sec_departures, map: L.sec_map };
        for (const [id, f] of Object.entries(this._forms)) {
            f.sec.querySelector("summary").textContent = titles[id];
            f.form.hass = this._hass;
            f.form.computeLabel = (x) => L[x.name] ?? x.name;
            // schema and data pushed only when they changed: reassigning
            // them re-renders ha-form, and can steal the caret while typing
            const schema = this._formSchema(id, L);
            const sjson = JSON.stringify(schema);
            if (sjson !== f.schema) { f.schema = sjson; f.form.schema = schema; }
            const data = this._formData(id);
            const djson = JSON.stringify(data);
            if (djson !== f.data) { f.data = djson; f.form.data = data; }
        }
        if (this._stopsKey() !== this._sKey) this._buildStops();
        else (this._sForms || []).forEach((f) => { f.hass = this._hass; });
    }

    _stopsKey() {
        return this._stops.map((s) => [s.entity, s.label ?? "", s.positions_url ?? ""].join("#")).join("|")
            + "|" + this._stopEntities().length;
    }

    _buildStops() {
        const box = this._sBox;
        box.innerHTML = "";
        this._sForms = [];
        const L = editorLabels(resolveLang(this._hass));
        this._stops.forEach((s, i) => {
            const card = document.createElement("details");
            card.style.cssText = "border: 1px solid var(--divider-color); border-radius: 8px; padding: 6px 10px; margin-top: 6px;";
            const sum = document.createElement("summary");
            const title = document.createElement("span");
            title.textContent = s.entity || L.t_add || "stop";
            title.style.cssText = "font-weight: 500;";
            sum.appendChild(title);
            const rm = document.createElement("button");
            rm.type = "button";
            rm.textContent = "\u00d7";
            rm.setAttribute("aria-label", "remove");
            rm.style.cssText = "float: right; border: none; background: none; cursor: pointer; color: var(--secondary-text-color);";
            rm.addEventListener("click", (ev) => {
                ev.preventDefault();
                this._stops.splice(i, 1);
                this._dirty = true;
                this._emit();
                this._render();
            });
            sum.appendChild(rm);
            card.appendChild(sum);
            const derived = s.entity ? this._derivedText(s.entity) : "";
            if (derived) {
                const sub = document.createElement("div");
                sub.style.cssText = "color: var(--secondary-text-color); font-size: 12px; margin: 2px 0 6px;";
                sub.textContent = `${L.derived ?? "derived"}: ${derived}`;
                card.appendChild(sub);
            }
            const form = document.createElement("ha-form");
            form.hass = this._hass;
            form.schema = this._stopSchema();
            form.computeLabel = (f) => L["l_" + f.name] ?? f.name;
            form.data = { entity: s.entity ?? "", label: s.label ?? "", positions_url: s.positions_url ?? "" };
            form.addEventListener("value-changed", (ev) => {
                ev.stopPropagation();
                const st = this._stops[i];
                if (!st) return;
                Object.assign(st, ev.detail.value || {});
                this._dirty = true;
                this._emit();
            });
            this._sForms.push(form);
            card.appendChild(form);
            box.appendChild(card);
        });
        const add = document.createElement("button");
        add.type = "button";
        add.textContent = `+ ${L.s_add ?? "+"}`;
        add.style.marginTop = "10px";
        add.addEventListener("click", () => {
            this._stops.push({ entity: "" });
            this._dirty = true;
            this._emit();
            this._render();
        });
        box.appendChild(add);
        this._sKey = this._stopsKey();
    }

    // every stop of the card, in the order given
    _allEntities() {
        return (this._stops || []).map((s) => s.entity).filter(Boolean);
    }

    _globalChanged(ev) {
        ev.stopPropagation();
        const v = ev.detail.value || {};
        const c = this._config;
        const has = (k) => Object.prototype.hasOwnProperty.call(v, k);
        // title: an empty string is meaningful (hidden title line)
        if (has("title")) { if (v.title === undefined) delete c.title; else c.title = v.title; }
        const assign = (key, autoDeletes) => {
            if (!has(key)) return;
            const val = v[key];
            // a form sends all its fields: a default the YAML never named
            // stays unwritten
            if (c[key] === undefined && val === DEFAULTS[key]) return;
            if (val === undefined || val === "" || val === null || (autoDeletes && val === "auto")) delete c[key];
            else c[key] = val;
        };
        assign("max_departures", false);
        assign("group_by", true);
        assign("refresh", false);
        assign("map_style", true);
        assign("map_aspect", false);
        assign("stop_color", false);
        for (const k of ["latitude", "longitude"]) {
            if (!has(k)) continue;
            const num = Number(v[k]);
            if (v[k] === "" || v[k] == null || !Number.isFinite(num)) delete c[k];
            else c[k] = num;
        }
        for (const k of ["mode_icons", "show_departures", "show_map"]) {
            if (!has(k)) continue;
            if (v[k] === false) c[k] = false; else delete c[k];
        }
        this._emit();
        // a pane switched on or off shows or hides its options
        if (has("show_departures") || has("show_map")) this._render();
    }

    _emit() {
        const config = { ...this._config };
        const keep = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
        if (this._dirty) {
            // one list, stops:, a local-stop sensor each: its bare id, or an
            // object with its settings
            const stops = this._stops.map((s) => {
                const o = s.entity ? { entity: s.entity } : {};
                for (const k of LINE_KEYS) if (keep(s[k])) o[k] = s[k];
                if (!Object.keys(o).length) return null;
                return Object.keys(o).length === 1 && o.entity ? o.entity : o;
            }).filter(Boolean);
            if (stops.length) config.stops = stops;
            else delete config.stops;
            // the single-sensor form, folded into the list
            for (const k of ["entity", "positions_url", "label"]) delete config[k];
            this._dirty = false;
        }
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
    }
}

customElements.define("gtfs2-stop-card-editor", Gtfs2StopCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
    type: "gtfs2-stop-card",
    name: "GTFS2 Stop Card",
    description: "Departures board and live vehicle map for gtfs2 local stops · Départs et carte temps réel des arrêts gtfs2.",
    documentationURL: "https://github.com/Pulpyyyy/gtfs2-live-card",
    preview: false,
    // Home Assistant 2026.6 and up: what the card picker offers once an
    // entity is chosen. A local-stop sensor makes a card of one stop -
    // anything else is not ours.
    getEntitySuggestion: (hass, entityId) => (
        isStopSensor(entityId, hass?.states?.[entityId])
            ? { config: { type: "custom:gtfs2-stop-card", stops: [entityId] } }
            : null
    ),
});
