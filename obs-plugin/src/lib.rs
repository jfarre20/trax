//! TRAX as an OBS plugin. Exports the handful of symbols OBS's module loader
//! looks for (obs_module_set_pointer, obs_module_ver, obs_module_load) and
//! registers the "TRAX Now Playing" source.

// Public so `examples/poll.rs` can drive the media pipeline without OBS.
pub mod bridge;
pub mod detector;
pub mod ffi;
pub mod smtc;

mod config;
mod source;

use std::ffi::c_char;
use std::sync::atomic::{AtomicPtr, Ordering};

use ffi::obs_module_t;

static MODULE: AtomicPtr<obs_module_t> = AtomicPtr::new(std::ptr::null_mut());

pub(crate) fn module() -> *mut obs_module_t {
    MODULE.load(Ordering::Relaxed)
}

// LIBOBS_API_VER for 30.2.2: (major << 24) | (minor << 16) | patch. The loader
// only requires the export to exist; the value is informational.
const LIBOBS_API_VER: u32 = (30 << 24) | (2 << 16) | 2;

#[no_mangle]
pub extern "C" fn obs_module_set_pointer(module: *mut obs_module_t) {
    MODULE.store(module, Ordering::Relaxed);
}

#[no_mangle]
pub extern "C" fn obs_module_ver() -> u32 {
    LIBOBS_API_VER
}

#[no_mangle]
pub extern "C" fn obs_module_name() -> *const c_char {
    c"TRAX Now Playing".as_ptr()
}

#[no_mangle]
pub extern "C" fn obs_module_description() -> *const c_char {
    c"EA Trax-style now-playing overlay driven by Windows media sessions".as_ptr()
}

#[no_mangle]
pub extern "C" fn obs_module_load() -> bool {
    if let Err(e) = ffi::init() {
        // No libobs to log through yet; stderr is the best we have.
        eprintln!("[trax] {e}");
        return false;
    }
    let obs_ver = unsafe { ffi::cstr_to_string((ffi::api().obs_get_version_string)()) };
    ffi::log(ffi::LOG_INFO, &format!("plugin {} loading (OBS {obs_ver})", env!("CARGO_PKG_VERSION")));
    source::register();
    true
}

#[no_mangle]
pub extern "C" fn obs_module_unload() {
    ffi::log(ffi::LOG_INFO, "plugin unloaded");
}
