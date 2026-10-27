/**
 * StreamSync - NTP Web Clock Synchronizer
 * 
 * Provides sub-millisecond clock synchronization against the relay server
 * using standard SNTP / NTP round-trip time (RTT) calculation with
 * outlier rejection, moving median filtering, and jitter tracking.
 */

export class ClockSynchronizer {
  /**
   * @param {Object} [options]
   * @param {number} [options.sampleSize=10] Maximum samples in sliding window
   * @param {number} [options.minSamples=3] Minimum samples required before marking calibrated
   * @param {number} [options.pingIntervalMs=5000] Interval between background sync pings
   * @param {function(): number} [options.nowProvider] Optional time provider (defaults to Date.now)
   */
  constructor(options = {}) {
    this.sampleSize = options.sampleSize ?? 10;
    this.minSamples = options.minSamples ?? 3;
    this.pingIntervalMs = options.pingIntervalMs ?? 5000;
    this.nowProvider = options.nowProvider ?? (() => Date.now());

    /**
     * Recent sample history
     * @type {Array<{ t0: number, t1: number, t3: number, rtt: number, offset: number, timestamp: number }>}
     */
    this.samples = [];

    /** @type {number} Current calibrated offset in ms (server_time - local_time) */
    this.offset = 0;

    /** @type {number} Round-trip time of best sample in ms */
    this.bestRtt = Infinity;

    /** @type {number} Moving median RTT in ms */
    this.medianRtt = 0;

    /** @type {number} Estimated jitter in ms */
    this.jitter = 0;

    /** @type {boolean} True if minimum required samples have been processed */
    this.isCalibrated = false;

    /** @type {NodeJS.Timeout|number|null} */
    this.pingTimer = null;

    /** @type {((msg: Object) => void)|null} Callback to send ping messages over transport */
    this.transportSend = null;

    /** @type {Set<(state: Object) => void>} Listeners for calibration updates */
    this.listeners = new Set();
  }

  /**
   * Attach a transport send function (e.g. WebSocket send).
   * @param {(msg: Object) => void} sendFn
   */
  setTransport(sendFn) {
    this.transportSend = sendFn;
  }

  /**
   * Generate an NTP ping payload to send to the server.
   * Records t0 using local high-resolution clock.
   * @returns {{ type: 'ping', client_time: number }}
   */
  createPingPayload() {
    return {
      type: 'ping',
      client_time: this.nowProvider(),
    };
  }

  /**
   * Send a ping immediately using the registered transport.
   */
  sendPing() {
    if (typeof this.transportSend === 'function') {
      const payload = this.createPingPayload();
      this.transportSend(payload);
    }
  }

  /**
   * Process a received 'pong' response from the server.
   * 
   * Formula:
   * t0 = client send time (echoed by server)
   * t1 = server receive/epoch time
   * t3 = client receive time (now)
   * RTT = t3 - t0
   * offset θ = t1 + (RTT / 2) - t3
   * 
   * @param {{ client_time: number, server_time: number }} pong
   * @param {number} [receiveTime] Optional explicit t3 (defaults to nowProvider())
   * @returns {{ rtt: number, offset: number, isCalibrated: boolean }}
   */
  handlePong(pong, receiveTime) {
    const t0 = Number(pong.client_time);
    const t1 = Number(pong.server_time);
    const t3 = receiveTime ?? this.nowProvider();

    if (isNaN(t0) || isNaN(t1) || t3 < t0) {
      return { rtt: 0, offset: this.offset, isCalibrated: this.isCalibrated };
    }

    const rtt = Math.max(0, t3 - t0);
    // Offset theta: how much to ADD to local clock to get server clock
    const offset = Math.round(t1 + (rtt / 2) - t3);

    const sample = {
      t0,
      t1,
      t3,
      rtt,
      offset,
      timestamp: t3,
    };

    this.samples.push(sample);
    if (this.samples.length > this.sampleSize) {
      this.samples.shift();
    }

    this._recompute();

    const state = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[ClockSync] Listener error:', err);
      }
    }

    return {
      rtt,
      offset: this.offset,
      isCalibrated: this.isCalibrated,
    };
  }

  /**
   * Filter outliers and recompute offset, median RTT, and jitter.
   * Discards samples whose RTT exceeds 1.5x the minimum observed RTT in window,
   * then computes the median offset from the remaining highest-quality samples.
   * @private
   */
  _recompute() {
    if (this.samples.length === 0) return;

    const rtts = this.samples.map(s => s.rtt).sort((a, b) => a - b);
    const minRtt = rtts[0];
    this.bestRtt = minRtt;
    this.medianRtt = this._median(rtts);

    // Keep samples within 1.5x median RTT or within 25ms of minRtt (rejection of congestion lag)
    const threshold = Math.max(minRtt + 25, this.medianRtt * 1.5);
    const validSamples = this.samples.filter(s => s.rtt <= threshold);

    const candidates = validSamples.length > 0 ? validSamples : this.samples;
    const offsets = candidates.map(s => s.offset).sort((a, b) => a - b);

    this.offset = this._median(offsets);

    // Compute jitter: mean absolute deviation from median offset
    const deviations = candidates.map(s => Math.abs(s.offset - this.offset));
    this.jitter = Math.round(deviations.reduce((acc, d) => acc + d, 0) / deviations.length);

    this.isCalibrated = this.samples.length >= this.minSamples;
  }

  /**
   * Helper: compute median of sorted array of numbers.
   * @param {number[]} sortedNumbers
   * @returns {number}
   * @private
   */
  _median(sortedNumbers) {
    if (sortedNumbers.length === 0) return 0;
    const mid = Math.floor(sortedNumbers.length / 2);
    if (sortedNumbers.length % 2 !== 0) {
      return sortedNumbers[mid];
    }
    return Math.round((sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2);
  }

  /**
   * Returns current synchronized server time in milliseconds.
   * @returns {number}
   */
  now() {
    return this.nowProvider() + this.offset;
  }

  /**
   * Start periodic background ping loop.
   */
  start() {
    if (this.pingTimer) return;
    this.sendPing();
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, this.pingIntervalMs);
  }

  /**
   * Stop background sync loop.
   */
  stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Subscribe to clock calibration state changes.
   * @param {(status: ReturnType<ClockSynchronizer['getStatus']>) => void} listener
   * @returns {() => void} Unsubscribe function
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get current clock health and diagnostics.
   */
  getStatus() {
    return {
      isCalibrated: this.isCalibrated,
      offset: this.offset,
      bestRtt: this.bestRtt === Infinity ? 0 : this.bestRtt,
      medianRtt: this.medianRtt,
      jitter: this.jitter,
      samplesCount: this.samples.length,
      serverTime: this.now(),
      localTime: this.nowProvider(),
    };
  }

  /**
   * Reset all samples and calibration.
   */
  reset() {
    this.samples = [];
    this.offset = 0;
    this.bestRtt = Infinity;
    this.medianRtt = 0;
    this.jitter = 0;
    this.isCalibrated = false;
  }
}
