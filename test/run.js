// Test suite for track-change detection and configuration loading.
// Plain Node, no framework:  npm test
//
// The point of the track-change tests is the negative case: a stream of samples
// with a moving position must never produce a `trackChanged`, because that is
// what would make the overlay replay its animation mid-song.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ✓ ' + name);
    } catch (e) {
        failed++;
        console.log('  ✗ ' + name);
        console.log('      ' + (e && e.message ? e.message : e));
    }
}

function group(name) { console.log('\n' + name); }

// ============================================================================
// track-change.js
// ============================================================================
const { createDetector, identityKey } = require('../track-change');

const sample = (over) => Object.assign({
    title: 'Riders On The Storm',
    artist: 'Snoop Dogg',
    album: 'Need For Speed',
    status: 'playing',
    position: 0,
    duration: 240,
    art: '',
    session: { id: 'Spotify', app: 'Spotify' },
    sessions: []
}, over);

group('track-change: identity');

test('identity key combines session, title and artist', () => {
    assert.strictEqual(identityKey(sample()), 'Spotify|Riders On The Storm|Snoop Dogg');
});

test('identity key tolerates a missing session', () => {
    assert.strictEqual(identityKey({ title: 'A', artist: 'B' }), '|A|B');
});

group('track-change: first sight and repeats');

test('first sample with a title is a trackChanged', () => {
    const d = createDetector();
    const e = d.step(sample(), 1000);
    assert.strictEqual(e.kind, 'trackChanged');
    assert.strictEqual(e.title, 'Riders On The Storm');
    assert.strictEqual(e.sourceApp, 'Spotify');
    assert.strictEqual(e.duration, 240);
});

test('an identical repeat immediately after is not an event', () => {
    const d = createDetector();
    d.step(sample(), 1000);
    assert.strictEqual(d.step(sample(), 1500).kind, 'none');
});

test('THE REGRESSION: ordinary progress never yields trackChanged', () => {
    const d = createDetector();
    d.step(sample({ position: 0 }), 0);
    // 4 minutes of 1 Hz polling on one track.
    const kinds = {};
    for (let i = 1; i <= 240; i++) {
        const e = d.step(sample({ position: i }), i * 1000);
        kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    }
    assert.strictEqual(kinds.trackChanged, undefined,
        'position movement produced ' + kinds.trackChanged + ' spurious track changes');
    // It should still be syncing the timeline periodically.
    assert.ok(kinds.timeline > 0, 'expected periodic timeline syncs');
});

test('timeline syncs are rate limited, not once per poll', () => {
    const d = createDetector({ timelineSyncMs: 5000 });
    d.step(sample({ position: 0 }), 0);
    let syncs = 0;
    // 30 s of 1 Hz polling, position advancing 1 s each time (no seeks).
    for (let i = 1; i <= 30; i++) {
        if (d.step(sample({ position: i }), i * 1000).kind === 'timeline') syncs++;
    }
    // ~6 expected at a 5 s interval; assert it is far below one per sample.
    assert.ok(syncs >= 4 && syncs <= 8, 'expected ~6 syncs over 30 s, got ' + syncs);
});

group('track-change: stalled position (observed live)');

test('a frozen position emits no timeline syncs at all', () => {
    // Observed with a Brave/Suno session: SMTC reported exactly 107.568 for 12 s
    // of polling while audibly playing, because Position only reflects what the
    // app last pushed. Re-broadcasting that on a timer made the overlay re-anchor
    // to a stale value every 5 s, so the progress bar jumped backwards.
    const d = createDetector();
    d.step(sample({ position: 107.568, duration: 127.28 }), 0);
    let syncs = 0;
    for (let i = 1; i <= 60; i++) {
        if (d.step(sample({ position: 107.568, duration: 127.28 }), i * 1000).kind === 'timeline') syncs++;
    }
    assert.strictEqual(syncs, 0, 'a stalled position must not produce syncs, got ' + syncs);
});

test('sub-epsilon jitter counts as stalled', () => {
    const d = createDetector();
    d.step(sample({ position: 50 }), 0);
    let syncs = 0;
    for (let i = 1; i <= 40; i++) {
        // ±0.1 s of noise around a fixed value.
        const p = 50 + (i % 2 ? 0.1 : -0.1);
        if (d.step(sample({ position: p }), i * 1000).kind === 'timeline') syncs++;
    }
    assert.strictEqual(syncs, 0, 'jitter must not look like movement, got ' + syncs);
});

test('a stalled position still yields to a real seek', () => {
    const d = createDetector();
    d.step(sample({ position: 107.568 }), 0);
    for (let i = 1; i <= 10; i++) d.step(sample({ position: 107.568 }), i * 1000);
    const e = d.step(sample({ position: 12 }), 11000);
    assert.strictEqual(e.kind, 'timeline');
    assert.strictEqual(e.position, 12);
});

test('duration arriving late is reported even while position is stalled', () => {
    // Apps commonly publish duration 0 on load and the real length a beat later.
    const d = createDetector();
    d.step(sample({ position: 0, duration: 0 }), 0);
    const e = d.step(sample({ position: 0, duration: 127.28 }), 1000);
    assert.strictEqual(e.kind, 'timeline', 'a duration change must reach the overlay');
    assert.strictEqual(e.duration, 127.28);
});

test('an unchanged duration does not re-sync on its own', () => {
    const d = createDetector();
    d.step(sample({ position: 10, duration: 200 }), 0);
    assert.strictEqual(d.step(sample({ position: 10, duration: 200 }), 9000).kind, 'none');
});

test('a moving position still syncs on schedule', () => {
    // The stall guard must not break players that do keep their timeline live.
    const d = createDetector();
    d.step(sample({ position: 0 }), 0);
    let syncs = 0;
    for (let i = 1; i <= 30; i++) {
        if (d.step(sample({ position: i }), i * 1000).kind === 'timeline') syncs++;
    }
    assert.ok(syncs >= 4 && syncs <= 8, 'expected ~6 syncs for live playback, got ' + syncs);
});

group('track-change: real changes');

test('a different title is a trackChanged', () => {
    const d = createDetector();
    d.step(sample(), 0);
    const e = d.step(sample({ title: 'Get Low', position: 0 }), 1000);
    assert.strictEqual(e.kind, 'trackChanged');
    assert.strictEqual(e.title, 'Get Low');
});

test('a different artist is a trackChanged', () => {
    const d = createDetector();
    d.step(sample(), 0);
    assert.strictEqual(d.step(sample({ artist: 'Someone Else' }), 1000).kind, 'trackChanged');
});

test('a different session is a trackChanged even with identical metadata', () => {
    const d = createDetector();
    d.step(sample(), 0);
    const e = d.step(sample({ session: { id: 'Chrome', app: 'Chrome' } }), 1000);
    assert.strictEqual(e.kind, 'trackChanged');
    assert.strictEqual(e.sourceApp, 'Chrome');
});

test('the same track repeating on a loop is not re-announced', () => {
    // A looping single track: position resets but identity is unchanged.
    const d = createDetector();
    d.step(sample({ position: 235 }), 0);
    const e = d.step(sample({ position: 0 }), 1000);
    assert.strictEqual(e.kind, 'timeline', 'a loop should sync the timeline, not replay');
});

group('track-change: playback state');

test('play -> pause is a playbackChanged', () => {
    const d = createDetector();
    d.step(sample(), 0);
    const e = d.step(sample({ status: 'paused' }), 1000);
    assert.strictEqual(e.kind, 'playbackChanged');
    assert.strictEqual(e.status, 'paused');
});

test('staying paused is not repeated', () => {
    const d = createDetector();
    d.step(sample(), 0);
    d.step(sample({ status: 'paused' }), 1000);
    assert.strictEqual(d.step(sample({ status: 'paused' }), 2000).kind, 'none');
});

test('resume reports how long the pause lasted', () => {
    const d = createDetector();
    d.step(sample(), 0);
    d.step(sample({ status: 'paused' }), 10000);
    const e = d.step(sample({ status: 'playing' }), 55000);
    assert.strictEqual(e.kind, 'playbackChanged');
    assert.strictEqual(e.status, 'playing');
    assert.strictEqual(e.resumedAfterPauseSeconds, 45);
});

test('a brief pause reports a small resume duration', () => {
    const d = createDetector();
    d.step(sample(), 0);
    d.step(sample({ status: 'paused' }), 1000);
    const e = d.step(sample({ status: 'playing' }), 3000);
    assert.strictEqual(e.resumedAfterPauseSeconds, 2);
});

test('an empty title reports stopped exactly once', () => {
    const d = createDetector();
    d.step(sample(), 0);
    assert.strictEqual(d.step(sample({ title: '' }), 1000).kind, 'stopped');
    assert.strictEqual(d.step(sample({ title: '' }), 2000).kind, 'none');
});

test('playback resuming after a stop is a trackChanged', () => {
    const d = createDetector();
    d.step(sample(), 0);
    d.step(sample({ title: '' }), 1000);
    assert.strictEqual(d.step(sample(), 2000).kind, 'trackChanged');
});

group('track-change: seeking');

test('seeking forward syncs immediately', () => {
    const d = createDetector();
    d.step(sample({ position: 10 }), 0);
    const e = d.step(sample({ position: 120 }), 500); // well inside the sync interval
    assert.strictEqual(e.kind, 'timeline');
    assert.strictEqual(e.position, 120);
});

test('seeking backward syncs immediately', () => {
    const d = createDetector();
    d.step(sample({ position: 120 }), 0);
    assert.strictEqual(d.step(sample({ position: 10 }), 500).kind, 'timeline');
});

test('reset makes the next sample look new again', () => {
    const d = createDetector();
    d.step(sample(), 0);
    assert.strictEqual(d.step(sample(), 500).kind, 'none');
    d.reset();
    assert.strictEqual(d.step(sample(), 1000).kind, 'trackChanged');
});

group('track-change: degraded metadata');

test('a title with no artist still works', () => {
    const d = createDetector();
    const e = d.step(sample({ artist: '', album: '' }), 0);
    assert.strictEqual(e.kind, 'trackChanged');
    assert.strictEqual(e.artist, '');
});

test('missing timeline properties become zero, not NaN', () => {
    const d = createDetector();
    const e = d.step({ title: 'X', status: 'playing' }, 0);
    assert.strictEqual(e.position, 0);
    assert.strictEqual(e.duration, 0);
});

test('an empty sample is inert', () => {
    const d = createDetector();
    assert.strictEqual(d.step({}, 0).kind, 'none');
    assert.strictEqual(d.step(undefined, 0).kind, 'none');
});

// ============================================================================
// config-store.js
// ============================================================================
group('config: defaults and validation');

const configStore = require('../config-store');

test('defaults load from config.default.json', () => {
    const d = configStore.loadDefaults();
    assert.strictEqual(typeof d.position, 'string');
    assert.strictEqual(typeof d.holdSeconds, 'number');
    assert.strictEqual(d.bind, '127.0.0.1', 'must default to localhost only');
});

test('validate fills every schema key from an empty object', () => {
    const c = configStore.validate({});
    configStore.KEYS.forEach((k) => {
        assert.ok(Object.prototype.hasOwnProperty.call(c, k), 'missing key: ' + k);
        assert.notStrictEqual(c[k], undefined, 'undefined key: ' + k);
    });
});

test('validate drops unknown keys', () => {
    const c = configStore.validate({ nonsense: 1, __proto__: { x: 1 } });
    assert.strictEqual(c.nonsense, undefined);
});

test('numbers are clamped to their range', () => {
    assert.strictEqual(configStore.validate({ scale: 999 }).scale, 4);
    assert.strictEqual(configStore.validate({ scale: -5 }).scale, 0.25);
    assert.strictEqual(configStore.validate({ panelOpacity: 3 }).panelOpacity, 1);
    assert.strictEqual(configStore.validate({ holdSeconds: 0 }).holdSeconds, 0.5);
});

test('numeric strings from form posts are coerced', () => {
    assert.strictEqual(configStore.validate({ scale: '1.5' }).scale, 1.5);
    assert.strictEqual(configStore.validate({ offsetX: '120' }).offsetX, 120);
});

test('non-numeric garbage falls back to the default', () => {
    const d = configStore.loadDefaults();
    assert.strictEqual(configStore.validate({ scale: 'huge' }).scale, d.scale);
    assert.strictEqual(configStore.validate({ blur: null }).blur, d.blur);
});

test('booleans accept form-style strings', () => {
    assert.strictEqual(configStore.validate({ showArt: 'false' }).showArt, false);
    assert.strictEqual(configStore.validate({ showArt: 'true' }).showArt, true);
    assert.strictEqual(configStore.validate({ compactMode: 1 }).compactMode, true);
});

test('enums reject values outside the list', () => {
    const d = configStore.loadDefaults();
    assert.strictEqual(configStore.validate({ position: 'nowhere' }).position, d.position);
    assert.strictEqual(configStore.validate({ position: 'top-right' }).position, 'top-right');
    assert.strictEqual(configStore.validate({ textCase: 'SHOUTING' }).textCase, d.textCase);
});

group('config: injection guards');

test('accent colour must be a hex literal', () => {
    const d = configStore.loadDefaults();
    // These land in a CSS custom property, so anything non-hex is refused.
    assert.strictEqual(configStore.validate({ accent: 'red; background:url(x)' }).accent, d.accent);
    assert.strictEqual(configStore.validate({ accent: 'expression(alert(1))' }).accent, d.accent);
    assert.strictEqual(configStore.validate({ accent: '#ff00aa' }).accent, '#ff00aa');
    assert.strictEqual(configStore.validate({ accent: '#fff' }).accent, '#fff');
});

test('font family rejects CSS punctuation', () => {
    const d = configStore.loadDefaults();
    assert.strictEqual(configStore.validate({ fontFamily: 'a; } body { display:none' }).fontFamily, d.fontFamily);
    assert.strictEqual(configStore.validate({ fontFamily: 'url(evil)' }).fontFamily, d.fontFamily);
    assert.strictEqual(configStore.validate({ fontFamily: '"Arial Narrow", sans-serif' }).fontFamily,
        '"Arial Narrow", sans-serif');
});

test('bind only accepts loopback or all-interfaces', () => {
    assert.strictEqual(configStore.validate({ bind: '8.8.8.8' }).bind, '127.0.0.1');
    assert.strictEqual(configStore.validate({ bind: '0.0.0.0' }).bind, '0.0.0.0');
});

test('long strings are truncated', () => {
    assert.strictEqual(configStore.validate({ preferredApp: 'x'.repeat(500) }).preferredApp.length, 80);
});

test('ignoredApps must be an array of strings and is capped', () => {
    const d = configStore.loadDefaults();
    assert.deepStrictEqual(configStore.validate({ ignoredApps: 'chrome' }).ignoredApps, d.ignoredApps);
    assert.deepStrictEqual(configStore.validate({ ignoredApps: ['chrome', 5, null, 'msedge'] }).ignoredApps,
        ['chrome', 'msedge']);
    assert.strictEqual(configStore.validate({ ignoredApps: new Array(60).fill('a') }).ignoredApps.length, 20);
});

test('validate is idempotent', () => {
    const once = configStore.validate({ scale: 2, accent: '#123456' });
    assert.deepStrictEqual(configStore.validate(once), once);
});

group('config: file loading');

test('a corrupt config.json does not throw and yields defaults', () => {
    // load() reads a fixed path, so exercise the same fallback shape directly:
    // an unparseable file leaves `saved` as {} and validate supplies defaults.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trax-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{ this is not json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { saved = {}; }
    const c = configStore.validate(saved);
    assert.strictEqual(c.position, configStore.loadDefaults().position);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a partial config keeps defaults for absent keys', () => {
    const d = configStore.loadDefaults();
    const c = configStore.validate({ accent: '#00ff00' });
    assert.strictEqual(c.accent, '#00ff00');
    assert.strictEqual(c.position, d.position);
    assert.strictEqual(c.holdSeconds, d.holdSeconds);
});

// ============================================================================
console.log('\n' + (failed ? '✗' : '✓') + ` ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
