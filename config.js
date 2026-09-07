/* TRAX configuration page.
 *
 * Controls are generated from FIELDS so their ranges live in exactly one place
 * on the client; config-store.js clamps to the same ranges server-side, which is
 * the authoritative check.
 *
 * Saving POSTs the whole config and the server broadcasts `configChanged`. The
 * preview iframe is an ordinary overlay client, so it picks that up like OBS
 * would — there is no separate preview code path to drift out of sync.
 */

(function () {
    'use strict';

    const FIELDS = [
        // group, key, label, type, options
        ['layout', 'position', 'Position', 'select', {
            options: ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-center',
                'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']
        }],
        ['layout', 'offsetX', 'X offset', 'range', { min: 0, max: 600, step: 1, unit: 'px' }],
        ['layout', 'offsetY', 'Y offset', 'range', { min: 0, max: 600, step: 1, unit: 'px' }],
        ['layout', 'scale', 'Scale', 'range', { min: 0.25, max: 3, step: 0.05, unit: '×' }],
        ['layout', 'maxWidth', 'Maximum width', 'range', { min: 260, max: 1200, step: 10, unit: 'px' }],

        ['timing', 'holdSeconds', 'Show for', 'range', { min: 1, max: 30, step: 0.5, unit: 's', hint: 'How long the full card stays up after a track change.' }],
        ['timing', 'alwaysVisible', 'Show always', 'check', { hint: 'Never hide the card at all. Ignored when mini mode is on.' }],
        ['timing', 'compactMode', 'Collapse to mini strip', 'check', { hint: 'After the hold, shrink to a compact strip and stay. Expands again on the next track.' }],
        ['timing', 'collapseDirection', 'Collapse direction', 'select', { options: ['down', 'up'], hint: '"down" keeps the full card’s bottom edge fixed. "up" keeps its top edge fixed.' }],
        ['timing', 'miniSeconds', 'Then collapse after', 'range', { min: 0, max: 60, step: 0.5, unit: 's', hint: 'Only with the mini strip. 0 = stay in mini. Otherwise it collapses on to "When hiding" after this long.' }],
        ['timing', 'exitStyle', 'When hiding', 'select', {
            options: ['retract', 'logo'],
            hint: '"retract" wipes away to nothing. "logo" slides the panel left and leaves a badge behind.'
        }],
        ['timing', 'badgeMark', 'Badge rests on', 'select', { options: ['eq', 'speaker', 'note'], hint: 'The "logo" exit cycles bars -> note -> speaker, then settles on this.' }],
        ['timing', 'badgeDropY', 'Badge drops by', 'range', { min: 0, max: 200, step: 5, unit: 'px', hint: 'Once collapsed, the whole badge slides down by this much to tuck into the corner.' }],
        ['timing', 'badgeDropDelay', 'Badge drops after', 'range', { min: 0, max: 20, step: 0.5, unit: 's', hint: 'How long the badge sits in place before sliding down.' }],
        ['timing', 'badgeTitle', 'Show title on the badge', 'check', { hint: 'Keeps a truncated track title under the collapsed logo.' }],
        ['timing', 'logoUrl', 'Badge image', 'text', { hint: 'Optional. Relative filename next to the overlay, e.g. "assets/logo.png". Overrides the mark.' }],
        ['timing', 'animSpeed', 'Animation speed', 'range', { min: 0.4, max: 3, step: 0.05, unit: '×', hint: 'Higher is faster. 1× is a ~880 ms reveal.' }],
        ['timing', 'showWhenPaused', 'Stay visible when paused', 'check'],
        ['timing', 'retriggerOnResume', 'Replay on resume', 'check'],
        ['timing', 'minPauseSeconds', 'Minimum pause before replay', 'range', { min: 0, max: 300, step: 5, unit: 's' }],

        ['content', 'showArt', 'Album art', 'check'],
        ['content', 'showArtist', 'Artist', 'check'],
        ['content', 'showAlbum', 'Album', 'check'],
        ['content', 'showSource', 'Source app', 'check'],
        ['content', 'showProgress', 'Progress bar', 'check'],
        ['content', 'showTime', 'Elapsed / total time', 'check'],
        ['content', 'textCase', 'Text case', 'select', { options: ['none', 'upper', 'lower', 'title'] }],
        ['content', 'marquee', 'Scroll long titles', 'check', { hint: 'When off, long titles are truncated instead.' }],
        ['content', 'titleMaxLength', 'Truncate title at', 'range', { min: 10, max: 120, step: 1, unit: ' chars' }],

        ['look', 'accent', 'Accent colour', 'color'],
        ['look', 'accent2', 'Secondary accent', 'color'],
        ['look', 'artAccent', 'Derive accents from artwork', 'check', { hint: 'Overrides the colours above while art is available.' }],
        ['look', 'opaqueBackground', 'Keep background opaque', 'check', { hint: 'Keep the music card solid. Uncheck to use Panel opacity.' }],
        ['look', 'panelOpacity', 'Panel opacity', 'range', { min: 0.1, max: 1, step: 0.02, hint: 'Used when Keep background opaque is unchecked.' }],
        ['look', 'blur', 'Blur strength', 'range', { min: 0, max: 24, step: 1, unit: 'px' }],
        ['look', 'scanlines', 'Scanline intensity', 'range', { min: 0, max: 1, step: 0.02 }],
        ['look', 'noise', 'CRT noise intensity', 'range', { min: 0, max: 0.5, step: 0.01 }],
        ['look', 'shake', 'UI shake strength', 'range', { min: 0, max: 3, step: 0.1, unit: '×' }],
        ['look', 'fontFamily', 'Font family', 'text', { hint: 'CSS font stack. Bahnschrift Condensed ships with Windows 10/11.' }],

        ['session', 'preferredApp', 'Pin to app', 'text', { hint: 'Substring match, e.g. "Spotify". Blank = follow whatever is playing.' }],
        ['session', 'ignoredApps', 'Ignore apps', 'text', { hint: 'Comma separated, e.g. "chrome, msedge".', list: true }],

        ['audio', 'audioReactive', 'Bars react to OBS audio', 'check', { hint: 'Drives the equalizer from obs-websocket levels. Enable the WebSocket Server in OBS under Tools.' }],
        ['audio', 'obsPort', 'obs-websocket port', 'text', { hint: 'Default 4455.' }],
        ['audio', 'obsPassword', 'obs-websocket password', 'text', { hint: 'Leave blank if authentication is disabled in OBS.' }],
        ['audio', 'obsSource', 'Meter this source', 'text', { hint: 'Exact OBS input name, e.g. "Desktop Audio". Blank = loudest of all inputs.' }],

        ['advanced', 'debug', 'Debug readout on overlay', 'check'],
        ['advanced', 'bind', 'Open to the LAN', 'bind', { hint: 'Off = 127.0.0.1 only (recommended).' }]
    ];

    let config = null;
    let saveTimer = null;
    const inputs = {};

    const $ = (sel) => document.querySelector(sel);
    const toast = $('#toast');
    const statusEl = $('#status');
    const npEl = $('#np');

    // ---------------------------------------------------------------- controls
    function buildRow(group, key, label, type, opts) {
        opts = opts || {};
        const host = document.querySelector(`.rows[data-group="${group}"]`);
        if (!host) return;

        const row = document.createElement('div');
        row.className = 'row';

        const lab = document.createElement('label');
        lab.setAttribute('for', 'f-' + key);
        lab.textContent = label;
        if (opts.hint) {
            const hint = document.createElement('span');
            hint.className = 'hint';
            hint.textContent = opts.hint;
            lab.appendChild(hint);
        }
        row.appendChild(lab);

        const ctl = document.createElement('div');
        ctl.className = 'ctl';
        let input;
        let readout = null;

        if (type === 'select') {
            input = document.createElement('select');
            opts.options.forEach((o) => {
                const opt = document.createElement('option');
                opt.value = o;
                opt.textContent = o;
                input.appendChild(opt);
            });
        } else if (type === 'range') {
            input = document.createElement('input');
            input.type = 'range';
            input.min = opts.min; input.max = opts.max; input.step = opts.step;
            readout = document.createElement('span');
            readout.className = 'val';
        } else if (type === 'check' || type === 'bind') {
            input = document.createElement('input');
            input.type = 'checkbox';
        } else if (type === 'color') {
            input = document.createElement('input');
            input.type = 'color';
        } else {
            input = document.createElement('input');
            input.type = 'text';
        }

        input.id = 'f-' + key;
        ctl.appendChild(input);
        if (readout) ctl.appendChild(readout);
        row.appendChild(ctl);
        host.appendChild(row);

        inputs[key] = { input, readout, type, opts };

        const evt = (type === 'text') ? 'input' : (type === 'range' ? 'input' : 'change');
        input.addEventListener(evt, () => {
            collect(key);
            if (readout) readout.textContent = fmt(key);
            // Ranges and text fire per keystroke/drag; debounce the write.
            scheduleSave(type === 'range' || type === 'text' ? 220 : 0);
        });
    }

    function fmt(key) {
        const f = inputs[key];
        const v = config[key];
        const unit = f.opts.unit || '';
        const step = parseFloat(f.opts.step);
        const decimals = step < 1 ? (String(step).split('.')[1] || '').length : 0;
        return (typeof v === 'number' ? v.toFixed(decimals) : v) + unit;
    }

    /** Read one control into `config`. */
    function collect(key) {
        const f = inputs[key];
        const el = f.input;
        if (f.type === 'check') config[key] = el.checked;
        else if (f.type === 'bind') config[key] = el.checked ? '0.0.0.0' : '127.0.0.1';
        else if (f.type === 'range') config[key] = parseFloat(el.value);
        else if (f.opts.list) config[key] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
        else config[key] = el.value;
    }

    /** Write `config` into all controls. */
    function fill() {
        Object.keys(inputs).forEach((key) => {
            const f = inputs[key];
            const v = config[key];
            if (f.type === 'check') f.input.checked = !!v;
            else if (f.type === 'bind') f.input.checked = v === '0.0.0.0';
            else if (f.opts.list) f.input.value = (v || []).join(', ');
            else f.input.value = v;
            if (f.readout) f.readout.textContent = fmt(key);
        });
    }

    // -------------------------------------------------------------------- save
    function scheduleSave(delay) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, delay);
    }

    function save() {
        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        })
            .then((r) => r.json())
            .then((saved) => {
                if (saved.error) return showToast('Save failed: ' + saved.error);
                // The server clamps values; adopt its answer so the UI cannot
                // drift from what is actually stored.
                config = saved;
                fill();
                showToast('Saved');
            })
            .catch((e) => showToast('Save failed: ' + e.message));
    }

    let toastTimer = null;
    function showToast(text) {
        toast.textContent = text;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
    }

    // ----------------------------------------------------------------- preview
    function fitPreview() {
        const scene = $('#scene');
        const frame = $('#frame');
        const scale = scene.clientWidth / 1920;
        frame.style.transform = 'scale(' + scale + ')';
    }
    window.addEventListener('resize', fitPreview);

    // ------------------------------------------------------------------- tests
    const TESTS = {
        track: () => ({
            title: 'Riders On The Storm', artist: 'Snoop Dogg vs The Doors',
            album: 'Need For Speed', sourceApp: 'Spotify', durationSeconds: 244
        }),
        noart: () => ({
            title: 'Get Low', artist: 'Lil Jon & The East Side Boyz',
            album: '', sourceApp: 'Chrome', durationSeconds: 218, artworkUrl: ''
        }),
        long: () => ({
            title: 'This Is An Extremely Long Track Title Intended To Exercise Truncation And The Scrolling Marquee Behaviour',
            artist: 'An Artist With A Similarly Excessive And Unreasonable Name',
            album: 'A Very Long Album Name As Well', sourceApp: 'MusicBee', durationSeconds: 300
        }),
        unicode: () => ({
            title: '極彩色のクロスロード', artist: '中田ヤスタカ feat. きゃりーぱみゅぱみゅ',
            album: 'ナカタ・コレクション', sourceApp: 'Media Player', durationSeconds: 197
        })
    };

    let paused = false;

    function post(path, body) {
        return fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        }).then((r) => r.json());
    }

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;

        if (btn.dataset.test) {
            const kind = btn.dataset.test;
            if (TESTS[kind]) {
                paused = false;
                post('/api/test', TESTS[kind]()).then(() => showToast('Sent: ' + kind));
            } else if (kind === 'playpause') {
                paused = !paused;
                post('/api/send', {
                    type: 'playbackChanged',
                    playbackStatus: paused ? 'paused' : 'playing',
                    resumedAfterPauseSeconds: paused ? 0 : 999,
                    timestamp: new Date().toISOString()
                }).then(() => showToast(paused ? 'Paused' : 'Playing'));
            } else if (kind === 'half') {
                const dur = 244;
                post('/api/send', {
                    type: 'timeline', positionSeconds: dur / 2, durationSeconds: dur,
                    timestamp: new Date().toISOString()
                }).then(() => showToast('Progress → 50% (no replay)'));
            }
        }

        if (btn.dataset.cmd) {
            post('/api/command', { command: btn.dataset.cmd })
                .then(() => showToast('Command: ' + btn.dataset.cmd));
        }

        if (btn.dataset.act === 'reload') {
            $('#frame').src = 'overlay?t=' + Date.now();
            showToast('Preview reloaded');
        }
        if (btn.dataset.act === 'scene') {
            $('#scene').classList.toggle('plain');
        }
    });

    // ------------------------------------------------------------------ status
    function refreshStatus() {
        fetch('/api/health').then((r) => r.json()).then((h) => {
            statusEl.innerHTML = 'server <b>up</b> · poller <b class="' + (h.poller ? '' : 'bad') + '">'
                + (h.poller ? 'reporting' : 'no data') + '</b> · <b>' + h.clients + '</b> client'
                + (h.clients === 1 ? '' : 's');
        }).catch(() => {
            statusEl.innerHTML = 'server <b class="bad">down</b>';
        });

        fetch('/api/now-playing').then((r) => r.json()).then((s) => {
            npEl.textContent = s.title
                ? `${s.title}\n${s.artist || '—'}${s.album ? '\n' + s.album : ''}\n${s.sourceApp || '?'} · ${s.playbackStatus} · ${Math.round(s.positionSeconds)}s / ${Math.round(s.durationSeconds)}s`
                : 'Nothing playing.';
            npEl.style.whiteSpace = 'pre-line';
        }).catch(() => { npEl.textContent = '—'; });

        fetch('/api/sessions').then((r) => r.json()).then((d) => {
            const note = $('#session-note');
            if (!d.sessions || !d.sessions.length) {
                note.textContent = 'No media sessions detected. Start playing something, then reload.';
                return;
            }
            note.textContent = 'Detected: ' + d.sessions.map((s) => `${s.app} (${s.status})`).join(', ')
                + (d.following ? ' · following: ' + d.following : '');
        }).catch(() => { });
    }

    // -------------------------------------------------------------------- init
    FIELDS.forEach((f) => buildRow(f[0], f[1], f[2], f[3], f[4]));
    $('#overlay-url').textContent = location.origin + '/overlay';

    fetch('/api/config')
        .then((r) => r.json())
        .then((c) => {
            config = c;
            fill();
            fitPreview();
        })
        .catch(() => showToast('Could not load config'));

    refreshStatus();
    setInterval(refreshStatus, 3000);
    // The iframe lays out after its own load; refit then too.
    $('#frame').addEventListener('load', fitPreview);
})();
