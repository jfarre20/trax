// Screenshot helper: drives a real Chromium/Edge over the DevTools protocol so
// animations and transitions run on the real clock.
//
// Why not `--headless --screenshot --virtual-time-budget`: virtual time does not
// advance CSS transitions (and does not advance them at all inside subframes), so
// that path reports a progress bar stuck at width 0 and a card positioned against
// a viewport that is shorter than the requested window. Both are artifacts. Use
// this instead when verifying anything animated.
//
//   node test/shoot.js <url> <outfile.png> [waitMs]

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const BROWSERS = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

const url = process.argv[2] || 'http://127.0.0.1:8787/overlay';
const out = process.argv[3] || 'shot.png';
const waitMs = parseInt(process.argv[4], 10) || 2500;
const PORT = parseInt(process.env.TRAX_CDP_PORT, 10) || 9444;
const WIDTH = 1920;
const HEIGHT = 1080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(pathname, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 2000, () => { req.destroy(new Error('timeout')); });
    });
}

async function portLive() {
    try { await getJson('/json/version', 1200); return true; } catch (e) { return false; }
}

let child = null;
let profile = null;

async function ensureBrowser() {
    // Reuse an instance already listening on the port — repeated runs are much
    // faster, and a leftover browser would otherwise make the port unusable.
    if (await portLive()) return 'reused';

    const exe = BROWSERS.find((p) => fs.existsSync(p));
    if (!exe) throw new Error('no Chrome or Edge found in the usual locations');

    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trax-shoot-'));
    child = spawn(exe, [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--hide-scrollbars',
        `--window-size=${WIDTH},${HEIGHT}`,
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: false });

    child.stderr.on('data', () => { /* Edge logs auth/enclave noise on startup */ });
    child.on('exit', (code) => {
        if (!done) console.error('[shoot] browser exited early with code ' + code);
    });

    for (let i = 0; i < 80; i++) {
        if (await portLive()) return 'spawned';
        await sleep(250);
    }
    throw new Error('browser never exposed its debugging port');
}

let done = false;

(async () => {
    const how = await ensureBrowser();

    const targets = await getJson('/json/list', 4000);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target available');

    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('devtools websocket did not open')), 10000);
    });

    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
    });

    // Per-command timeout: a silent hang here is the difference between a useful
    // failure and a 120 s wall-clock mystery.
    const send = (method, params) => new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
        setTimeout(() => {
            if (pending.has(msgId)) { pending.delete(msgId); reject(new Error('CDP timeout: ' + method)); }
        }, 15000);
    });

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
        width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false
    });
    // Transparent page background so the captured alpha channel is meaningful —
    // this is what proves the overlay composites cleanly in OBS.
    await send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: 0, g: 0, b: 0, a: 0 }
    });
    await send('Page.navigate', { url });

    // Real wall-clock wait so the enter sequence and progress transition run.
    await sleep(waitMs);

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`wrote ${out} (${fs.statSync(out).size} bytes) after ${waitMs}ms [browser ${how}]`);

    done = true;
    ws.close();
    if (child) {
        child.kill();
        await sleep(400);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* leave it in temp */ }
    }
    process.exit(0);
})().catch((e) => {
    done = true;
    console.error('screenshot failed:', e.message);
    if (child) child.kill();
    process.exit(1);
});
