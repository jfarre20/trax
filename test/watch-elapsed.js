// Watches the overlay's rendered elapsed time in a real browser and reports any
// backwards jump. Guards the specific regression where a stale position from the
// state heartbeat re-anchored the interpolation and reset elapsed to zero.
//
//   node test/watch-elapsed.js [seconds]

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const BROWSERS = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];
const SECONDS = parseInt(process.argv[2], 10) || 60;
const PORT = 9488;
const TRAX = parseInt(process.env.TRAX_PORT, 10) || 8787;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(p) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
            let b = ''; res.on('data', (c) => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(1500, () => req.destroy(new Error('timeout')));
    });
}

(async () => {
    const exe = BROWSERS.find((p) => fs.existsSync(p));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trax-watch-'));
    const child = spawn(exe, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
        '--window-size=1920,1080', `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', () => {});

    for (let i = 0; i < 60; i++) {
        try { await getJson('/json/version'); break; } catch (e) { await sleep(250); }
    }

    const page = (await getJson('/json/list')).find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.id && pending.has(m.id)) {
            const { resolve, reject } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        }
    });
    const send = (method, params) => new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, { resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params: params || {} }));
        setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + method)); } }, 10000);
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${TRAX}/overlay` });
    await sleep(2500);

    const read = async () => {
        const r = await send('Runtime.evaluate', {
            expression: `JSON.stringify({
                e: document.getElementById('elapsed').textContent,
                t: document.getElementById('total').textContent,
                title: document.getElementById('title').textContent.slice(0,28)
            })`,
            returnByValue: true
        });
        return JSON.parse(r.result.value);
    };

    const toSec = (s) => {
        const p = String(s).split(':').map(Number);
        return p.length === 2 ? p[0] * 60 + p[1] : NaN;
    };

    console.log(`watching elapsed for ${SECONDS}s...\n`);
    let prev = null, prevTitle = null, regressions = 0, samples = 0;

    for (let i = 0; i < SECONDS; i++) {
        const s = await read();
        const cur = toSec(s.e);
        samples++;
        let note = '';
        if (prevTitle !== null && s.title !== prevTitle) {
            note = '  <== new track (reset expected)';
            prev = null;
        }
        if (prev !== null && cur < prev - 1) {
            note = `  <== *** WENT BACKWARDS from ${prev}s ***`;
            regressions++;
        }
        if (i % 5 === 0 || note) console.log(`  t=${String(i).padStart(3)}s  ${s.e} / ${s.t}${note}`);
        prev = cur; prevTitle = s.title;
        await sleep(1000);
    }

    console.log(`\n${regressions ? '✗' : '✓'} ${samples} samples, ${regressions} backwards jump(s)`);
    ws.close(); child.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    process.exit(regressions ? 1 : 0);
})().catch((e) => { console.error('watch failed:', e.message); process.exit(1); });
