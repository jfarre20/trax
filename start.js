// One-command launcher: relay server + media bridge in a single process.
//
//   node start.js              start everything
//   node start.js --configure  also open the config page in a browser
//
// Env: TRAX_PORT (default 8787), TRAX_BIND (127.0.0.1 | 0.0.0.0),
//      TRAX_NO_MEDIA=1 to skip the poller (useful for pure overlay work).

const { exec } = require('child_process');

const PORT = parseInt(process.env.TRAX_PORT, 10) || 8787;
const CONFIG_URL = `http://127.0.0.1:${PORT}/config`;
const OVERLAY_URL = `http://127.0.0.1:${PORT}/overlay`;

console.log('');
console.log('  ==========================================');
console.log('     TRAX — now playing overlay for OBS');
console.log('  ==========================================');
console.log('   OBS Browser Source (1920x1080, 60 fps):');
console.log(`     ${OVERLAY_URL}`);
console.log('   Configuration:');
console.log(`     ${CONFIG_URL}`);
console.log('  ==========================================');
console.log('');

require('./server.js');

// Let the relay bind before the bridge tries to connect. The bridge retries with
// backoff anyway, so this only avoids a noisy first attempt.
if (!process.env.TRAX_NO_MEDIA) {
    setTimeout(() => {
        require('./media-bridge.js');
        // Only connects to OBS when audioReactive is enabled in config.
        require('./obs-bridge.js');
    }, 400);
} else {
    console.log('[start] TRAX_NO_MEDIA set — poller not started');
}

// Only open a browser when explicitly asked, so running at startup is silent.
if (process.argv.includes('--configure')) {
    const open = process.platform === 'win32'
        ? `start "" "${CONFIG_URL}"`      // cmd builtin; the empty title arg is required
        : `xdg-open "${CONFIG_URL}"`;
    setTimeout(() => exec(open), 1200);
}

function shutdown() {
    console.log('\n[start] shutting down');
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
