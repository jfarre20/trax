// Config load / validate / save.
//
// Every value coming from the config page is untrusted: it is clamped to a sane
// range and coerced to the right type here, so the overlay can use it directly
// without re-checking. Unknown keys are dropped.

const fs = require('fs');
const path = require('path');

const BASE = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = path.join(BASE, 'config.json');
const DEFAULT_FILE = path.join(BASE, 'config.default.json');

const POSITIONS = [
    'top-left', 'top-center', 'top-right',
    'middle-left', 'middle-center', 'middle-right',
    'bottom-left', 'bottom-center', 'bottom-right'
];
const TEXT_CASES = ['none', 'upper', 'lower', 'title'];
const EXIT_STYLES = ['retract', 'logo'];
const BADGE_MARKS = ['eq', 'speaker', 'note'];
const COLLAPSE_DIRECTIONS = ['down', 'up'];

// key -> validator. num(min,max) / bool / str(maxLen) / enum(list)
const num = (min, max) => (v, d) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return d;
    return Math.min(max, Math.max(min, n));
};
const bool = () => (v, d) => (typeof v === 'boolean' ? v : v === 'true' || v === 1 || v === '1' ? true : v === 'false' || v === 0 || v === '0' ? false : d);
const str = (maxLen) => (v, d) => (typeof v === 'string' ? v.slice(0, maxLen) : d);
const oneOf = (list) => (v, d) => (list.includes(v) ? v : d);
// Hex colour only — this value lands in a CSS custom property, so anything else
// would be an injection point.
const colour = () => (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : d);
const appList = () => (v, d) => {
    if (!Array.isArray(v)) return d;
    return v.filter((s) => typeof s === 'string' && s.length && s.length <= 80).slice(0, 20);
};

const SCHEMA = {
    bind: oneOf(['127.0.0.1', '0.0.0.0']),
    position: oneOf(POSITIONS),
    offsetX: num(-2000, 2000),
    offsetY: num(-2000, 2000),
    scale: num(0.25, 4),
    maxWidth: num(200, 1920),
    holdSeconds: num(0.5, 120),
    animSpeed: num(0.25, 4),
    compactMode: bool(),
    collapseDirection: oneOf(COLLAPSE_DIRECTIONS),
    alwaysVisible: bool(),
    showArt: bool(),
    showArtist: bool(),
    showAlbum: bool(),
    showSource: bool(),
    showProgress: bool(),
    showTime: bool(),
    showWhenPaused: bool(),
    retriggerOnResume: bool(),
    miniSeconds: num(0, 600),
    minPauseSeconds: num(0, 3600),
    textCase: oneOf(TEXT_CASES),
    titleMaxLength: num(8, 200),
    marquee: bool(),
    accent: colour(),
    accent2: colour(),
    opaqueBackground: bool(),
    panelOpacity: num(0, 1),
    blur: num(0, 40),
    scanlines: num(0, 1),
    noise: num(0, 1),
    shake: num(0, 3),
    // Font family also lands in CSS. Allow letters, digits, spaces, quotes,
    // commas and dashes only.
    fontFamily: (v, d) => (typeof v === 'string' && v.length <= 200 && /^[\w\s"',\-]+$/.test(v) ? v : d),
    artAccent: bool(),
    debug: bool(),
    preferredApp: str(80),
    ignoredApps: appList(),

    // Exit behaviour
    exitStyle: oneOf(EXIT_STYLES),
    badgeMark: oneOf(BADGE_MARKS),
    badgeTitle: bool(),
    badgeDropY: num(0, 400),
    badgeDropDelay: num(0, 60),
    // Optional custom badge image, resolved relative to the server root. Kept to
    // a safe relative filename so this cannot be pointed at an arbitrary path or
    // an off-machine URL.
    logoUrl: (v, d) => (typeof v === 'string'
        && (v === '' || (/^[\w\-]+(\/[\w\-]+)*\.(png|jpe?g|svg|webp|gif)$/i.test(v) && !v.includes('..')))
        ? v : d),

    // OBS audio-reactive equalizer
    audioReactive: bool(),
    obsPort: num(1, 65535),
    obsPassword: str(200),
    obsSource: str(200)
};

let defaults = null;

function loadDefaults() {
    if (defaults) return defaults;
    try {
        defaults = JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8'));
    } catch (e) {
        // config.default.json missing or corrupt — fall back to a hardcoded
        // minimum so the overlay still renders something.
        console.error('[config] could not read config.default.json:', e.message);
        defaults = {
            bind: '127.0.0.1', position: 'bottom-left', offsetX: 60, offsetY: 60,
            scale: 1, maxWidth: 620, holdSeconds: 7, animSpeed: 1,
            compactMode: false, collapseDirection: 'down', alwaysVisible: false, showArt: true,
            showArtist: true, showAlbum: false, showSource: true,
            showProgress: true, showTime: false, showWhenPaused: false,
            retriggerOnResume: true, minPauseSeconds: 30, textCase: 'upper',
            titleMaxLength: 44, marquee: true, accent: '#ff6a00',
            accent2: '#e01b1b', opaqueBackground: true, panelOpacity: 0.86, blur: 6, scanlines: 0.18,
            noise: 0.05, shake: 1, fontFamily: 'Arial Narrow, sans-serif',
            artAccent: false, debug: false, preferredApp: '', ignoredApps: []
        };
    }
    return defaults;
}

/** Coerce an arbitrary object into a complete, valid config. */
function validate(input) {
    const d = loadDefaults();
    const out = {};
    for (const key of Object.keys(SCHEMA)) {
        const fallback = Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
        out[key] = SCHEMA[key](input ? input[key] : undefined, fallback);
    }
    return out;
}

function load() {
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('[config] config.json unreadable, using defaults:', e.message);
    }
    return validate(saved);
}

function save(input) {
    const clean = validate(input);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2));
    return clean;
}

module.exports = { load, save, validate, loadDefaults, CONFIG_FILE, POSITIONS, TEXT_CASES, KEYS: Object.keys(SCHEMA) };
