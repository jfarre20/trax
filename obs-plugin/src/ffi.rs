//! Hand-declared bindings to the slice of libobs this plugin uses.
//!
//! Resolved at runtime from obs.dll with GetProcAddress rather than linked
//! against an import library, so the build needs no OBS SDK on the box and the
//! same DLL works with any OBS whose exports and struct layouts match. Layouts
//! were taken from obs-studio 30.2.2 headers (obs-source.h, calldata.h).

#![allow(non_camel_case_types, dead_code)]

use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::OnceLock;

use windows::core::{w, PCSTR};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

macro_rules! opaque {
    ($($n:ident),*) => { $( #[repr(C)] pub struct $n { _p: [u8; 0] } )* };
}
opaque!(
    obs_source_t, obs_data_t, obs_properties_t, obs_property_t, obs_module_t,
    proc_handler_t, gs_effect_t, obs_volmeter_t
);

/// Levels arrive as dB per channel (libobs runs them through mul_to_db before
/// the callback), with silence reported as a large negative or non-finite value.
pub type obs_volmeter_updated_t = Option<
    unsafe extern "C" fn(
        param: *mut c_void,
        magnitude: *const f32,
        peak: *const f32,
        input_peak: *const f32,
    ),
>;
pub type obs_enum_sources_proc_t =
    Option<unsafe extern "C" fn(param: *mut c_void, source: *mut obs_source_t) -> bool>;

pub const MAX_AUDIO_CHANNELS: usize = 8;
pub const OBS_FADER_LOG: i32 = 2;

pub type obs_source_enum_proc_t =
    Option<unsafe extern "C" fn(parent: *mut obs_source_t, child: *mut obs_source_t, param: *mut c_void)>;
pub type obs_property_clicked_t =
    Option<unsafe extern "C" fn(props: *mut obs_properties_t, property: *mut obs_property_t, data: *mut c_void) -> bool>;

pub const OBS_SOURCE_TYPE_INPUT: i32 = 0;
pub const OBS_SOURCE_VIDEO: u32 = 1 << 0;
pub const OBS_SOURCE_AUDIO: u32 = 1 << 1;
pub const OBS_SOURCE_CUSTOM_DRAW: u32 = 1 << 3;
pub const OBS_SOURCE_DO_NOT_DUPLICATE: u32 = 1 << 7;
pub const OBS_ICON_TYPE_MEDIA: i32 = 11;

pub const OBS_COMBO_TYPE_EDITABLE: i32 = 1;
pub const OBS_COMBO_TYPE_LIST: i32 = 2;
pub const OBS_COMBO_FORMAT_STRING: i32 = 3;
pub const OBS_TEXT_DEFAULT: i32 = 0;
pub const OBS_GROUP_NORMAL: i32 = 1;

pub const LOG_ERROR: i32 = 100;
pub const LOG_WARNING: i32 = 200;
pub const LOG_INFO: i32 = 300;
pub const LOG_DEBUG: i32 = 400;

/// struct obs_source_info, obs-studio 30.2.2. Every field is present so the
/// size handed to obs_register_source_s is right; unused ones stay None.
#[repr(C)]
pub struct obs_source_info {
    pub id: *const c_char,
    pub type_: i32,
    pub output_flags: u32,
    pub get_name: Option<unsafe extern "C" fn(type_data: *mut c_void) -> *const c_char>,
    pub create: Option<unsafe extern "C" fn(settings: *mut obs_data_t, source: *mut obs_source_t) -> *mut c_void>,
    pub destroy: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub get_width: Option<unsafe extern "C" fn(data: *mut c_void) -> u32>,
    pub get_height: Option<unsafe extern "C" fn(data: *mut c_void) -> u32>,
    pub get_defaults: Option<unsafe extern "C" fn(settings: *mut obs_data_t)>,
    pub get_properties: Option<unsafe extern "C" fn(data: *mut c_void) -> *mut obs_properties_t>,
    pub update: Option<unsafe extern "C" fn(data: *mut c_void, settings: *mut obs_data_t)>,
    pub activate: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub deactivate: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub show: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub hide: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub video_tick: Option<unsafe extern "C" fn(data: *mut c_void, seconds: f32)>,
    pub video_render: Option<unsafe extern "C" fn(data: *mut c_void, effect: *mut gs_effect_t)>,
    pub filter_video: Option<unsafe extern "C" fn(data: *mut c_void, frame: *mut c_void) -> *mut c_void>,
    pub filter_audio: Option<unsafe extern "C" fn(data: *mut c_void, audio: *mut c_void) -> *mut c_void>,
    pub enum_active_sources: Option<unsafe extern "C" fn(data: *mut c_void, cb: obs_source_enum_proc_t, param: *mut c_void)>,
    pub save: Option<unsafe extern "C" fn(data: *mut c_void, settings: *mut obs_data_t)>,
    pub load: Option<unsafe extern "C" fn(data: *mut c_void, settings: *mut obs_data_t)>,
    pub mouse_click: Option<unsafe extern "C" fn(data: *mut c_void, event: *const c_void, type_: i32, mouse_up: bool, click_count: u32)>,
    pub mouse_move: Option<unsafe extern "C" fn(data: *mut c_void, event: *const c_void, mouse_leave: bool)>,
    pub mouse_wheel: Option<unsafe extern "C" fn(data: *mut c_void, event: *const c_void, x_delta: i32, y_delta: i32)>,
    pub focus: Option<unsafe extern "C" fn(data: *mut c_void, focus: bool)>,
    pub key_click: Option<unsafe extern "C" fn(data: *mut c_void, event: *const c_void, key_up: bool)>,
    pub filter_remove: Option<unsafe extern "C" fn(data: *mut c_void, source: *mut obs_source_t)>,
    pub type_data: *mut c_void,
    pub free_type_data: Option<unsafe extern "C" fn(type_data: *mut c_void)>,
    pub audio_render: Option<unsafe extern "C" fn(data: *mut c_void, ts_out: *mut u64, audio_output: *mut c_void, mixers: u32, channels: usize, sample_rate: usize) -> bool>,
    pub enum_all_sources: Option<unsafe extern "C" fn(data: *mut c_void, cb: obs_source_enum_proc_t, param: *mut c_void)>,
    pub transition_start: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub transition_stop: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub get_defaults2: Option<unsafe extern "C" fn(type_data: *mut c_void, settings: *mut obs_data_t)>,
    pub get_properties2: Option<unsafe extern "C" fn(data: *mut c_void, type_data: *mut c_void) -> *mut obs_properties_t>,
    pub audio_mix: Option<unsafe extern "C" fn(data: *mut c_void, ts_out: *mut u64, audio_output: *mut c_void, channels: usize, sample_rate: usize) -> bool>,
    pub icon_type: i32,
    pub media_play_pause: Option<unsafe extern "C" fn(data: *mut c_void, pause: bool)>,
    pub media_restart: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub media_stop: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub media_next: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub media_previous: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub media_get_duration: Option<unsafe extern "C" fn(data: *mut c_void) -> i64>,
    pub media_get_time: Option<unsafe extern "C" fn(data: *mut c_void) -> i64>,
    pub media_set_time: Option<unsafe extern "C" fn(data: *mut c_void, ms: i64)>,
    pub media_get_state: Option<unsafe extern "C" fn(data: *mut c_void) -> i32>,
    pub version: u32,
    pub unversioned_id: *const c_char,
    pub missing_files: Option<unsafe extern "C" fn(data: *mut c_void) -> *mut c_void>,
    pub video_get_color_space: Option<unsafe extern "C" fn(data: *mut c_void, count: usize, preferred: *const i32) -> i32>,
    pub filter_add: Option<unsafe extern "C" fn(data: *mut c_void, source: *mut obs_source_t)>,
}

impl obs_source_info {
    pub const fn zeroed() -> Self {
        // All-zero is a valid value: null pointers and None everywhere.
        unsafe { std::mem::zeroed() }
    }
}

// Handed to OBS once from obs_module_load; the pointers inside are static
// strings, so sharing the static across threads is fine.
unsafe impl Sync for obs_source_info {}
unsafe impl Send for obs_source_info {}

/// struct calldata, callback/calldata.h.
#[repr(C)]
pub struct calldata_t {
    pub stack: *mut u8,
    pub size: usize,
    pub capacity: usize,
    pub fixed: bool,
}

macro_rules! api {
    ($( fn $name:ident ( $($arg:ident : $ty:ty),* $(,)? ) $(-> $ret:ty)? ; )*) => {
        pub struct Api {
            $( pub $name: unsafe extern "C" fn($($arg: $ty),*) $(-> $ret)?, )*
            pub blog: unsafe extern "C" fn(level: i32, format: *const c_char, ...),
        }
        impl Api {
            unsafe fn load() -> Result<Api, String> {
                let h = GetModuleHandleW(w!("obs.dll"))
                    .map_err(|e| format!("obs.dll is not loaded in this process: {e}"))?;
                let sym = |name: &'static str| -> Result<usize, String> {
                    let c = CString::new(name).unwrap();
                    GetProcAddress(h, PCSTR(c.as_ptr() as *const u8))
                        .map(|f| f as usize)
                        .ok_or_else(|| format!("obs.dll has no export '{name}'"))
                };
                Ok(Api {
                    $( $name: std::mem::transmute::<usize, unsafe extern "C" fn($($arg: $ty),*) $(-> $ret)?>(sym(stringify!($name))?), )*
                    blog: std::mem::transmute::<usize, unsafe extern "C" fn(i32, *const c_char, ...)>(sym("blog")?),
                })
            }
        }
    };
}

api! {
    fn obs_get_version_string() -> *const c_char;
    fn obs_register_source_s(info: *const obs_source_info, size: usize);
    fn obs_get_module_data_path(module: *mut obs_module_t) -> *const c_char;
    fn obs_obj_get_data(obj: *mut c_void) -> *mut c_void;

    fn obs_source_create_private(id: *const c_char, name: *const c_char, settings: *mut obs_data_t) -> *mut obs_source_t;
    fn obs_source_release(source: *mut obs_source_t);
    fn obs_source_update(source: *mut obs_source_t, settings: *mut obs_data_t);
    fn obs_source_video_render(source: *mut obs_source_t);
    fn obs_source_get_width(source: *mut obs_source_t) -> u32;
    fn obs_source_get_height(source: *mut obs_source_t) -> u32;
    fn obs_source_get_name(source: *const obs_source_t) -> *const c_char;
    fn obs_source_get_unversioned_id(source: *const obs_source_t) -> *const c_char;
    fn obs_source_get_proc_handler(source: *const obs_source_t) -> *mut proc_handler_t;
    fn obs_source_add_active_child(parent: *mut obs_source_t, child: *mut obs_source_t) -> bool;
    fn obs_source_remove_active_child(parent: *mut obs_source_t, child: *mut obs_source_t);

    fn obs_enum_sources(proc_: obs_enum_sources_proc_t, param: *mut c_void);
    fn obs_get_source_by_name(name: *const c_char) -> *mut obs_source_t;
    fn obs_source_get_output_flags(source: *const obs_source_t) -> u32;

    fn obs_volmeter_create(type_: i32) -> *mut obs_volmeter_t;
    fn obs_volmeter_destroy(volmeter: *mut obs_volmeter_t);
    fn obs_volmeter_attach_source(volmeter: *mut obs_volmeter_t, source: *mut obs_source_t) -> bool;
    fn obs_volmeter_detach_source(volmeter: *mut obs_volmeter_t);
    fn obs_volmeter_add_callback(volmeter: *mut obs_volmeter_t, cb: obs_volmeter_updated_t, param: *mut c_void);
    fn obs_volmeter_remove_callback(volmeter: *mut obs_volmeter_t, cb: obs_volmeter_updated_t, param: *mut c_void);

    fn proc_handler_call(handler: *mut proc_handler_t, name: *const c_char, params: *mut calldata_t) -> bool;
    fn calldata_set_data(data: *mut calldata_t, name: *const c_char, in_: *const c_void, size: usize);
    fn bfree(ptr: *mut c_void);

    fn obs_data_create() -> *mut obs_data_t;
    fn obs_data_release(data: *mut obs_data_t);
    fn obs_data_set_string(data: *mut obs_data_t, name: *const c_char, val: *const c_char);
    fn obs_data_set_int(data: *mut obs_data_t, name: *const c_char, val: i64);
    fn obs_data_set_double(data: *mut obs_data_t, name: *const c_char, val: f64);
    fn obs_data_set_bool(data: *mut obs_data_t, name: *const c_char, val: bool);
    fn obs_data_set_default_string(data: *mut obs_data_t, name: *const c_char, val: *const c_char);
    fn obs_data_set_default_int(data: *mut obs_data_t, name: *const c_char, val: i64);
    fn obs_data_set_default_double(data: *mut obs_data_t, name: *const c_char, val: f64);
    fn obs_data_set_default_bool(data: *mut obs_data_t, name: *const c_char, val: bool);
    fn obs_data_get_string(data: *mut obs_data_t, name: *const c_char) -> *const c_char;
    fn obs_data_get_int(data: *mut obs_data_t, name: *const c_char) -> i64;
    fn obs_data_get_double(data: *mut obs_data_t, name: *const c_char) -> f64;
    fn obs_data_get_bool(data: *mut obs_data_t, name: *const c_char) -> bool;

    fn obs_properties_create() -> *mut obs_properties_t;
    fn obs_properties_add_bool(props: *mut obs_properties_t, name: *const c_char, desc: *const c_char) -> *mut obs_property_t;
    fn obs_properties_add_int(props: *mut obs_properties_t, name: *const c_char, desc: *const c_char, min: i32, max: i32, step: i32) -> *mut obs_property_t;
    fn obs_properties_add_int_slider(props: *mut obs_properties_t, name: *const c_char, desc: *const c_char, min: i32, max: i32, step: i32) -> *mut obs_property_t;
    fn obs_properties_add_float_slider(props: *mut obs_properties_t, name: *const c_char, desc: *const c_char, min: f64, max: f64, step: f64) -> *mut obs_property_t;
    fn obs_properties_add_text(props: *mut obs_properties_t, name: *const c_char, desc: *const c_char, type_: i32) -> *mut obs_property_t;
    fn obs_properties_add_list(props: *mut obs_properties_t, name: *const c_char, desc: *const c_char, type_: i32, format: i32) -> *mut obs_property_t;
    fn obs_properties_add_color(props: *mut obs_properties_t, name: *const c_char, desc: *const c_char) -> *mut obs_property_t;
    fn obs_properties_add_button(props: *mut obs_properties_t, name: *const c_char, text: *const c_char, cb: obs_property_clicked_t) -> *mut obs_property_t;
    fn obs_properties_add_group(props: *mut obs_properties_t, name: *const c_char, desc: *const c_char, type_: i32, group: *mut obs_properties_t) -> *mut obs_property_t;
    fn obs_property_list_add_string(p: *mut obs_property_t, name: *const c_char, val: *const c_char) -> usize;
    fn obs_property_set_long_description(p: *mut obs_property_t, desc: *const c_char);
    fn obs_property_int_set_suffix(p: *mut obs_property_t, suffix: *const c_char);
    fn obs_property_float_set_suffix(p: *mut obs_property_t, suffix: *const c_char);
}

static API: OnceLock<Api> = OnceLock::new();

/// Resolve every symbol once. Called from obs_module_load; a failure there
/// means this OBS build is not one we can talk to.
pub fn init() -> Result<(), String> {
    if API.get().is_some() {
        return Ok(());
    }
    let api = unsafe { Api::load()? };
    let _ = API.set(api);
    Ok(())
}

pub fn api() -> &'static Api {
    API.get().expect("libobs API used before obs_module_load")
}

pub fn log(level: i32, msg: &str) {
    // Falls back to stderr when there is no libobs — before obs_module_load,
    // and in the standalone example that exercises the poller.
    let Some(api) = API.get() else {
        eprintln!("[trax] {msg}");
        return;
    };
    let text = CString::new(msg.replace('\0', " ")).unwrap();
    unsafe { (api.blog)(level, c"[trax] %s".as_ptr(), text.as_ptr()) }
}

pub unsafe fn cstr_to_string(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}
