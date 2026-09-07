# Reads Linux "now playing" media info (MPRIS over D-Bus — the same source
# playerctl and the desktop's own media widgets use) and prints one JSON line
# per poll on stdout. Consumed by media-bridge.js.
#
# This is the Linux counterpart to nowplaying.py and emits an identical
# contract, so nothing downstream needs to know which one was spawned.
#
# Requires: python3-dbus
#   Debian/Ubuntu  sudo apt install python3-dbus
#   Fedora         sudo dnf install python3-dbus
#   Arch           sudo pacman -S python-dbus
#
# Album art is only fetched when the track changes (it is 10-100 KB, and for
# Spotify it is an HTTPS round trip) and then cached so every subsequent update
# for the same track still carries it — an overlay that connects mid-song gets
# the art without waiting for the next track.

import base64
import json
import mimetypes
import sys
import time
from urllib.parse import urlparse
from urllib.request import url2pathname, urlopen

try:
    import dbus
except ImportError:
    print(json.dumps({"error": "python3-dbus is not installed — "
                               "sudo apt install python3-dbus "
                               "(Fedora: dnf install python3-dbus, Arch: pacman -S python-dbus)"}),
          flush=True)
    sys.exit(1)

MPRIS_PREFIX = "org.mpris.MediaPlayer2."
MPRIS_PATH = "/org/mpris/MediaPlayer2"
ROOT_IFACE = "org.mpris.MediaPlayer2"
PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"
PROPS_IFACE = "org.freedesktop.DBus.Properties"

MAX_ART_BYTES = 5_000_000
ART_TIMEOUT = 5.0
# A wedged player must not stall the whole poll loop. MPRIS calls are local and
# answer in microseconds when the player is healthy, so this is generous.
CALL_TIMEOUT = 2.0
POLL_SECONDS = 1.0


def read_config():
    """Selection prefs are passed in as a single JSON argument by media-bridge.js."""
    if len(sys.argv) > 1:
        try:
            return json.loads(sys.argv[1])
        except (ValueError, TypeError):
            pass
    return {}


def props_iface(bus, name):
    return dbus.Interface(bus.get_object(name, MPRIS_PATH), PROPS_IFACE)


# Identity cannot change for the life of a bus name, so it is asked for once.
_identities = {}


def identity_of(bus, name):
    if name not in _identities:
        try:
            _identities[name] = str(props_iface(bus, name).Get(
                ROOT_IFACE, "Identity", timeout=CALL_TIMEOUT))
        except dbus.DBusException:
            _identities[name] = ""
    return _identities[name]


def app_label(bus_name, identity):
    """MPRIS offers two names: the bus suffix
    ("org.mpris.MediaPlayer2.firefox.instance_1_15") and the player's own
    Identity ("Mozilla Firefox"). Identity is what every other desktop media
    widget shows, so prefer it and fall back to the bus suffix with its
    per-process instance tag trimmed — that tag is a PID, not part of a name."""
    if identity:
        return identity
    label = bus_name[len(MPRIS_PREFIX):].split(".instance")[0]
    return label or bus_name


def status_of(props):
    """MPRIS PlaybackStatus is Playing/Paused/Stopped, which lowercases straight
    into the three strings the overlay already understands."""
    return str(props.get("PlaybackStatus") or "Stopped").lower()


def metadata_strings(meta):
    title = str(meta.get("xesam:title") or "")
    artists = meta.get("xesam:artist") or meta.get("xesam:albumArtist") or []
    if isinstance(artists, str):
        artists = [artists]
    artist = ", ".join(str(a) for a in artists if a)
    return title, artist, str(meta.get("xesam:album") or "")


def usec(v):
    """MPRIS times are microseconds, but not every player types them as Int64."""
    try:
        return max(0.0, float(v or 0) / 1e6)
    except (TypeError, ValueError):
        return 0.0


def timeline_of(bus, name, props):
    """Read position and duration.

    Unlike SMTC, MPRIS Position is a live value the player computes when asked,
    so there is no LastUpdatedTime correction to apply and joining mid-song is
    simply correct.

    Players that do not implement Position (Firefox is the usual one) hold it at
    zero forever. Reporting that stalled zero is right rather than something to
    paper over: media-bridge.js keeps its own anchor and interpolates, and
    track-change.js already refuses to treat a frozen position as movement.

    Returns (position, duration); either may be 0.0, and a zero duration tells
    the overlay to hide the progress bar.
    """
    meta = props.get("Metadata") or {}
    duration = usec(meta.get("mpris:length"))

    # Position is the one property that never emits PropertiesChanged, and some
    # players leave it out of GetAll for exactly that reason. Ask directly then.
    raw = props.get("Position")
    if raw is None:
        try:
            raw = props_iface(bus, name).Get(PLAYER_IFACE, "Position", timeout=CALL_TIMEOUT)
        except dbus.DBusException:
            raw = 0
    pos = usec(raw)

    if duration > 0:
        pos = min(pos, duration)
    return pos, duration


def read_art(url):
    """MPRIS publishes artwork as a URL rather than bytes, so it has to be
    fetched and inlined — overlay.js only ever loads a data: URL (see
    preloadArt), and its accent sampler needs an untainted canvas anyway.

    file: covers most local players; Spotify and Chromium publish https URLs
    into their own CDNs. Any other scheme is refused rather than handed to
    urlopen, and the read is capped so a wrong URL cannot pull down a video.
    """
    if not url:
        return ""
    if url.startswith("data:image/"):
        return url

    if url.startswith("file://"):
        path = url2pathname(urlparse(url).path)
        with open(path, "rb") as f:
            data = f.read(MAX_ART_BYTES + 1)
        mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    elif url.startswith(("http://", "https://")):
        with urlopen(url, timeout=ART_TIMEOUT) as r:
            data = r.read(MAX_ART_BYTES + 1)
            mime = r.headers.get_content_type() or "image/jpeg"
    else:
        return ""

    if len(data) > MAX_ART_BYTES or not mime.startswith("image/"):
        return ""
    return f"data:{mime};base64," + base64.b64encode(data).decode()


def gather(bus, cfg):
    """One GetAll per player: status and metadata in a single round trip.

    Returns (bus_name, label, status, props) tuples for every player that is not
    on the ignore list.
    """
    ignored = [s.lower() for s in cfg.get("ignoredApps", []) if s]
    names = [n for n in bus.list_names() if n.startswith(MPRIS_PREFIX)]

    entries = []
    for name in names:
        label = app_label(name, identity_of(bus, name))
        if any(ig in label.lower() for ig in ignored):
            continue
        try:
            props = props_iface(bus, name).GetAll(PLAYER_IFACE, timeout=CALL_TIMEOUT)
        except dbus.DBusException:
            continue  # player quit between ListNames and now
        entries.append((name, label, status_of(props), props))

    # Bus names come and go with browser tabs; don't let the cache grow with them.
    for gone in set(_identities) - set(names):
        del _identities[gone]
    return entries


def pick_session(entries, cfg, current_id):
    """Active-session selection — the same rules as the Windows poller, minus
    SMTC's "current session" fallback, which MPRIS has no equivalent of.

    1. A pinned app always wins, if present.
    2. Otherwise prefer a session that is actually playing.
    3. Keep the session we are already following while it is still valid and not
       stopped — this is what stops the overlay ping-ponging between browser tabs
       that each hold an idle media session.
    4. Fall back to whichever one we saw first.
    """
    if not entries:
        return None

    pinned = (cfg.get("preferredApp") or "").lower()
    if pinned:
        for e in entries:
            if pinned in e[1].lower():
                return e

    playing = [e for e in entries if e[2] == "playing"]
    if playing:
        # Stay put if the session we already follow is among the playing ones.
        for e in playing:
            if e[1] == current_id:
                return e
        return playing[0]

    if current_id:
        for e in entries:
            if e[1] == current_id and e[2] != "stopped":
                return e

    return entries[0]


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


def poll():
    cfg = read_config()
    bus = None
    last_key = ""
    last_art = ""
    current_id = ""

    while True:
        out = dict(EMPTY)
        try:
            if bus is None:
                # A private connection rather than the process-wide SessionBus
                # singleton, so a dead bus can actually be dropped and reopened.
                bus = dbus.bus.BusConnection(dbus.bus.BusConnection.TYPE_SESSION)

            entries = gather(bus, cfg)
            out["sessions"] = [{"id": lbl, "app": lbl, "status": st}
                               for _, lbl, st, _ in entries]

            chosen = pick_session(entries, cfg, current_id)
            if chosen is not None:
                name, label, status, props = chosen
                current_id = label
                out["session"] = {"id": label, "app": label}

                meta = props.get("Metadata") or {}
                out["title"], out["artist"], out["album"] = metadata_strings(meta)
                out["status"] = status
                out["position"], out["duration"] = timeline_of(bus, name, props)

                key = f"{label}|{out['title']}|{out['artist']}"
                if key != last_key:
                    last_art = ""
                    try:
                        last_art = read_art(str(meta.get("mpris:artUrl") or ""))
                    except Exception:
                        pass  # no art available — not fatal
                    last_key = key
                out["art"] = last_art
            else:
                current_id = ""
                last_key = ""
                last_art = ""
        except dbus.DBusException as exc:
            # The session bus went away (logout), or DBUS_SESSION_BUS_ADDRESS was
            # never set. Drop the connection so the next pass reopens it.
            if bus is not None:
                try:
                    bus.close()
                except Exception:
                    pass
                bus = None
            print(json.dumps({"error": str(exc)[:200]}), flush=True)
        except Exception as exc:
            print(json.dumps({"error": str(exc)[:200]}), flush=True)

        print(json.dumps(out), flush=True)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        poll()
    except KeyboardInterrupt:
        sys.exit(0)
