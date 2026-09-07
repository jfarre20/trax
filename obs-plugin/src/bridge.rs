//! Sample -> overlay message translation. Port of the state half of
//! ../media-bridge.js (process supervision and the WebSocket are gone; the
//! source hands messages to the page directly).
//!
//! Produces the same JSON messages overlay.js already understands:
//! `sessions`, `trackChanged`, `playbackChanged`, `timeline`, `state`.

use serde_json::{json, Value};
use sha1::{Digest, Sha1};

use crate::detector::{Detector, Event};
use crate::smtc::{Sample, SessionInfo};

#[derive(Debug, Clone)]
struct State {
    track_id: String,
    title: String,
    artist: String,
    album: String,
    source_app: String,
    artwork_url: String,
    playback_status: String,
    position_seconds: f64,
    duration_seconds: f64,
}

pub struct Bridge {
    detector: Detector,
    state: Option<State>,
    pub sessions: Vec<SessionInfo>,
    sessions_sent: bool,
    // SMTC publishes a position once per track and then freezes it, so the
    // bridge keeps its own anchor and reports an interpolated position. That
    // way a page that loads mid-song is primed with an honest value.
    pos_anchor: f64,
    pos_anchor_at: u64,
    pos_playing: bool,
}

impl Default for Bridge {
    fn default() -> Self {
        Self::new()
    }
}

impl Bridge {
    pub fn new() -> Bridge {
        Bridge {
            detector: Detector::new(),
            state: None,
            sessions: Vec::new(),
            sessions_sent: false,
            pos_anchor: 0.0,
            pos_anchor_at: 0,
            pos_playing: false,
        }
    }

    /// Preferences changed and the poller may now follow a different app.
    pub fn reset(&mut self) {
        self.detector.reset();
        self.state = None;
        self.sessions_sent = false;
    }

    fn set_anchor(&mut self, position: f64, playing: bool, now: u64) {
        self.pos_anchor = position.max(0.0);
        self.pos_anchor_at = now;
        self.pos_playing = playing;
    }

    fn reported_position(&self, now: u64) -> f64 {
        let mut p = self.pos_anchor;
        if self.pos_playing {
            p += now.saturating_sub(self.pos_anchor_at) as f64 / 1000.0;
        }
        p = p.max(0.0);
        match &self.state {
            Some(s) if s.duration_seconds > 0.0 => p.min(s.duration_seconds),
            _ => p,
        }
    }

    fn state_json(&self, s: &State, type_: &str) -> Value {
        json!({
            "type": type_,
            "trackId": s.track_id,
            "title": s.title,
            "artist": s.artist,
            "album": s.album,
            "sourceApp": s.source_app,
            "artworkUrl": s.artwork_url,
            "playbackStatus": s.playback_status,
            "positionSeconds": s.position_seconds,
            "durationSeconds": s.duration_seconds,
        })
    }

    /// Current state as a `state` message with the position advanced to now,
    /// for priming a page that (re)loaded. An empty title means nothing is
    /// playing and the overlay hides.
    pub fn snapshot(&self, now: u64) -> Value {
        match &self.state {
            Some(s) => {
                let mut s = s.clone();
                s.position_seconds = self.reported_position(now);
                self.state_json(&s, "state")
            }
            None => json!({
                "type": "state",
                "trackId": "",
                "title": "",
                "artist": "",
                "album": "",
                "sourceApp": "",
                "artworkUrl": "",
                "playbackStatus": "stopped",
                "positionSeconds": 0,
                "durationSeconds": 0,
            }),
        }
    }

    pub fn handle_sample(&mut self, sample: &Sample, now: u64) -> Vec<Value> {
        let mut out = Vec::new();

        if !self.sessions_sent || sample.sessions != self.sessions {
            self.sessions = sample.sessions.clone();
            self.sessions_sent = true;
            let list: Vec<Value> = self
                .sessions
                .iter()
                .map(|s| json!({ "id": s.id, "app": s.app, "status": s.status }))
                .collect();
            out.push(json!({ "type": "sessions", "sessions": list }));
        }

        match self.detector.step(sample, now) {
            Event::None => {}

            Event::Stopped => {
                self.state = None;
                out.push(json!({ "type": "playbackChanged", "playbackStatus": "stopped" }));
            }

            Event::TrackChanged { key, title, artist, album, source_app, art, status, position, duration } => {
                let playing = status == "playing";
                self.set_anchor(position, playing, now);
                let digest = Sha1::digest(key.as_bytes());
                let track_id: String = digest.iter().map(|b| format!("{b:02x}")).collect::<String>()[..12].to_string();
                let s = State {
                    track_id,
                    title,
                    artist,
                    album,
                    source_app,
                    artwork_url: art,
                    playback_status: status,
                    position_seconds: position,
                    duration_seconds: duration,
                };
                out.push(self.state_json(&s, "trackChanged"));
                self.state = Some(s);
            }

            Event::PlaybackChanged { status, position, duration, resumed_after_pause_seconds } => {
                let playing = status == "playing";
                // Pausing freezes wherever we had interpolated to. Resuming trusts
                // a freshly published position if there is one, since a play/pause
                // edge is one of the few moments an app does refresh it.
                let anchor = if playing && position > 0.0 { position } else { self.reported_position(now) };
                self.set_anchor(anchor, playing, now);
                let reported = self.reported_position(now);
                if let Some(s) = &mut self.state {
                    s.playback_status = status.clone();
                    s.position_seconds = reported;
                    if duration > 0.0 {
                        s.duration_seconds = duration;
                    }
                }
                out.push(json!({
                    "type": "playbackChanged",
                    "playbackStatus": status,
                    "positionSeconds": reported,
                    "durationSeconds": duration,
                    "resumedAfterPauseSeconds": resumed_after_pause_seconds,
                }));
            }

            Event::Timeline { position, duration } => {
                // Only emitted for genuine movement, a seek, or a duration
                // correction — so re-anchor to it.
                if let Some(s) = &mut self.state {
                    if duration > 0.0 {
                        s.duration_seconds = duration;
                    }
                }
                let playing = self.pos_playing;
                self.set_anchor(position, playing, now);
                let reported = self.reported_position(now);
                if let Some(s) = &mut self.state {
                    s.position_seconds = reported;
                }
                out.push(json!({
                    "type": "timeline",
                    "positionSeconds": position,
                    "durationSeconds": duration,
                }));
            }
        }

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smtc::SessionRef;

    fn sample(position: f64) -> Sample {
        Sample {
            title: "Song".into(),
            artist: "Band".into(),
            album: String::new(),
            status: "playing".into(),
            position,
            duration: 200.0,
            art: "data:image/png;base64,AAAA".into(),
            session: Some(SessionRef { id: "Spotify".into(), app: "Spotify".into() }),
            sessions: vec![SessionInfo { id: "Spotify".into(), app: "Spotify".into(), status: "playing".into() }],
        }
    }

    #[test]
    fn first_sample_emits_sessions_then_track_changed_with_art() {
        let mut b = Bridge::new();
        let msgs = b.handle_sample(&sample(10.0), 0);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["type"], "sessions");
        assert_eq!(msgs[1]["type"], "trackChanged");
        assert_eq!(msgs[1]["artworkUrl"], "data:image/png;base64,AAAA");
        assert_eq!(msgs[1]["trackId"].as_str().unwrap().len(), 12);
    }

    #[test]
    fn snapshot_interpolates_while_playing_and_freezes_when_paused() {
        let mut b = Bridge::new();
        b.handle_sample(&sample(10.0), 0);
        assert_eq!(b.snapshot(5000)["positionSeconds"], 15.0);

        let paused = Sample { status: "paused".into(), ..sample(10.0) };
        let msgs = b.handle_sample(&paused, 5000);
        assert_eq!(msgs.last().unwrap()["type"], "playbackChanged");
        assert_eq!(b.snapshot(9000)["positionSeconds"], 15.0);
    }

    #[test]
    fn stopped_snapshot_has_empty_title() {
        let mut b = Bridge::new();
        b.handle_sample(&sample(0.0), 0);
        b.handle_sample(&Sample { title: String::new(), ..sample(0.0) }, 1000);
        assert_eq!(b.snapshot(2000)["title"], "");
    }

    #[test]
    fn unchanged_sessions_are_not_resent() {
        let mut b = Bridge::new();
        b.handle_sample(&sample(0.0), 0);
        let msgs = b.handle_sample(&sample(0.5), 1000);
        assert!(msgs.iter().all(|m| m["type"] != "sessions"));
    }
}
