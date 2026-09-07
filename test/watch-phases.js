// Logs every change to the card's animation phase, so the intro / reveal /
// collapse / badge sequence can be read as a timeline instead of inferred from
// isolated screenshots.
//
//   node test/watch-phases.js [seconds]

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
const SECONDS = parseInt(process.argv[2], 10) || 30;
// Optional: also write a PNG each time the phase changes.
const SHOTS = process.argv.includes('--shots')
    ? (process.env.TRAX_SHOT_DIR || 'C:/Users/Administrator/AppData/Local/Temp/phases') : null;
const PORT = parseInt(process.env.TRAX_CDP_PORT, 10) || 9489;
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

const PROBE = `JSON.stringify({
  card: document.getElementById('card').className || '(none)',
  vis: (function(){
     function v(sel){ var e=document.querySelector(sel); if(!e) return 'x';
       var c=getComputedStyle(e); var r=e.getBoundingClientRect();
       return c.display==='none' ? 'none' : (Math.round(r.width)+'x'+Math.round(r.height)+'@'+Math.round(r.x)+','+Math.round(r.y));
     }
     return { eq:v('.eq'), badge:v('#card > .badge'), body:v('.body'), word:v('.badge-word') };
  })(),
  wordOpen: getComputedStyle(document.querySelector('.badge-word')).maxWidth,
  badgeCss: (function(){ var b=document.querySelector('#card > .badge'); var c=getComputedStyle(b);
    return { anim: c.animationName, delay: c.animationDelay, xform: c.transform,
             drop: getComputedStyle(document.documentElement).getPropertyValue('--badge-drop') }; })(),
  on: ['m-eq','m-note','m-speaker','m-img'].filter(function(m){
        var e=document.querySelector('.badge-mark.'+m); return e && e.classList.contains('on'); })
})`;

(async () => {
    const exe = BROWSERS.find((p) => fs.existsSync(p));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trax-phase-'));
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
    if (!page) throw new Error('no page target');
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
    if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
        await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${TRAX}/overlay` });

    console.log(`watching phase changes for ${SECONDS}s (polling 80ms)\n`);
    const t0 = Date.now();
    let prev = '';
    const deadline = t0 + SECONDS * 1000;

    while (Date.now() < deadline) {
        let s;
        try {
            const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
            s = JSON.parse(r.result.value);
        } catch (e) { break; }

        const sig = s.card + '|' + JSON.stringify(s.on) + '|' + s.wordOpen + '|' + s.vis.badge + '|' + s.vis.body + '|' + s.vis.eq;
        if (sig !== prev) {
            const t = String(Date.now() - t0).padStart(6);
            console.log(`${t}ms  card=${JSON.stringify(s.card)}  on=${JSON.stringify(s.on)}  word=${s.wordOpen}`);
            console.log(`         eq=${s.vis.eq}  badge=${s.vis.badge}  body=${s.vis.body}`);
            console.log(`         badgeAnim=${s.badgeCss.anim} delay=${s.badgeCss.delay} xform=${s.badgeCss.xform} --badge-drop=${s.badgeCss.drop}`);
            prev = sig;
            if (SHOTS) {
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                fs.writeFileSync(path.join(SHOTS, `p-${String(Date.now() - t0).padStart(6, '0')}.png`), Buffer.from(shot.data, 'base64'));
            }
        }
        await sleep(80);
    }

    ws.close(); child.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
})().catch((e) => { console.error('watch failed:', e.message); process.exit(1); });
