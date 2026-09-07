//! The "TRAX Now Playing" source.
//!
//! It owns a private browser_source child that loads overlay.html from this
//! plugin's data directory, and pushes messages into that page through
//! obs-browser's `javascript_event` proc handler (they arrive as a DOM
//! CustomEvent named "trax"; see the file:// branch at the bottom of
//! overlay.js). A worker thread polls SMTC once a second; everything that
//! touches libobs happens on OBS threads (video_tick drains the outbox).

use std::collections::VecDeque;
use std::ffi::{c_void, CString};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

use crate::bridge::Bridge;
use crate::config;
use crate::ffi::*;
use crate::smtc::{Poller, Prefs};

const SOURCE_ID: &CStr = c"trax_now_playing";
const HEARTBEAT_S: f32 = 20.0;
/// Quietest level the bars react to. Matches the web version's obs-bridge.js so
/// the meter feels the same in both.
const FLOOR_DB: f32 = -50.0;
/// The meter fires faster than the overlay can show. 25 Hz is plenty.
const LEVEL_INTERVAL_S: f32 = 0.04;
/// A picked audio source may not exist yet while a scene collection is still
/// loading, so keep trying.
const ATTACH_RETRY_S: f32 = 2.0;
/// After the browser (re)loads we cannot know when the page is ready, so the
/// config + state snapshot is repeated on this schedule.
const BOOT_RESEND_S: &[f32] = &[0.5, 1.5, 3.0, 6.0, 12.0];

use std::ffi::CStr;

pub struct Shared {
    pub bridge: Bridge,
    pub outbox: VecDeque<Value>,
    pub prefs: Prefs,
    pub prefs_gen: u64,
    pub stop: bool,
}

/// Written by the audio thread, read on the OBS graphics thread. Floats are
/// stored as bits because there is no AtomicF32; `seq` says when a new pair has
/// landed so the tick only sends something when there is something new.
pub struct Levels {
    level: AtomicU32,
    peak: AtomicU32,
    seq: AtomicU32,
}

impl Levels {
    fn new() -> Levels {
        Levels { level: AtomicU32::new(0), peak: AtomicU32::new(0), seq: AtomicU32::new(0) }
    }
    fn get(&self) -> (f32, f32, u32) {
        (
            f32::from_bits(self.level.load(Ordering::Relaxed)),
            f32::from_bits(self.peak.load(Ordering::Relaxed)),
            self.seq.load(Ordering::Relaxed),
        )
    }
}

pub struct Context {
    source: *mut obs_source_t,
    browser: *mut obs_source_t,
    width: u32,
    height: u32,
    config: Value,
    shared: Arc<Mutex<Shared>>,
    worker: Option<JoinHandle<()>>,
    clock: f32,
    resend_at: Vec<f32>,
    next_heartbeat: f32,
    // Audio-reactive equalizer
    volmeter: *mut obs_volmeter_t,
    levels: *mut Levels,
    audio_reactive: bool,
    audio_source: String,
    audio_attached: bool,
    attach_retry_at: f32,
    last_level_at: f32,
    last_level_seq: u32,
    /// Whether the outcome of a dispatch has been reported yet. The first one
    /// is logged either way, so a missing proc handler is visible in the log.
    dispatch_logged: std::cell::Cell<bool>,
    /// Whether the first audible level has been reported, so the log shows the
    /// meter is really feeding the bars and not just attached.
    level_logged: std::cell::Cell<bool>,
}

static START: OnceLock<Instant> = OnceLock::new();
fn now_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Live Context pointers, so button callbacks can check what OBS hands them
/// before dereferencing it.
static INSTANCES: Mutex<Vec<usize>> = Mutex::new(Vec::new());

fn guard<R>(what: &str, fallback: R, f: impl FnOnce() -> R) -> R {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(e) => {
            let msg = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "panic".into());
            log(LOG_ERROR, &format!("{what}: {msg}"));
            fallback
        }
    }
}

// ------------------------------------------------------------------ worker

fn worker_loop(shared: Arc<Mutex<Shared>>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut poller = Poller::new();
    let (mut prefs, mut gen) = {
        let s = shared.lock().unwrap();
        (s.prefs.clone(), s.prefs_gen)
    };
    log(LOG_INFO, "media poller started");

    loop {
        {
            let mut s = shared.lock().unwrap();
            if s.stop {
                break;
            }
            if s.prefs_gen != gen {
                gen = s.prefs_gen;
                prefs = s.prefs.clone();
                poller.reset();
                s.bridge.reset();
                log(LOG_INFO, "session preferences changed, re-selecting media session");
            }
        }

        let sample = poller.poll(&prefs);
        let now = now_ms();
        {
            let mut s = shared.lock().unwrap();
            let msgs = s.bridge.handle_sample(&sample, now);
            for m in &msgs {
                if m["type"] == "trackChanged" {
                    log(
                        LOG_INFO,
                        &format!(
                            "{}: {} - {}{}",
                            m["playbackStatus"].as_str().unwrap_or(""),
                            m["artist"].as_str().unwrap_or(""),
                            m["title"].as_str().unwrap_or(""),
                            if m["artworkUrl"].as_str().map(|a| !a.is_empty()).unwrap_or(false) { " [art]" } else { "" }
                        ),
                    );
                }
            }
            s.outbox.extend(msgs);
            while s.outbox.len() > 50 {
                s.outbox.pop_front();
            }
        }

        // 1 s poll, in short steps so shutdown is prompt.
        for _ in 0..10 {
            if shared.lock().unwrap().stop {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    unsafe { CoUninitialize() };
    log(LOG_INFO, "media poller stopped");
}

// -------------------------------------------------------------------- audio

/// dB from the meter -> 0..1 for the bars, taking the loudest channel.
fn normalise(values: &[f32]) -> f32 {
    let mut best = 0.0f32;
    for &db in values {
        if !db.is_finite() || db <= FLOOR_DB {
            continue;
        }
        let v = ((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0);
        if v > best {
            best = v;
        }
    }
    best
}

/// Runs on an audio thread: only touch the atomics here.
unsafe extern "C" fn on_levels(
    param: *mut c_void,
    magnitude: *const f32,
    peak: *const f32,
    _input_peak: *const f32,
) {
    if param.is_null() || magnitude.is_null() || peak.is_null() {
        return;
    }
    let levels = &*(param as *const Levels);
    let level = normalise(std::slice::from_raw_parts(magnitude, MAX_AUDIO_CHANNELS));
    let pk = normalise(std::slice::from_raw_parts(peak, MAX_AUDIO_CHANNELS)).max(level);
    levels.level.store(level.to_bits(), Ordering::Relaxed);
    levels.peak.store(pk.to_bits(), Ordering::Relaxed);
    levels.seq.fetch_add(1, Ordering::Relaxed);
}

/// Names of every source OBS considers an audio source, for the picker.
pub unsafe fn audio_source_names() -> Vec<String> {
    unsafe extern "C" fn collect(param: *mut c_void, source: *mut obs_source_t) -> bool {
        let names = &mut *(param as *mut Vec<String>);
        if (api().obs_source_get_output_flags)(source) & OBS_SOURCE_AUDIO != 0 {
            let name = cstr_to_string((api().obs_source_get_name)(source));
            if !name.is_empty() {
                names.push(name);
            }
        }
        true
    }
    let mut names: Vec<String> = Vec::new();
    (api().obs_enum_sources)(Some(collect), &mut names as *mut _ as *mut c_void);
    names
}

// ------------------------------------------------------------------ context

impl Context {
    unsafe fn dispatch(&self, msg: &Value) {
        if self.browser.is_null() {
            return;
        }
        let api = api();
        let ph = (api.obs_source_get_proc_handler)(self.browser);
        if ph.is_null() {
            return;
        }
        let Ok(json) = CString::new(msg.to_string()) else { return };
        let mut cd = calldata_t { stack: std::ptr::null_mut(), size: 0, capacity: 0, fixed: false };
        (api.calldata_set_data)(&mut cd, c"eventName".as_ptr(), c"trax".as_ptr() as *const c_void, 5);
        (api.calldata_set_data)(&mut cd, c"jsonString".as_ptr(), json.as_ptr() as *const c_void, json.as_bytes_with_nul().len());
        let ok = (api.proc_handler_call)(ph, c"javascript_event".as_ptr(), &mut cd);
        if !cd.stack.is_null() {
            (api.bfree)(cd.stack as *mut c_void);
        }
        if !self.dispatch_logged.replace(true) {
            if ok {
                log(LOG_INFO, "overlay events are reaching the page");
            } else {
                log(LOG_ERROR, "obs-browser rejected javascript_event; the overlay will stay blank");
            }
        }
    }

    unsafe fn send_snapshot(&self, with_config: bool) {
        if with_config {
            self.dispatch(&json!({ "type": "configChanged", "config": self.config }));
        }
        let snap = self.shared.lock().unwrap().bridge.snapshot(now_ms());
        self.dispatch(&snap);
    }

    fn schedule_boot_resends(&mut self) {
        self.resend_at = BOOT_RESEND_S.iter().map(|d| self.clock + d).collect();
    }

    unsafe fn overlay_path() -> String {
        let dir = cstr_to_string((api().obs_get_module_data_path)(crate::module()));
        format!("{}/overlay.html", dir.trim_end_matches(['/', '\\']))
    }

    unsafe fn create_browser(&mut self) {
        let api = api();
        let path = Self::overlay_path();
        if !std::path::Path::new(&path).is_file() {
            log(LOG_ERROR, &format!("overlay.html not found at {path} — copy overlay.html/.css/.js into the plugin data folder"));
        }
        let s = (api.obs_data_create)();
        let file = CString::new(path.clone()).unwrap();
        (api.obs_data_set_bool)(s, c"is_local_file".as_ptr(), true);
        (api.obs_data_set_string)(s, c"local_file".as_ptr(), file.as_ptr());
        (api.obs_data_set_int)(s, c"width".as_ptr(), self.width as i64);
        (api.obs_data_set_int)(s, c"height".as_ptr(), self.height as i64);
        (api.obs_data_set_bool)(s, c"fps_custom".as_ptr(), false);
        (api.obs_data_set_bool)(s, c"shutdown".as_ptr(), false);
        (api.obs_data_set_bool)(s, c"restart_when_active".as_ptr(), false);
        (api.obs_data_set_bool)(s, c"reroute_audio".as_ptr(), false);
        self.browser = (api.obs_source_create_private)(c"browser_source".as_ptr(), c"trax-overlay".as_ptr(), s);
        (api.obs_data_release)(s);

        if self.browser.is_null() {
            log(LOG_ERROR, "could not create the browser_source child");
            return;
        }
        let id = cstr_to_string((api.obs_source_get_unversioned_id)(self.browser));
        if id != "browser_source" {
            log(LOG_WARNING, &format!("child source has id '{id}', obs-browser does not seem to be available"));
        }
        (api.obs_source_add_active_child)(self.source, self.browser);
        log(LOG_INFO, &format!("browser child created for {path} ({}x{})", self.width, self.height));
        self.schedule_boot_resends();
    }

    unsafe fn apply_settings(&mut self, settings: *mut obs_data_t) {
        let api = api();
        let (w, h) = config::read_size(settings);
        let resized = (w, h) != (self.width, self.height);
        self.width = w;
        self.height = h;

        if self.browser.is_null() {
            self.create_browser();
        } else if resized {
            let s = (api.obs_data_create)();
            (api.obs_data_set_int)(s, c"width".as_ptr(), w as i64);
            (api.obs_data_set_int)(s, c"height".as_ptr(), h as i64);
            (api.obs_source_update)(self.browser, s);
            (api.obs_data_release)(s);
        }

        self.apply_audio_settings(settings);

        self.config = config::read_config(settings);
        let prefs = config::read_prefs(settings);
        {
            let mut sh = self.shared.lock().unwrap();
            if sh.prefs != prefs {
                sh.prefs = prefs;
                sh.prefs_gen += 1;
            }
        }
        self.dispatch(&json!({ "type": "configChanged", "config": self.config }));
    }

    fn queue(&self, msg: Value) {
        self.shared.lock().unwrap().outbox.push_back(msg);
    }

    unsafe fn apply_audio_settings(&mut self, settings: *mut obs_data_t) {
        let (enabled, name) = config::read_audio(settings);
        let changed = enabled != self.audio_reactive || name != self.audio_source;
        self.audio_reactive = enabled;
        self.audio_source = name;
        if !changed {
            return;
        }

        self.detach_audio();
        if !enabled {
            return;
        }

        let api = api();
        if self.volmeter.is_null() {
            self.volmeter = (api.obs_volmeter_create)(OBS_FADER_LOG);
            if self.volmeter.is_null() {
                log(LOG_ERROR, "could not create a volume meter; the bars will keep idling");
                return;
            }
            (api.obs_volmeter_add_callback)(self.volmeter, Some(on_levels), self.levels as *mut c_void);
        }
        // Attempt it now; video_tick retries while this fails, since the picked
        // source may not have loaded yet.
        self.attach_retry_at = self.clock;
    }

    unsafe fn detach_audio(&mut self) {
        if !self.volmeter.is_null() && self.audio_attached {
            (api().obs_volmeter_detach_source)(self.volmeter);
        }
        self.audio_attached = false;
    }

    unsafe fn try_attach_audio(&mut self) {
        if self.volmeter.is_null() {
            return;
        }
        let api = api();
        let wanted = self.audio_source.clone();
        let name = if wanted.is_empty() {
            match audio_source_names().into_iter().next() {
                Some(n) => n,
                None => return,
            }
        } else {
            wanted
        };

        let c = match CString::new(name.clone()) {
            Ok(c) => c,
            Err(_) => return,
        };
        let src = (api.obs_get_source_by_name)(c.as_ptr());
        if src.is_null() {
            return;
        }
        self.audio_attached = (api.obs_volmeter_attach_source)(self.volmeter, src);
        (api.obs_source_release)(src);

        if self.audio_attached {
            log(LOG_INFO, &format!("equalizer is following audio from '{name}'"));
        }
    }

    /// Forward the newest level, at most every LEVEL_INTERVAL_S.
    unsafe fn pump_levels(&mut self) {
        if !self.audio_reactive {
            return;
        }
        if !self.audio_attached {
            if self.clock >= self.attach_retry_at {
                self.attach_retry_at = self.clock + ATTACH_RETRY_S;
                self.try_attach_audio();
            }
            return;
        }
        let (level, peak, seq) = (*self.levels).get();
        if seq == self.last_level_seq || self.clock - self.last_level_at < LEVEL_INTERVAL_S {
            return;
        }
        self.last_level_seq = seq;
        self.last_level_at = self.clock;
        if level > 0.0 && !self.level_logged.replace(true) {
            log(LOG_INFO, &format!("audio levels are driving the bars (first level {level:.2})"));
        }
        self.dispatch(&json!({ "type": "levels", "level": level, "peak": peak }));
    }
}

// ------------------------------------------------------------ obs callbacks

unsafe extern "C" fn get_name(_type_data: *mut c_void) -> *const std::ffi::c_char {
    c"TRAX Now Playing".as_ptr()
}

unsafe extern "C" fn create(settings: *mut obs_data_t, source: *mut obs_source_t) -> *mut c_void {
    guard("create", std::ptr::null_mut(), || {
        let shared = Arc::new(Mutex::new(Shared {
            bridge: Bridge::new(),
            outbox: VecDeque::new(),
            prefs: config::read_prefs(settings),
            prefs_gen: 0,
            stop: false,
        }));
        let worker_shared = shared.clone();
        let worker = thread::Builder::new()
            .name("trax-smtc".into())
            .spawn(move || worker_loop(worker_shared))
            .ok();

        let mut ctx = Box::new(Context {
            source,
            browser: std::ptr::null_mut(),
            width: 0,
            height: 0,
            config: Value::Null,
            shared,
            worker,
            clock: 0.0,
            resend_at: Vec::new(),
            next_heartbeat: HEARTBEAT_S,
            volmeter: std::ptr::null_mut(),
            levels: Box::into_raw(Box::new(Levels::new())),
            audio_reactive: false,
            audio_source: String::new(),
            audio_attached: false,
            attach_retry_at: 0.0,
            last_level_at: 0.0,
            last_level_seq: 0,
            dispatch_logged: std::cell::Cell::new(false),
            level_logged: std::cell::Cell::new(false),
        });
        ctx.apply_settings(settings);
        let ptr = Box::into_raw(ctx);
        INSTANCES.lock().unwrap().push(ptr as usize);
        ptr as *mut c_void
    })
}

unsafe extern "C" fn destroy(data: *mut c_void) {
    guard("destroy", (), || {
        INSTANCES.lock().unwrap().retain(|&p| p != data as usize);
        let mut ctx = Box::from_raw(data as *mut Context);
        ctx.shared.lock().unwrap().stop = true;
        if let Some(w) = ctx.worker.take() {
            let _ = w.join();
        }
        if !ctx.browser.is_null() {
            let api = api();
            (api.obs_source_remove_active_child)(ctx.source, ctx.browser);
            (api.obs_source_release)(ctx.browser);
            ctx.browser = std::ptr::null_mut();
        }

        // Unhook the meter before the memory its callback reads goes away.
        ctx.detach_audio();
        if !ctx.volmeter.is_null() {
            let api = api();
            (api.obs_volmeter_remove_callback)(ctx.volmeter, Some(on_levels), ctx.levels as *mut c_void);
            (api.obs_volmeter_destroy)(ctx.volmeter);
            ctx.volmeter = std::ptr::null_mut();
        }
        if !ctx.levels.is_null() {
            drop(Box::from_raw(ctx.levels));
            ctx.levels = std::ptr::null_mut();
        }
    })
}

unsafe extern "C" fn get_width(data: *mut c_void) -> u32 {
    (*(data as *mut Context)).width
}

unsafe extern "C" fn get_height(data: *mut c_void) -> u32 {
    (*(data as *mut Context)).height
}

unsafe extern "C" fn get_defaults(settings: *mut obs_data_t) {
    guard("get_defaults", (), || config::set_defaults(settings))
}

unsafe extern "C" fn update(data: *mut c_void, settings: *mut obs_data_t) {
    guard("update", (), || (*(data as *mut Context)).apply_settings(settings))
}

unsafe extern "C" fn video_tick(data: *mut c_void, seconds: f32) {
    guard("video_tick", (), || {
        let ctx = &mut *(data as *mut Context);
        ctx.clock += seconds;

        while let Some(&t) = ctx.resend_at.first() {
            if ctx.clock < t {
                break;
            }
            ctx.resend_at.remove(0);
            ctx.send_snapshot(true);
        }

        if ctx.clock >= ctx.next_heartbeat {
            ctx.next_heartbeat = ctx.clock + HEARTBEAT_S;
            ctx.send_snapshot(false);
        }

        let msgs: Vec<Value> = ctx.shared.lock().unwrap().outbox.drain(..).collect();
        for m in &msgs {
            ctx.dispatch(m);
        }

        ctx.pump_levels();
    })
}

unsafe extern "C" fn video_render(data: *mut c_void, _effect: *mut gs_effect_t) {
    let ctx = &*(data as *mut Context);
    if !ctx.browser.is_null() {
        (api().obs_source_video_render)(ctx.browser);
    }
}

unsafe extern "C" fn enum_active_sources(data: *mut c_void, cb: obs_source_enum_proc_t, param: *mut c_void) {
    let ctx = &*(data as *mut Context);
    if let (Some(cb), false) = (cb, ctx.browser.is_null()) {
        cb(ctx.source, ctx.browser, param);
    }
}

/// Resolve the `data` a button callback receives to one of our contexts. The
/// frontend passes the obs_source_t*; obs_obj_get_data turns that into our
/// private data. Both forms are accepted, and anything unrecognised is ignored.
unsafe fn context_from_button_data(data: *mut c_void) -> Option<&'static Context> {
    if data.is_null() {
        return None;
    }
    let live = INSTANCES.lock().unwrap();
    if live.contains(&(data as usize)) {
        return Some(&*(data as *const Context));
    }
    let via_obj = (api().obs_obj_get_data)(data);
    if !via_obj.is_null() && live.contains(&(via_obj as usize)) {
        return Some(&*(via_obj as *const Context));
    }
    None
}

unsafe extern "C" fn on_test(_p: *mut obs_properties_t, _prop: *mut obs_property_t, data: *mut c_void) -> bool {
    guard("test button", false, || {
        if let Some(ctx) = context_from_button_data(data) {
            ctx.queue(json!({
                "type": "trackChanged",
                "trackId": format!("test-{}", now_ms()),
                "title": "Test Track",
                "artist": "Test Artist",
                "album": "",
                "sourceApp": "Test",
                "artworkUrl": "",
                "playbackStatus": "playing",
                "positionSeconds": 0,
                "durationSeconds": 210,
            }));
        }
        false
    })
}

unsafe extern "C" fn on_show(_p: *mut obs_properties_t, _prop: *mut obs_property_t, data: *mut c_void) -> bool {
    guard("show button", false, || {
        if let Some(ctx) = context_from_button_data(data) {
            ctx.queue(json!({ "type": "show" }));
        }
        false
    })
}

unsafe extern "C" fn on_hide(_p: *mut obs_properties_t, _prop: *mut obs_property_t, data: *mut c_void) -> bool {
    guard("hide button", false, || {
        if let Some(ctx) = context_from_button_data(data) {
            ctx.queue(json!({ "type": "hide" }));
        }
        false
    })
}

unsafe extern "C" fn get_properties(data: *mut c_void) -> *mut obs_properties_t {
    guard("get_properties", std::ptr::null_mut(), || {
        let sessions = if data.is_null() {
            Vec::new()
        } else {
            (*(data as *mut Context)).shared.lock().unwrap().bridge.sessions.clone()
        };
        config::build_properties(
            &sessions,
            &audio_source_names(),
            config::Buttons { test: Some(on_test), show: Some(on_show), hide: Some(on_hide) },
        )
    })
}

// --------------------------------------------------------------- register

static INFO: OnceLock<obs_source_info> = OnceLock::new();

pub fn register() {
    let info = INFO.get_or_init(|| {
        let mut i = obs_source_info::zeroed();
        i.id = SOURCE_ID.as_ptr();
        i.type_ = OBS_SOURCE_TYPE_INPUT;
        i.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_DO_NOT_DUPLICATE;
        i.icon_type = OBS_ICON_TYPE_MEDIA;
        i.get_name = Some(get_name);
        i.create = Some(create);
        i.destroy = Some(destroy);
        i.get_width = Some(get_width);
        i.get_height = Some(get_height);
        i.get_defaults = Some(get_defaults);
        i.get_properties = Some(get_properties);
        i.update = Some(update);
        i.video_tick = Some(video_tick);
        i.video_render = Some(video_render);
        i.enum_active_sources = Some(enum_active_sources);
        i
    });
    unsafe { (api().obs_register_source_s)(info, std::mem::size_of::<obs_source_info>()) };
}
