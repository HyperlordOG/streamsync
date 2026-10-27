/**
 * StreamSync - Virtual Timeline Calculator
 * 
 * Computes exact playback positions at any arbitrary NTP time epoch.
 * Converts Play / Pause / Seek user actions into synchronized timeline states
 * compatible with the Hearo / StreamSync relay server protocol.
 * 
 * Positions are tracked in milliseconds internally for precision.
 */

export class VirtualTimeline {
  /**
   * @param {Object} [initialState]
   * @param {number|null} [initialState.started=null] Server NTP epoch ms when playback began
   * @param {number|null} [initialState.paused=0] Milliseconds position if paused, null if playing
   * @param {number} [initialState.rate=1.0] Nominal playback rate
   */
  constructor(initialState = {}) {
    /** @type {number|null} NTP epoch ms when play began (NTP_now - position_ms) */
    this.started = initialState.started ?? null;

    /** @type {number|null} Milliseconds position if paused; null if playing */
    this.paused = initialState.paused !== undefined ? initialState.paused : 0;

    /** @type {number} Nominal playback rate (default 1.0) */
    this.rate = initialState.rate ?? 1.0;
  }

  /**
   * Check if virtual timeline is currently paused.
   * @returns {boolean}
   */
  isPaused() {
    return this.paused !== null;
  }

  /**
   * Compute the calculated playback position in milliseconds at a specific NTP time epoch.
   * 
   * Formula:
   * - If paused: Position = sync.paused
   * - If playing: Position = (ntpTimeMs - sync.started) * rate
   * 
   * @param {number} ntpTimeMs Current synchronized server time
   * @returns {number} Playback position in milliseconds
   */
  getPositionMs(ntpTimeMs) {
    if (this.paused !== null) {
      return Math.max(0, Math.round(this.paused));
    }

    if (this.started !== null) {
      const elapsed = Math.max(0, ntpTimeMs - this.started);
      return Math.round(elapsed * this.rate);
    }

    return 0;
  }

  /**
   * Compute playback position in seconds (for HTML5 <video> elements).
   * @param {number} ntpTimeMs Current synchronized server time
   * @returns {number} Playback position in seconds
   */
  getPositionSeconds(ntpTimeMs) {
    return this.getPositionMs(ntpTimeMs) / 1000;
  }

  /**
   * Transition timeline into PLAYING state.
   * 
   * Formula:
   * sync.started = currentNtpMs - (fromPositionMs / rate)
   * sync.paused = null
   * 
   * @param {number} currentNtpMs Synchronized NTP time when play triggered
   * @param {number} [fromPositionMs] Optional start position in ms (defaults to current position)
   * @returns {{ started: number, paused: null }} New sync state payload for server
   */
  play(currentNtpMs, fromPositionMs) {
    const pos = fromPositionMs !== undefined ? fromPositionMs : this.getPositionMs(currentNtpMs);
    this.started = Math.round(currentNtpMs - (pos / this.rate));
    this.paused = null;

    return {
      started: this.started,
      paused: null,
    };
  }

  /**
   * Transition timeline into PAUSED state.
   * 
   * Formula:
   * sync.paused = current computed position
   * sync.started = null (or retained for historical reference)
   * 
   * @param {number} currentNtpMs Synchronized NTP time when pause triggered
   * @param {number} [atPositionMs] Optional explicit position in ms
   * @returns {{ started: number|null, paused: number }} New sync state payload for server
   */
  pause(currentNtpMs, atPositionMs) {
    const pos = atPositionMs !== undefined ? atPositionMs : this.getPositionMs(currentNtpMs);
    this.paused = Math.max(0, Math.round(pos));

    return {
      started: this.started,
      paused: this.paused,
    };
  }

  /**
   * Seek timeline to a specific target position in milliseconds.
   * 
   * Formula:
   * - If paused: sync.paused = targetPositionMs
   * - If playing: sync.started = currentNtpMs - (targetPositionMs / rate)
   * 
   * @param {number} currentNtpMs Synchronized NTP time when seek triggered
   * @param {number} targetPositionMs Target position in milliseconds
   * @returns {{ started: number|null, paused: number|null }} New sync state payload for server
   */
  seek(currentNtpMs, targetPositionMs) {
    const target = Math.max(0, Math.round(targetPositionMs));

    if (this.paused !== null) {
      this.paused = target;
    } else {
      this.started = Math.round(currentNtpMs - (target / this.rate));
    }

    return {
      started: this.started,
      paused: this.paused,
    };
  }

  /**
   * Update internal state from an inbound server sync payload.
   * @param {{ started?: number|null, paused?: number|null, rate?: number }} syncState
   */
  applySync(syncState) {
    if (!syncState) return;

    if (syncState.paused !== undefined) {
      this.paused = syncState.paused !== null ? Math.max(0, Math.round(syncState.paused)) : null;
    }

    if (syncState.started !== undefined) {
      this.started = syncState.started !== null ? Number(syncState.started) : null;
    }

    if (syncState.rate !== undefined && syncState.rate > 0) {
      this.rate = Number(syncState.rate);
    }
  }

  /**
   * Export current timeline state for serialization.
   * @returns {{ started: number|null, paused: number|null, rate: number }}
   */
  getState() {
    return {
      started: this.started,
      paused: this.paused,
      rate: this.rate,
    };
  }
}
