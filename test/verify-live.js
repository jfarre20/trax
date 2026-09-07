// Live end-to-end check against a running TRAX instance.
//   node test/verify-live.js
//
// Complements test/run.js (which is pure unit tests) by exercising the actual
// HTTP + WebSocket surface: artwork round trip, message routing, and the
// guarantee that timeline traffic does not look like a track change on the wire.

const http = require('http');
const WebSocket = require('ws');

const PORT = parseInt(process.env.TRAX_PORT, 10) || 8787;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function req(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const r = http.request({
            host: '127.0.0.1', port: PORT, path, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 1x1 red PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

(async () => {
    console.log('\nTRAX live verification against ' + ORIGIN);

    // ---------------------------------------------------------------- HTTP
    console.log('\nHTTP');
    const health = await req('GET', '/api/health');
    ok('/api/health returns 200 and ok:true', health.status === 200 && JSON.parse(health.body).ok === true);

    for (const p of ['/overlay', '/config', '/preview', '/overlay.css', '/overlay.js']) {
        const r = await req('GET', p);
        ok(p + ' serves 200', r.status === 200, 'got ' + r.status);
    }

    const cfg = await req('GET', '/api/config');
    const config = JSON.parse(cfg.body);
    ok('/api/config binds to loopback by default', config.bind === '127.0.0.1');

    // ------------------------------------------------------------- security
    console.log('\nSecurity');
    const rawConfig = await req('GET', '/config.json');
    ok('config.json is not served as a static file', rawConfig.status === 404, 'got ' + rawConfig.status);

    for (const attack of [
        '/../package.json',
        '/..%2fpackage.json',
        '/api/artwork/../../package.json',
        '/api/artwork/..%2F..%2Fpackage.json',
        '/api/artwork/zz;rm',
        '/.rpc-token.json'
    ]) {
        const r = await req('GET', attack);
        const leaked = r.status === 200 && /"dependencies"|"name":\s*"trax"/.test(r.body.toString());
        ok('rejects ' + attack, !leaked, 'status ' + r.status);
    }

    const badCmd = await req('POST', '/api/command', { command: 'process.exit' });
    ok('unknown commands are rejected', badCmd.status === 400);

    // -------------------------------------------------------------- artwork
    console.log('\nArtwork cache');
    const up1 = await req('POST', '/api/artwork', { data: PNG });
    const art1 = JSON.parse(up1.body);
    ok('artwork upload returns a hash url', up1.status === 200 && /^\/api\/artwork\/[0-9a-f]+$/.test(art1.url), art1.url);

    const up2 = await req('POST', '/api/artwork', { data: PNG });
    ok('identical artwork yields the identical hash (no duplicate storage)',
        JSON.parse(up2.body).hash === art1.hash);

    const fetched = await req('GET', art1.url);
    ok('cached artwork is served with an image content type',
        fetched.status === 200 && /^image\//.test(fetched.headers['content-type']),
        fetched.headers['content-type']);
    ok('cached artwork is immutable-cacheable', /immutable/.test(fetched.headers['cache-control'] || ''));

    const bogus = await req('POST', '/api/artwork', { data: 'data:text/html,<script>alert(1)</script>' });
    ok('non-image data urls are rejected', bogus.status === 400);

    const missing = await req('GET', '/api/artwork/deadbeefdeadbeef');
    ok('unknown artwork hash 404s', missing.status === 404);

    // ------------------------------------------------------------ WebSocket
    console.log('\nWebSocket');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const received = [];
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('ws open timed out')), 4000);
    });
    ws.on('message', (raw) => {
        try { received.push(JSON.parse(raw.toString())); } catch (e) { /* ignore */ }
    });

    await sleep(250);
    ok('a new client is primed with config on connect', received.some((m) => m.type === 'configChanged'));
    ok('a new client is primed with current state on connect', received.some((m) => m.type === 'state'));

    // --- Simulated track change ---
    received.length = 0;
    await req('POST', '/api/test', {
        title: 'Riders On The Storm', artist: 'Snoop Dogg', album: 'Need For Speed',
        sourceApp: 'Spotify', durationSeconds: 244, artworkUrl: art1.url
    });
    await sleep(250);
    const changes = received.filter((m) => m.type === 'trackChanged');
    ok('POST /api/test broadcasts exactly one trackChanged', changes.length === 1, 'got ' + changes.length);
    ok('the broadcast carries the metadata', changes[0] && changes[0].title === 'Riders On The Storm');

    const np = JSON.parse((await req('GET', '/api/now-playing')).body);
    ok('/api/now-playing reflects the simulated track', np.title === 'Riders On The Storm');
    ok('/api/now-playing carries the artwork url', np.artworkUrl === art1.url);

    // --- THE key behaviour: timeline traffic must not look like a track change ---
    received.length = 0;
    for (let i = 1; i <= 25; i++) {
        await req('POST', '/api/send', {
            type: 'timeline', positionSeconds: i * 4, durationSeconds: 244,
            timestamp: new Date().toISOString()
        });
    }
    await sleep(300);
    const spurious = received.filter((m) => m.type === 'trackChanged');
    const timelines = received.filter((m) => m.type === 'timeline');
    ok('25 timeline updates produce zero trackChanged messages', spurious.length === 0,
        'got ' + spurious.length + ' spurious track changes');
    ok('the timeline updates did arrive', timelines.length === 25, 'got ' + timelines.length);

    const np2 = JSON.parse((await req('GET', '/api/now-playing')).body);
    // /api/now-playing interpolates forward from the last reported position, so
    // this lands slightly past 100 — the point is that it advanced to roughly the
    // synced value and the track identity did not change.
    ok('position advanced without the track changing',
        np2.positionSeconds >= 100 && np2.positionSeconds < 103 && np2.trackId === np.trackId,
        `pos=${np2.positionSeconds} trackId=${np2.trackId} vs ${np.trackId}`);

    // --- config broadcast ---
    received.length = 0;
    const saveRes = await req('POST', '/api/config', Object.assign({}, config, { scale: 1.25 }));
    await sleep(250);
    ok('saving config returns the clamped result', JSON.parse(saveRes.body).scale === 1.25);
    ok('saving config broadcasts configChanged', received.some((m) => m.type === 'configChanged'));
    // Put it back.
    await req('POST', '/api/config', config);

    // --- commands ---
    received.length = 0;
    await req('POST', '/api/command', { command: 'show' });
    await req('POST', '/api/command', { command: 'hide' });
    await sleep(250);
    ok('show/hide commands are broadcast',
        received.some((m) => m.type === 'show') && received.some((m) => m.type === 'hide'));

    ws.close();
    console.log('\n' + (failed ? '✗' : '✓') + ` ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error('\nverification aborted:', e.message);
    console.error('Is TRAX running?  node start.js');
    process.exit(1);
});
