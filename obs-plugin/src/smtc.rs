//! Windows "now playing" reader. Port of ../nowplaying.py onto the `windows`
//! crate, reading the Global System Media Transport Controls session — the
//! same source the volume OSD uses.
//!
//! Album art is only read when the track changes (it is 10-100 KB) and then
//! cached so every subsequent sample for the same track still carries it.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use windows::core::Interface;
use windows::Foundation::IClosable;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
};
use windows::Storage::Streams::{DataReader, IInputStream};

const MAX_ART_BYTES: u64 = 5_000_000;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionRef {
    pub id: String,
    pub app: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionInfo {
    pub id: String,
    pub app: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Sample {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub status: String,
    pub position: f64,
    pub duration: f64,
    /// data: URL, or empty.
    pub art: String,
    pub session: Option<SessionRef>,
    pub sessions: Vec<SessionInfo>,
}

impl Sample {
    fn empty() -> Sample {
        Sample { status: "stopped".into(), ..Default::default() }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Prefs {
    pub preferred_app: String,
    pub ignored_apps: Vec<String>,
}

/// AppUserModelId is what SMTC gives us — e.g. "Spotify.exe", or a long
/// "...!App" package id for Store apps. Trim it into something displayable.
pub fn app_label(raw: &str) -> String {
    let mut label = raw.to_string();
    if let Some(i) = label.find('!') {
        label.truncate(i);
    }
    if label.contains('_') && label.contains('.') {
        // Store package family name: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0"
        if let Some(i) = label.find('_') {
            label.truncate(i);
        }
        if let Some(i) = label.rfind('.') {
            label = label[i + 1..].to_string();
        }
    }
    if label.to_lowercase().ends_with(".exe") {
        label.truncate(label.len() - 4);
    }
    if label.is_empty() {
        raw.to_string()
    } else {
        label
    }
}

fn status_name(code: i32) -> &'static str {
    match code {
        0 => "closed",
        1 => "opened",
        2 => "changing",
        3 => "stopped",
        4 => "playing",
        5 => "paused",
        _ => "stopped",
    }
}

fn status_of(session: &Session) -> String {
    session
        .GetPlaybackInfo()
        .and_then(|i| i.PlaybackStatus())
        .map(|s| status_name(s.0).to_string())
        .unwrap_or_else(|_| "stopped".to_string())
}

/// Now, as a Windows FILETIME tick count (100 ns since 1601), the unit
/// DateTime.UniversalTime uses.
fn now_ticks() -> i64 {
    let since_unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (since_unix.as_nanos() / 100) as i64 + 116_444_736_000_000_000
}

const TICKS_PER_SECOND: f64 = 10_000_000.0;

/// Read position and duration.
///
/// SMTC's Position is NOT a live clock: it is whatever the app last pushed via
/// UpdateTimelineProperties. LastUpdatedTime says WHEN, so the real position
/// while playing is `position + (now - last_updated)`. Without it, anything
/// starting mid-track is behind by however long the track had been playing.
/// While paused the position is already the frozen value, so no correction.
///
/// Duration is reliable when present but which field carries it varies:
/// EndTime is usual, some apps leave it zero and fill MaxSeekTime instead.
fn timeline_of(session: &Session, playing: bool) -> (f64, f64) {
    let Ok(tl) = session.GetTimelineProperties() else { return (0.0, 0.0) };
    let secs = |t: windows::core::Result<windows::Foundation::TimeSpan>| {
        t.map(|v| v.Duration as f64 / TICKS_PER_SECOND).unwrap_or(0.0)
    };
    let start = secs(tl.StartTime());
    let mut pos = (secs(tl.Position()) - start).max(0.0);
    let mut duration = (secs(tl.EndTime()) - start).max(0.0);
    if duration <= 0.0 {
        duration = (secs(tl.MaxSeekTime()) - start).max(0.0);
    }

    if playing {
        if let Ok(updated) = tl.LastUpdatedTime() {
            // Apps that never call UpdateTimelineProperties leave this at the
            // epoch; treat anything implausible as "no information".
            if updated.UniversalTime > 0 {
                let age = (now_ticks() - updated.UniversalTime) as f64 / TICKS_PER_SECOND;
                if (0.0..86400.0).contains(&age) {
                    pos += age;
                }
            }
        }
    }

    if duration > 0.0 {
        pos = pos.min(duration);
    }
    (pos, duration)
}

fn read_thumbnail(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
    let thumb = props.Thumbnail().ok()?;
    let stream = thumb.OpenReadAsync().ok()?.join().ok()?;
    let result = (|| -> windows::core::Result<Option<String>> {
        let size = stream.Size()?;
        if size == 0 || size > MAX_ART_BYTES {
            return Ok(None);
        }
        let mut mime = stream.ContentType()?.to_string_lossy();
        if !mime.starts_with("image/") {
            mime = "image/jpeg".to_string();
        }
        let input: IInputStream = stream.cast()?;
        let reader = DataReader::CreateDataReader(&input)?;
        let loaded = reader.LoadAsync(size as u32)?.join()?;
        let mut buf = vec![0u8; loaded as usize];
        reader.ReadBytes(&mut buf)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        Ok(Some(format!("data:{mime};base64,{b64}")))
    })();
    if let Ok(closable) = stream.cast::<IClosable>() {
        let _ = closable.Close();
    }
    result.ok().flatten()
}

struct Entry {
    session: Session,
    label: String,
    status: String,
}

/// Active-session selection.
///
/// 1. A pinned app always wins, if present.
/// 2. Otherwise prefer a session that is actually playing.
/// 3. Keep the session we are already following while it is still valid and
///    not stopped — this stops the overlay ping-ponging between browser tabs
///    that each hold an idle media session.
/// 4. Fall back to whatever SMTC calls the current session.
fn pick_session(manager: &Manager, prefs: &Prefs, current_id: &str) -> (Option<Session>, Vec<SessionInfo>) {
    let mut entries: Vec<Entry> = Vec::new();
    if let Ok(sessions) = manager.GetSessions() {
        for s in sessions {
            let raw = s.SourceAppUserModelId().map(|h| h.to_string_lossy()).unwrap_or_default();
            let label = app_label(&raw);
            let lower = label.to_lowercase();
            if prefs.ignored_apps.iter().any(|ig| !ig.is_empty() && lower.contains(&ig.to_lowercase())) {
                continue;
            }
            let status = status_of(&s);
            entries.push(Entry { session: s, label, status });
        }
    }

    if entries.is_empty() {
        return (None, vec![]);
    }

    let listing: Vec<SessionInfo> = entries
        .iter()
        .map(|e| SessionInfo { id: e.label.clone(), app: e.label.clone(), status: e.status.clone() })
        .collect();

    let pinned = prefs.preferred_app.to_lowercase();
    if !pinned.is_empty() {
        if let Some(e) = entries.iter().find(|e| e.label.to_lowercase().contains(&pinned)) {
            return (Some(e.session.clone()), listing);
        }
    }

    let playing: Vec<&Entry> = entries.iter().filter(|e| e.status == "playing").collect();
    if !playing.is_empty() {
        if let Some(e) = playing.iter().find(|e| e.label == current_id) {
            return (Some(e.session.clone()), listing);
        }
        return (Some(playing[0].session.clone()), listing);
    }

    if !current_id.is_empty() {
        if let Some(e) = entries.iter().find(|e| e.label == current_id && e.status != "stopped") {
            return (Some(e.session.clone()), listing);
        }
    }

    if let Ok(cur) = manager.GetCurrentSession() {
        let raw = cur.SourceAppUserModelId().map(|h| h.to_string_lossy()).unwrap_or_default();
        let lower = app_label(&raw).to_lowercase();
        if !prefs.ignored_apps.iter().any(|ig| !ig.is_empty() && lower.contains(&ig.to_lowercase())) {
            return (Some(cur), listing);
        }
    }

    (Some(entries[0].session.clone()), listing)
}

pub struct Poller {
    manager: Option<Manager>,
    last_key: String,
    last_art: String,
    current_id: String,
}

impl Default for Poller {
    fn default() -> Self {
        Self::new()
    }
}

impl Poller {
    pub fn new() -> Poller {
        Poller { manager: None, last_key: String::new(), last_art: String::new(), current_id: String::new() }
    }

    /// Forget the followed session and cached art (preferences changed).
    pub fn reset(&mut self) {
        self.last_key.clear();
        self.last_art.clear();
        self.current_id.clear();
    }

    fn manager(&mut self) -> windows::core::Result<Manager> {
        if let Some(m) = &self.manager {
            return Ok(m.clone());
        }
        let m = Manager::RequestAsync()?.join()?;
        self.manager = Some(m.clone());
        Ok(m)
    }

    /// One sample. Never fails: a WinRT error (RPC_E_DISCONNECTED when a media
    /// app exits mid-call, say) reports stopped and drops the cached manager so
    /// the next poll re-requests it.
    pub fn poll(&mut self, prefs: &Prefs) -> Sample {
        match self.try_poll(prefs) {
            Ok(s) => s,
            Err(e) => {
                crate::ffi::log(crate::ffi::LOG_DEBUG, &format!("smtc poll failed: {e}"));
                self.manager = None;
                self.current_id.clear();
                self.last_key.clear();
                self.last_art.clear();
                Sample::empty()
            }
        }
    }

    fn try_poll(&mut self, prefs: &Prefs) -> windows::core::Result<Sample> {
        let manager = self.manager()?;
        let mut out = Sample::empty();
        let (session, listing) = pick_session(&manager, prefs, &self.current_id);
        out.sessions = listing;

        let Some(session) = session else {
            self.current_id.clear();
            self.last_key.clear();
            self.last_art.clear();
            return Ok(out);
        };

        let raw = session.SourceAppUserModelId()?.to_string_lossy();
        let label = app_label(&raw);
        self.current_id = label.clone();
        out.session = Some(SessionRef { id: label.clone(), app: label.clone() });

        let props = session.TryGetMediaPropertiesAsync()?.join()?;
        out.title = props.Title().map(|h| h.to_string_lossy()).unwrap_or_default();
        out.artist = props.Artist().map(|h| h.to_string_lossy()).unwrap_or_default();
        out.album = props.AlbumTitle().map(|h| h.to_string_lossy()).unwrap_or_default();
        out.status = status_of(&session);
        let (pos, dur) = timeline_of(&session, out.status == "playing");
        out.position = pos;
        out.duration = dur;

        let key = format!("{}|{}|{}", label, out.title, out.artist);
        if key != self.last_key {
            self.last_art = read_thumbnail(&props).unwrap_or_default();
            self.last_key = key;
        }
        out.art = self.last_art.clone();
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::app_label;

    #[test]
    fn app_labels() {
        assert_eq!(app_label("Spotify.exe"), "Spotify");
        assert_eq!(app_label("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "SpotifyMusic");
        assert_eq!(app_label("Chrome"), "Chrome");
        assert_eq!(app_label(""), "");
    }
}
