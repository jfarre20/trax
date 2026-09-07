// OBS audio-level bridge.
//
// Connects to obs-websocket v5, subscribes to InputVolumeMeters, and forwards a
// normalised level to the overlay so the equalizer bars react to real audio.
//
// This gives loudness, not a spectrum: obs-websocket reports magnitude and peak
// per channel, with no frequency breakdown. The bars are therefore a level meter
// with per-bar smoothing rather than an FFT display. The upside over capturing
// system audio is that this is exactly what is going out on stream, and it can be
// pointed at a single input so Discord and notification sounds do not move it.
//
// Env: TRAX_OBS_HOST (default 127.0.0.1) for a dual-PC setup.

const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = parseInt(process.env.TRAX_PORT, 10) || 8787;
const RELAY_URL = process.env.TRAX_WS_URL || `ws://127.0.0.1:${PORT}/ws`;
const OBS_HOST = process.env.TRAX_OBS_HOST || '127.0.0.1';

// obs-websocket EventSubscription bit for InputVolumeMeters. It is opt-in
// precisely because it is high volume (~20 events/sec), so subscribe to nothing
// else.
const SUB_INPUT_VOLUME_METERS = 1 << 16;

// OBS emits meters about every 50 ms. Forward at ~25 Hz — past that the overlay
// cannot show the difference and it is just WebSocket traffic.
const FORWARD_MS = 40;
// Silence floor. Anything quieter than this maps to zero. -50 rather than -60
// keeps more of the scale over the range music actually occupies; the overlay
// then auto-gains against a rolling peak on top of this.
const FLOOR_DB = -50;

let config = { audioReactive: false, obsPort: 4455, obsPassword: '', obsSource: '' };

// --- Relay (our own server) --------------------------------------------------
let relay = null;
let relayDelay = 1000;

function connectRelay() {
    relay = new WebSocket(RELAY_URL);

    relay.on('open', () => { relayDelay = 1000; });
    relay.on('close', () => {
        relay = null;
        setTimeout(connectRelay, relayDelay);
        relayDelay = Math.min(relayDelay * 2, 15000);
    });
    relay.on('error', (e) => {
        if (e.code !== 'ECONNREFUSED') console.error('[obs]', e.message);
    });

    relay.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (msg.type !== 'configChanged' || !msg.config) return;

        const next = msg.config;
        const reconnectNeeded = next.obsPort !== config.obsPort
            || next.obsPassword !== config.obsPassword
            || next.audioReactive !== config.audioReactive;
        config = next;

        if (reconnectNeeded) {
            if (config.audioReactive) {
                console.log('[obs] settings changed, reconnecting');
                closeObs();
                connectObs();
            } else {
                console.log('[obs] audio reactivity disabled');
                closeObs();
            }
        }
    });
}

function sendLevel(level, peak) {
    if (relay && relay.readyState === WebSocket.OPEN) {
        relay.send(JSON.stringify({ type: 'levels', level, peak }));
    }
}

// --- OBS ---------------------------------------------------------------------
let obs = null;
let obsDelay = 2000;
let lastForward = 0;
let warnedMissingSource = false;

function closeObs() {
    if (obs) {
        const sock = obs;
        obs = null;              // so the close handler does not reconnect
        try { sock.close(); } catch (e) { /* already closing */ }
    }
}

/** obs-websocket v5 auth: base64(sha256(base64(sha256(password + salt)) + challenge)) */
function authToken(password, salt, challenge) {
    const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
    return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

/** Linear multiplier -> 0..1, via dB so the response matches what an ear expects.
 *  A raw linear magnitude spends almost all its range near zero and the bars
 *  barely move. */
function normalise(mul) {
    if (!(mul > 0)) return 0;
    const db = 20 * Math.log10(mul);
    if (db <= FLOOR_DB) return 0;
    return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

function connectObs() {
    if (!config.audioReactive) return;

    const url = `ws://${OBS_HOST}:${config.obsPort}`;
    const sock = new WebSocket(url);
    obs = sock;

    sock.on('open', () => console.log(`[obs] connected to ${url}`));

    sock.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

        // op 0 = Hello. Answer with Identify, authenticating if asked.
        if (msg.op === 0) {
            const d = { rpcVersion: 1, eventSubscriptions: SUB_INPUT_VOLUME_METERS };
            const auth = msg.d && msg.d.authentication;
            if (auth) {
                if (!config.obsPassword) {
                    console.error('[obs] this OBS requires a websocket password — set it on the config page');
                    closeObs();
                    return;
                }
                d.authentication = authToken(config.obsPassword, auth.salt, auth.challenge);
            }
            sock.send(JSON.stringify({ op: 1, d }));
            return;
        }

        // op 2 = Identified.
        if (msg.op === 2) {
            obsDelay = 2000;
            console.log('[obs] subscribed to input volume meters'
                + (config.obsSource ? ` (source: ${config.obsSource})` : ' (all inputs)'));
            return;
        }

        // op 5 = Event.
        if (msg.op === 5 && msg.d && msg.d.eventType === 'InputVolumeMeters') {
            handleMeters(msg.d.eventData && msg.d.eventData.inputs);
        }
    });

    sock.on('close', (code) => {
        if (obs !== sock) return;      // deliberate close
        obs = null;
        if (!config.audioReactive) return;
        // 4009 is "authentication failed" — retrying in a tight loop is pointless.
        if (code === 4009) {
            console.error('[obs] authentication failed — check the websocket password');
            return;
        }
        setTimeout(connectObs, obsDelay);
        obsDelay = Math.min(obsDelay * 2, 20000);
    });

    sock.on('error', (e) => {
        // OBS not running, or the websocket server is off. 'close' handles retry.
        if (e.code !== 'ECONNREFUSED') console.error('[obs]', e.message);
    });
}

function handleMeters(inputs) {
    if (!Array.isArray(inputs) || !inputs.length) return;

    const wanted = (config.obsSource || '').trim().toLowerCase();
    let magnitude = 0;
    let peak = 0;
    let matched = false;

    for (const input of inputs) {
        if (wanted && String(input.inputName || '').toLowerCase() !== wanted) continue;
        matched = true;

        // inputLevelsMul is one array per channel: [magnitude, peak, inputPeak].
        // An input that is muted or not producing audio reports an empty array.
        const channels = input.inputLevelsMul || [];
        for (const ch of channels) {
            if (!Array.isArray(ch) || !ch.length) continue;
            magnitude = Math.max(magnitude, ch[0] || 0);
            peak = Math.max(peak, ch[1] || ch[0] || 0);
        }
    }

    if (wanted && !matched) {
        if (!warnedMissingSource) {
            warnedMissingSource = true;
            console.error(`[obs] no input named "${config.obsSource}" is reporting levels`
                + ` — check the name matches the OBS source exactly`);
        }
        return;
    }
    warnedMissingSource = false;

    const now = Date.now();
    if (now - lastForward < FORWARD_MS) return;
    lastForward = now;

    sendLevel(normalise(magnitude), normalise(peak));
}

// --- Start -------------------------------------------------------------------
// Read config once up front so we know whether to connect at all; the relay
// pushes configChanged afterwards.
require('http').get({ host: '127.0.0.1', port: PORT, path: '/api/config' }, (res) => {
    let body = '';
    res.on('data', (c) => body += c);
    res.on('end', () => {
        try { config = JSON.parse(body); } catch (e) { /* keep defaults */ }
        if (config.audioReactive) connectObs();
        else console.log('[obs] audio-reactive bars are off (enable them on the config page)');
    });
}).on('error', () => {
    // Server not up yet; the relay connection will deliver config shortly.
});

connectRelay();
