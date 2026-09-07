//! Publishes a synthetic media session, then reads it back through the
//! plugin's own poller. This exercises the whole read path — session
//! enumeration, app labelling, status mapping, the LastUpdatedTime position
//! correction, thumbnail decoding, the detector and the bridge — without
//! needing a real media app or making any sound.
//!
//!     cargo run --example publish -- [seconds]
//!
//! The publisher owns the main thread because SMTC hangs off a window and
//! wants a single-threaded apartment with a message pump. The poller runs on
//! its own multi-threaded-apartment thread, since blocking on a WinRT async
//! from an STA would deadlock against that same pump.

use std::time::{Duration, Instant};

use windows::core::{w, HSTRING};
use windows::Foundation::TimeSpan;
use windows::Media::{MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls};
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Com::{
    CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, PeekMessageW, RegisterClassW,
    TranslateMessage, CW_USEDEFAULT, MSG, PM_REMOVE, WINDOW_EX_STYLE, WNDCLASSW, WS_OVERLAPPED,
};

const TITLE: &str = "Riders On The Storm";
const ARTIST: &str = "Snoop Dogg";
const ALBUM: &str = "Need For Speed: Underground 2";
const DURATION_S: f64 = 240.0;
/// Where the track is when we publish. The poller should report this plus the
/// time elapsed since, which is the correction the whole overlay depends on.
const START_POSITION_S: f64 = 42.0;

const TICKS_PER_SECOND: f64 = 10_000_000.0;

fn span(seconds: f64) -> TimeSpan {
    TimeSpan { Duration: (seconds * TICKS_PER_SECOND) as i64 }
}

/// A 1x1 PNG, so there is something for the thumbnail reader to decode.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> windows::Win32::Foundation::LRESULT {
    DefWindowProcW(hwnd, msg, wp, lp)
}

/// A never-shown top-level window for SMTC to attach to.
unsafe fn make_window() -> windows::core::Result<HWND> {
    let instance = GetModuleHandleW(None)?;
    let class = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: instance.into(),
        lpszClassName: w!("TraxSmtcPublisher"),
        ..Default::default()
    };
    RegisterClassW(&class);
    CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("TraxSmtcPublisher"),
        w!("TRAX SMTC publisher"),
        WS_OVERLAPPED,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        320,
        200,
        None,
        None,
        Some(instance.into()),
        None,
    )
}

fn thumbnail() -> windows::core::Result<RandomAccessStreamReference> {
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream.GetOutputStreamAt(0)?)?;
    writer.WriteBytes(PNG)?;
    writer.StoreAsync()?.join()?;
    writer.FlushAsync()?.join()?;
    stream.Seek(0)?;
    RandomAccessStreamReference::CreateFromStream(&stream)
}

fn publish() -> windows::core::Result<SystemMediaTransportControls> {
    let hwnd = unsafe { make_window()? };
    let interop = windows::core::factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
    let smtc: SystemMediaTransportControls = unsafe { interop.GetForWindow(hwnd)? };

    smtc.SetIsEnabled(true)?;
    smtc.SetIsPlayEnabled(true)?;
    smtc.SetIsPauseEnabled(true)?;
    smtc.SetPlaybackStatus(MediaPlaybackStatus::Playing)?;

    let updater = smtc.DisplayUpdater()?;
    updater.SetType(MediaPlaybackType::Music)?;
    let music = updater.MusicProperties()?;
    music.SetTitle(&HSTRING::from(TITLE))?;
    music.SetArtist(&HSTRING::from(ARTIST))?;
    music.SetAlbumTitle(&HSTRING::from(ALBUM))?;
    match thumbnail() {
        Ok(t) => updater.SetThumbnail(&t)?,
        Err(e) => eprintln!("thumbnail not published: {e}"),
    }
    updater.Update()?;

    let timeline = windows::Media::SystemMediaTransportControlsTimelineProperties::new()?;
    timeline.SetStartTime(span(0.0))?;
    timeline.SetEndTime(span(DURATION_S))?;
    timeline.SetMinSeekTime(span(0.0))?;
    timeline.SetMaxSeekTime(span(DURATION_S))?;
    timeline.SetPosition(span(START_POSITION_S))?;
    smtc.UpdateTimelineProperties(&timeline)?;

    Ok(smtc)
}

/// Reads whatever is playing and prints the overlay messages it produces.
fn poll_thread(seconds: u64) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut poller = trax::smtc::Poller::new();
    let mut bridge = trax::bridge::Bridge::new();
    let prefs = trax::smtc::Prefs::default();
    let started = Instant::now();

    while started.elapsed().as_secs() < seconds {
        let now = started.elapsed().as_millis() as u64;
        let sample = poller.poll(&prefs);
        for mut msg in bridge.handle_sample(&sample, now) {
            if let Some(art) = msg.get("artworkUrl").and_then(|v| v.as_str()) {
                let text = if art.is_empty() { "none".into() } else { format!("{} bytes of base64", art.len()) };
                msg["artworkUrl"] = serde_json::Value::String(text);
            }
            println!("{:>6.1}s  {}", now as f64 / 1000.0, msg);
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
}

fn main() {
    let seconds: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(8);

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let smtc = match publish() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("could not publish a media session: {e}");
            std::process::exit(1);
        }
    };
    println!("publishing \"{ARTIST} - {TITLE}\" at {START_POSITION_S}s of {DURATION_S}s\n");

    let reader = std::thread::spawn(move || poll_thread(seconds));

    // Pump messages until the reader is done; SMTC wants a live message loop.
    let started = Instant::now();
    while !reader.is_finished() && started.elapsed().as_secs() < seconds + 5 {
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let _ = reader.join();
    let _ = smtc.SetPlaybackStatus(MediaPlaybackStatus::Stopped);
    let _ = smtc.SetIsEnabled(false);
    println!("\nexpected position at the end: about {:.0}s", START_POSITION_S + seconds as f64);
}
