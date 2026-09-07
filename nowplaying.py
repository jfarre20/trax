# Reads Windows "now playing" media info (SMTC — the same source the volume OSD
# uses) and prints one JSON line per poll on stdout. Consumed by media-bridge.js.
#
# Requires: pip install winsdk
#
# Album art is only read when the track changes (it is 10-100 KB) and then cached
# so every subsequent update for the same track still carries it — an overlay that
# connects mid-song gets the art without waiting for the next track.

import asyncio
import base64
import json
import sys
from datetime import datetime, timezone

from winsdk.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
)
from winsdk.windows.storage.streams import Buffer, DataReader, InputStreamOptions

MAX_ART_BYTES = 5_000_000
POLL_SECONDS = 1.0

# SMTC reports playback status as an enum; map to the strings the overlay uses.
STATUS_NAMES = {
    0: "closed",
    1: "opened",
    2: "changing",
    3: "stopped",
    4: "playing",
    5: "paused",
}


def read_config():
    """Selection prefs are passed in as a single JSON argument by media-bridge.js."""
    if len(sys.argv) > 1:
        try:
            return json.loads(sys.argv[1])
        except (ValueError, TypeError):
            pass
    return {}


def app_label(session):
    """AppUserModelId is what SMTC gives us — e.g. "Spotify.exe", or a long
    "...!App" package id for Store apps. Trim it into something displayable."""
    raw = session.source_app_user_model_id or ""
    label = raw
    if "!" in label:
        label = label.split("!")[0]
    if "_" in label and "." in label:
        # Store package family name: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0"
        label = label.split("_")[0]
        if "." in label:
            label = label.split(".")[-1]
    if label.lower().endswith(".exe"):
        label = label[:-4]
    return label or raw


async def read_thumbnail(props):
    ref = props.thumbnail
    if not ref:
        return ""
    # open_read_async gives a stream we must drain ourselves; there is no
    # convenience "get bytes" on the WinRT reference.
    stream = await ref.open_read_async()
    try:
        buf = Buffer(MAX_ART_BYTES)
        await stream.read_async(buf, buf.capacity, InputStreamOptions.READ_AHEAD)
        reader = DataReader.from_buffer(buf)
        data = bytearray(buf.length)
        reader.read_bytes(data)
        mime = stream.content_type or "image/jpeg"
        if not mime.startswith("image/"):
            mime = "image/jpeg"
        return f"data:{mime};base64," + base64.b64encode(bytes(data)).decode()
    finally:
        stream.close()


def timeline_of(session, playing):
    """Read position and duration.

    Three things to know about SMTC timeline properties, all observed live:

    1. Position is NOT a live clock. It is whatever the app last pushed via
       UpdateTimelineProperties. A Brave session was seen holding position
       0.016 for 30+ s of audible playback.

    2. But LastUpdatedTime tells you WHEN it pushed that value, so the real
       position is `position + (now - last_updated)` while playing. This is how
       the Windows volume OSD stays accurate, and it is the only way to get a
       correct position when joining mid-song — without it, anything that starts
       up partway through a track reads the value from track start and is behind
       by however long the track had been playing.

       While paused, position is already the frozen paused value, so no
       correction applies.

    3. Duration is reliable when present, but which field carries it varies.
       end_time is the usual one; some apps leave it zero and populate
       max_seek_time instead, so fall back to that before giving up.

    Returns (position, duration); either may be 0.0, and a zero duration tells
    the overlay to hide the progress bar.
    """
    try:
        tl = session.get_timeline_properties()
        # WinRT TimeSpan surfaces as datetime.timedelta in winsdk.
        start = tl.start_time.total_seconds()
        pos = max(0.0, tl.position.total_seconds() - start)

        duration = max(0.0, tl.end_time.total_seconds() - start)
        if duration <= 0:
            duration = max(0.0, tl.max_seek_time.total_seconds() - start)

        if playing:
            updated = tl.last_updated_time
            # Apps that never call UpdateTimelineProperties leave this at the
            # DateTime epoch; treat anything implausible as "no information".
            if updated is not None and updated.year > 1601:
                age = (datetime.now(timezone.utc) - updated).total_seconds()
                if 0 <= age < 86400:
                    pos += age

        if duration > 0:
            pos = min(pos, duration)

        return pos, duration
    except Exception:
        return 0.0, 0.0


def status_of(session):
    try:
        raw = session.get_playback_info().playback_status
        # winsdk exposes .value on the enum; fall back to .name for safety.
        value = getattr(raw, "value", None)
        if value in STATUS_NAMES:
            return STATUS_NAMES[value]
        return str(getattr(raw, "name", raw)).lower()
    except Exception:
        return "stopped"


def pick_session(manager, cfg, current_id):
    """Active-session selection.

    1. A pinned app always wins, if present.
    2. Otherwise prefer a session that is actually playing.
    3. Keep the session we are already following while it is still valid and not
       stopped — this is what stops the overlay ping-ponging between browser tabs
       that each hold an idle media session.
    4. Fall back to whatever SMTC calls the current session.
    """
    try:
        sessions = list(manager.get_sessions())
    except Exception:
        sessions = []

    ignored = [s.lower() for s in cfg.get("ignoredApps", []) if s]
    pinned = (cfg.get("preferredApp") or "").lower()

    entries = []
    for s in sessions:
        label = app_label(s)
        if any(ig in label.lower() for ig in ignored):
            continue
        entries.append((s, label, status_of(s)))

    if not entries:
        return None, []

    listing = [{"id": label, "app": label, "status": st} for _, label, st in entries]

    if pinned:
        for s, label, st in entries:
            if pinned in label.lower():
                return s, listing

    playing = [e for e in entries if e[2] == "playing"]
    if playing:
        # Stay put if the session we already follow is among the playing ones.
        for s, label, st in playing:
            if label == current_id:
                return s, listing
        return playing[0][0], listing

    if current_id:
        for s, label, st in entries:
            if label == current_id and st != "stopped":
                return s, listing

    try:
        cur = manager.get_current_session()
        if cur:
            label = app_label(cur)
            if not any(ig in label.lower() for ig in ignored):
                return cur, listing
    except Exception:
        pass

    return entries[0][0], listing


EMPTY = {
    "title": "",
    "artist": "",
    "album": "",
    "status": "stopped",
    "position": 0.0,
    "duration": 0.0,
    "art": "",
    "session": None,
    "sessions": [],
}


async def poll():
    cfg = read_config()
    last_key = ""
    last_art = ""
    current_id = ""

    while True:
        out = dict(EMPTY)
        try:
            manager = await SessionManager.request_async()
            session, listing = pick_session(manager, cfg, current_id)
            out["sessions"] = listing

            if session is not None:
                label = app_label(session)
                current_id = label
                out["session"] = {"id": label, "app": label}

                props = await session.try_get_media_properties_async()
                out["title"] = props.title or ""
                out["artist"] = props.artist or ""
                out["album"] = props.album_title or ""
                out["status"] = status_of(session)
                out["position"], out["duration"] = timeline_of(session, out["status"] == "playing")

                key = f"{label}|{out['title']}|{out['artist']}"
                if key != last_key:
                    last_art = ""
                    try:
                        last_art = await read_thumbnail(props)
                    except Exception:
                        pass  # no art available — not fatal
                    last_key = key
                out["art"] = last_art
            else:
                current_id = ""
                last_key = ""
                last_art = ""
        except Exception as exc:
            # No session, or a transient WinRT error (RPC_E_DISCONNECTED shows up
            # when a media app exits mid-call). Report stopped and keep polling.
            print(json.dumps({"error": str(exc)[:200]}), flush=True)

        print(json.dumps(out), flush=True)
        await asyncio.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        asyncio.run(poll())
    except KeyboardInterrupt:
        sys.exit(0)
