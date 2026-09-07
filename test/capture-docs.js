// Captures the README screenshots.
//
// Drives the overlay's config in-page via window.TRAX rather than writing to
// config.json, so running this never disturbs a live setup.
//
//   node test/capture-docs.js

const { spawn } = require('child_process');
const fs = require('fs'); const http = require('http');
const os = require('os'); const path = require('path'); const WebSocket = require('ws');

const BROWSERS = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];
const PORT = parseInt(process.env.TRAX_CDP_PORT, 10) || 9611;
const TRAX = parseInt(process.env.TRAX_PORT, 10) || 8787;
const OUT = 'docs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const g = (p) => new Promise((r, j) => {
    const q = http.get({ host: '127.0.0.1', port: PORT, path: p }, (s) => {
        let o = ''; s.on('data', (c) => o += c);
        s.on('end', () => { try { r(JSON.parse(o)); } catch (e) { j(e); } });
    });
    q.on('error', j); q.setTimeout(2000, () => q.destroy(new Error('timeout')));
});

const TRACK = {
    title: 'Riders On The Storm', artist: 'Snoop Dogg vs The Doors',
    album: 'Need For Speed Underground 2', sourceApp: 'Spotify',
    durationSeconds: 244, positionSeconds: 71
};

// Each shot: a config overlay on top of the server's, and when to grab it.
const SHOTS = [
    {
        file: 'screenshot-full-card.png',
        at: 2200,
        cfg: { alwaysVisible: true, compactMode: false, showAlbum: true, showTime: true, exitStyle: 'retract' }
    },
    {
        file: 'screenshot-mini-mode.png',
        at: 4200,
        cfg: { alwaysVisible: false, compactMode: true, miniSeconds: 0, holdSeconds: 1, showAlbum: true, showTime: true }
    },
    {
        file: 'screenshot-collapsed.png',
        at: 6000,
        cfg: {
            alwaysVisible: false, compactMode: false, holdSeconds: 1, exitStyle: 'logo',
            badgeMark: 'eq', badgeTitle: true, badgeDropY: 35, badgeDropDelay: 0.4
        }
    }
];

(async () => {
    fs.mkdirSync(OUT, { recursive: true });

    // Artwork for the card, pushed into the server's hash cache.
    const png = fs.readFileSync(path.join(os.tmpdir(), 'art.png')).toString('base64');
    const artUrl = await new Promise((resolve) => {
        const body = JSON.stringify({ data: 'data:image/png;base64,' + png });
        const req = http.request({
            host: '127.0.0.1', port: TRAX, path: '/api/artwork', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => { let o = ''; res.on('data', (c) => o += c); res.on('end', () => resolve(JSON.parse(o).url)); });
        req.on('error', () => resolve(''));
        req.end(body);
    });

    const exe = BROWSERS.find((p) => fs.existsSync(p));
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
    const child = spawn(exe, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
        '--hide-scrollbars', '--default-background-color=00000000', '--disable-extensions',
        '--window-size=1920,1080', `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${prof}`, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', () => {});

    // /json/version starts answering before Chrome has created a page, and with
    // headless=new the only initial targets can be an extension background page
    // and chrome://headless. Rather than poll and hope, attach to the browser
    // endpoint and create the page target explicitly.
    let version = null;
    for (let i = 0; i < 80; i++) {
        try { version = await g('/json/version'); break; } catch (e) { await sleep(300); }
    }
    if (!version) throw new Error('browser never exposed its debugging port');

    // Ask the browser to make a page, then talk to that page on its own socket —
    // simpler and more predictable than multiplexing sessions over the browser
    // endpoint.
    const bws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { bws.on('open', r); bws.on('error', j); setTimeout(() => j(new Error('browser ws timeout')), 15000); });
    await new Promise((r, j) => {
        bws.once('message', () => r());
        bws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }));
        setTimeout(() => j(new Error('createTarget timeout')), 10000);
    });
    bws.close();

    let page = null;
    for (let i = 0; i < 60; i++) {
        try { page = (await g('/json/list')).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (page) break; } catch (e) {}
        await sleep(250);
    }
    if (!page) throw new Error('no page target after createTarget');

    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); setTimeout(() => j(new Error('page ws timeout')), 15000); });

    let id = 0; const pend = new Map();
    ws.on('message', (buf) => {
        const m = JSON.parse(buf.toString());
        if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); }
    });
    const send = (me, pa) => new Promise((r, j) => {
        const i = ++id; pend.set(i, { r, j });
        ws.send(JSON.stringify({ id: i, method: me, params: pa || {} }));
        setTimeout(() => { if (pend.has(i)) { pend.delete(i); j(new Error('timeout ' + me)); } }, 15000);
    });
    const ev = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

    for (const shot of SHOTS) {
        await send('Page.navigate', { url: `http://127.0.0.1:${TRAX}/overlay` });
        await sleep(1200);
        const track = Object.assign({}, TRACK, {
            type: 'trackChanged', trackId: 'docs-' + shot.file, artworkUrl: artUrl,
            playbackStatus: 'playing', timestamp: new Date().toISOString()
        });
        await ev(`fetch('/api/config').then(function(r){return r.json()}).then(function(c){
            Object.assign(c, ${JSON.stringify(shot.cfg)});
            window.TRAX.applyConfig(c);
            window.TRAX.handle(${JSON.stringify(track)});
            return 'ok';
        })`);
        await sleep(shot.at);
        // Crop to the graphic, including the badge's transformed drop position.
        // The full transparent OBS canvas otherwise becomes empty space on GitHub.
        const clip = await ev(`(function () {
            const card = document.getElementById('card');
            const el = card.classList.contains('collapsed') ? card.querySelector('.badge') : card;
            const r = el.getBoundingClientRect();
            const x = Math.max(0, Math.floor(r.left - 16));
            const y = Math.max(0, Math.floor(r.top - 16));
            return { x, y, width: Math.min(innerWidth, Math.ceil(r.right + 16)) - x,
                height: Math.min(innerHeight, Math.ceil(r.bottom + 16)) - y, scale: 1 };
        })()`);
        const png2 = await send('Page.captureScreenshot', { format: 'png', clip });
        fs.writeFileSync(path.join(OUT, shot.file), Buffer.from(png2.data, 'base64'));
        console.log('wrote ' + path.join(OUT, shot.file));
    }

    ws.close(); child.kill();
    await sleep(400);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})().catch((e) => { console.error('capture failed:', e.message); process.exit(1); });
