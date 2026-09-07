// Track-change detection.
//
// Pulled out of media-bridge.js so it can be tested without spawning a poller or
// a WebSocket. The detector is fed raw poller samples and decides what kind of
// event, if any, each one represents. Time is passed in rather than read from the
// clock so tests can drive it deterministically.
//
// The distinction this module exists to enforce: a sample whose identity key
// (session|title|artist) is unchanged can NEVER produce a `trackChanged`, no
// matter how much its position moved. That is what stops the overlay replaying
// its reveal animation during ordinary playback.

const TIMELINE_SYNC_MS = 5000;
const SEEK_THRESHOLD_S = 3;
// Below this, the reported position is treated as not having moved at all.
const STALLED_EPSILON_S = 0.25;

function identityKey(sample) {
    const session = (sample.session && sample.session.id) || '';
    return `${session}|${sample.title || ''}|${sample.artist || ''}`;
}

function createDetector(options) {
    const opts = Object.assign({
        timelineSyncMs: TIMELINE_SYNC_MS,
        seekThresholdS: SEEK_THRESHOLD_S,
        stalledEpsilonS: STALLED_EPSILON_S
    }, options);

    let lastKey = '';
    let lastStatus = '';
    let lastPosition = 0;
    let lastDuration = 0;
    let lastSyncAt = -Infinity;
    let pausedSince = 0;

    return {
        /**
         * @param {object} sample  one parsed line from the poller
         * @param {number} now     milliseconds, monotonic within a run
         * @returns {object} { kind: 'none'|'stopped'|'trackChanged'|'playbackChanged'|'timeline', ... }
         */
        step(sample, now) {
            sample = sample || {};
            const title = sample.title || '';
            const status = sample.status || 'stopped';
            const position = typeof sample.position === 'number' ? sample.position : 0;
            const duration = typeof sample.duration === 'number' ? sample.duration : 0;

            // Nothing playing. Only report the transition, not every poll.
            if (!title) {
                if (lastKey === '') return { kind: 'none' };
                lastKey = '';
                lastStatus = status;
                lastPosition = 0;
                pausedSince = 0;
                return { kind: 'stopped' };
            }

            const key = identityKey(sample);
            const isNewTrack = key !== lastKey;

            // How long we were paused, measured before the status bookkeeping below
            // overwrites it. Only meaningful on a paused -> playing edge.
            let resumedAfterPauseSeconds = 0;
            if (!isNewTrack && status === 'playing' && lastStatus === 'paused' && pausedSince > 0) {
                resumedAfterPauseSeconds = (now - pausedSince) / 1000;
            }

            if (status === 'paused' && lastStatus !== 'paused') pausedSince = now;
            if (status === 'playing') pausedSince = 0;

            if (isNewTrack) {
                lastKey = key;
                lastStatus = status;
                lastPosition = position;
                lastDuration = duration;
                lastSyncAt = now;
                return {
                    kind: 'trackChanged',
                    key,
                    title,
                    artist: sample.artist || '',
                    album: sample.album || '',
                    sourceApp: (sample.session && sample.session.app) || '',
                    art: sample.art || '',
                    status,
                    position,
                    duration
                };
            }

            // --- Same track from here down. `trackChanged` is unreachable. ---

            if (status !== lastStatus) {
                lastStatus = status;
                lastSyncAt = now;
                lastPosition = position;
                lastDuration = duration;
                return { kind: 'playbackChanged', status, position, duration, resumedAfterPauseSeconds };
            }

            // Timeline sync.
            //
            // Critical: many apps never refresh their published position. SMTC's
            // Position only reflects what the app last pushed via
            // UpdateTimelineProperties, and browsers in particular push it once
            // and then leave it. Observed live: a Brave session sat at exactly
            // 107.568 for 12 s of polling while audibly playing.
            //
            // Re-sending that frozen value on a timer makes the overlay re-anchor
            // its local interpolation to a stale number every few seconds, so the
            // progress bar visibly jumps backwards on the sync interval. A sync is
            // therefore only worth sending when the value actually moved, when the
            // user seeked, or when the duration changed (apps often report 0 first
            // and the real length a beat later).
            const moved = Math.abs(position - lastPosition) > opts.stalledEpsilonS;
            const wentBackwards = position < lastPosition - 0.5;
            const jumped = Math.abs(position - lastPosition) > opts.seekThresholdS;
            const durationChanged = Math.abs(duration - lastDuration) > opts.stalledEpsilonS;

            if (wentBackwards || jumped || durationChanged || (moved && now - lastSyncAt >= opts.timelineSyncMs)) {
                lastSyncAt = now;
                lastPosition = position;
                lastDuration = duration;
                return { kind: 'timeline', position, duration };
            }

            return { kind: 'none' };
        },

        /** Forget everything — used when session preferences change and the poller
         *  restarts, since it may begin following a different app. */
        reset() {
            lastKey = '';
            lastStatus = '';
            lastPosition = 0;
            lastDuration = 0;
            lastSyncAt = -Infinity;
            pausedSince = 0;
        }
    };
}

module.exports = { createDetector, identityKey, TIMELINE_SYNC_MS, SEEK_THRESHOLD_S };
