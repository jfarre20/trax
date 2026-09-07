//! Drives the media pipeline with no OBS in the picture, so the SMTC reader,
//! the detector and the bridge can be checked against whatever is really
//! playing on this machine.
//!
//!     cargo run --example poll -- [seconds]
//!
//! Prints the session list, then one line per overlay message. Artwork is
//! summarised rather than dumped, since it is a base64 data URL.

use std::time::{Duration, Instant};

use trax::bridge::Bridge;
use trax::smtc::{Poller, Prefs};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

fn main() {
    let seconds: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(10);

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let mut poller = Poller::new();
    let mut bridge = Bridge::new();
    let prefs = Prefs::default();
    let started = Instant::now();

    println!("polling for {seconds}s\n");

    while started.elapsed().as_secs() < seconds {
        let now = started.elapsed().as_millis() as u64;
        let sample = poller.poll(&prefs);

        for mut msg in bridge.handle_sample(&sample, now) {
            // Keep the line readable: report the art by size, not by content.
            if let Some(art) = msg.get("artworkUrl").and_then(|v| v.as_str()) {
                let text = if art.is_empty() {
                    "none".to_string()
                } else {
                    format!("{} KB", art.len() / 1024)
                };
                msg["artworkUrl"] = serde_json::Value::String(text);
            }
            println!("{:>6.1}s  {}", now as f64 / 1000.0, msg);
        }

        std::thread::sleep(Duration::from_millis(1000));
    }

    println!("\nfinal snapshot: {}", {
        let mut s = bridge.snapshot(started.elapsed().as_millis() as u64);
        if let Some(art) = s.get("artworkUrl").and_then(|v| v.as_str()) {
            let text = if art.is_empty() { "none".to_string() } else { format!("{} KB", art.len() / 1024) };
            s["artworkUrl"] = serde_json::Value::String(text);
        }
        s
    });
}
