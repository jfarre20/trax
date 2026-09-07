//! Source settings <-> overlay config.
//!
//! The overlay is configured by the same JSON object the web version's
//! config page produced (see ../config-store.js for the schema). Here each key
//! is an OBS property on the source, and `read_config` folds the settings back
//! into that JSON. Keys the web version needed for its server (bind, obs*,
//! audioReactive) are left at their defaults.

use std::ffi::{c_char, CString};

use serde_json::{Map, Value};

use crate::ffi::*;
use crate::smtc::{Prefs, SessionInfo};

const DEFAULTS_JSON: &str = include_str!("../../config.default.json");

/// The source is sized to the card, not to the canvas, so it gets a tight
/// bounding box that can be dragged and scaled with OBS's own transform. A
/// little slack beyond the card's natural size leaves room for the glows, the
/// shake overshoot and the badge's drop.
/// Sized for the defaults: the equalizer plus a card at the default 620 px max
/// width is about 690 px across and 150 px tall, and the collapsed badge drops
/// another 50 px. Anything longer than that is the viewer's to raise.
pub const DEFAULT_WIDTH: i64 = 760;
pub const DEFAULT_HEIGHT: i64 = 220;

/// Inside that box the card always sits at the top-left. Positioning is OBS's
/// job, so the overlay's own anchor and offsets are fixed rather than exposed
/// as properties that would fight the source transform.
const INSET: i64 = 8;

#[derive(Clone, Copy)]
enum Kind {
    Bool,
    Int,
    Float,
    Str,
    /// Stored by OBS as 0xAABBGGRR; the overlay wants "#rrggbb".
    Color,
    /// Comma-separated text -> JSON array of strings.
    Apps,
}

const KEYS: &[(&str, Kind)] = &[
    ("scale", Kind::Float),
    ("maxWidth", Kind::Int),
    ("holdSeconds", Kind::Float),
    ("animSpeed", Kind::Float),
    ("compactMode", Kind::Bool),
    ("alwaysVisible", Kind::Bool),
    ("showArt", Kind::Bool),
    ("showArtist", Kind::Bool),
    ("showAlbum", Kind::Bool),
    ("showSource", Kind::Bool),
    ("showProgress", Kind::Bool),
    ("showTime", Kind::Bool),
    ("showWhenPaused", Kind::Bool),
    ("retriggerOnResume", Kind::Bool),
    ("miniSeconds", Kind::Float),
    ("minPauseSeconds", Kind::Float),
    ("textCase", Kind::Str),
    ("titleMaxLength", Kind::Int),
    ("marquee", Kind::Bool),
    ("accent", Kind::Color),
    ("accent2", Kind::Color),
    ("panelOpacity", Kind::Float),
    ("scanlines", Kind::Float),
    ("noise", Kind::Float),
    ("shake", Kind::Float),
    ("fontFamily", Kind::Str),
    ("artAccent", Kind::Bool),
    ("debug", Kind::Bool),
    ("preferredApp", Kind::Str),
    ("ignoredApps", Kind::Apps),
    ("exitStyle", Kind::Str),
    ("badgeMark", Kind::Str),
    ("badgeTitle", Kind::Bool),
    ("badgeDropY", Kind::Int),
    ("badgeDropDelay", Kind::Float),
    ("audioReactive", Kind::Bool),
    ("obsSource", Kind::Str),
];

fn defaults() -> Map<String, Value> {
    match serde_json::from_str::<Value>(DEFAULTS_JSON) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

fn cs(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap()
}

fn hex_to_obs_color(hex: &str) -> i64 {
    let h = hex.trim_start_matches('#');
    let (r, g, b) = match h.len() {
        3 => {
            let d = |i: usize| u8::from_str_radix(&h[i..i + 1].repeat(2), 16).unwrap_or(0);
            (d(0), d(1), d(2))
        }
        6 | 8 => {
            let d = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0);
            (d(0), d(2), d(4))
        }
        _ => (255, 106, 0),
    };
    0xff00_0000 | ((b as i64) << 16) | ((g as i64) << 8) | r as i64
}

fn obs_color_to_hex(v: i64) -> String {
    let r = v & 0xff;
    let g = (v >> 8) & 0xff;
    let b = (v >> 16) & 0xff;
    format!("#{r:02x}{g:02x}{b:02x}")
}

pub unsafe fn set_defaults(settings: *mut obs_data_t) {
    let api = api();
    let d = defaults();
    (api.obs_data_set_default_int)(settings, c"width".as_ptr(), DEFAULT_WIDTH);
    (api.obs_data_set_default_int)(settings, c"height".as_ptr(), DEFAULT_HEIGHT);
    for (key, kind) in KEYS {
        let name = cs(key);
        let v = d.get(*key);
        match kind {
            Kind::Bool => (api.obs_data_set_default_bool)(settings, name.as_ptr(), v.and_then(Value::as_bool).unwrap_or(false)),
            Kind::Int => (api.obs_data_set_default_int)(settings, name.as_ptr(), v.and_then(Value::as_f64).unwrap_or(0.0) as i64),
            Kind::Float => (api.obs_data_set_default_double)(settings, name.as_ptr(), v.and_then(Value::as_f64).unwrap_or(0.0)),
            Kind::Str => {
                let s = cs(v.and_then(Value::as_str).unwrap_or(""));
                (api.obs_data_set_default_string)(settings, name.as_ptr(), s.as_ptr());
            }
            Kind::Color => {
                let hex = v.and_then(Value::as_str).unwrap_or("#ff6a00");
                (api.obs_data_set_default_int)(settings, name.as_ptr(), hex_to_obs_color(hex));
            }
            Kind::Apps => {
                let joined = v
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
                    .unwrap_or_default();
                let s = cs(&joined);
                (api.obs_data_set_default_string)(settings, name.as_ptr(), s.as_ptr());
            }
        }
    }
}

pub unsafe fn read_size(settings: *mut obs_data_t) -> (u32, u32) {
    let api = api();
    let w = (api.obs_data_get_int)(settings, c"width".as_ptr()).clamp(1, 16384) as u32;
    let h = (api.obs_data_get_int)(settings, c"height".as_ptr()).clamp(1, 16384) as u32;
    (w, h)
}

unsafe fn get_string(settings: *mut obs_data_t, name: *const c_char) -> String {
    cstr_to_string((api().obs_data_get_string)(settings, name))
}

fn split_apps(text: &str) -> Vec<Value> {
    text.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 80)
        .take(20)
        .map(|s| Value::String(s.to_string()))
        .collect()
}

/// The full overlay config object, starting from the shipped defaults so every
/// key the page reads is present.
pub unsafe fn read_config(settings: *mut obs_data_t) -> Value {
    let api = api();
    let mut out = defaults();
    for (key, kind) in KEYS {
        let name = cs(key);
        let v = match kind {
            Kind::Bool => Value::Bool((api.obs_data_get_bool)(settings, name.as_ptr())),
            Kind::Int => Value::from((api.obs_data_get_int)(settings, name.as_ptr())),
            Kind::Float => Value::from((api.obs_data_get_double)(settings, name.as_ptr())),
            Kind::Str => Value::String(get_string(settings, name.as_ptr())),
            Kind::Color => Value::String(obs_color_to_hex((api.obs_data_get_int)(settings, name.as_ptr()))),
            Kind::Apps => Value::Array(split_apps(&get_string(settings, name.as_ptr()))),
        };
        out.insert(key.to_string(), v);
    }
    // The card is pinned to the top-left of a card-sized source; the viewer
    // moves it with OBS's transform instead of with these.
    out.insert("position".into(), Value::String("top-left".into()));
    out.insert("offsetX".into(), Value::from(INSET));
    out.insert("offsetY".into(), Value::from(INSET));

    // Server-only keys in the web version; make them explicit here.
    out.insert("bind".into(), Value::String("127.0.0.1".into()));
    out.insert("logoUrl".into(), Value::String(String::new()));
    Value::Object(out)
}

/// (bars follow audio, mixer input name — empty means "first audio source")
pub unsafe fn read_audio(settings: *mut obs_data_t) -> (bool, String) {
    let enabled = (api().obs_data_get_bool)(settings, c"audioReactive".as_ptr());
    (enabled, get_string(settings, c"obsSource".as_ptr()))
}

pub unsafe fn read_prefs(settings: *mut obs_data_t) -> Prefs {
    let ignored = split_apps(&get_string(settings, c"ignoredApps".as_ptr()))
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    Prefs { preferred_app: get_string(settings, c"preferredApp".as_ptr()), ignored_apps: ignored }
}

// ---------------------------------------------------------------- properties

struct Group {
    props: *mut obs_properties_t,
}

impl Group {
    unsafe fn new() -> Group {
        Group { props: (api().obs_properties_create)() }
    }
    unsafe fn bool(&self, name: &str, desc: &str) -> *mut obs_property_t {
        let (n, d) = (cs(name), cs(desc));
        (api().obs_properties_add_bool)(self.props, n.as_ptr(), d.as_ptr())
    }
    unsafe fn int(&self, name: &str, desc: &str, min: i32, max: i32, step: i32, suffix: &str) -> *mut obs_property_t {
        let (n, d) = (cs(name), cs(desc));
        let p = (api().obs_properties_add_int)(self.props, n.as_ptr(), d.as_ptr(), min, max, step);
        if !suffix.is_empty() {
            let s = cs(suffix);
            (api().obs_property_int_set_suffix)(p, s.as_ptr());
        }
        p
    }
    unsafe fn int_slider(&self, name: &str, desc: &str, min: i32, max: i32, step: i32, suffix: &str) {
        let (n, d) = (cs(name), cs(desc));
        let p = (api().obs_properties_add_int_slider)(self.props, n.as_ptr(), d.as_ptr(), min, max, step);
        if !suffix.is_empty() {
            let s = cs(suffix);
            (api().obs_property_int_set_suffix)(p, s.as_ptr());
        }
    }
    unsafe fn float(&self, name: &str, desc: &str, min: f64, max: f64, step: f64, suffix: &str) {
        let (n, d) = (cs(name), cs(desc));
        let p = (api().obs_properties_add_float_slider)(self.props, n.as_ptr(), d.as_ptr(), min, max, step);
        if !suffix.is_empty() {
            let s = cs(suffix);
            (api().obs_property_float_set_suffix)(p, s.as_ptr());
        }
    }
    unsafe fn text(&self, name: &str, desc: &str, hint: &str) {
        let (n, d) = (cs(name), cs(desc));
        let p = (api().obs_properties_add_text)(self.props, n.as_ptr(), d.as_ptr(), OBS_TEXT_DEFAULT);
        if !hint.is_empty() {
            let h = cs(hint);
            (api().obs_property_set_long_description)(p, h.as_ptr());
        }
    }
    unsafe fn color(&self, name: &str, desc: &str) {
        let (n, d) = (cs(name), cs(desc));
        (api().obs_properties_add_color)(self.props, n.as_ptr(), d.as_ptr());
    }
    unsafe fn list(&self, name: &str, desc: &str, editable: bool, items: &[(&str, &str)]) -> *mut obs_property_t {
        let (n, d) = (cs(name), cs(desc));
        let type_ = if editable { OBS_COMBO_TYPE_EDITABLE } else { OBS_COMBO_TYPE_LIST };
        let p = (api().obs_properties_add_list)(self.props, n.as_ptr(), d.as_ptr(), type_, OBS_COMBO_FORMAT_STRING);
        for (label, value) in items {
            let (l, v) = (cs(label), cs(value));
            (api().obs_property_list_add_string)(p, l.as_ptr(), v.as_ptr());
        }
        p
    }
    unsafe fn button(&self, name: &str, text: &str, cb: obs_property_clicked_t) {
        let (n, t) = (cs(name), cs(text));
        (api().obs_properties_add_button)(self.props, n.as_ptr(), t.as_ptr(), cb);
    }
    unsafe fn attach(self, parent: *mut obs_properties_t, name: &str, desc: &str) {
        let (n, d) = (cs(name), cs(desc));
        (api().obs_properties_add_group)(parent, n.as_ptr(), d.as_ptr(), OBS_GROUP_NORMAL, self.props);
    }
}

pub struct Buttons {
    pub test: obs_property_clicked_t,
    pub show: obs_property_clicked_t,
    pub hide: obs_property_clicked_t,
}

pub unsafe fn build_properties(
    sessions: &[SessionInfo],
    audio_sources: &[String],
    buttons: Buttons,
) -> *mut obs_properties_t {
    let root = (api().obs_properties_create)();

    let g = Group::new();
    let size = g.int("width", "Source width", 200, 7680, 2, " px");
    (api().obs_property_set_long_description)(
        size,
        cs("The card is drawn at the top-left of the source, so keep this just \
            big enough for it and position the source itself in the scene. \
            Raise it if a long title or a larger Scale gets clipped.")
            .as_ptr(),
    );
    g.int("height", "Source height", 120, 4320, 2, " px");
    g.float("scale", "Scale", 0.25, 4.0, 0.05, "");
    g.int("maxWidth", "Card max width", 200, 1920, 10, " px");
    g.attach(root, "grp_layout", "Size");

    let g = Group::new();
    g.float("holdSeconds", "Show for", 0.5, 120.0, 0.5, " s");
    g.float("animSpeed", "Animation speed", 0.25, 4.0, 0.05, "x");
    g.bool("compactMode", "Then collapse to mini strip");
    g.float("miniSeconds", "Mini strip stays for (0 = forever)", 0.0, 600.0, 1.0, " s");
    g.bool("alwaysVisible", "Always visible");
    g.bool("showWhenPaused", "Stay up while paused");
    g.bool("retriggerOnResume", "Replay reveal after a long pause");
    g.float("minPauseSeconds", "…long means at least", 0.0, 3600.0, 5.0, " s");
    g.attach(root, "grp_timing", "Timing");

    let g = Group::new();
    g.bool("showArt", "Album art");
    g.bool("showArtist", "Artist");
    g.bool("showAlbum", "Album");
    g.bool("showSource", "Source app");
    g.bool("showProgress", "Progress bar");
    g.bool("showTime", "Elapsed / total");
    g.list("textCase", "Text case", false, &[
        ("As is", "none"), ("UPPER", "upper"), ("lower", "lower"), ("Title Case", "title"),
    ]);
    g.int_slider("titleMaxLength", "Title max length", 8, 200, 1, "");
    g.bool("marquee", "Scroll long lines");
    g.attach(root, "grp_content", "Content");

    let g = Group::new();
    g.color("accent", "Accent");
    g.color("accent2", "Accent 2");
    g.bool("artAccent", "Pull accents from artwork");
    g.float("panelOpacity", "Panel opacity", 0.0, 1.0, 0.01, "");
    // No backdrop-blur control: a browser source cannot see the scene behind it,
    // so the filter only ever smeared the card's own artwork. See overlay.css.
    g.float("scanlines", "Scanlines", 0.0, 1.0, 0.01, "");
    g.float("noise", "CRT noise", 0.0, 1.0, 0.01, "");
    g.float("shake", "Shake", 0.0, 3.0, 0.1, "");
    g.text("fontFamily", "Font family", "CSS font-family list, e.g. \"Bahnschrift Condensed\", Impact, sans-serif");
    g.attach(root, "grp_look", "Look");

    let g = Group::new();
    g.list("exitStyle", "When hiding", false, &[("Retract", "retract"), ("Collapse to badge", "logo")]);
    g.list("badgeMark", "Badge mark", false, &[("Equalizer", "eq"), ("Speaker", "speaker"), ("Note", "note")]);
    g.bool("badgeTitle", "Badge shows title");
    g.int("badgeDropY", "Badge drop distance", 0, 400, 1, " px");
    g.float("badgeDropDelay", "Badge drop delay", 0.0, 60.0, 0.5, " s");
    g.attach(root, "grp_exit", "Exit");

    let g = Group::new();
    let mut items: Vec<(String, String)> = vec![("(automatic)".to_string(), String::new())];
    for s in sessions {
        items.push((format!("{} ({})", s.app, s.status), s.id.clone()));
    }
    let refs: Vec<(&str, &str)> = items.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    g.list("preferredApp", "Follow this app", true, &refs);
    g.text("ignoredApps", "Ignore apps", "Comma-separated app names to never follow, e.g. Discord, Chrome");
    g.attach(root, "grp_media", "Media source");

    let g = Group::new();
    g.bool("audioReactive", "Drive the bars from audio");
    let mut audio: Vec<(String, String)> = vec![("(first audio source)".to_string(), String::new())];
    for name in audio_sources {
        audio.push((name.clone(), name.clone()));
    }
    let audio_refs: Vec<(&str, &str)> = audio.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let p = g.list("obsSource", "Audio source", true, &audio_refs);
    (api().obs_property_set_long_description)(
        p,
        cs("Which mixer input the equalizer follows. Pick one input rather than \
            the whole mix so alerts and chat do not move the bars.")
            .as_ptr(),
    );
    g.attach(root, "grp_audio", "Audio");

    let g = Group::new();
    g.button("btn_test", "Send test track", buttons.test);
    g.button("btn_show", "Show now", buttons.show);
    g.button("btn_hide", "Hide now", buttons.hide);
    g.bool("debug", "Debug readout on overlay");
    g.attach(root, "grp_test", "Test");

    root
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_round_trip() {
        assert_eq!(obs_color_to_hex(hex_to_obs_color("#ff6a00")), "#ff6a00");
        assert_eq!(obs_color_to_hex(hex_to_obs_color("#e01b1b")), "#e01b1b");
        assert_eq!(obs_color_to_hex(hex_to_obs_color("#abc")), "#aabbcc");
        assert_eq!(hex_to_obs_color("#000000") as u64, 0xff00_0000);
    }

    #[test]
    fn defaults_parse_and_cover_every_key() {
        let d = defaults();
        for (key, _) in KEYS {
            assert!(d.contains_key(*key), "config.default.json is missing {key}");
        }
    }

    #[test]
    fn apps_split() {
        let v = split_apps(" Discord, Chrome ,, ");
        assert_eq!(v, vec![Value::from("Discord"), Value::from("Chrome")]);
    }
}
