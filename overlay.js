/* TRAX overlay client.
 *
 * Responsibilities, in order of importance:
 *   1. Never animate unless the track actually changed. The bridge already
 *      distinguishes trackChanged from timeline/playbackChanged, and this file
 *      additionally guards on trackId so a re-announced `state` message (sent
 *      every 20 s so a late-loading source is correct) does not replay anything.
 *   2. Stay quiet when disconnected — hide, retry with backoff, no error UI.
 *   3. Interpolate progress locally between the sparse timeline syncs.
 */

(function () {
    'use strict';

    // ---------------------------------------------------------------- elements
    const body = document.body;
    const card = document.getElementById('card');
    const stage = document.getElementById('stage');
    const artBox = document.querySelector('.art');
    const artLayers = Array.prototype.slice.call(document.querySelectorAll('.art-layer'));
    const elTitle = document.getElementById('title');
    const elArtist = document.getElementById('artist');
    const elAlbum = document.getElementById('album');
    // Each text line sits inside a .mq-wrap that clips it and scrolls on overflow.
    const wrapOf = (el) => el.closest('.mq-wrap');
    const elSource = document.getElementById('source');
    const elFill = document.getElementById('fill');
    const elElapsed = document.getElementById('elapsed');
    const elTotal = document.getElementById('total');
    const elBadgeTitle = document.getElementById('badge-title');
    const elDebug = document.getElementById('debug');

    // Animation lengths must match overlay.css. Kept here as the authored
    // (speed-1) totals; divided by animSpeed at use time.
    const ENTER_MS = 1040;
    const EXIT_MS = 880;
    const LOGO_EXIT_MS = 880;   // panel retracts before the badge assembles
    const INTRO_MS = 520;       // logo appears centred and drops in before the reveal
    const SETTLE_MS = 300;   // metadata debounce before animating

    // Matches a run of emoji, including variation selectors, ZWJ sequences and
    // flag pairs, so a multi-codepoint emoji is wrapped as one unit.
    const PICTOGRAPHIC = /(?:\p{RI}\p{RI}|\p{Extended_Pictographic}(?:️|⃣)?(?:‍\p{Extended_Pictographic}(?:️|⃣)?)*)/gu;

    const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

    // ------------------------------------------------------------------ state
    let config = null;
    let track = null;            // last track we animated for
    let pendingTrack = null;
    let settleTimer = null;
    let holdTimer = null;
    let phaseTimer = null;
    let artIndex = 0;
    let derivedAccent = null;   // accents pulled from the current artwork, if any
    let wsRef = null;
    let backoff = 1000;
    let connected = false;
    let lastMessage = '(none)';

    // Progress interpolation anchor
    let sync = { position: 0, duration: 0, at: 0, playing: false };
    let rafId = 0;

    // -------------------------------------------------------------- utilities
    function clearTimers() {
        clearTimeout(settleTimer); settleTimer = null;
        clearTimeout(holdTimer); holdTimer = null;
        clearTimeout(phaseTimer); phaseTimer = null;
        clearTimeout(badgeTimer); badgeTimer = null;
        clearTimeout(dropTimer); dropTimer = null;
    }

    function fmtTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) seconds = 0;
        const total = Math.floor(seconds);
        const m = Math.floor(total / 60);
        const s = total % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    /** Force a style flush so removing + re-adding an animation class restarts it. */
    function reflow(el) { void el.offsetWidth; }

    function speed() { return (config && config.animSpeed) || 1; }

    /** Set text, wrapping emoji runs so the CRT bloom can skip them.
     *  Built from text nodes only — metadata is never parsed as HTML. */
    function setText(el, text) {
        el.textContent = '';
        const str = text || '';
        let last = 0;
        for (const m of str.matchAll(PICTOGRAPHIC)) {
            if (m.index > last) el.appendChild(document.createTextNode(str.slice(last, m.index)));
            const span = document.createElement('span');
            span.className = 'emoji';
            span.textContent = m[0];
            el.appendChild(span);
            last = m.index + m[0].length;
        }
        if (last < str.length) el.appendChild(document.createTextNode(str.slice(last)));
    }

    /** Scroll a line only when it genuinely overflows its wrapper. */
    function applyMarquee(el) {
        const wrap = wrapOf(el);
        if (!wrap) return;
        wrap.classList.remove('scrolling');
        wrap.style.removeProperty('--mq');
        wrap.style.removeProperty('--mq-dur');
        if (!config.marquee) return;

        const overflow = el.scrollWidth - wrap.clientWidth;
        if (overflow > 4) {
            wrap.style.setProperty('--mq', overflow + 'px');
            // Constant scroll rate so a very long line is not faster than a
            // slightly-too-long one, plus the held pauses at each end.
            wrap.style.setProperty('--mq-dur', Math.max(5, overflow / 55 + 3).toFixed(1) + 's');
            wrap.classList.add('scrolling');
        }
    }

    // ----------------------------------------------------------------- config
    function applyConfig(next) {
        config = next;
        const root = document.documentElement.style;

        root.setProperty('--accent', config.accent);
        root.setProperty('--accent2', config.accent2);
        root.setProperty('--panel-op', String(config.panelOpacity));
        // Older saved configs do not have this checkbox yet; default it on.
        root.setProperty('--plate-op', config.opaqueBackground === false ? String(config.panelOpacity) : '1');
        root.setProperty('--blur', config.blur + 'px');
        root.setProperty('--scan', String(config.scanlines));
        root.setProperty('--noise', String(config.noise));
        root.setProperty('--shake', String(config.shake));
        root.setProperty('--font', config.fontFamily);
        root.setProperty('--scale', String(config.scale));
        root.setProperty('--maxw', config.maxWidth + 'px');
        root.setProperty('--spd', String(config.animSpeed));
        root.setProperty('--ox', config.offsetX + 'px');
        root.setProperty('--oy', config.offsetY + 'px');
        root.setProperty('--badge-drop', config.badgeDropY + 'px');

        // Re-apply the artwork-derived accent after the configured one, so saving
        // a setting mid-track does not revert the colour.
        if (config.artAccent && derivedAccent) {
            root.setProperty('--accent', derivedAccent.accent);
            root.setProperty('--accent2', derivedAccent.accent2);
        }

        // Position class
        body.className = body.className.replace(/\bpos-[\w-]+/g, '').trim();
        body.classList.add('pos-' + config.position);
        card.classList.toggle('collapse-up', config.collapseDirection === 'up');

        // Text case
        body.classList.remove('case-none', 'case-upper', 'case-lower', 'case-title');
        body.classList.add('case-' + config.textCase);

        body.classList.toggle('no-art', !config.showArt);
        body.classList.toggle('no-artist', !config.showArtist);
        body.classList.toggle('no-album', !config.showAlbum);
        body.classList.toggle('no-source', !config.showSource);
        body.classList.toggle('no-progress', !config.showProgress);
        body.classList.toggle('no-time', !config.showTime);
        body.classList.toggle('debug', !!config.debug);
        body.classList.toggle('no-badge-title', !config.badgeTitle);

        // A custom badge image, if configured, replaces the built-in marks.
        // The path is validated server-side as a safe relative filename.
        if (config.logoUrl) badgeMarks.img.src = config.logoUrl;
        else badgeMarks.img.removeAttribute('src');
        setBadgeMark();

        // Re-render the current track so truncation / marquee / case changes and
        // the mini-vs-full resting state take effect immediately.
        if (track) {
            render(track);

            // Only reshape the card when it is at rest — interrupting a running
            // sequence would strand half-finished animations.
            const animating = card.classList.contains('intro') || card.classList.contains('enter')
                || card.classList.contains('exit') || card.classList.contains('exit-logo');

            if (!animating) {
                if (config.compactMode) {
                    // Mini and the badge hide each other's elements, so a leftover
                    // badge state here would leave nothing on screen at all.
                    clearTimeout(badgeTimer); badgeTimer = null;
                    card.classList.remove('hold', 'badge', 'badge-cycle', 'word-on', 'badge-dropped');
                    card.classList.add('mini');
                    show();
                } else if (card.classList.contains('mini')) {
                    card.classList.remove('mini');
                    card.classList.add('hold');
                    show();
                }
            }
            if (config.alwaysVisible && !card.classList.contains('collapsed')) show();
        }
        debug();
    }

    // ---------------------------------------------------------------- artwork
    /** Resolve once the image is decodable, or immediately if there is no art. */
    function preloadArt(url) {
        return new Promise((resolve) => {
            // Only ever load from our own artwork route, or an inline image the
            // OBS plugin embedded — never an arbitrary URL taken from metadata.
            const ok = url && (/^\/api\/artwork\/[0-9a-f]{1,64}$/.test(url)
                || /^data:image\/(png|jpe?g|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/.test(url));
            if (!ok) return resolve(null);
            const img = new Image();
            img.onload = () => resolve(img.src);
            img.onerror = () => resolve(null);
            img.src = url;
        });
    }

    function setArt(src) {
        if (!src) {
            artLayers.forEach((l) => l.classList.remove('shown'));
            artBox.classList.remove('has-image');
            derivedAccent = null;
            return;
        }
        // Alternate layers so the outgoing image fades under the incoming one.
        const incoming = artLayers[artIndex % artLayers.length];
        const outgoing = artLayers[(artIndex + 1) % artLayers.length];
        artIndex++;

        incoming.src = src;
        incoming.classList.add('shown');
        outgoing.classList.remove('shown');
        artBox.classList.add('has-image');

        if (config && config.artAccent) deriveAccent(incoming);
    }

    /** Pull a usable accent from the artwork: the most colourful pixel of a
     *  downscaled copy, floored so a near-grey cover cannot produce a dead accent. */
    function deriveAccent(img) {
        try {
            const N = 12;
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = N;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, N, N);
            const px = ctx.getImageData(0, 0, N, N).data;

            let best = null;
            let bestScore = -1;
            for (let i = 0; i < px.length; i += 4) {
                const r = px[i], g = px[i + 1], b = px[i + 2];
                const max = Math.max(r, g, b), min = Math.min(r, g, b);
                if (max < 40 || max > 245) continue;           // skip near-black/white
                const sat = max === 0 ? 0 : (max - min) / max;
                const score = sat * (max / 255);
                if (score > bestScore) { bestScore = score; best = [r, g, b]; }
            }
            if (!best || bestScore < 0.12) return;             // too grey to be useful

            // Lift into a bright, saturated accent so it still reads on charcoal.
            const boost = (v) => Math.round(Math.min(255, v * 1.25 + 20));
            const hex = '#' + best.map((v) => boost(v).toString(16).padStart(2, '0')).join('');
            // Secondary: same hue, darker.
            const dim = '#' + best.map((v) => Math.round(v * 0.62).toString(16).padStart(2, '0')).join('');
            // Remembered, because applyConfig rewrites --accent from the config on
            // every save — without this, changing any unrelated setting snaps the
            // colour back to the configured orange mid-track.
            derivedAccent = { accent: hex, accent2: dim };
            document.documentElement.style.setProperty('--accent', hex);
            document.documentElement.style.setProperty('--accent2', dim);
        } catch (e) {
            // Tainted canvas should be impossible (same-origin artwork), but a
            // failure here must never break the reveal.
        }
    }

    // ----------------------------------------------------------------- render
    function render(t) {
        let title = t.title || '';
        const useMarquee = config.marquee;

        // Truncate only when the marquee is off; otherwise let it scroll.
        if (!useMarquee && title.length > config.titleMaxLength) {
            title = title.slice(0, config.titleMaxLength).trimEnd() + '…';
        }

        // Text nodes only — metadata is never interpreted as HTML.
        setText(elTitle, title);
        setText(elArtist, t.artist || '');
        setText(elAlbum, t.album || '');
        elSource.textContent = t.sourceApp || '';

        // Collapsed mode keeps a truncated line of data under the mark. CSS does
        // the visual ellipsis; the slice is a guard against pathological lengths.
        setText(elBadgeTitle, (t.title || '').slice(0, 120));

        // Marquee every line that overflows, not just the title: browser sessions
        // routinely put a whole paragraph of description in the artist field.
        // Measured after layout, so it reflects the real rendered width.
        requestAnimationFrame(() => {
            applyMarquee(elTitle);
            applyMarquee(elArtist);
            applyMarquee(elAlbum);
        });

        const showBar = config.showProgress && t.durationSeconds > 0;
        body.classList.toggle('no-progress', !showBar);
        updateProgress();
    }

    // --------------------------------------------------------------- progress
    /** Where playback has got to, interpolating from the last anchor. */
    function currentPosition() {
        let pos = sync.position;
        if (sync.playing) pos += (performance.now() - sync.at) / 1000;
        return Math.max(0, sync.duration ? Math.min(sync.duration, pos) : pos);
    }

    /** Move the interpolation anchor.
     *
     *  Only three things may call this: a track change, a real play/pause edge,
     *  and a `timeline` message. Nothing else — in particular NOT the periodic
     *  `state` heartbeat.
     *
     *  The reason is that SMTC's Position is not a live clock. It is whatever the
     *  app last pushed via UpdateTimelineProperties, and most apps push it once at
     *  track start and never again — a Brave session was observed holding
     *  position 0.016 with last_updated_time frozen across 30 s of audible
     *  playback. The heartbeat echoes that frozen value, so anchoring to it drags
     *  elapsed back to zero on the heartbeat interval.
     *
     *  A tolerance check does not save you here: the longer the track plays, the
     *  further the stale value diverges, so "only adopt it when it disagrees a
     *  lot" adopts it every single time. Gating by message type is what works.
     *  `timeline` is safe to trust because track-change.js only emits it when the
     *  position genuinely moved, the user seeked, or the duration changed. */
    function anchor(position, duration) {
        if (typeof duration === 'number' && duration > 0) sync.duration = duration;
        if (typeof position !== 'number') return;
        sync.position = Math.max(0, position);
        sync.at = performance.now();
    }

    /** Change play/pause state, freezing the interpolated value at the transition
     *  so a pause does not silently accumulate elapsed time. */
    function setPlaying(playing) {
        if (playing === sync.playing) return;
        sync.position = currentPosition();
        sync.at = performance.now();
        sync.playing = playing;
        body.classList.toggle('paused', !playing);
    }

    function updateProgress() {
        if (!track || !sync.duration) {
            elFill.style.width = '0%';
            elElapsed.textContent = '0:00';
            elTotal.textContent = '0:00';
            return;
        }
        const pos = currentPosition();
        elFill.style.width = (pos / sync.duration * 100).toFixed(2) + '%';
        elElapsed.textContent = fmtTime(pos);
        // Elapsed / total. Showing remaining here instead reads as a wrong
        // duration, because "0:32 / 2:27" looks like a total to anyone glancing at it.
        elTotal.textContent = fmtTime(sync.duration);
    }

    function tick() {
        updateProgress();
        checkLevelStaleness();
        rafId = requestAnimationFrame(tick);
    }

    function startTicking() {
        if (!rafId) rafId = requestAnimationFrame(tick);
    }

    function stopTicking() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }

    // ------------------------------------------------------------ audio levels
    // obs-websocket reports loudness, not a spectrum, so every bar is driven from
    // the same number. To keep it from looking like one solid block, each bar gets
    // its own weighting and decay rate — the result reads as a level meter, which
    // is honest about what the data actually is.
    // Both the card's meter and the badge's bar mark are driven from one set of
    // heights, so they stay in step through the collapse.
    const barGroups = [
        Array.prototype.slice.call(document.querySelectorAll('.eq i')),
        Array.prototype.slice.call(document.querySelectorAll('.m-eq i'))
    ];
    const bars = barGroups[0];
    const BAR_WEIGHT = [0.72, 1.0, 0.6, 0.9, 0.66];
    const BAR_DECAY = [0.22, 0.15, 0.28, 0.18, 0.25];
    const BAR_LAG = [3, 0, 5, 1, 4];   // samples of delay, for a travelling-wave read
    const barHeights = bars.map(() => 0);
    const BAR_MIN = 4;
    const BAR_MAX = 32;

    // Recent history so each bar can read a slightly older sample.
    const HISTORY = 8;
    const history = new Array(HISTORY).fill(0);
    let historyAt = 0;

    // Rolling peak envelope, for auto-gain. Raw loudness barely travels — music
    // sits in a narrow band a long way above silence, so mapping absolute dB to
    // bar height leaves them pinned high and nearly static. Scaling against the
    // recent peak instead means the bars use their full range whatever the
    // material's level, and the expansion below deepens the troughs so the motion
    // actually reads on stream.
    const PEAK_DECAY = 0.995;
    const PEAK_FLOOR = 0.08;
    let peakEnv = PEAK_FLOOR;
    const EXPAND = 1.6;

    let levelsSeenAt = 0;

    function applyLevel(level, peak) {
        const v = Math.max(0, Math.min(1, typeof level === 'number' ? level : 0));
        const p = Math.max(v, Math.min(1, typeof peak === 'number' ? peak : v));
        levelsSeenAt = performance.now();
        body.classList.add('audio-reactive');

        const raw = v * 0.7 + p * 0.3;

        // Peak follows instantly upward, bleeds down slowly.
        peakEnv = raw > peakEnv ? raw : Math.max(PEAK_FLOOR, peakEnv * PEAK_DECAY);
        const scaled = Math.min(1, raw / peakEnv);
        const shaped = Math.pow(scaled, EXPAND);

        history[historyAt % HISTORY] = shaped;
        historyAt++;

        for (let i = 0; i < barHeights.length; i++) {
            const idx = (historyAt - 1 - BAR_LAG[i] + HISTORY * 2) % HISTORY;
            const target = Math.min(1, history[idx] * BAR_WEIGHT[i]);
            // Fast attack, slow release — the standard meter feel.
            barHeights[i] = target > barHeights[i]
                ? target
                : barHeights[i] + (target - barHeights[i]) * BAR_DECAY[i];
            const px = (BAR_MIN + barHeights[i] * (BAR_MAX - BAR_MIN)).toFixed(1) + 'px';
            barGroups.forEach((group) => { if (group[i]) group[i].style.height = px; });
        }
    }

    /** If the level feed stops (OBS closed, setting turned off), hand the bars
     *  back to the CSS animation rather than leaving them frozen. */
    function checkLevelStaleness() {
        if (!levelsSeenAt || performance.now() - levelsSeenAt < 1200) return;
        levelsSeenAt = 0;
        body.classList.remove('audio-reactive');
        barGroups.forEach((group) => group.forEach((bar) => bar.style.removeProperty('height')));
    }

    // ------------------------------------------------------------------- badge
    // The collapsed state lands where the meter was and cycles its mark:
    // bars -> note -> speaker -> bars, crossfading, then shrinks a little.
    // Slow on purpose — fast swaps read as a blink rather than a dissolve.
    // Starts on 'note' because the badge is already resting on the bars — a
    // leading 'eq' would be a step that changes nothing.
    const BADGE_CYCLE = ['note', 'speaker', 'eq'];
    const BADGE_STEP_MS = 900;
    const WORD_DELAY_MS = 760;   // let the badge assemble, then spell it out
    const WORD_HOLD_MS = 3200;   // how long "Music" stays before the mark cycles
    const badgeMarks = {
        eq: document.querySelector('.badge-mark.m-eq'),
        note: document.querySelector('.badge-mark.m-note'),
        speaker: document.querySelector('.badge-mark.m-speaker'),
        img: document.querySelector('.badge-mark.m-img')
    };
    let badgeTimer = null;
    let dropTimer = null;

    /** Crossfade to one mark by name. */
    function setBadgeMark(name) {
        const want = (config && config.logoUrl) ? 'img'
            : (name || (config && config.badgeMark) || 'eq');
        Object.keys(badgeMarks).forEach((key) => {
            if (badgeMarks[key]) badgeMarks[key].classList.toggle('on', key === want);
        });
    }

    /** Collapse choreography: rest on the M, spell it out to "Music" for a beat,
     *  then cycle the mark and settle. */
    function runBadgeCycle() {
        clearTimeout(badgeTimer);
        clearTimeout(dropTimer);
        card.classList.remove('word-on', 'badge-dropped');

        // Let the badge sit where the card left it for a beat before tucking it
        // into the corner — moving it while the collapse is still reading looks
        // rushed. Independent of the mark cycle, so tuning one cannot skew the other.
        dropTimer = setTimeout(() => card.classList.add('badge-dropped'),
            Math.max(0, config.badgeDropDelay * 1000));

        // A custom image has nothing to spell or alternate — go straight to resting.
        if (config.logoUrl) {
            setBadgeMark();
            return;
        }

        const step = (ms, fn) => { badgeTimer = setTimeout(fn, ms / speed()); };

        setBadgeMark('eq');                       // the M: slashes + bars
        step(WORD_DELAY_MS, () => {
            card.classList.add('word-on');        // ...usic
            step(WORD_HOLD_MS, () => {
                // "Music" withdraws on the same beat the mark first changes, so
                // the wordmark reads as giving way to the cycle rather than
                // disappearing on its own a moment earlier.
                let i = 0;
                const next = () => {
                    if (i === 0) card.classList.remove('word-on');
                    setBadgeMark(BADGE_CYCLE[i]);
                    i++;
                    if (i < BADGE_CYCLE.length) step(BADGE_STEP_MS, next);
                    else step(BADGE_STEP_MS, () => setBadgeMark());
                };
                next();
            });
        });
    }

    // -------------------------------------------------------- animation phases
    function show() {
        card.classList.add('visible');
        startTicking();
    }

    function hide() {
        clearTimers();
        card.classList.remove('visible', 'intro', 'enter', 'hold', 'exit', 'exit-logo', 'mini', 'collapsed', 'badge-cycle', 'word-on', 'badge-dropped');
        setBadgeMark();
        stopTicking();
    }

    /** Full enter -> hold -> (exit | mini) sequence. */
    function play() {
        clearTimers();

        card.classList.remove('intro', 'enter', 'exit', 'exit-logo', 'hold', 'mini', 'collapsed', 'badge-cycle', 'word-on', 'badge-dropped');
        reflow(card);
        // Keep the full card's bottom edge through the smaller resting states.
        // offsetHeight is unscaled, so OBS transforms and overlay Scale still work.
        card.style.setProperty('--full-height', card.offsetHeight + 'px');
        show();

        if (config.exitStyle === 'logo') {
            // Mirror the collapse on the way in: logo up, drop into place, then
            // the panel unfolds. Resting on the bar mark makes the hand-off to the
            // card's own meter invisible.
            setBadgeMark('eq');
            card.classList.add('intro');
            phaseTimer = setTimeout(() => {
                card.classList.remove('intro');
                reflow(card);
                card.classList.add('enter');
                afterEnter();
            }, INTRO_MS / speed());
        } else {
            card.classList.add('enter');
            afterEnter();
        }
    }

    /** Settle into hold once the reveal finishes, then schedule the exit. */
    function afterEnter() {
        phaseTimer = setTimeout(() => {
            // Swap to the settled state so no `both`-filled animation is left
            // pinning the element when we later start the exit.
            card.classList.remove('enter');
            card.classList.add('hold');

            if (config.alwaysVisible && !config.compactMode) return; // stay open

            holdTimer = setTimeout(() => {
                if (!config.compactMode) { retract(); return; }

                // Stage two: collapse into the persistent strip.
                card.classList.remove('hold');
                card.classList.add('mini');

                // Stage three, optional: keep going on to the badge (or away
                // entirely) after the strip has had its turn. miniSeconds 0 means
                // the strip is the final resting state.
                if (config.miniSeconds > 0 && !config.alwaysVisible) {
                    holdTimer = setTimeout(retract, config.miniSeconds * 1000);
                }
            }, Math.max(0, config.holdSeconds * 1000));
        }, ENTER_MS / speed());
    }

    function retract() {
        clearTimeout(holdTimer); holdTimer = null;
        card.classList.remove('hold', 'enter');
        reflow(card);

        // "logo": slide the panel out to the left and leave the badge behind.
        // "retract": the original reverse wipe, ending with nothing on screen.
        const toBadge = config.exitStyle === 'logo';
        card.classList.add(toBadge ? 'exit-logo' : 'exit');

        phaseTimer = setTimeout(() => {
            if (toBadge) {
                // Swap to the resting badge state only once the panel has fully
                // gone, so the badge is not fighting it for layout space, then run
                // the mark cycle and shrink.
                card.classList.remove('exit-logo', 'mini');
                card.classList.add('collapsed');
                runBadgeCycle();
            } else {
                card.classList.remove('exit', 'visible', 'mini');
            }
            stopTicking();
        }, (toBadge ? LOGO_EXIT_MS : EXIT_MS) / speed());
    }

    /** A track change arrived — debounce, preload art, then animate. */
    function queueTrack(t) {
        pendingTrack = t;
        clearTimeout(settleTimer);
        // Metadata often arrives in two steps (title first, artist a beat later),
        // so wait for it to stop moving before committing to an animation.
        settleTimer = setTimeout(async () => {
            const t2 = pendingTrack;
            if (!t2) return;
            track = t2;
            sync = {
                position: t2.positionSeconds || 0,
                duration: t2.durationSeconds || 0,
                at: performance.now(),
                playing: t2.playbackStatus === 'playing'
            };
            body.classList.toggle('paused', t2.playbackStatus !== 'playing');

            const src = await preloadArt(t2.artworkUrl);
            setArt(src);
            render(t2);

            if (t2.playbackStatus !== 'playing' && !config.showWhenPaused) {
                hide();
                return;
            }
            play();
            debug();
        }, SETTLE_MS);
    }

    // ------------------------------------------------------------- WS handling
    function handle(msg) {
        lastMessage = msg.type;

        switch (msg.type) {
            case 'configChanged':
                applyConfig(msg.config);
                break;

            case 'state':
            case 'trackChanged': {
                if (!msg.title) { track = null; hide(); break; }

                const isNew = !track || msg.trackId !== track.trackId;
                if (msg.type === 'trackChanged' || isNew) {
                    queueTrack(msg);
                } else {
                    // Same track re-announced (the 20 s heartbeat). Refresh
                    // metadata, duration and play state — but deliberately NOT
                    // the position. This message echoes whatever the app last
                    // published, which for most apps is a frozen value from track
                    // start; adopting it is what made elapsed reset on a timer.
                    track = Object.assign({}, track, msg);
                    if (msg.durationSeconds) sync.duration = msg.durationSeconds;
                    setPlaying(msg.playbackStatus === 'playing');
                }
                break;
            }

            case 'playbackChanged': {
                if (!track) break;
                const wasPlaying = sync.playing;
                setPlaying(msg.playbackStatus === 'playing');
                // A real play/pause edge is one of the few moments an app does
                // refresh its published position, so trust it here.
                if (typeof msg.positionSeconds === 'number' && msg.positionSeconds > 0) {
                    sync.position = msg.positionSeconds;
                    sync.at = performance.now();
                }
                if (msg.durationSeconds) sync.duration = msg.durationSeconds;

                if (msg.playbackStatus === 'stopped') { hide(); track = null; break; }

                if (!sync.playing && !config.showWhenPaused) {
                    hide();
                } else if (sync.playing && !wasPlaying) {
                    const pausedFor = msg.resumedAfterPauseSeconds || 0;
                    if (config.retriggerOnResume && pausedFor >= config.minPauseSeconds) {
                        play();   // long enough pause to be worth re-announcing
                    } else {
                        // Short pause: come back without replaying the reveal.
                        show();
                        if (config.compactMode) card.classList.add('mini');
                        else card.classList.add('hold');
                    }
                }
                break;
            }

            case 'timeline':
                // Never animates. This is the message that used to cause replays.
                // Safe to anchor on: the detector only sends it for real movement.
                if (!track) break;
                anchor(msg.positionSeconds, msg.durationSeconds);
                track.positionSeconds = sync.position;
                track.durationSeconds = sync.duration;
                body.classList.toggle('no-progress', !(config.showProgress && sync.duration > 0));
                break;

            case 'show':
                if (track) play();
                break;

            case 'hide':
                hide();
                break;

            case 'test':
                if (track) play();
                break;

            case 'levels':
                applyLevel(msg.level, msg.peak);
                break;

            case 'reconnect':
                if (wsRef) wsRef.close();
                break;
        }
        debug();
    }

    function connect() {
        let ws;
        try {
            ws = new WebSocket(WS_URL);
        } catch (e) {
            setTimeout(connect, backoff);
            backoff = Math.min(backoff * 2, 15000);
            return;
        }
        wsRef = ws;

        ws.onopen = () => {
            connected = true;
            backoff = 1000;
            debug();
        };

        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (!config && msg.type !== 'configChanged') return; // wait for config
            handle(msg);
        };

        ws.onclose = () => {
            connected = false;
            wsRef = null;
            // Quietly disappear — never show a disconnected state on stream.
            hide();
            setTimeout(connect, backoff);
            backoff = Math.min(backoff * 2, 15000);
            debug();
        };

        ws.onerror = () => { try { ws.close(); } catch (e) { /* already closing */ } };
    }

    // ------------------------------------------------------------------ debug
    function debug() {
        if (!config || !config.debug) return;
        const phase = card.classList.contains('enter') ? 'enter'
            : card.classList.contains('exit') ? 'exit'
                : card.classList.contains('mini') ? 'mini'
                    : card.classList.contains('hold') ? 'hold' : 'idle';
        elDebug.textContent = [
            'TRAX  ws=' + (connected ? 'open' : 'closed') + '  last=' + lastMessage,
            'phase=' + phase + '  visible=' + card.classList.contains('visible'),
            'track=' + (track ? track.trackId : '-') + '  ' + (track ? track.title + ' / ' + track.artist : ''),
            'source=' + (track ? track.sourceApp : '-') + '  status=' + (track ? track.playbackStatus : '-'),
            'pos=' + sync.position.toFixed(1) + 's  dur=' + sync.duration.toFixed(1) + 's  art=' + (track && track.artworkUrl ? 'yes' : 'no'),
            'viewport=' + window.innerWidth + 'x' + window.innerHeight + '  scale=' + config.scale
        ].join('\n');
    }

    // Hosted by the OBS plugin (obs-plugin/) rather than by server.js: there is
    // no server to talk to. The plugin pushes the same messages through
    // obs-browser's javascript_event proc handler, which lands here as a DOM
    // CustomEvent carrying the JSON in detail. Listening for it is harmless
    // under the server too, so it is always wired up.
    //
    // Detecting that mode has to allow for both shapes obs-browser gives a
    // local file: a real file:/// URL, or http://absolute/<path> when it was
    // built without the local-file URL scheme (see obs-browser-source.cpp).
    const pluginHosted = location.protocol === 'file:' || location.hostname === 'absolute';

    window.addEventListener('trax', (ev) => {
        const msg = ev.detail;
        if (!msg || typeof msg !== 'object') return;
        if (!config && msg.type !== 'configChanged') return; // wait for config
        handle(msg);
    });

    if (!pluginHosted) {
        // Config arrives over WS on connect, but fetch it too so ?preview pages and
        // a first paint before the socket opens are not unstyled.
        fetch('/api/config')
            .then((r) => r.json())
            .then((c) => { if (!config) applyConfig(c); })
            .catch(() => { /* server not up yet; WS will deliver it */ });

        connect();
    }

    // Expose a minimal hook for preview.html, which drives the same code path
    // with fake messages and no backend.
    window.TRAX = { handle, applyConfig, play, hide };
})();
