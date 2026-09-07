//! Track-change detection. Port of ../track-change.js.
//!
//! Fed raw poller samples, decides what kind of event each one represents.
//! Time is passed in so tests can drive it deterministically.
//!
//! The rule this module exists to enforce: a sample whose identity key
//! (session|title|artist) is unchanged can NEVER produce a TrackChanged, no
//! matter how much its position moved. That is what stops the overlay replaying
//! its reveal animation during ordinary playback.

use crate::smtc::Sample;

pub const TIMELINE_SYNC_MS: u64 = 5000;
pub const SEEK_THRESHOLD_S: f64 = 3.0;
/// Below this, the reported position is treated as not having moved at all.
pub const STALLED_EPSILON_S: f64 = 0.25;

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    None,
    Stopped,
    TrackChanged {
        key: String,
        title: String,
        artist: String,
        album: String,
        source_app: String,
        art: String,
        status: String,
        position: f64,
        duration: f64,
    },
    PlaybackChanged {
        status: String,
        position: f64,
        duration: f64,
        resumed_after_pause_seconds: f64,
    },
    Timeline {
        position: f64,
        duration: f64,
    },
}

pub fn identity_key(sample: &Sample) -> String {
    let session = sample.session.as_ref().map(|s| s.id.as_str()).unwrap_or("");
    format!("{}|{}|{}", session, sample.title, sample.artist)
}

pub struct Detector {
    timeline_sync_ms: u64,
    seek_threshold_s: f64,
    stalled_epsilon_s: f64,
    last_key: String,
    last_status: String,
    last_position: f64,
    last_duration: f64,
    last_sync_at: Option<u64>,
    paused_since: Option<u64>,
}

impl Default for Detector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector {
    pub fn new() -> Self {
        Detector {
            timeline_sync_ms: TIMELINE_SYNC_MS,
            seek_threshold_s: SEEK_THRESHOLD_S,
            stalled_epsilon_s: STALLED_EPSILON_S,
            last_key: String::new(),
            last_status: String::new(),
            last_position: 0.0,
            last_duration: 0.0,
            last_sync_at: None,
            paused_since: None,
        }
    }

    /// `now` is milliseconds, monotonic within a run.
    pub fn step(&mut self, sample: &Sample, now: u64) -> Event {
        let status = if sample.status.is_empty() { "stopped" } else { sample.status.as_str() };
        let position = sample.position;
        let duration = sample.duration;

        // Nothing playing. Only report the transition, not every poll.
        if sample.title.is_empty() {
            if self.last_key.is_empty() {
                return Event::None;
            }
            self.last_key.clear();
            self.last_status = status.to_string();
            self.last_position = 0.0;
            self.paused_since = None;
            return Event::Stopped;
        }

        let key = identity_key(sample);
        let is_new_track = key != self.last_key;

        // How long we were paused, measured before the status bookkeeping below
        // overwrites it. Only meaningful on a paused -> playing edge.
        let mut resumed_after_pause_seconds = 0.0;
        if !is_new_track && status == "playing" && self.last_status == "paused" {
            if let Some(since) = self.paused_since {
                resumed_after_pause_seconds = now.saturating_sub(since) as f64 / 1000.0;
            }
        }

        if status == "paused" && self.last_status != "paused" {
            self.paused_since = Some(now);
        }
        if status == "playing" {
            self.paused_since = None;
        }

        if is_new_track {
            self.last_key = key.clone();
            self.last_status = status.to_string();
            self.last_position = position;
            self.last_duration = duration;
            self.last_sync_at = Some(now);
            return Event::TrackChanged {
                key,
                title: sample.title.clone(),
                artist: sample.artist.clone(),
                album: sample.album.clone(),
                source_app: sample.session.as_ref().map(|s| s.app.clone()).unwrap_or_default(),
                art: sample.art.clone(),
                status: status.to_string(),
                position,
                duration,
            };
        }

        // --- Same track from here down. TrackChanged is unreachable. ---

        if status != self.last_status {
            self.last_status = status.to_string();
            self.last_sync_at = Some(now);
            self.last_position = position;
            self.last_duration = duration;
            return Event::PlaybackChanged {
                status: status.to_string(),
                position,
                duration,
                resumed_after_pause_seconds,
            };
        }

        // Timeline sync. Many apps never refresh their published position, so a
        // sync is only worth sending when the value actually moved, when the
        // user seeked, or when the duration changed (apps often report 0 first
        // and the real length a beat later). Re-sending a frozen value would
        // make the overlay re-anchor to a stale number.
        let delta = (position - self.last_position).abs();
        let moved = delta > self.stalled_epsilon_s;
        let went_backwards = position < self.last_position - 0.5;
        let jumped = delta > self.seek_threshold_s;
        let duration_changed = (duration - self.last_duration).abs() > self.stalled_epsilon_s;
        let due = match self.last_sync_at {
            Some(at) => now.saturating_sub(at) >= self.timeline_sync_ms,
            None => true,
        };

        if went_backwards || jumped || duration_changed || (moved && due) {
            self.last_sync_at = Some(now);
            self.last_position = position;
            self.last_duration = duration;
            return Event::Timeline { position, duration };
        }

        Event::None
    }

    /// Forget everything. Used when session preferences change and the poller
    /// restarts, since it may begin following a different app.
    pub fn reset(&mut self) {
        *self = Detector {
            timeline_sync_ms: self.timeline_sync_ms,
            seek_threshold_s: self.seek_threshold_s,
            stalled_epsilon_s: self.stalled_epsilon_s,
            ..Detector::new()
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smtc::SessionRef;

    fn sample() -> Sample {
        Sample {
            title: "Riders On The Storm".into(),
            artist: "Snoop Dogg".into(),
            album: "Need For Speed".into(),
            status: "playing".into(),
            position: 0.0,
            duration: 240.0,
            art: String::new(),
            session: Some(SessionRef { id: "Spotify".into(), app: "Spotify".into() }),
            sessions: vec![],
        }
    }

    fn at(position: f64) -> Sample {
        Sample { position, ..sample() }
    }

    fn kind(e: &Event) -> &'static str {
        match e {
            Event::None => "none",
            Event::Stopped => "stopped",
            Event::TrackChanged { .. } => "trackChanged",
            Event::PlaybackChanged { .. } => "playbackChanged",
            Event::Timeline { .. } => "timeline",
        }
    }

    #[test]
    fn identity_key_combines_session_title_artist() {
        assert_eq!(identity_key(&sample()), "Spotify|Riders On The Storm|Snoop Dogg");
        let s = Sample { session: None, title: "A".into(), artist: "B".into(), ..sample() };
        assert_eq!(identity_key(&s), "|A|B");
    }

    #[test]
    fn first_sample_is_track_changed() {
        let mut d = Detector::new();
        match d.step(&sample(), 1000) {
            Event::TrackChanged { title, source_app, duration, .. } => {
                assert_eq!(title, "Riders On The Storm");
                assert_eq!(source_app, "Spotify");
                assert_eq!(duration, 240.0);
            }
            e => panic!("expected trackChanged, got {e:?}"),
        }
    }

    #[test]
    fn identical_repeat_is_not_an_event() {
        let mut d = Detector::new();
        d.step(&sample(), 1000);
        assert_eq!(d.step(&sample(), 1500), Event::None);
    }

    #[test]
    fn the_regression_progress_never_yields_track_changed() {
        let mut d = Detector::new();
        d.step(&at(0.0), 0);
        let mut track_changes = 0;
        let mut timelines = 0;
        for i in 1..=240u64 {
            match d.step(&at(i as f64), i * 1000) {
                Event::TrackChanged { .. } => track_changes += 1,
                Event::Timeline { .. } => timelines += 1,
                _ => {}
            }
        }
        assert_eq!(track_changes, 0, "position movement produced spurious track changes");
        assert!(timelines > 0, "expected periodic timeline syncs");
    }

    #[test]
    fn timeline_syncs_are_rate_limited() {
        let mut d = Detector::new();
        d.step(&at(0.0), 0);
        let mut syncs = 0;
        for i in 1..=30u64 {
            if kind(&d.step(&at(i as f64), i * 1000)) == "timeline" {
                syncs += 1;
            }
        }
        assert!((4..=8).contains(&syncs), "expected ~6 syncs over 30 s, got {syncs}");
    }

    #[test]
    fn frozen_position_emits_no_syncs() {
        let mut d = Detector::new();
        let frozen = Sample { position: 107.568, duration: 127.28, ..sample() };
        d.step(&frozen, 0);
        let mut syncs = 0;
        for i in 1..=60u64 {
            if kind(&d.step(&frozen, i * 1000)) == "timeline" {
                syncs += 1;
            }
        }
        assert_eq!(syncs, 0);
    }

    #[test]
    fn sub_epsilon_jitter_counts_as_stalled() {
        let mut d = Detector::new();
        d.step(&at(50.0), 0);
        let mut syncs = 0;
        for i in 1..=40u64 {
            let p = 50.0 + if i % 2 == 1 { 0.1 } else { -0.1 };
            if kind(&d.step(&at(p), i * 1000)) == "timeline" {
                syncs += 1;
            }
        }
        assert_eq!(syncs, 0);
    }

    #[test]
    fn stalled_position_still_yields_to_a_seek() {
        let mut d = Detector::new();
        d.step(&at(107.568), 0);
        for i in 1..=10u64 {
            d.step(&at(107.568), i * 1000);
        }
        assert_eq!(d.step(&at(12.0), 11000), Event::Timeline { position: 12.0, duration: 240.0 });
    }

    #[test]
    fn late_duration_is_reported_while_stalled() {
        let mut d = Detector::new();
        d.step(&Sample { position: 0.0, duration: 0.0, ..sample() }, 0);
        let e = d.step(&Sample { position: 0.0, duration: 127.28, ..sample() }, 1000);
        assert_eq!(e, Event::Timeline { position: 0.0, duration: 127.28 });
    }

    #[test]
    fn unchanged_duration_does_not_resync() {
        let mut d = Detector::new();
        let s = Sample { position: 10.0, duration: 200.0, ..sample() };
        d.step(&s, 0);
        assert_eq!(d.step(&s, 9000), Event::None);
    }

    #[test]
    fn different_title_artist_or_session_is_track_changed() {
        let mut d = Detector::new();
        d.step(&sample(), 0);
        assert_eq!(kind(&d.step(&Sample { title: "Get Low".into(), ..sample() }, 1000)), "trackChanged");

        let mut d = Detector::new();
        d.step(&sample(), 0);
        assert_eq!(kind(&d.step(&Sample { artist: "Someone Else".into(), ..sample() }, 1000)), "trackChanged");

        let mut d = Detector::new();
        d.step(&sample(), 0);
        let chrome = Sample {
            session: Some(SessionRef { id: "Chrome".into(), app: "Chrome".into() }),
            ..sample()
        };
        match d.step(&chrome, 1000) {
            Event::TrackChanged { source_app, .. } => assert_eq!(source_app, "Chrome"),
            e => panic!("expected trackChanged, got {e:?}"),
        }
    }

    #[test]
    fn looping_track_is_a_timeline_not_a_replay() {
        let mut d = Detector::new();
        d.step(&at(235.0), 0);
        assert_eq!(kind(&d.step(&at(0.0), 1000)), "timeline");
    }

    #[test]
    fn pause_and_resume() {
        let mut d = Detector::new();
        d.step(&sample(), 0);
        let paused = Sample { status: "paused".into(), ..sample() };
        match d.step(&paused, 1000) {
            Event::PlaybackChanged { status, .. } => assert_eq!(status, "paused"),
            e => panic!("expected playbackChanged, got {e:?}"),
        }
        assert_eq!(d.step(&paused, 2000), Event::None);

        let mut d = Detector::new();
        d.step(&sample(), 0);
        d.step(&paused, 10000);
        match d.step(&sample(), 55000) {
            Event::PlaybackChanged { status, resumed_after_pause_seconds, .. } => {
                assert_eq!(status, "playing");
                assert_eq!(resumed_after_pause_seconds, 45.0);
            }
            e => panic!("expected playbackChanged, got {e:?}"),
        }
    }

    #[test]
    fn empty_title_reports_stopped_once_then_track_changed_on_return() {
        let mut d = Detector::new();
        d.step(&sample(), 0);
        let stopped = Sample { title: String::new(), ..sample() };
        assert_eq!(d.step(&stopped, 1000), Event::Stopped);
        assert_eq!(d.step(&stopped, 2000), Event::None);
        assert_eq!(kind(&d.step(&sample(), 3000)), "trackChanged");
    }

    #[test]
    fn seeking_syncs_immediately() {
        let mut d = Detector::new();
        d.step(&at(10.0), 0);
        assert_eq!(d.step(&at(120.0), 500), Event::Timeline { position: 120.0, duration: 240.0 });

        let mut d = Detector::new();
        d.step(&at(120.0), 0);
        assert_eq!(kind(&d.step(&at(10.0), 500)), "timeline");
    }
}
