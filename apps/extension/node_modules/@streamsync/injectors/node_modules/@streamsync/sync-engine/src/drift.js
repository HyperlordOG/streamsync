/**
 * StreamSync - Dual-Threshold Drift Correction Engine
 * 
 * Implements the continuous playback synchronization control loop derived
 * from the Hearo reverse-engineering analysis.
 * 
 * Zones:
 * - Deadband (|Δ| < 500ms): In sync. Normal rate (1.0x).
 * - Rate Slew (500ms <= |Δ| < 5000ms): Squelch drift smoothly without audio pitch warp (1.05x / 0.95x).
 * - Hard Seek (|Δ| >= 5000ms): Jump directly to target position.
 */

export const DriftState = {
  IN_SYNC: 'in_sync',
  SLEWING: 'slewing',
  SEEKING: 'seeking',
  BUFFERING: 'buffering',
};

export class DriftEngine {
  /**
   * @param {Object} options
   * @param {import('./timeline.js').VirtualTimeline} options.timeline
   * @param {import('./clock.js').ClockSynchronizer} options.clock
   * @param {import('./adapter/base.js').BasePlayerAdapter} options.player
   * @param {number} [options.checkIntervalMs=250] Control loop interval
   * @param {number} [options.deadbandMs=500] Drift threshold below which rate is 1.0x
   * @param {number} [options.hardSeekThresholdMs=5000] Drift threshold triggering hard seekTo
   * @param {number} [options.slewFastRate=1.05] Playback rate when local player is behind
   * @param {number} [options.slewSlowRate=0.95] Playback rate when local player is ahead
   * @param {number} [options.seekCooldownMs=600] Cooldown duration after hard seek before re-evaluating
   */
  constructor(options) {
    if (!options.timeline || !options.clock || !options.player) {
      throw new Error('DriftEngine requires { timeline, clock, player }');
    }

    this.timeline = options.timeline;
    this.clock = options.clock;
    this.player = options.player;

    this.checkIntervalMs = options.checkIntervalMs ?? 250;
    this.deadbandMs = options.deadbandMs ?? 500;
    this.hardSeekThresholdMs = options.hardSeekThresholdMs ?? 5000;
    this.slewFastRate = options.slewFastRate ?? 1.05;
    this.slewSlowRate = options.slewSlowRate ?? 0.95;
    this.seekCooldownMs = options.seekCooldownMs ?? 600;

    /** @type {string} Current drift status */
    this.currentState = DriftState.IN_SYNC;

    /** @type {NodeJS.Timeout|number|null} */
    this.timer = null;

    /** @type {number} Timestamp when last seek completed (for cooldown) */
    this.lastSeekTime = 0;

    /** @type {boolean} Engine running state */
    this.isRunning = false;

    /** @type {Set<(info: DriftReport) => void>} */
    this.listeners = new Set();
  }

  /**
   * Start the continuous drift correction control loop.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timer = setInterval(() => {
      this.tick();
    }, this.checkIntervalMs);
  }

  /**
   * Stop the drift control loop and reset player playback rate to 1.0.
   */
  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.player.setPlaybackRate(1.0);
    } catch {
      // Ignore if player destroyed
    }
  }

  /**
   * Single evaluation step of the drift correction loop.
   * Can be called manually in tests or every checkIntervalMs in production.
   * @returns {Promise<DriftReport>}
   */
  async tick() {
    const timelinePaused = this.timeline.isPaused();
    const playerPaused = this.player.isPaused();

    // 1. Align Play/Pause states between VirtualTimeline and Player
    if (timelinePaused && !playerPaused) {
      if (typeof this.player.withInternalAction === 'function') {
        await this.player.withInternalAction(() => this.player.pause());
      } else {
        await this.player.pause();
      }
    } else if (!timelinePaused && playerPaused) {
      try {
        if (typeof this.player.withInternalAction === 'function') {
          await this.player.withInternalAction(() => this.player.play());
        } else {
          await this.player.play();
        }
      } catch (err) {
        // Autoplay policy or user interaction needed
      }
    }

    // 2. If playback is running and player is actively buffering/stalled, wait for it
    if (!timelinePaused && this.player.isBuffering()) {
      this.currentState = DriftState.BUFFERING;
      const report = this._buildReport(0, 0, 0, DriftState.BUFFERING);
      this._notify(report);
      return report;
    }

    // 3. Compute Delta (Target - Current)
    const ntpNow = this.clock.now();
    const targetMs = this.timeline.getPositionMs(ntpNow);
    const currentMs = Math.round(this.player.getCurrentTime() * 1000);
    const deltaMs = targetMs - currentMs;
    const absDeltaMs = Math.abs(deltaMs);

    const now = Date.now();
    const isSeekingCooldown = (now - this.lastSeekTime) < this.seekCooldownMs;

    // 4. Evaluate Dual-Threshold Drift Correction
    if (absDeltaMs >= this.hardSeekThresholdMs && !isSeekingCooldown) {
      // Zone 3: Hard Seek
      this.currentState = DriftState.SEEKING;
      this.lastSeekTime = now;
      if (typeof this.player.withInternalAction === 'function') {
        await this.player.withInternalAction(() => this.player.seekTo(targetMs / 1000));
      } else {
        await this.player.seekTo(targetMs / 1000);
      }
      this.player.setPlaybackRate(1.0);

    } else if (absDeltaMs >= this.deadbandMs && !timelinePaused && !isSeekingCooldown) {
      // Zone 2: Pitch-preserving Rate Slewing
      this.currentState = DriftState.SLEWING;
      if (deltaMs > 0) {
        // Local is behind -> Speed up smoothly
        this.player.setPlaybackRate(this.slewFastRate);
      } else {
        // Local is ahead -> Slow down smoothly
        this.player.setPlaybackRate(this.slewSlowRate);
      }

    } else {
      // Zone 1: Deadband (< 500ms) or Paused in place
      this.currentState = DriftState.IN_SYNC;
      if (this.player.getPlaybackRate() !== 1.0) {
        this.player.setPlaybackRate(1.0);
      }
    }

    const report = this._buildReport(deltaMs, targetMs, currentMs, this.currentState);
    this._notify(report);
    return report;
  }

  /**
   * Helper to construct status snapshot.
   * @private
   */
  _buildReport(deltaMs, targetMs, currentMs, state) {
    return {
      deltaMs,
      absDeltaMs: Math.abs(deltaMs),
      targetMs,
      currentMs,
      state,
      playbackRate: this.player.getPlaybackRate(),
      isPaused: this.timeline.isPaused(),
      isCalibrated: this.clock.isCalibrated,
      serverTime: this.clock.now(),
      timestamp: Date.now(),
    };
  }

  /**
   * Broadcast drift report to subscribers.
   * @private
   */
  _notify(report) {
    for (const listener of this.listeners) {
      try {
        listener(report);
      } catch (err) {
        console.error('[DriftEngine] Listener error:', err);
      }
    }
  }

  /**
   * Subscribe to drift reports.
   * @param {(report: DriftReport) => void} listener
   * @returns {() => void} Unsubscribe function
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * @typedef {Object} DriftReport
 * @property {number} deltaMs
 * @property {number} absDeltaMs
 * @property {number} targetMs
 * @property {number} currentMs
 * @property {string} state
 * @property {number} playbackRate
 * @property {boolean} isPaused
 * @property {boolean} isCalibrated
 * @property {number} serverTime
 * @property {number} timestamp
 */
