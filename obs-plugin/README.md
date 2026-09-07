# TRAX as an OBS plugin

The same overlay, without Node, Python, or a server. `trax.dll` registers a
**TRAX Now Playing** source in OBS. Add it to a scene and you are done.

```
OBS process
  trax.dll ── worker thread ── Windows SMTC (windows crate)
     │              │
     │              └── detector + bridge ── JSON messages ── outbox
     │
     └── "TRAX Now Playing" source
            └── private browser_source child ── data/overlay.html
                     ▲
                     └── javascript_event("trax", json)  →  window CustomEvent
```

Rendering is untouched: `overlay.html/.css/.js` from the repo root are copied
into the plugin's data folder and loaded as a local page. Instead of a
WebSocket, the plugin calls obs-browser's `javascript_event` proc handler,
which dispatches a DOM `CustomEvent` on the page. `overlay.js` listens for that
in both hosting modes and only starts the WebSocket when it is actually being
served by `server.js`.

Settings live in the source's Properties dialog (Size, Timing, Content, Look,
Exit, Media source, Audio, Test). Same keys as `config.json` in the web version.

## The source is card-sized, not canvas-sized

The source defaults to 760x220 — roughly the card plus room for its glows and
the badge's drop — and the card is pinned to the top-left inside it. So it gets
a tight bounding box you drag, scale and align with OBS's own transform, like
any other source.

That is why the overlay's own anchor and offset settings are not exposed here:
they would fight the source transform. Raise **Source width** if a very long
title or a larger **Scale** gets clipped.

## Audio-reactive equalizer

Turn on **Drive the bars from audio** and pick a mixer input under **Audio
source**. The plugin attaches a libobs volume meter to that input and feeds the
level straight to the bars, so there is no obs-websocket connection, no
password, and nothing to configure outside the dialog. Leave the source blank
to follow the first audio source OBS reports.

It is a level meter, not a spectrum: libobs gives magnitude and peak per
channel, with no frequency breakdown. The per-bar lag and weighting in
`overlay.js` are what make it read as an equalizer. The floor is -50 dB, the
same as the web version's `obs-bridge.js`, so the feel matches. Pick a single
input rather than the whole mix if you don't want alerts and chat moving the
bars.

Verified in OBS at 1:1: bars sit at their 4 px floor in silence and run to
20-31 px on a test tone, each bar leading by a different amount.

## Install a release

Grab either file from the latest run of the **OBS plugin** workflow (or a
release, if the version was tagged):

- `trax-<version>-setup.exe` — installer, with an Add/Remove Programs entry.
- `trax-<version>-windows-x64.zip` — extract the `trax` folder into
  `%PROGRAMDATA%\obs-studio\plugins\`.

Close OBS first either way, then start it and add a **TRAX Now Playing** source.

## Build from source

Requirements: Rust (MSVC toolchain) and OBS Studio 30.x on Windows. No OBS SDK
is needed — the plugin resolves `obs.dll` exports at runtime. Inno Setup is only
needed to build the installer (`winget install JRSoftware.InnoSetup`).

```powershell
cd obs-plugin
.\build.ps1                  # build the release DLL
.\build.ps1 install          # build, then install (or update) into OBS
.\build.ps1 status           # what is built vs installed
.\build.ps1 uninstall        # remove it again
.\build.ps1 package          # zip + setup.exe into dist\
```

Add `-DebugBuild` for the debug profile, `-Force` to let it close OBS for you,
`-Elevate` to re-launch under UAC. (It is `-DebugBuild` because PowerShell
reserves `-Debug`.)

**ProgramData, not AppData.** On Windows OBS builds its third-party module
search path from `GetProgramDataPath` (`AddExtraModulePaths` in
`UI/window-basic-main.cpp`), so it scans
`%PROGRAMDATA%\obs-studio\plugins\<name>\bin\64bit\<name>.dll`. The per-user
AppData plugin folder is Linux and macOS only; a DLL placed there is silently
never scanned. For a dev loop that avoids ProgramData entirely, set
`OBS_PLUGINS_PATH` and `OBS_PLUGINS_DATA_PATH` before launching OBS.

Replacing files that `setup.exe` wrote needs an elevated shell, because they
grant plain users read-only. `build.ps1` says so plainly when it hits that.

**ProgramData, not AppData.** On Windows OBS builds its third-party module
search path from `GetProgramDataPath` (`AddExtraModulePaths` in
`UI/window-basic-main.cpp`), so it scans
`%PROGRAMDATA%\obs-studio\plugins\<name>\bin\64bit\<name>.dll`. The per-user
AppData plugin folder is Linux and macOS only; a DLL placed there is silently
never scanned. For a dev loop without writing to ProgramData, set
`OBS_PLUGINS_PATH` and `OBS_PLUGINS_DATA_PATH` before launching OBS.

Confirm it loaded by looking for `[trax]` in the OBS log:

```
[trax] plugin 0.1.0 loading (OBS 30.2.2)
[trax] browser child created for …\data\overlay.html (1920x1080)
[trax] media poller started
[trax] overlay events are reaching the page
[trax] playing: Snoop Dogg - Riders On The Storm [art]
```

## Tests

```powershell
cargo test
```

Covers the detector (including the regression that ordinary progress must never
look like a track change), the bridge's position interpolation, and the config
plumbing.

Two examples exercise the real Windows media APIs, which unit tests cannot:

```powershell
cargo run --example poll          # read whatever is playing right now
cargo run --example publish       # publish a synthetic session, then read it back
```

`publish` is the useful one: it registers its own SMTC session from a hidden
window, so the whole read path can be checked with no media app running and no
audio. It publishes a track at 42 s of 240 s and the poller should report ~43 s
one second later, which is the `LastUpdatedTime` correction working.

## Layout

| file | job |
|------|-----|
| `build.ps1` | build, install, update, uninstall, package |
| `installer/trax.iss` | Inno Setup script, driven by `build.ps1 package` |
| `src/ffi.rs` | hand-declared libobs bindings, `GetProcAddress` from `obs.dll` |
| `src/smtc.rs` | SMTC poller, port of `nowplaying.py` (incl. `LastUpdatedTime` correction) |
| `src/detector.rs` | track-change detection, port of `track-change.js` with its tests |
| `src/bridge.rs` | sample → overlay messages, port of the state half of `media-bridge.js` |
| `src/config.rs` | OBS properties ↔ overlay config JSON |
| `src/source.rs` | the source: browser child, worker thread, event dispatch |

## Gotchas worth knowing

**obs-browser gives a local file two different URLs.** Depending on whether it
was built with `ENABLE_LOCAL_FILE_URL_SCHEME`, the page is either a real
`file:///C:/…` URL or `http://absolute/C:/…` served by a registered scheme
handler. `overlay.js` treats both as plugin-hosted; checking only for `file:`
leaves the page trying to open `ws://absolute/ws`, which fails silently and
renders nothing.

**Struct layouts are pinned to 30.2.2 headers.** `obs_source_info` has been
append-only for years so 29–31 should work, but only 30.2.2 has been tested.

**CEF caches the overlay files.** After editing `overlay.css` or `overlay.js`,
reloading the browser source is not enough; restart OBS or you will be looking
at the cached copy.

## Not ported

- **Config web page / live preview.** Replaced by OBS properties.
- **Custom badge image** (`logoUrl`). Would need a path property and a copy
  placed next to `overlay.html`.
