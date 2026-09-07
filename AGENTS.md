# Working on TRAX

Notes for anyone (human or agent) picking this up. Read this before building or
changing the overlay.

## Two ways the same overlay runs

There is one set of overlay files and two hosts for them.

| | web version (repo root) | OBS plugin (`obs-plugin/`) |
|---|---|---|
| Reads Windows media | `nowplaying.py`, `nowplaying.ps1` | `src/smtc.rs` (`windows` crate) |
| Track-change logic | `track-change.js` | `src/detector.rs` (a port, same tests) |
| State + messages | `media-bridge.js` | `src/bridge.rs` |
| Transport to page | WebSocket via `server.js` | obs-browser `javascript_event` proc |
| Config | `config.html` + `config.json` | OBS source properties |
| Needs | Node + Python | nothing but OBS |

`overlay.html`, `overlay.css` and `overlay.js` are shared verbatim. The plugin
copies them into its data folder at install time. **Any change to them affects
both hosts.**

`overlay.js` decides which host it is in: served over http from a real host it
opens the WebSocket, otherwise it listens for a `trax` DOM event. Both paths are
always wired up, so don't "simplify" one away.

## Build and install the plugin

Everything goes through one script. From `obs-plugin/`:

```powershell
.\build.ps1                  # build the release DLL
.\build.ps1 install          # build, then install (or update) into OBS
.\build.ps1 install -Elevate # same, re-launching elevated (see below)
.\build.ps1 status           # what is built vs installed
.\build.ps1 uninstall        # remove it (uses setup.exe's uninstaller if present)
.\build.ps1 package          # zip + setup.exe into obs-plugin/dist
```

Add `-DebugBuild` for the debug profile, `-Force` to let it close OBS, `-Quiet`
for less output. Note it is `-DebugBuild`, not `-Debug`: PowerShell reserves
that name.

Tests: `cargo test` in `obs-plugin/`, and `node test/run.js` at the root. CI
(`.github/workflows/plugin.yml`) runs both, then packages and uploads the zip
and installer; a `v*` tag also attaches them to a release.

## Things that will waste your time if you don't know them

**Install path is ProgramData, not AppData.** OBS on Windows builds its
third-party module path from `GetProgramDataPath` (`AddExtraModulePaths` in
`UI/window-basic-main.cpp`), so it scans
`%PROGRAMDATA%\obs-studio\plugins\<name>\bin\64bit\<name>.dll`. The per-user
AppData plugin folder is Linux and macOS only. A DLL put there is never scanned
and **nothing is logged** — it just silently doesn't exist.

**Installing needs elevation, sometimes.** Files written by `setup.exe` grant
plain users read-only, so replacing them needs an elevated shell even though
creating the folder the first time did not. `build.ps1` detects this and says
so; `-Elevate` re-launches via UAC.

**CEF caches the overlay files.** After editing `overlay.css`/`.js`, a browser
source reload is not enough — CEF serves the cached copy, and you will spend an
hour concluding your fix "didn't work". Restart OBS.

**obs-browser gives a local file two different URLs.** Depending on whether it
was built with `ENABLE_LOCAL_FILE_URL_SCHEME`, the page is either
`file:///C:/…` or `http://absolute/C:/…`. `overlay.js` treats both as
plugin-hosted. Checking only for `file:` leaves the page opening
`ws://absolute/ws`, which fails silently and renders nothing.

**No `backdrop-filter` in the overlay, deliberately.** A browser source cannot
see the OBS scene behind it, so the only thing a backdrop filter had to blur was
the card's own artwork — and because a blur samples pixels from outside its own
box, it dragged the leading blade into a wide smear. The `--blur` variable and
the `blur` config key still exist so saved configs stay valid, but nothing reads
them. Don't "restore" it.

**SMTC position is not a clock.** It is whatever the app last pushed via
`UpdateTimelineProperties`; browsers push once and stop. `LastUpdatedTime` is
what makes a mid-song start correct. A stalled position must emit nothing rather
than re-anchor the overlay to a stale value. Both behaviours are covered by
tests in `detector.rs` and `test/run.js` — if you change timeline handling, run
them.

**Ordinary progress must never look like a track change.** That is the whole
point of the detector. There are explicit regression tests; keep them passing.

## Verifying a visual change

Chrome is not a valid stand-in for OBS. The engine OBS ships is much older, and
at least one rendering bug here reproduces only there. Two tools:

```powershell
node test/shoot.js <url> out.png [waitMs]        # real Chrome over CDP
node test/obs-shot.js "<source name>" out.png 760 220   # the actual OBS source, 1:1
```

`test/obs-shot.js` asks OBS itself for the frame through obs-websocket, so there
is no preview scaling — necessary for judging a few-pixel artifact. It reads the
websocket password from obs-websocket's own config file.

To test the media pipeline with no media app and no sound, `obs-plugin` has an
example that publishes its own Windows media session:

```powershell
cd obs-plugin
cargo run --example publish -- 60    # publishes a fake track, then reads it back
cargo run --example poll -- 10       # just reads whatever is really playing
```

`publish` announces a track at 42 s of 240 s; the poller should report ~43 s a
second later, which is the `LastUpdatedTime` correction working. Note that
publishing a session makes Windows show its own media flyout — that popup is
the OS, not the overlay.

## Style

`karpathy.md` rules apply: no speculative abstraction, no unrequested features,
surgical diffs, match the surrounding style. Comments explain *why*, especially
where the code works around a platform quirk — most of the comments in
`smtc.rs`, `detector.rs` and `overlay.css` exist because the obvious
implementation was wrong for a reason that is invisible from the code.
