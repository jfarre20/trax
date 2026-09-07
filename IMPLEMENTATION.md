# Implementation Plan — TRAX

An EA Trax-inspired "Now Playing" overlay for OBS, driven by Windows media metadata.

## Decisions

**Stack: Node + Python/PowerShell SMTC poller.** `prompt.txt` prefers C#/.NET 8, but
`../xmb/xmb-overlay` already has a working, proven SMTC poller on this machine
(`nowplaying.py` via `winsdk`, with a `nowplaying.ps1` fallback for when Python is
absent). Reusing it removes the .NET SDK dependency and gets the project running
immediately. The poller is a process boundary that prints JSON lines to stdout, so
swapping in a C# helper later means matching that contract — nothing else changes.

**Scope: overlay + minimal config.** Full overlay and backend, plus a config page
covering the settings that materially change the look. Not building: tray icon,
startup-task installer, or the standalone debug panel. Test media controls live on
the config page instead, since that page already exists and already talks to the
server.

## Components

```
trax/
├── package.json
├── server.js            WS + REST + static, port 8787, artwork cache
├── media-bridge.js      spawns poller, detects real track changes, broadcasts
├── nowplaying.py        SMTC poller (winsdk) — preferred, has album art
├── nowplaying.ps1       SMTC poller fallback — no album art
├── config-store.js      load/validate/save config.json
├── config.default.json  shipped defaults
├── overlay.html/.css/.js
├── config.html/.js      config UI with live preview + test controls
├── preview.html         standalone demo, runs with no backend
├── start.js / start.bat one-command launcher
└── README.md
```

### Poller contract (`nowplaying.py` → stdout, one JSON object per line)

```json
{
  "sessions": [{ "id": "Spotify.exe", "app": "Spotify", "status": "playing" }],
  "session": { "id": "Spotify.exe", "app": "Spotify" },
  "title": "", "artist": "", "album": "",
  "status": "playing|paused|stopped",
  "position": 42.5, "duration": 215.2,
  "art": "data:image/jpeg;base64,..."
}
```

`art` is emitted only on track change (it is 10–100 KB); the poller caches it and
re-attaches it to every update for the same track so a late-connecting overlay
still gets it. Poll interval ~1s for timeline freshness; the overlay interpolates
progress locally between updates so the bar stays smooth without a fast poll.

### Backend responsibilities

- `media-bridge.js` owns **track-change detection**. It compares a stable key
  (`sessionId|title|artist`) and only emits `trackChanged` when that key actually
  changes — never on a timeline tick. This is what stops the animation replaying
  during ordinary progress updates.
- On track change it POSTs the artwork to `/api/artwork`, gets a content hash back,
  and broadcasts `artworkUrl: /api/artwork/<hash>` rather than inlining base64 in
  every message.
- `server.js` hosts overlay + config, relays WS messages, caches artwork by hash
  with a bounded LRU, and binds `127.0.0.1` by default.

### Message types over WS

`state` (initial), `trackChanged`, `playbackChanged`, `timeline`, `configChanged`,
`show`, `hide`, `test`.

### Overlay animation sequence

Staged CSS animations on a single `.enter` / `.exit` class, each element carrying
its own `animation-delay` scaled by a `--spd` custom property so config can retune
the whole sequence with one number:

1. Debounce metadata 300 ms, preload artwork.
2. Equalizer indicator slides in.
3. Angled panel wipes outward (`clip-path`), card shakes on the slam.
4. Artwork reveals under a `clip-path` mask.
5. Title wipes left→right; artist follows.
6. Progress bar fills in.
7. Hold for the configured duration.
8. Text retracts, panel collapses, indicator fades.

Full reveal lands around 700 ms by default. Mini mode collapses to a compact strip
after the hold instead of leaving entirely.

## Verification

- `GET /api/health`, `GET /api/now-playing`, `GET /overlay`, `GET /config` all 200.
- WS accepts a connection and receives current state on connect.
- Simulated track change via `POST /api/test` drives the full animation.
- Overlay body background is transparent (no opaque paint outside the card).
- Repeated `timeline` messages do not retrigger the animation.
- Overlay reconnects with backoff after the backend restarts, showing nothing while
  disconnected.
