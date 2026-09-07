// TRAX relay server: static hosting + REST + WebSocket on one port.
//
//   GET  /overlay              the OBS browser source
//   GET  /config               config page with live preview
//   GET  /preview              standalone demo, works with no poller running
//   GET  /api/health           { ok, uptime, clients, poller }
//   GET  /api/now-playing      last known state
//   GET  /api/config           current config
//   POST /api/config           save config, broadcast configChanged
//   POST /api/artwork          body = { data: "data:image/..." } -> { hash, url }
//   GET  /api/artwork/<hash>   cached artwork bytes
//   POST /api/send             broadcast an arbitrary overlay message
//   POST /api/test             { title, artist, ... } -> simulated trackChanged
//   POST /api/command          { command: "show"|"hide"|"test"|"reconnect" }
//   GET  /api/sessions         media sessions the poller last reported
//   WS   /ws                   overlay connects here; gets state on connect

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const configStore = require('./config-store');

const PORT = parseInt(process.env.TRAX_PORT, 10) || 8787;
const BASE = process.pkg ? path.dirname(process.execPath) : __dirname;
const started = Date.now();

let config = configStore.load();
let bindHost = process.env.TRAX_BIND || config.bind || '127.0.0.1';

// --- Current state -----------------------------------------------------------
// Held here so a browser source that loads (or reloads) mid-song immediately
// gets the current track instead of waiting for the next poll.
let state = {
    type: 'state',
    trackId: '',
    title: '',
    artist: '',
    album: '',
    sourceApp: '',
    artworkUrl: '',
    playbackStatus: 'stopped',
    positionSeconds: 0,
    durationSeconds: 0,
    timestamp: new Date(0).toISOString()
};
let sessions = [];
let pollerAlive = false;

// --- Artwork cache -----------------------------------------------------------
// Keyed by content hash so identical art is never stored or sent twice. Bounded
// so a long stream with hundreds of tracks cannot grow without limit.
const ART_MAX_ENTRIES = 60;
const artwork = new Map(); // hash -> { buf, mime }

function cacheArtwork(dataUrl) {
    const m = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) return null;
    const mime = m[1] === 'image/png' || m[1] === 'image/jpeg' ? m[1] : 'image/jpeg';
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null;

    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    if (artwork.has(hash)) {
        // Refresh recency: delete + re-set moves it to the end of the Map order.
        const entry = artwork.get(hash);
        artwork.delete(hash);
        artwork.set(hash, entry);
    } else {
        artwork.set(hash, { buf, mime });
        while (artwork.size > ART_MAX_ENTRIES) {
            artwork.delete(artwork.keys().next().value); // evict oldest
        }
    }
    return hash;
}

// --- HTTP --------------------------------------------------------------------
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.md': 'text/plain; charset=utf-8'
};

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function json(res, code, body) {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS));
    res.end(JSON.stringify(body));
}

function isLoopback(req) {
    const a = req.socket.remoteAddress;
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function readBody(req, limit, cb) {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
        body += c;
        if (body.length > limit) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
        if (tooBig) return cb(new Error('body too large'));
        if (!body) return cb(null, {});
        try { cb(null, JSON.parse(body)); } catch (e) { cb(e); }
    });
    req.on('error', () => { if (!tooBig) cb(new Error('request aborted')); });
}

function lanUrls() {
    const urls = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const i of ifaces[name]) {
            if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}/overlay`);
        }
    }
    return urls;
}

// Page routes -> files on disk
const PAGES = { '/': 'config.html', '/overlay': 'overlay.html', '/config': 'config.html', '/preview': 'preview.html' };

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    // --- GET API ---
    if (req.method === 'GET') {
        if (url === '/api/health') {
            return json(res, 200, {
                ok: true,
                uptime: Math.floor((Date.now() - started) / 1000),
                clients: wss.clients.size,
                poller: pollerAlive,
                bind: bindHost,
                lanUrls: bindHost === '127.0.0.1' ? [] : lanUrls()
            });
        }
        if (url === '/api/now-playing') return json(res, 200, liveState());
        if (url === '/api/config') return json(res, 200, config);
        if (url === '/api/sessions') return json(res, 200, { sessions, following: state.sourceApp });

        if (url.startsWith('/api/artwork/')) {
            // Hex-only hash lookup against an in-memory Map — no filesystem path
            // is ever built from the request, so this route cannot read files.
            const hash = url.slice('/api/artwork/'.length);
            const entry = /^[0-9a-f]{1,64}$/.test(hash) ? artwork.get(hash) : null;
            if (!entry) return json(res, 404, { error: 'not found' });
            res.writeHead(200, {
                'Content-Type': entry.mime,
                'Content-Length': entry.buf.length,
                // Immutable: the URL is a content hash, so it can never change.
                'Cache-Control': 'public, max-age=31536000, immutable'
            });
            return res.end(entry.buf);
        }

        // --- Static ---
        const rel = PAGES[url] || url.slice(1);
        const file = path.resolve(BASE, rel);
        // Must stay inside BASE, and config.json (may contain a LAN setting) is
        // served through /api/config instead, never as a raw file.
        const inBase = file === BASE || file.startsWith(BASE + path.sep);
        if (inBase && !path.basename(file).startsWith('.') && path.basename(file) !== 'config.json') {
            const ext = path.extname(file).toLowerCase();
            if (MIME[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
                // no-cache so OBS picks up edits on source refresh
                res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-cache' });
                return fs.createReadStream(file).pipe(res);
            }
        }
        return json(res, 404, { error: 'not found' });
    }

    // --- POST API ---
    if (req.method === 'POST') {
        if (url === '/api/config') {
            if (!isLoopback(req)) return json(res, 403, { error: 'loopback only' });
            return readBody(req, 65536, (err, body) => {
                if (err) return json(res, 400, { error: err.message });
                const previousBind = config.bind;
                try {
                    config = configStore.save(body);
                } catch (e) {
                    return json(res, 500, { error: 'could not write config.json: ' + e.message });
                }
                broadcast({ type: 'configChanged', config });
                json(res, 200, config);
                if (config.bind !== previousBind) rebind(config.bind);
            });
        }

        if (url === '/api/artwork') {
            if (!isLoopback(req)) return json(res, 403, { error: 'loopback only' });
            return readBody(req, 12 * 1024 * 1024, (err, body) => {
                if (err) return json(res, 400, { error: err.message });
                const hash = cacheArtwork(body && body.data);
                if (!hash) return json(res, 400, { error: 'not a png/jpeg data url' });
                json(res, 200, { hash, url: `/api/artwork/${hash}` });
            });
        }

        if (url === '/api/send') {
            if (!isLoopback(req)) return json(res, 403, { error: 'loopback only' });
            return readBody(req, 65536, (err, body) => {
                if (err) return json(res, 400, { error: err.message });
                applyMessage(body);
                broadcast(body);
                json(res, 200, { ok: true, clients: wss.clients.size });
            });
        }

        if (url === '/api/test') {
            if (!isLoopback(req)) return json(res, 403, { error: 'loopback only' });
            return readBody(req, 65536, (err, body) => {
                if (err) return json(res, 400, { error: err.message });
                const msg = Object.assign({
                    type: 'trackChanged',
                    trackId: 'test-' + Date.now(),
                    title: 'Test Track',
                    artist: 'Test Artist',
                    album: '',
                    sourceApp: 'Test',
                    artworkUrl: '',
                    playbackStatus: 'playing',
                    positionSeconds: 0,
                    durationSeconds: 210,
                    timestamp: new Date().toISOString()
                }, body || {});
                msg.type = 'trackChanged';
                applyMessage(msg);
                broadcast(msg);
                json(res, 200, { ok: true, sent: msg });
            });
        }

        if (url === '/api/command') {
            if (!isLoopback(req)) return json(res, 403, { error: 'loopback only' });
            return readBody(req, 4096, (err, body) => {
                if (err) return json(res, 400, { error: err.message });
                const allowed = ['show', 'hide', 'test', 'reconnect'];
                const command = body && body.command;
                if (!allowed.includes(command)) return json(res, 400, { error: 'unknown command', allowed });
                broadcast({ type: command });
                json(res, 200, { ok: true });
            });
        }

        if (url === '/api/shutdown') {
            if (!isLoopback(req)) return json(res, 403, { error: 'loopback only' });
            json(res, 200, { ok: true });
            console.log('[server] shutdown requested');
            return setTimeout(() => process.exit(0), 250);
        }
    }

    json(res, 404, { error: 'not found' });
});

// --- WebSocket ---------------------------------------------------------------
const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcast(obj, except) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    wss.clients.forEach((client) => {
        if (client !== except && client.readyState === WebSocket.OPEN) client.send(text);
    });
}

/** Cached state with the position advanced to right now.
 *
 *  The bridge reports an interpolated position (SMTC freezes its own after track
 *  start), stamped with the moment it was computed. Advancing from that timestamp
 *  is therefore valid, and it closes the gap between heartbeats — without it, a
 *  browser source that refreshes mid-song would resume counting from wherever the
 *  last heartbeat left off, up to 20 s behind. */
function liveState() {
    const s = Object.assign({}, state);
    if (s.playbackStatus !== 'playing' || !(s.durationSeconds > 0)) return s;
    const at = Date.parse(s.timestamp);
    if (isNaN(at)) return s;
    const elapsed = (Date.now() - at) / 1000;
    // Sanity-bound it: a stale cache from before a long idle should not fabricate
    // an absurd position.
    if (elapsed > 0 && elapsed < 3600) {
        s.positionSeconds = Math.min(s.durationSeconds, s.positionSeconds + elapsed);
    }
    return s;
}

/** Fold an incoming message into the cached state, so a late overlay is current. */
function applyMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'trackChanged' || msg.type === 'state') {
        state = Object.assign({}, state, msg, { type: 'state' });
        pollerAlive = true;
    } else if (msg.type === 'playbackChanged') {
        state.playbackStatus = msg.playbackStatus || state.playbackStatus;
        if (typeof msg.positionSeconds === 'number') state.positionSeconds = msg.positionSeconds;
        state.timestamp = msg.timestamp || new Date().toISOString();
        pollerAlive = true;
    } else if (msg.type === 'timeline') {
        if (typeof msg.positionSeconds === 'number') state.positionSeconds = msg.positionSeconds;
        if (typeof msg.durationSeconds === 'number') state.durationSeconds = msg.durationSeconds;
        state.timestamp = msg.timestamp || new Date().toISOString();
        pollerAlive = true;
    } else if (msg.type === 'sessions') {
        sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
        pollerAlive = true;
    }
}

wss.on('connection', (ws, req) => {
    const isLocal = isLoopback(req);
    console.log(`[ws] client connected (${wss.clients.size} total)`);

    // Prime the new client so it renders the current track immediately.
    ws.send(JSON.stringify({ type: 'configChanged', config }));
    ws.send(JSON.stringify(liveState()));

    ws.on('message', (raw) => {
        const text = raw.toString();
        if (text.length > 65536) return;
        let msg;
        try { msg = JSON.parse(text); } catch (e) { return; }
        // Only the local bridge may push state; a LAN-connected overlay is a
        // consumer, not a producer.
        if (!isLocal) return;
        applyMessage(msg);
        broadcast(text, ws);
    });

    ws.on('close', () => console.log(`[ws] client disconnected (${wss.clients.size} left)`));
    ws.on('error', (e) => console.error('[ws]', e.message));
});

// --- Listen ------------------------------------------------------------------
function rebind(host) {
    bindHost = host;
    console.log(`[server] rebinding to ${host}`);
    // Drop connections so close() can finish; overlay and bridge reconnect on
    // their own within seconds.
    wss.clients.forEach((c) => c.terminate());
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => {
        server.listen(PORT, bindHost, () => {
            console.log(`[server] now ${bindHost === '127.0.0.1' ? 'localhost only' : 'open to the LAN'}`);
        });
    });
}

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`\n  Port ${PORT} is already in use — TRAX may already be running.`);
        console.error(`  Config page: http://127.0.0.1:${PORT}/config\n`);
        process.exit(1);
    } else {
        throw e;
    }
});

server.listen(PORT, bindHost, () => {
    console.log(`[server] TRAX on http://127.0.0.1:${PORT} (${bindHost === '127.0.0.1' ? 'localhost only' : 'open to LAN'})`);
});

// The bridge marks the poller dead if it stops reporting, so /api/health is
// honest about whether metadata is actually flowing.
module.exports = {
    markPollerDead: () => { pollerAlive = false; },
    getConfig: () => config
};
