// Grab a 1:1 screenshot of an OBS source through obs-websocket.
//
//   node obs-shot.js <sourceName> <out.png> [width] [height]
//
// The OBS preview is scaled to fit its dock, so screen-capturing it loses the
// pixel detail needed to judge a few-pixel rendering artifact. This asks OBS to
// render the source itself at an exact size instead.
//
// Password comes from obs-websocket's own config file, so it is never typed
// here or passed on the command line.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const source = process.argv[2];
const out = process.argv[3];
const width = parseInt(process.argv[4], 10) || 1920;
const height = parseInt(process.argv[5], 10) || 1080;

if (!source || !out) {
    console.error('usage: node obs-shot.js <sourceName> <out.png> [width] [height]');
    process.exit(2);
}

const cfgPath = path.join(process.env.APPDATA, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const port = cfg.server_port || 4455;

/** obs-websocket v5 auth: base64(sha256(base64(sha256(password + salt)) + challenge)) */
function authToken(password, salt, challenge) {
    const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
    return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const timer = setTimeout(() => { console.error('timed out'); process.exit(1); }, 20000);

ws.on('error', (e) => { console.error('websocket error:', e.message); process.exit(1); });

ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.op === 0) {
        const d = { rpcVersion: 1, eventSubscriptions: 0 };
        if (msg.d && msg.d.authentication) {
            d.authentication = authToken(cfg.server_password, msg.d.authentication.salt, msg.d.authentication.challenge);
        }
        return ws.send(JSON.stringify({ op: 1, d }));
    }

    if (msg.op === 2) {
        return ws.send(JSON.stringify({
            op: 6,
            d: {
                requestType: 'GetSourceScreenshot',
                requestId: 'shot',
                requestData: {
                    sourceName: source,
                    imageFormat: 'png',
                    imageWidth: width,
                    imageHeight: height
                }
            }
        }));
    }

    if (msg.op === 7) {
        clearTimeout(timer);
        const r = msg.d.requestStatus;
        if (!r.result) {
            console.error(`request failed: ${r.code} ${r.comment || ''}`);
            process.exit(1);
        }
        const data = msg.d.responseData.imageData.replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(out, Buffer.from(data, 'base64'));
        console.log(`wrote ${out} (${fs.statSync(out).size} bytes) at ${width}x${height}`);
        ws.close();
        process.exit(0);
    }
});
