// Windows now-playing -> overlay bridge.
//
// Spawns the SMTC poller (nowplaying.py, or nowplaying.ps1 if Python is absent),
// runs each sample through the track-change detector, and forwards the resulting
// events to server.js over the relay WebSocket.
//
// The decision of *what changed* lives in track-change.js so it can be tested in
// isolation. This file handles process supervision, artwork upload, and transport.

const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const readline = require('readline');
const WebSocket = require('ws');

const { createDetector } = require('./track-change');

const PORT = parseInt(process.env.TRAX_PORT, 10) || 8787;
const WS_URL = process.env.TRAX_WS_URL || `ws://127.0.0.1:${PORT}/ws`;
const BASE = process.pkg ? path.dirname(process.execPath) : __dirname;

// Re-announce current state periodically so an overlay that starts mid-song is
// correct even if it missed the track change. The overlay ignores these for
// animation purposes (it compares trackId).
const STATE_REANNOUNCE_MS = 20000;

const detector = createDetector();

// --- Relay connection --------------------------------------------------------
let ws = null;
let queue = [];
let reconnectDelay = 1000;

function connect() {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        console.log('[bridge] connected to relay');
        reconnectDelay = 1000;
        while (queue.length) ws.send(queue.shift());
    });

    ws.on('close', () => {
        ws = null;
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    });

    ws.on('error', (e) => {
        // The relay may not be listening yet on a cold start; 'close' retries.
        if (e.code !== 'ECONNREFUSED') console.error('[bridge]', e.message);
    });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (msg.type === 'configChanged' && msg.config) {
            const next = selectionPrefs(msg.config);
            if (next === selectionKey) return;

            // The server sends configChanged to every client on connect, so the
            // first one is not a change — adopt it silently. Restarting the poller
            // here would reset the detector, which makes the current track look
            // new and resets the overlay's elapsed time for no reason.
            const first = selectionKey === null;
            selectionKey = next;
            if (first) return;

            console.log('[bridge] session preferences changed, restarting poller');
            restartPoller();
        }
    });
}

function send(obj) {
    const text = JSON.stringify(obj);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(text);
    } else {
        queue.push(text);
        if (queue.length > 20) queue.shift();
    }
}

/** POST artwork to the server, which caches it by content hash and returns a URL.
 *  Done once per track rather than inlining base64 into every message. */
function uploadArtwork(dataUrl) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ data: dataUrl });
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: '/api/artwork', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let out = '';
            res.on('data', (c) => out += c);
            res.on('end', () => {
                try { resolve(JSON.parse(out).url || ''); } catch (e) { resolve(''); }
            });
        });
        req.on('error', () => resolve(''));
        req.setTimeout(5000, () => { req.destroy(); resolve(''); });
        req.end(body);
    });
}

// --- State -------------------------------------------------------------------
let currentState = null;
let lastSessionsKey = '';
// null until the first configChanged arrives, so that one can be adopted without
// triggering a poller restart. See the configChanged handler.
let selectionKey = null;

function selectionPrefs(config) {
    return JSON.stringify({
        preferredApp: config.preferredApp || '',
        ignoredApps: config.ignoredApps || []
    });
}

function stamp() { return new Date().toISOString(); }

// --- Position we report onward -----------------------------------------------
// SMTC publishes a position once per track and then freezes it, so passing that
// value straight through means anything that joins mid-song (an OBS source
// refresh, a reopened browser tab) starts counting from zero again. The bridge
// therefore keeps its own anchor and reports an interpolated position, so the
// server's cached state — and every client primed from it — is honest.
let posAnchor = 0;
let posAnchorAt = 0;
let posPlaying = false;

function setAnchor(position, playing) {
    posAnchor = Math.max(0, position || 0);
    posAnchorAt = Date.now();
    posPlaying = !!playing;
}

function reportedPosition() {
    let p = posAnchor;
    if (posPlaying) p += (Date.now() - posAnchorAt) / 1000;
    const duration = currentState && currentState.durationSeconds;
    return duration ? Math.min(duration, Math.max(0, p)) : Math.max(0, p);
}

async function handleSample(sample) {
    if (sample.error) {
        console.error('[poller]', sample.error);
        return;
    }

    // Session list, for the config page's picker.
    const sessionsKey = JSON.stringify(sample.sessions || []);
    if (sessionsKey !== lastSessionsKey) {
        lastSessionsKey = sessionsKey;
        send({ type: 'sessions', sessions: sample.sessions || [] });
    }

    const event = detector.step(sample, Date.now());

    switch (event.kind) {
        case 'none':
            return;

        case 'stopped':
            currentState = null;
            console.log('[media] stopped');
            send({ type: 'playbackChanged', playbackStatus: 'stopped', timestamp: stamp() });
            return;

        case 'trackChanged': {
            const artworkUrl = event.art ? await uploadArtwork(event.art) : '';
            setAnchor(event.position, event.status === 'playing');
            currentState = {
                trackId: crypto.createHash('sha1').update(event.key).digest('hex').slice(0, 12),
                title: event.title,
                artist: event.artist,
                album: event.album,
                sourceApp: event.sourceApp,
                artworkUrl,
                playbackStatus: event.status,
                positionSeconds: event.position,
                durationSeconds: event.duration
            };
            console.log(`[media] ${event.status}: ${event.artist} - ${event.title}${artworkUrl ? ' [art]' : ''}`);
            send(Object.assign({ type: 'trackChanged', timestamp: stamp() }, currentState));
            return;
        }

        case 'playbackChanged': {
            const playing = event.status === 'playing';
            // Pausing freezes wherever we had interpolated to. Resuming trusts a
            // freshly published position if there is one, since a play/pause edge
            // is one of the few moments an app does refresh it.
            setAnchor(playing && event.position > 0 ? event.position : reportedPosition(), playing);
            if (currentState) {
                currentState.playbackStatus = event.status;
                currentState.positionSeconds = reportedPosition();
                if (event.duration) currentState.durationSeconds = event.duration;
            }
            console.log(`[media] ${event.status}`);
            send({
                type: 'playbackChanged',
                playbackStatus: event.status,
                positionSeconds: reportedPosition(),
                durationSeconds: event.duration,
                resumedAfterPauseSeconds: event.resumedAfterPauseSeconds,
                timestamp: stamp()
            });
            return;
        }

        case 'timeline':
            // The detector only emits this for genuine movement, a seek, or a
            // duration correction — so re-anchor to it.
            if (currentState && event.duration) currentState.durationSeconds = event.duration;
            setAnchor(event.position, posPlaying);
            if (currentState) currentState.positionSeconds = reportedPosition();
            send({
                type: 'timeline',
                positionSeconds: event.position,
                durationSeconds: event.duration,
                timestamp: stamp()
            });
            return;
    }
}

// Re-announce with a live interpolated position, so the server's cache stays
// honest and a client that connects between heartbeats is at most a few seconds
// out (the server interpolates forward from the timestamp to close that gap).
setInterval(() => {
    if (!currentState) return;
    currentState.positionSeconds = reportedPosition();
    send(Object.assign({ type: 'state' }, currentState, { timestamp: stamp() }));
}, STATE_REANNOUNCE_MS);

// --- Poller supervision ------------------------------------------------------
let usePython = true;
let poller = null;
let restarting = false;

function spawnPoller() {
    if (usePython) {
        return spawn('python', [path.join(BASE, 'nowplaying.py'), selectionKey || '{}'], { windowsHide: true });
    }
    return spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(BASE, 'nowplaying.ps1')
    ], { windowsHide: true });
}

function startPoller() {
    poller = spawnPoller();
    const child = poller;

    child.on('error', (e) => {
        if (usePython) {
            console.log('[bridge] python unavailable, falling back to PowerShell (no session pinning)');
            usePython = false;
            poller = null;
            startPoller();
        } else {
            console.error('[bridge] poller failed to start:', e.message);
        }
    });

    const rl = readline.createInterface({ input: child.stdout });
    // Serialised: handleSample awaits an artwork upload, and two overlapping calls
    // could both observe the same track as new.
    let chain = Promise.resolve();
    rl.on('line', (line) => {
        let sample;
        try { sample = JSON.parse(line); } catch (e) { return; }
        chain = chain.then(() => handleSample(sample)).catch((e) => console.error('[bridge]', e.message));
    });

    child.stderr.on('data', (d) => {
        const text = d.toString().trim();
        if (text) console.error('[poller]', text.slice(0, 400));
    });

    child.on('exit', (code) => {
        if (restarting || child !== poller) return; // deliberate restart
        console.log(`[bridge] poller exited (${code}), restarting in 5s`);
        poller = null;
        setTimeout(startPoller, 5000);
    });
}

function restartPoller() {
    restarting = true;
    detector.reset();
    lastSessionsKey = '';
    currentState = null;
    if (poller) { try { poller.kill(); } catch (e) { /* already gone */ } }
    poller = null;
    setTimeout(() => { restarting = false; startPoller(); }, 300);
}

process.on('exit', () => { if (poller) { try { poller.kill(); } catch (e) { /* already gone */ } } });

connect();
startPoller();
