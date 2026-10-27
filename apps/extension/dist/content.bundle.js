(() => {
  // ../../packages/sync-engine/src/clock.js
  var ClockSynchronizer = class {
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
      this.pingIntervalMs = options.pingIntervalMs ?? 5e3;
      this.nowProvider = options.nowProvider ?? (() => Date.now());
      this.samples = [];
      this.offset = 0;
      this.bestRtt = Infinity;
      this.medianRtt = 0;
      this.jitter = 0;
      this.isCalibrated = false;
      this.pingTimer = null;
      this.transportSend = null;
      this.listeners = /* @__PURE__ */ new Set();
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
        type: "ping",
        client_time: this.nowProvider()
      };
    }
    /**
     * Send a ping immediately using the registered transport.
     */
    sendPing() {
      if (typeof this.transportSend === "function") {
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
      const offset = Math.round(t1 + rtt / 2 - t3);
      const sample = {
        t0,
        t1,
        t3,
        rtt,
        offset,
        timestamp: t3
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
          console.error("[ClockSync] Listener error:", err);
        }
      }
      return {
        rtt,
        offset: this.offset,
        isCalibrated: this.isCalibrated
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
      const rtts = this.samples.map((s) => s.rtt).sort((a, b) => a - b);
      const minRtt = rtts[0];
      this.bestRtt = minRtt;
      this.medianRtt = this._median(rtts);
      const threshold = Math.max(minRtt + 25, this.medianRtt * 1.5);
      const validSamples = this.samples.filter((s) => s.rtt <= threshold);
      const candidates = validSamples.length > 0 ? validSamples : this.samples;
      const offsets = candidates.map((s) => s.offset).sort((a, b) => a - b);
      this.offset = this._median(offsets);
      const deviations = candidates.map((s) => Math.abs(s.offset - this.offset));
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
        localTime: this.nowProvider()
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
  };

  // ../../packages/sync-engine/src/timeline.js
  var VirtualTimeline = class {
    /**
     * @param {Object} [initialState]
     * @param {number|null} [initialState.started=null] Server NTP epoch ms when playback began
     * @param {number|null} [initialState.paused=0] Milliseconds position if paused, null if playing
     * @param {number} [initialState.rate=1.0] Nominal playback rate
     */
    constructor(initialState = {}) {
      this.started = initialState.started ?? null;
      this.paused = initialState.paused !== void 0 ? initialState.paused : 0;
      this.rate = initialState.rate ?? 1;
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
      return this.getPositionMs(ntpTimeMs) / 1e3;
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
      const pos = fromPositionMs !== void 0 ? fromPositionMs : this.getPositionMs(currentNtpMs);
      this.started = Math.round(currentNtpMs - pos / this.rate);
      this.paused = null;
      return {
        started: this.started,
        paused: null
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
      const pos = atPositionMs !== void 0 ? atPositionMs : this.getPositionMs(currentNtpMs);
      this.paused = Math.max(0, Math.round(pos));
      return {
        started: this.started,
        paused: this.paused
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
        this.started = Math.round(currentNtpMs - target / this.rate);
      }
      return {
        started: this.started,
        paused: this.paused
      };
    }
    /**
     * Update internal state from an inbound server sync payload.
     * @param {{ started?: number|null, paused?: number|null, rate?: number }} syncState
     */
    applySync(syncState) {
      if (!syncState) return;
      if (syncState.paused !== void 0) {
        this.paused = syncState.paused !== null ? Math.max(0, Math.round(syncState.paused)) : null;
      }
      if (syncState.started !== void 0) {
        this.started = syncState.started !== null ? Number(syncState.started) : null;
      }
      if (syncState.rate !== void 0 && syncState.rate > 0) {
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
        rate: this.rate
      };
    }
  };

  // ../../packages/sync-engine/src/drift.js
  var DriftState = {
    IN_SYNC: "in_sync",
    SLEWING: "slewing",
    SEEKING: "seeking",
    BUFFERING: "buffering"
  };
  var DriftEngine = class {
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
        throw new Error("DriftEngine requires { timeline, clock, player }");
      }
      this.timeline = options.timeline;
      this.clock = options.clock;
      this.player = options.player;
      this.checkIntervalMs = options.checkIntervalMs ?? 250;
      this.deadbandMs = options.deadbandMs ?? 500;
      this.hardSeekThresholdMs = options.hardSeekThresholdMs ?? 5e3;
      this.slewFastRate = options.slewFastRate ?? 1.05;
      this.slewSlowRate = options.slewSlowRate ?? 0.95;
      this.seekCooldownMs = options.seekCooldownMs ?? 600;
      this.currentState = DriftState.IN_SYNC;
      this.timer = null;
      this.lastSeekTime = 0;
      this.isRunning = false;
      this.listeners = /* @__PURE__ */ new Set();
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
        this.player.setPlaybackRate(1);
      } catch {
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
      if (timelinePaused && !playerPaused) {
        if (typeof this.player.withInternalAction === "function") {
          await this.player.withInternalAction(() => this.player.pause());
        } else {
          await this.player.pause();
        }
      } else if (!timelinePaused && playerPaused) {
        try {
          if (typeof this.player.withInternalAction === "function") {
            await this.player.withInternalAction(() => this.player.play());
          } else {
            await this.player.play();
          }
        } catch (err) {
        }
      }
      if (!timelinePaused && this.player.isBuffering()) {
        this.currentState = DriftState.BUFFERING;
        const report2 = this._buildReport(0, 0, 0, DriftState.BUFFERING);
        this._notify(report2);
        return report2;
      }
      const ntpNow = this.clock.now();
      const targetMs = this.timeline.getPositionMs(ntpNow);
      const currentMs = Math.round(this.player.getCurrentTime() * 1e3);
      const deltaMs = targetMs - currentMs;
      const absDeltaMs = Math.abs(deltaMs);
      const now = Date.now();
      const isSeekingCooldown = now - this.lastSeekTime < this.seekCooldownMs;
      if (absDeltaMs >= this.hardSeekThresholdMs && !isSeekingCooldown) {
        this.currentState = DriftState.SEEKING;
        this.lastSeekTime = now;
        if (typeof this.player.withInternalAction === "function") {
          await this.player.withInternalAction(() => this.player.seekTo(targetMs / 1e3));
        } else {
          await this.player.seekTo(targetMs / 1e3);
        }
        this.player.setPlaybackRate(1);
      } else if (absDeltaMs >= this.deadbandMs && !timelinePaused && !isSeekingCooldown) {
        this.currentState = DriftState.SLEWING;
        if (deltaMs > 0) {
          this.player.setPlaybackRate(this.slewFastRate);
        } else {
          this.player.setPlaybackRate(this.slewSlowRate);
        }
      } else {
        this.currentState = DriftState.IN_SYNC;
        if (this.player.getPlaybackRate() !== 1) {
          this.player.setPlaybackRate(1);
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
        timestamp: Date.now()
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
          console.error("[DriftEngine] Listener error:", err);
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
  };

  // ../../packages/sync-engine/src/adapter/base.js
  var BasePlayerAdapter = class {
    constructor() {
      this.events = /* @__PURE__ */ new Map();
      this.isInternalAction = false;
    }
    /**
     * Current playback position in seconds.
     * @returns {number}
     */
    getCurrentTime() {
      throw new Error("getCurrentTime() not implemented");
    }
    /**
     * Total media duration in seconds.
     * @returns {number}
     */
    getDuration() {
      return 0;
    }
    /**
     * Whether the player is currently paused.
     * @returns {boolean}
     */
    isPaused() {
      throw new Error("isPaused() not implemented");
    }
    /**
     * Whether the player is stalled or buffering.
     * @returns {boolean}
     */
    isBuffering() {
      return false;
    }
    /**
     * Current playback rate (nominal 1.0).
     * @returns {number}
     */
    getPlaybackRate() {
      return 1;
    }
    /**
     * Start or resume playback.
     * @returns {Promise<void>}
     */
    async play() {
      throw new Error("play() not implemented");
    }
    /**
     * Pause playback.
     * @returns {Promise<void>}
     */
    async pause() {
      throw new Error("pause() not implemented");
    }
    /**
     * Seek player to target position in seconds.
     * @param {number} seconds
     * @returns {Promise<void>}
     */
    async seekTo(seconds) {
      throw new Error("seekTo() not implemented");
    }
    /**
     * Set playback rate for drift compensation (e.g. 0.95 or 1.05).
     * @param {number} rate
     */
    setPlaybackRate(rate) {
      throw new Error("setPlaybackRate() not implemented");
    }
    /**
     * Configure audio pitch preservation during rate changes.
     * @param {boolean} enabled
     */
    setPreservesPitch(enabled) {
    }
    /**
     * Execute an operation marked as an internal engine action to prevent recursive event feedback.
     * @template T
     * @param {() => Promise<T>|T} fn
     * @returns {Promise<T>|T}
     */
    async withInternalAction(fn) {
      this.isInternalAction = true;
      try {
        return await fn();
      } finally {
        setTimeout(() => {
          this.isInternalAction = false;
        }, 50);
      }
    }
    /**
     * Subscribe to player events: 'play', 'pause', 'seek', 'waiting', 'playing', 'ratechange'
     * @param {string} event
     * @param {Function} handler
     * @returns {() => void} Unsubscribe function
     */
    on(event, handler) {
      if (!this.events.has(event)) {
        this.events.set(event, /* @__PURE__ */ new Set());
      }
      this.events.get(event).add(handler);
      return () => this.off(event, handler);
    }
    /**
     * Unsubscribe from event.
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
      const handlers = this.events.get(event);
      if (handlers) {
        handlers.delete(handler);
      }
    }
    /**
     * Emit an event to registered listeners.
     * @param {string} event
     * @param  {...any} args
     */
    emit(event, ...args) {
      const handlers = this.events.get(event);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (err) {
          console.error(`[BasePlayerAdapter] Error in event '${event}':`, err);
        }
      }
    }
    /**
     * Cleanup and detach all listeners.
     */
    destroy() {
      this.events.clear();
    }
  };

  // ../../packages/sync-engine/src/adapter/html5.js
  var HTML5VideoAdapter = class extends BasePlayerAdapter {
    /**
     * @param {HTMLMediaElement|HTMLVideoElement} videoElement
     */
    constructor(videoElement) {
      super();
      if (!videoElement) {
        throw new Error("HTML5VideoAdapter requires a valid HTMLMediaElement");
      }
      this.video = videoElement;
      this.setPreservesPitch(true);
      this._bindEvents();
    }
    getCurrentTime() {
      return this.video.currentTime;
    }
    getDuration() {
      return this.video.duration || 0;
    }
    isPaused() {
      return this.video.paused;
    }
    isBuffering() {
      return this.video.seeking || this.video.readyState === 0;
    }
    getPlaybackRate() {
      return this.video.playbackRate;
    }
    async play() {
      if (!this.video.paused) return;
      try {
        await this.video.play();
      } catch (err) {
        console.warn("[HTML5VideoAdapter] play() rejected:", err.message);
        throw err;
      }
    }
    async pause() {
      if (this.video.paused) return;
      this.video.pause();
    }
    async seekTo(seconds) {
      const clamped = Math.max(0, Math.min(this.video.duration || Infinity, seconds));
      return this.withInternalAction(async () => {
        this.video.currentTime = clamped;
      });
    }
    setPlaybackRate(rate) {
      if (this.video.playbackRate !== rate) {
        this.video.playbackRate = rate;
      }
    }
    setPreservesPitch(enabled) {
      if ("preservesPitch" in this.video) {
        this.video.preservesPitch = enabled;
      } else if ("mozPreservesPitch" in this.video) {
        this.video.mozPreservesPitch = enabled;
      } else if ("webkitPreservesPitch" in this.video) {
        this.video.webkitPreservesPitch = enabled;
      }
    }
    /**
     * Attach native DOM event listeners and proxy to adapter events.
     * @private
     */
    _bindEvents() {
      this._onPlay = () => {
        if (!this.isInternalAction) this.emit("play", this.video.currentTime);
      };
      this._onPause = () => {
        if (!this.isInternalAction) this.emit("pause", this.video.currentTime);
      };
      this._onSeeking = () => {
        if (!this.isInternalAction) this.emit("seek", this.video.currentTime);
      };
      this._onSeeked = () => {
        this.emit("seeked", this.video.currentTime);
      };
      this._onWaiting = () => {
        this.emit("waiting", this.video.currentTime);
      };
      this._onPlaying = () => {
        this.emit("playing", this.video.currentTime);
      };
      this._onRateChange = () => {
        this.emit("ratechange", this.video.playbackRate);
      };
      this.video.addEventListener("play", this._onPlay);
      this.video.addEventListener("pause", this._onPause);
      this.video.addEventListener("seeking", this._onSeeking);
      this.video.addEventListener("seeked", this._onSeeked);
      this.video.addEventListener("waiting", this._onWaiting);
      this.video.addEventListener("playing", this._onPlaying);
      this.video.addEventListener("ratechange", this._onRateChange);
    }
    destroy() {
      super.destroy();
      if (this.video) {
        this.video.removeEventListener("play", this._onPlay);
        this.video.removeEventListener("pause", this._onPause);
        this.video.removeEventListener("seeking", this._onSeeking);
        this.video.removeEventListener("seeked", this._onSeeked);
        this.video.removeEventListener("waiting", this._onWaiting);
        this.video.removeEventListener("playing", this._onPlaying);
        this.video.removeEventListener("ratechange", this._onRateChange);
      }
    }
  };

  // ../../packages/sync-engine/src/client.js
  var SyncClient = class {
    /**
     * @param {Object} [options]
     * @param {import('./adapter/base.js').BasePlayerAdapter} [options.player] Player adapter instance
     * @param {typeof WebSocket} [options.WebSocketImpl] Custom WebSocket constructor (defaults to globalThis.WebSocket)
     * @param {number} [options.pingIntervalMs=4000] Clock sync ping interval
     * @param {number} [options.driftCheckIntervalMs=250] Drift engine check interval
     */
    constructor(options = {}) {
      this.options = options;
      this.player = options.player ?? null;
      this.WebSocketClass = options.WebSocketImpl || globalThis.WebSocket;
      this.pingIntervalMs = options.pingIntervalMs ?? 4e3;
      this.driftCheckIntervalMs = options.driftCheckIntervalMs ?? 250;
      this.clock = options.clock || new ClockSynchronizer({
        pingIntervalMs: this.pingIntervalMs,
        ...options.clockOptions || {}
      });
      this.timeline = new VirtualTimeline();
      this.driftEngine = null;
      this.ws = null;
      this.room = {
        partyId: null,
        shortId: null,
        sharedControls: true,
        creatorId: null,
        video: null,
        peers: /* @__PURE__ */ new Map()
      };
      this.user = {
        id: null,
        displayName: "Guest",
        isOwner: false
      };
      this.events = /* @__PURE__ */ new Map();
      this.reconnectTimer = null;
      this.shouldReconnect = false;
      this.clock.setTransport((msg) => this.send(msg));
      if (this.player) {
        this.attachPlayer(this.player);
      }
    }
    /**
     * Bind or rebind a player adapter.
     * @param {import('./adapter/base.js').BasePlayerAdapter} player
     */
    attachPlayer(player) {
      if (this.driftEngine) {
        this.driftEngine.stop();
      }
      this.player = player;
      this.driftEngine = new DriftEngine({
        timeline: this.timeline,
        clock: this.clock,
        player: this.player,
        checkIntervalMs: this.driftCheckIntervalMs,
        ...this.options.driftOptions || {}
      });
      this.driftEngine.subscribe((report) => {
        this.emit("drift", report);
      });
      this._bindPlayerActions();
      if (this.isConnected()) {
        this.driftEngine.start();
      }
    }
    /**
     * Connect to StreamSync relay server WebSocket.
     * @param {Object} params
     * @param {string} params.url Relay server base URL (e.g. 'ws://localhost:3001/ws' or 'http://localhost:3001')
     * @param {string} params.partyId Party room ID or short code
     * @param {string} [params.userId] User UUID
     * @param {string} [params.displayName] Display name
     * @returns {Promise<void>}
     */
    async connect({ url, partyId, userId, displayName }) {
      this.shouldReconnect = true;
      this.user.id = userId || `u_${Math.random().toString(36).slice(2, 10)}`;
      this.user.displayName = displayName || "Peer";
      let wsUrl = url.replace(/^http/, "ws");
      if (!wsUrl.includes("/ws")) {
        wsUrl = wsUrl.replace(/\/+$/, "") + "/ws";
      }
      const query = new URLSearchParams({
        party_id: partyId,
        user_id: this.user.id,
        display_name: this.user.displayName
      });
      const fullUrl = `${wsUrl}?${query.toString()}`;
      return new Promise((resolve, reject) => {
        try {
          this.ws = new this.WebSocketClass(fullUrl);
        } catch (err) {
          return reject(err);
        }
        this.ws.onopen = () => {
          this.emit("connected");
          this.clock.start();
          if (this.driftEngine) {
            this.driftEngine.start();
          }
          resolve();
        };
        this.ws.onmessage = (event) => {
          this._handleMessage(typeof event.data === "string" ? event.data : event.data.toString());
        };
        this.ws.onerror = (err) => {
          this.emit("error", err);
        };
        this.ws.onclose = () => {
          this.clock.stop();
          if (this.driftEngine) {
            this.driftEngine.stop();
          }
          this.emit("disconnected");
          if (this.shouldReconnect) {
            this.reconnectTimer = setTimeout(() => {
              this.connect({ url, partyId, userId, displayName }).catch(() => {
              });
            }, 3e3);
          }
        };
      });
    }
    /**
     * Route inbound messages from relay server.
     * @param {string} raw
     * @private
     */
    _handleMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.type) {
        case "pong":
          this.clock.handlePong(msg);
          break;
        case "joined":
          this.room.partyId = msg.party_id;
          this.room.shortId = msg.short_id;
          this.room.creatorId = msg.creator_id;
          this.room.sharedControls = !!msg.shared_controls;
          this.user.isOwner = this.user.id === msg.creator_id;
          if (msg.sync) {
            this.timeline.applySync(msg.sync);
          }
          if (msg.video) {
            this.room.video = msg.video;
          }
          if (Array.isArray(msg.peers)) {
            this.room.peers = new Map(msg.peers.map((p) => [p.id, p]));
            this.emit("peers", this.room.peers);
          } else if (Array.isArray(msg.users)) {
            this.room.peers = new Map(msg.users.map((u) => [u.id, u]));
            this.emit("peers", this.room.peers);
          }
          this.emit("joined", {
            room: this.room,
            user: this.user
          });
          break;
        case "party":
          if (msg.sync) {
            this.timeline.applySync(msg.sync);
          }
          if (msg.video) {
            this.room.video = msg.video;
          }
          if (msg.shared_controls !== void 0) {
            this.room.sharedControls = msg.shared_controls;
          }
          if (Array.isArray(msg.users)) {
            this.room.peers = new Map(msg.users.map((u) => [u.id, u]));
            this.emit("peers", this.room.peers);
          }
          this.emit("party_update", {
            sync: this.timeline.getState(),
            video: this.room.video,
            senderId: msg.sender_id
          });
          break;
        case "users":
          if (Array.isArray(msg.users)) {
            this.room.peers = new Map(msg.users.map((u) => [u.id, u]));
            this.emit("peers", this.room.peers);
          }
          break;
        case "peer_join":
          this.room.peers.set(msg.peer.id, msg.peer);
          this.emit("peer_join", msg.peer);
          this.emit("peers", this.room.peers);
          break;
        case "peer_leave":
          this.room.peers.delete(msg.peer_id);
          this.emit("peer_leave", msg.peer_id);
          this.emit("peers", this.room.peers);
          break;
        case "chat":
          this.emit("chat", msg);
          break;
        case "typing":
          this.emit("typing", msg);
          break;
        default:
          this.emit("message", msg);
      }
    }
    /**
     * Send JSON message over WebSocket transport.
     * @param {Object} payload
     */
    send(payload) {
      if (this.ws && this.ws.readyState === (this.WebSocketClass.OPEN ?? 1)) {
        this.ws.send(JSON.stringify(payload));
      }
    }
    /**
     * Whether the client can control playback in the room.
     * @returns {boolean}
     */
    canControl() {
      return this.room.sharedControls || this.user.isOwner;
    }
    /**
     * Broadcast play action to room.
     */
    play() {
      if (!this.canControl()) return;
      const ntpNow = this.clock.now();
      const currentMs = this.player ? Math.round(this.player.getCurrentTime() * 1e3) : 0;
      const sync = this.timeline.play(ntpNow, currentMs);
      this.send({
        type: "party",
        sync
      });
    }
    /**
     * Broadcast pause action to room.
     */
    pause() {
      if (!this.canControl()) return;
      const ntpNow = this.clock.now();
      const currentMs = this.player ? Math.round(this.player.getCurrentTime() * 1e3) : 0;
      const sync = this.timeline.pause(ntpNow, currentMs);
      this.send({
        type: "party",
        sync
      });
    }
    /**
     * Broadcast seek action to room.
     * @param {number} positionSeconds
     */
    seek(positionSeconds) {
      if (!this.canControl()) return;
      const ntpNow = this.clock.now();
      const positionMs = Math.round(positionSeconds * 1e3);
      const sync = this.timeline.seek(ntpNow, positionMs);
      this.send({
        type: "party",
        sync
      });
    }
    /**
     * Broadcast video change (switch show/movie).
     * @param {{ url: string, provider: 'mp4'|'hls'|'youtube'|'dash', title: string, thumbnail?: string }} video
     */
    changeVideo(video) {
      if (!this.user.isOwner) return;
      this.send({
        type: "party",
        video
      });
    }
    /**
     * Send text chat message.
     * @param {string} content
     */
    sendChat(content) {
      this.send({
        type: "chat",
        content
      });
    }
    /**
     * Send typing indicator.
     * @param {boolean} isTyping
     */
    setTyping(isTyping) {
      this.send({
        type: "typing",
        is_typing: !!isTyping
      });
    }
    /**
     * Listen for user interactions on the player adapter.
     * @private
     */
    _bindPlayerActions() {
      if (!this.player) return;
      this.player.on("play", () => {
        if (this.canControl()) {
          this.play();
        }
      });
      this.player.on("pause", () => {
        if (this.canControl()) {
          this.pause();
        }
      });
      this.player.on("seek", (currentTimeSec) => {
        if (this.canControl()) {
          this.seek(currentTimeSec);
        }
      });
    }
    isConnected() {
      return this.ws && this.ws.readyState === (this.WebSocketClass.OPEN ?? 1);
    }
    on(event, handler) {
      if (!this.events.has(event)) {
        this.events.set(event, /* @__PURE__ */ new Set());
      }
      this.events.get(event).add(handler);
      return () => this.off(event, handler);
    }
    off(event, handler) {
      const handlers = this.events.get(event);
      if (handlers) {
        handlers.delete(handler);
      }
    }
    emit(event, ...args) {
      const handlers = this.events.get(event);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (err) {
          console.error(`[SyncClient] Event handler error (${event}):`, err);
        }
      }
    }
    /**
     * Disconnect and release all resources.
     */
    disconnect() {
      this.shouldReconnect = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.clock.stop();
      if (this.driftEngine) {
        this.driftEngine.stop();
      }
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
    }
  };

  // ../../packages/injectors/src/bridge/index.js
  var BRIDGE_CHANNELS = {
    COMMAND: "STREAMSYNC_MAIN_COMMAND",
    EVENT: "STREAMSYNC_MAIN_EVENT"
  };

  // ../../packages/injectors/src/netflix/index.js
  var NetflixAdapter = class extends BasePlayerAdapter {
    /**
     * @param {Object} [options]
     * @param {Window} [options.targetWindow=globalThis.window] Target window object
     * @param {HTMLVideoElement} [options.videoElement] Optional direct video element reference
     */
    constructor(options = {}) {
      super();
      this.targetWindow = options.targetWindow || globalThis.window;
      this.videoElement = options.videoElement || null;
      this.cadmiumPlayer = null;
      this.sessionId = null;
      this.pollTimer = null;
      this._eventsBound = false;
      this._init();
    }
    /**
     * Locate and attach to the active Netflix Cadmium video player.
     * @private
     */
    _init() {
      this._attachCadmiumPlayer();
      this._bindEvents();
      if (!this.videoElement || this.videoElement.isConnected === false) {
        this.videoElement = this._findVideo();
      }
      if (this.videoElement) {
        this.setPreservesPitch(true);
      }
    }
    /**
     * Search for active Cadmium player session.
     * @private
     */
    _attachCadmiumPlayer() {
      try {
        const netflix = this.targetWindow?.netflix;
        const playerApp = netflix?.appContext?.state?.playerApp;
        const api = playerApp?.getAPI?.();
        const videoPlayer = api?.videoPlayer;
        if (videoPlayer) {
          const sessionIds = videoPlayer.getAllPlayerSessionIds ? videoPlayer.getAllPlayerSessionIds() : [];
          const watchId = sessionIds.find((id) => typeof id === "string" && id.startsWith("watch-")) || sessionIds[sessionIds.length - 1] || sessionIds[0];
          if (watchId) {
            this.sessionId = watchId;
            this.cadmiumPlayer = videoPlayer.getVideoPlayerBySessionId(watchId);
            this._bindCadmiumEvents(videoPlayer);
            return true;
          }
        }
      } catch (err) {
        console.warn("[NetflixAdapter] Cadmium inspection warning:", err);
      }
      return false;
    }
    /**
     * Intelligently find Netflix video element.
     * @private
     */
    _findVideo() {
      const doc = this.targetWindow?.document;
      if (!doc) return null;
      const preferred = typeof doc.querySelector === "function" ? doc.querySelector(".watch-video--player-view video") || doc.querySelector('div[data-uia="video-canvas"] video') || doc.querySelector(".nf-player-container video") || doc.querySelector("video") : null;
      if (preferred) return preferred;
      const all = typeof doc.querySelectorAll === "function" ? Array.from(doc.querySelectorAll("video")) : [];
      if (all.length === 0) return null;
      if (all.length === 1) return all[0];
      return all.find((v) => (v.offsetWidth > 200 || v.offsetHeight > 200) && (v.duration > 0 || !v.paused)) || all.find((v) => v.offsetWidth > 200 || v.offsetHeight > 200) || all.find((v) => v.duration > 0) || all[all.length - 1];
    }
    /**
     * Resolve active video element.
     * @private
     */
    _getVideo() {
      if (this.videoElement && this.videoElement.isConnected !== false) {
        return this.videoElement;
      }
      this._init();
      return this.videoElement;
    }
    /**
     * Dispatch a command to the Main World Bridge.
     * @private
     */
    async _sendBridgeCommand(action, payload = {}) {
      if (!this.targetWindow || typeof this.targetWindow.addEventListener !== "function" || typeof this.targetWindow.dispatchEvent !== "function") {
        return null;
      }
      const id = `nf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      return new Promise((resolve) => {
        const handler = (event) => {
          const detail = event?.detail || {};
          if (detail.id === id) {
            this.targetWindow.removeEventListener(BRIDGE_CHANNELS.EVENT, handler);
            resolve(detail);
          }
        };
        this.targetWindow.addEventListener(BRIDGE_CHANNELS.EVENT, handler);
        try {
          const evt = typeof CustomEvent !== "undefined" ? new CustomEvent(BRIDGE_CHANNELS.COMMAND, { detail: { id, action, payload } }) : { type: BRIDGE_CHANNELS.COMMAND, detail: { id, action, payload } };
          this.targetWindow.dispatchEvent(evt);
        } catch {
          this.targetWindow.removeEventListener(BRIDGE_CHANNELS.EVENT, handler);
          resolve(null);
          return;
        }
        setTimeout(() => {
          if (typeof this.targetWindow?.removeEventListener === "function") {
            this.targetWindow.removeEventListener(BRIDGE_CHANNELS.EVENT, handler);
          }
          resolve(null);
        }, 1500);
      });
    }
    /**
     * Poll until Netflix player session is fully ready.
     * @param {number} [timeoutMs=15000]
     * @param {number} [intervalMs=250]
     * @returns {Promise<boolean>}
     */
    async waitForPlayer(timeoutMs = 15e3, intervalMs = 250) {
      if (this.cadmiumPlayer || this._getVideo()) return true;
      const start = Date.now();
      return new Promise((resolve) => {
        this.pollTimer = setInterval(() => {
          this._init();
          if (this.cadmiumPlayer || this._getVideo()) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            resolve(true);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            resolve(false);
          }
        }, intervalMs);
      });
    }
    getCurrentTime() {
      if (this.cadmiumPlayer && typeof this.cadmiumPlayer.getCurrentTime === "function") {
        const ms = this.cadmiumPlayer.getCurrentTime();
        if (typeof ms === "number" && !isNaN(ms)) {
          return ms / 1e3;
        }
      }
      const v = this._getVideo();
      return v ? v.currentTime : 0;
    }
    getDuration() {
      if (this.cadmiumPlayer && typeof this.cadmiumPlayer.getDuration === "function") {
        const ms = this.cadmiumPlayer.getDuration();
        if (typeof ms === "number" && !isNaN(ms)) {
          return ms / 1e3;
        }
      }
      const v = this._getVideo();
      return v ? v.duration || 0 : 0;
    }
    isPaused() {
      if (this.cadmiumPlayer) {
        if (typeof this.cadmiumPlayer.isPaused === "function") {
          return this.cadmiumPlayer.isPaused();
        }
        if (typeof this.cadmiumPlayer.isPlaying === "function") {
          return !this.cadmiumPlayer.isPlaying();
        }
      }
      const v = this._getVideo();
      return v ? v.paused : true;
    }
    isBuffering() {
      if (this.cadmiumPlayer && typeof this.cadmiumPlayer.getBusy === "function") {
        const busy = this.cadmiumPlayer.getBusy();
        if (busy?.buffering) return true;
      }
      const v = this._getVideo();
      if (!v) return false;
      if (v.paused && !v.seeking) return false;
      return v.seeking || v.readyState === 0;
    }
    getPlaybackRate() {
      const v = this._getVideo();
      return v ? v.playbackRate : 1;
    }
    async play() {
      if (!this.isPaused()) return;
      if (this.cadmiumPlayer && typeof this.cadmiumPlayer.play === "function") {
        await this.cadmiumPlayer.play();
        return;
      }
      const res = await this._sendBridgeCommand("play");
      if (!res?.success) {
        const v = this._getVideo();
        if (v) await v.play().catch(() => {
        });
      }
    }
    async pause() {
      if (this.isPaused()) return;
      if (this.cadmiumPlayer && typeof this.cadmiumPlayer.pause === "function") {
        await this.cadmiumPlayer.pause();
        return;
      }
      const res = await this._sendBridgeCommand("pause");
      if (!res?.success) {
        const v = this._getVideo();
        if (v) v.pause();
      }
    }
    async seekTo(seconds) {
      return this.withInternalAction(async () => {
        const ms = Math.max(0, Math.round(seconds * 1e3));
        if (this.cadmiumPlayer && typeof this.cadmiumPlayer.seek === "function") {
          await this.cadmiumPlayer.seek(ms);
          return;
        }
        const res = await this._sendBridgeCommand("seek", { seconds });
        if (!res?.success) {
          const v = this._getVideo();
          if (v) v.currentTime = seconds;
        }
      });
    }
    setPlaybackRate(rate) {
      if (this.cadmiumPlayer && typeof this.cadmiumPlayer.setPlaybackRate === "function") {
        try {
          this.cadmiumPlayer.setPlaybackRate(rate);
        } catch {
        }
      } else {
        this._sendBridgeCommand("rate", { rate }).catch(() => {
        });
      }
      const v = this._getVideo();
      if (v && v.playbackRate !== rate) {
        v.playbackRate = rate;
      }
    }
    setPreservesPitch(enabled) {
      const v = this._getVideo();
      if (!v) return;
      if ("preservesPitch" in v) {
        v.preservesPitch = enabled;
      } else if ("webkitPreservesPitch" in v) {
        v.webkitPreservesPitch = enabled;
      }
    }
    /**
     * Bind to Cadmium player event listener (Main World).
     * @private
     */
    _bindCadmiumEvents(videoPlayerApi) {
      if (!this.cadmiumPlayer || typeof this.cadmiumPlayer.addEventListener !== "function") return;
      const EVENTS = videoPlayerApi.EVENTS || {};
      const onCurrentTimeChange = (e) => {
        if (!this.isInternalAction && e?.currentTime !== void 0) {
          this.emit("timeupdate", e.currentTime / 1e3);
        }
      };
      const onPausedChange = (e) => {
        if (this.isInternalAction) return;
        const paused = e?.paused !== void 0 ? e.paused : this.isPaused();
        if (paused) {
          this.emit("pause", this.getCurrentTime());
        } else {
          this.emit("play", this.getCurrentTime());
        }
      };
      try {
        if (EVENTS.CURRENT_TIME_CHANGE) {
          this.cadmiumPlayer.addEventListener(EVENTS.CURRENT_TIME_CHANGE, onCurrentTimeChange);
        }
        if (EVENTS.PAUSED_CHANGE) {
          this.cadmiumPlayer.addEventListener(EVENTS.PAUSED_CHANGE, onPausedChange);
        }
      } catch (err) {
        console.warn("[NetflixAdapter] Failed binding Cadmium events:", err);
      }
    }
    /**
     * Bind to native DOM video element events using capturing phase listeners on document.
     * @private
     */
    _bindEvents() {
      if (this._eventsBound) return;
      this._eventsBound = true;
      const doc = this.targetWindow?.document;
      if (!doc) return;
      if (typeof doc.addEventListener === "function") {
        doc.addEventListener("play", (e) => {
          if (e.target && e.target.tagName === "VIDEO") {
            this.videoElement = e.target;
            if (!this.isInternalAction) this.emit("play", this.getCurrentTime());
          }
        }, true);
        doc.addEventListener("pause", (e) => {
          if (e.target && e.target.tagName === "VIDEO") {
            this.videoElement = e.target;
            if (!this.isInternalAction) this.emit("pause", this.getCurrentTime());
          }
        }, true);
        doc.addEventListener("seeking", (e) => {
          if (e.target && e.target.tagName === "VIDEO") {
            this.videoElement = e.target;
            if (!this.isInternalAction) this.emit("seek", this.getCurrentTime());
          }
        }, true);
        doc.addEventListener("seeked", (e) => {
          if (e.target && e.target.tagName === "VIDEO") {
            this.videoElement = e.target;
            this.emit("seeked", this.getCurrentTime());
          }
        }, true);
        doc.addEventListener("ratechange", (e) => {
          if (e.target && e.target.tagName === "VIDEO") {
            this.videoElement = e.target;
            this.emit("ratechange", this.getPlaybackRate());
          }
        }, true);
      }
    }
    destroy() {
      super.destroy();
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.cadmiumPlayer = null;
      this.videoElement = null;
    }
  };

  // ../../packages/injectors/src/prime/index.js
  var PrimeVideoAdapter = class extends BasePlayerAdapter {
    /**
     * @param {Object} [options]
     * @param {Window} [options.targetWindow=globalThis.window] Target window
     * @param {HTMLVideoElement} [options.videoElement] Optional direct video element
     */
    constructor(options = {}) {
      super();
      this.targetWindow = options.targetWindow || globalThis.window;
      this.videoElement = options.videoElement || null;
      this.pollTimer = null;
      this._init();
    }
    /**
     * Scan Prime Video DOM for the active media stream.
     * @private
     */
    _init() {
      this._bindEvents();
      if (!this.videoElement || this.videoElement.isConnected === false) {
        this.videoElement = this._findVideo();
      }
      if (this.videoElement) {
        this.setPreservesPitch(true);
      }
    }
    /**
     * Intelligently locate the active Prime Video player element.
     * @private
     */
    _findVideo() {
      const doc = this.targetWindow?.document;
      if (!doc) return null;
      const preferred = doc.querySelector(".webPlayerContainer video") || doc.querySelector(".rendererContainer video") || doc.querySelector("#dv-web-player video") || doc.querySelector('div[data-testid="video-player"] video') || doc.querySelector(".dv-player-fullscreen video");
      if (preferred) return preferred;
      const all = Array.from(doc.querySelectorAll("video"));
      if (all.length === 0) return null;
      if (all.length === 1) return all[0];
      return all.find((v) => (v.offsetWidth > 200 || v.offsetHeight > 200) && (v.duration > 0 || !v.paused)) || all.find((v) => v.offsetWidth > 200 || v.offsetHeight > 200) || all.find((v) => v.duration > 0) || all[all.length - 1];
    }
    /**
     * Poll until Prime Video player is mounted.
     * @param {number} [timeoutMs=15000]
     * @param {number} [intervalMs=250]
     * @returns {Promise<boolean>}
     */
    async waitForPlayer(timeoutMs = 15e3, intervalMs = 250) {
      if (this.videoElement) return true;
      const start = Date.now();
      return new Promise((resolve) => {
        this.pollTimer = setInterval(() => {
          this._init();
          if (this.videoElement) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            resolve(true);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            resolve(false);
          }
        }, intervalMs);
      });
    }
    /**
     * Resolve active, connected video element.
     * @private
     */
    _getVideo() {
      if (this.videoElement && this.videoElement.isConnected !== false) {
        return this.videoElement;
      }
      this._init();
      return this.videoElement;
    }
    getCurrentTime() {
      const v = this._getVideo();
      return v ? v.currentTime : 0;
    }
    getDuration() {
      const v = this._getVideo();
      return v ? v.duration || 0 : 0;
    }
    isPaused() {
      const v = this._getVideo();
      return v ? v.paused : true;
    }
    isBuffering() {
      const v = this._getVideo();
      if (!v) return false;
      if (v.paused && !v.seeking) return false;
      return v.seeking || v.readyState === 0;
    }
    getPlaybackRate() {
      const v = this._getVideo();
      return v ? v.playbackRate : 1;
    }
    async play() {
      const v = this._getVideo();
      if (!v || !v.paused) return;
      try {
        await v.play();
      } catch {
        const doc = this.targetWindow?.document;
        const btn = doc?.querySelector('button[data-testid="dwell-play-pause-button"]') || doc?.querySelector(".dwell-player-container button");
        if (btn && typeof btn.click === "function") {
          btn.click();
        }
      }
    }
    async pause() {
      const v = this._getVideo();
      if (!v || v.paused) return;
      try {
        v.pause();
      } catch {
        const doc = this.targetWindow?.document;
        const btn = doc?.querySelector('button[data-testid="dwell-play-pause-button"]') || doc?.querySelector(".dwell-player-container button");
        if (btn && typeof btn.click === "function") {
          btn.click();
        }
      }
    }
    async seekTo(seconds) {
      const v = this._getVideo();
      if (!v) return;
      return this.withInternalAction(async () => {
        const clamped = Math.max(0, Math.min(v.duration || Infinity, seconds));
        v.currentTime = clamped;
      });
    }
    setPlaybackRate(rate) {
      const v = this._getVideo();
      if (v && v.playbackRate !== rate) {
        v.playbackRate = rate;
      }
    }
    setPreservesPitch(enabled) {
      const v = this._getVideo();
      if (!v) return;
      if ("preservesPitch" in v) {
        v.preservesPitch = enabled;
      } else if ("webkitPreservesPitch" in v) {
        v.webkitPreservesPitch = enabled;
      }
    }
    /**
     * Bind to native HTMLMediaElement DOM events using capturing listeners.
     * @private
     */
    _bindEvents() {
      if (this._eventsBound) return;
      this._eventsBound = true;
      const doc = this.targetWindow?.document;
      if (!doc) return;
      if (typeof doc.addEventListener === "function") {
        doc.addEventListener("play", (e) => {
          if (e.target && e.target.tagName === "VIDEO") {
            this.videoElement = e.target;
            if (!this.isInternalAction) this.emit("play", this.getCurrentTime());
          }
        }, true);
        doc.addEventListener("pause", (e) => {
          if (e.target && e.target.tagName === "VIDEO") {
            this.videoElement = e.target;
            if (!this.isInternalAction) this.emit("pause", this.getCurrentTime());
          }
        }, true);
        doc.addEventListener("seeking", (e) => {
          if (e.target && e.target.tagName === "VIDEO") {
            this.videoElement = e.target;
            if (!this.isInternalAction) this.emit("seek", this.getCurrentTime());
          }
        }, true);
        doc.addEventListener("seeked", (e) => {
          if (e.target && e.target.tagName === "VIDEO") {
            this.videoElement = e.target;
            this.emit("seeked", this.getCurrentTime());
          }
        }, true);
        doc.addEventListener("ratechange", (e) => {
          if (e.target && e.target.tagName === "VIDEO") {
            this.videoElement = e.target;
            this.emit("ratechange", this.getPlaybackRate());
          }
        }, true);
      } else if (this.videoElement && typeof this.videoElement.addEventListener === "function") {
        this.videoElement.addEventListener("play", () => {
          if (!this.isInternalAction) this.emit("play", this.getCurrentTime());
        });
        this.videoElement.addEventListener("pause", () => {
          if (!this.isInternalAction) this.emit("pause", this.getCurrentTime());
        });
        this.videoElement.addEventListener("seeking", () => {
          if (!this.isInternalAction) this.emit("seek", this.getCurrentTime());
        });
        this.videoElement.addEventListener("seeked", () => {
          this.emit("seeked", this.getCurrentTime());
        });
        this.videoElement.addEventListener("ratechange", () => {
          this.emit("ratechange", this.getPlaybackRate());
        });
      }
    }
    destroy() {
      super.destroy();
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.videoElement = null;
    }
  };

  // ../../packages/injectors/src/youtube/index.js
  var YouTubeAdapter = class extends BasePlayerAdapter {
    /**
     * @param {Object} [options]
     * @param {Window} [options.targetWindow=globalThis.window] Target window
     * @param {any} [options.moviePlayer] Optional YouTube player reference
     * @param {HTMLVideoElement} [options.videoElement] Optional direct video element
     */
    constructor(options = {}) {
      super();
      this.targetWindow = options.targetWindow || globalThis.window;
      this.moviePlayer = options.moviePlayer || null;
      this.videoElement = options.videoElement || null;
      this.pollTimer = null;
      this._init();
    }
    _init() {
      if (!this.moviePlayer && this.targetWindow?.document) {
        this.moviePlayer = this.targetWindow.document.getElementById("movie_player");
      }
      if (!this.videoElement && this.targetWindow?.document) {
        this.videoElement = this.targetWindow.document.querySelector(".html5-main-video") || this.targetWindow.document.querySelector("video");
      }
      if (this.videoElement) {
        this.setPreservesPitch(true);
        this._bindEvents();
      }
    }
    /**
     * Poll until YouTube player is ready.
     * @param {number} [timeoutMs=10000]
     * @param {number} [intervalMs=250]
     * @returns {Promise<boolean>}
     */
    async waitForPlayer(timeoutMs = 1e4, intervalMs = 250) {
      if (this.moviePlayer || this.videoElement) return true;
      const start = Date.now();
      return new Promise((resolve) => {
        this.pollTimer = setInterval(() => {
          this._init();
          if (this.moviePlayer || this.videoElement) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            resolve(true);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            resolve(false);
          }
        }, intervalMs);
      });
    }
    getCurrentTime() {
      if (this.moviePlayer && typeof this.moviePlayer.getCurrentTime === "function") {
        return this.moviePlayer.getCurrentTime();
      }
      return this.videoElement ? this.videoElement.currentTime : 0;
    }
    getDuration() {
      if (this.moviePlayer && typeof this.moviePlayer.getDuration === "function") {
        return this.moviePlayer.getDuration();
      }
      return this.videoElement ? this.videoElement.duration || 0 : 0;
    }
    isPaused() {
      if (this.moviePlayer && typeof this.moviePlayer.getPlayerState === "function") {
        const state = this.moviePlayer.getPlayerState();
        return state !== 1 && state !== 3;
      }
      return this.videoElement ? this.videoElement.paused : true;
    }
    isBuffering() {
      if (this.moviePlayer && typeof this.moviePlayer.getPlayerState === "function") {
        return this.moviePlayer.getPlayerState() === 3;
      }
      return this.videoElement ? this.videoElement.readyState < 3 : false;
    }
    getPlaybackRate() {
      if (this.moviePlayer && typeof this.moviePlayer.getPlaybackRate === "function") {
        return this.moviePlayer.getPlaybackRate();
      }
      return this.videoElement ? this.videoElement.playbackRate : 1;
    }
    async play() {
      if (!this.isPaused()) return;
      if (this.moviePlayer && typeof this.moviePlayer.playVideo === "function") {
        this.moviePlayer.playVideo();
      } else if (this.videoElement) {
        await this.videoElement.play();
      }
    }
    async pause() {
      if (this.isPaused()) return;
      if (this.moviePlayer && typeof this.moviePlayer.pauseVideo === "function") {
        this.moviePlayer.pauseVideo();
      } else if (this.videoElement) {
        this.videoElement.pause();
      }
    }
    async seekTo(seconds) {
      return this.withInternalAction(async () => {
        const target = Math.max(0, seconds);
        if (this.moviePlayer && typeof this.moviePlayer.seekTo === "function") {
          this.moviePlayer.seekTo(target, true);
        } else if (this.videoElement) {
          this.videoElement.currentTime = target;
        }
      });
    }
    setPlaybackRate(rate) {
      if (this.moviePlayer && typeof this.moviePlayer.setPlaybackRate === "function") {
        this.moviePlayer.setPlaybackRate(rate);
      }
      if (this.videoElement && this.videoElement.playbackRate !== rate) {
        this.videoElement.playbackRate = rate;
      }
    }
    setPreservesPitch(enabled) {
      if (!this.videoElement) return;
      if ("preservesPitch" in this.videoElement) {
        this.videoElement.preservesPitch = enabled;
      } else if ("webkitPreservesPitch" in this.videoElement) {
        this.videoElement.webkitPreservesPitch = enabled;
      }
    }
    _bindEvents() {
      if (!this.videoElement) return;
      this.videoElement.addEventListener("play", () => {
        if (!this.isInternalAction) this.emit("play", this.getCurrentTime());
      });
      this.videoElement.addEventListener("pause", () => {
        if (!this.isInternalAction) this.emit("pause", this.getCurrentTime());
      });
      this.videoElement.addEventListener("seeking", () => {
        if (!this.isInternalAction) this.emit("seek", this.getCurrentTime());
      });
      this.videoElement.addEventListener("seeked", () => {
        this.emit("seeked", this.getCurrentTime());
      });
      this.videoElement.addEventListener("waiting", () => {
        this.emit("waiting", this.getCurrentTime());
      });
      this.videoElement.addEventListener("playing", () => {
        this.emit("playing", this.getCurrentTime());
      });
      this.videoElement.addEventListener("ratechange", () => {
        this.emit("ratechange", this.getPlaybackRate());
      });
    }
    destroy() {
      super.destroy();
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.moviePlayer = null;
      this.videoElement = null;
    }
  };

  // ../../packages/injectors/src/universal/index.js
  var UniversalVideoAdapter = class extends HTML5VideoAdapter {
    /**
     * @param {HTMLMediaElement|HTMLVideoElement} videoElement
     * @param {Object} [options]
     * @param {any} [options.hlsInstance] Active HLS.js instance
     * @param {any} [options.dashInstance] Active Dash.js instance
     */
    constructor(videoElement, options = {}) {
      super(videoElement);
      this.hls = options.hlsInstance || null;
      this.dash = options.dashInstance || null;
    }
    /**
     * Dynamically load a new media stream URL onto the video element.
     * @param {string} url
     * @param {'mp4'|'hls'|'dash'} [type='mp4']
     * @returns {Promise<void>}
     */
    async loadSource(url, type = "mp4") {
      if (type === "hls" && this.hls) {
        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);
      } else if (type === "dash" && this.dash) {
        this.dash.attachSource(url);
      } else {
        this.video.src = url;
        this.video.load();
      }
    }
    destroy() {
      super.destroy();
      if (this.hls) {
        try {
          this.hls.destroy();
        } catch {
        }
        this.hls = null;
      }
      if (this.dash) {
        try {
          this.dash.reset();
        } catch {
        }
        this.dash = null;
      }
    }
  };

  // ../../packages/injectors/src/index.js
  function detectProvider(locationInput) {
    let hostname = "";
    if (typeof locationInput === "string") {
      try {
        hostname = new URL(locationInput).hostname.toLowerCase();
      } catch {
        hostname = locationInput.toLowerCase();
      }
    } else if (locationInput && typeof locationInput.hostname === "string") {
      hostname = locationInput.hostname.toLowerCase();
    } else if (typeof globalThis.window !== "undefined" && globalThis.window.location) {
      hostname = globalThis.window.location.hostname.toLowerCase();
    }
    if (hostname.includes("netflix.com")) return "netflix";
    if (hostname.includes("primevideo.com") || hostname.includes("amazon.")) return "prime";
    if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) return "youtube";
    return "universal";
  }
  function createPlayerAdapter(options = {}) {
    const targetWindow = options.targetWindow || globalThis.window;
    const provider = options.provider || detectProvider(targetWindow?.location);
    switch (provider) {
      case "netflix":
        return new NetflixAdapter({ targetWindow });
      case "prime":
        return new PrimeVideoAdapter({ targetWindow });
      case "youtube":
        return new YouTubeAdapter({ targetWindow });
      default:
        const video = targetWindow?.document?.querySelector("video");
        return new UniversalVideoAdapter(video || targetWindow?.document?.createElement("video"));
    }
  }

  // src/content/overlay.js
  var StreamSyncOverlay = class {
    /**
     * @param {Object} options
     * @param {import('@streamsync/sync-engine').SyncClient} options.client
     * @param {string} options.cssText Raw CSS stylesheet text
     * @param {string} [options.serverUrl='http://localhost:3001']
     */
    constructor(options) {
      this.client = options.client;
      this.cssText = options.cssText;
      this.serverUrl = (options.serverUrl || "http://localhost:3001").replace(/\/+$/, "");
      this.shortId = options.shortId || this.client?.room?.shortId || null;
      this.container = null;
      this.shadowRoot = null;
      this.isCollapsed = false;
      this.isDragging = false;
      this.dragOffset = { x: 0, y: 0 };
      this.typingTimer = null;
      this.mount();
    }
    mount() {
      if (document.getElementById("streamsync-overlay-host")) {
        return;
      }
      this.container = document.createElement("div");
      this.container.id = "streamsync-overlay-host";
      this.shadowRoot = this.container.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = this.cssText;
      this.shadowRoot.appendChild(style);
      const activeCode = this.shortId || this.client?.room?.shortId || "------";
      const widget = document.createElement("div");
      widget.className = "streamsync-widget";
      widget.innerHTML = `
      <!-- Header / Drag Bar -->
      <div class="streamsync-header" id="drag-handle">
        <div class="streamsync-brand">
          <div class="streamsync-logo">S</div>
          <span class="streamsync-title">StreamSync</span>
        </div>
        <div class="streamsync-header-actions">
          <button class="streamsync-btn-icon" id="btn-collapse" title="Collapse / Expand">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
          <button class="streamsync-btn-icon" id="btn-close" title="Leave Party">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      <!-- Status Bar -->
      <div class="streamsync-status-bar">
        <div class="streamsync-pill in_sync" id="status-pill">
          <span class="streamsync-dot"></span>
          <span id="status-text">PAUSED (IN SYNC)</span>
        </div>

        <div class="streamsync-room-chip" id="btn-copy-code" title="Click to copy invite link">
          <span class="streamsync-code" id="room-code-display">${activeCode}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </div>
      </div>

      <!-- Main Body -->
      <div class="streamsync-body">
        <!-- Peers -->
        <div class="streamsync-peers-wrap">
          <div class="streamsync-section-label">Watching Now (<span id="peers-count">1</span>)</div>
          <div class="streamsync-peers-list" id="peers-list"></div>
        </div>

        <!-- Chat -->
        <div class="streamsync-chat-box">
          <div class="streamsync-messages" id="chat-messages">
            <div class="streamsync-msg">
              <span class="streamsync-msg-sender">System</span>
              <span class="streamsync-msg-text">Watch Party ready! Room Code: <b>${activeCode}</b>. Click the code pill above to copy your invite link.</span>
            </div>
          </div>
          <div class="streamsync-typing" id="typing-indicator"></div>
          <div class="streamsync-chat-input-row">
            <input type="text" class="streamsync-chat-input" id="chat-input" placeholder="Say something..." maxlength="500" />
            <button class="streamsync-send-btn" id="btn-send-chat" title="Send">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Toast Feedback -->
      <div class="streamsync-toast" id="toast">Link Copied!</div>
    `;
      this.shadowRoot.appendChild(widget);
      document.body.appendChild(this.container);
      this._bindInteractions();
      this._bindClientEvents();
    }
    _bindInteractions() {
      const root = this.shadowRoot;
      const widget = root.querySelector(".streamsync-widget");
      const dragHandle = root.querySelector("#drag-handle");
      const btnCollapse = root.querySelector("#btn-collapse");
      const btnClose = root.querySelector("#btn-close");
      const btnCopy = root.querySelector("#btn-copy-code");
      const chatInput = root.querySelector("#chat-input");
      const btnSendChat = root.querySelector("#btn-send-chat");
      dragHandle.addEventListener("mousedown", (e) => {
        this.isDragging = true;
        const rect = this.container.getBoundingClientRect();
        this.dragOffset.x = e.clientX - rect.left;
        this.dragOffset.y = e.clientY - rect.top;
        e.preventDefault();
      });
      window.addEventListener("mousemove", (e) => {
        if (!this.isDragging) return;
        const x = Math.max(10, Math.min(window.innerWidth - 330, e.clientX - this.dragOffset.x));
        const y = Math.max(10, Math.min(window.innerHeight - 200, e.clientY - this.dragOffset.y));
        this.container.style.left = `${x}px`;
        this.container.style.top = `${y}px`;
        this.container.style.right = "auto";
      });
      window.addEventListener("mouseup", () => {
        this.isDragging = false;
      });
      btnCollapse.addEventListener("click", () => {
        this.isCollapsed = !this.isCollapsed;
        widget.classList.toggle("collapsed", this.isCollapsed);
      });
      btnClose.addEventListener("click", () => {
        if (confirm("Leave StreamSync Watch Party?")) {
          this.client.disconnect();
          this.destroy();
        }
      });
      btnCopy.addEventListener("click", () => {
        const shortId = this.client?.room?.shortId || this.shortId || "676767";
        const link = `${this.serverUrl}/party/${shortId}`;
        navigator.clipboard.writeText(link).then(() => {
          this.showToast("Invite Link Copied!");
        }).catch(() => {
          this.showToast(`Code: ${shortId}`);
        });
      });
      const sendCurrentMessage = () => {
        const text = chatInput.value.trim();
        if (!text) return;
        this.client.sendChat(text);
        chatInput.value = "";
        this.client.setTyping(false);
      };
      btnSendChat.addEventListener("click", sendCurrentMessage);
      chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          sendCurrentMessage();
        } else {
          this._notifyTyping();
        }
      });
    }
    _notifyTyping() {
      this.client.setTyping(true);
      if (this.typingTimer) clearTimeout(this.typingTimer);
      this.typingTimer = setTimeout(() => {
        this.client.setTyping(false);
      }, 2e3);
    }
    _bindClientEvents() {
      const root = this.shadowRoot;
      const roomCodeDisplay = root.querySelector("#room-code-display");
      const statusPill = root.querySelector("#status-pill");
      const statusText = root.querySelector("#status-text");
      const peersCount = root.querySelector("#peers-count");
      const peersList = root.querySelector("#peers-list");
      const chatMessages = root.querySelector("#chat-messages");
      const typingIndicator = root.querySelector("#typing-indicator");
      const initialCode = this.client?.room?.shortId || this.shortId;
      if (initialCode) {
        roomCodeDisplay.textContent = initialCode;
      }
      if (this.client?.room?.peers?.size) {
        this._updatePeers(this.client.room.peers, this.client.user?.id);
      }
      this.client.on("joined", ({ room, user }) => {
        if (room.shortId) {
          this.shortId = room.shortId;
          roomCodeDisplay.textContent = room.shortId;
        }
        this._updatePeers(room.peers, user.id);
      });
      this.client.on("drift", (report) => {
        statusPill.className = `streamsync-pill ${report.state}`;
        switch (report.state) {
          case "in_sync":
            const isPaused = this.client?.timeline?.isPaused();
            statusText.textContent = isPaused ? "PAUSED (IN SYNC)" : `IN SYNC (${report.absDeltaMs}ms)`;
            break;
          case "slewing":
            statusText.textContent = `SLEWING ${report.playbackRate}x`;
            break;
          case "seeking":
            statusText.textContent = "SEEKING...";
            break;
          case "buffering":
            statusText.textContent = "BUFFERING...";
            break;
        }
      });
      this.client.on("peers", (peersMap) => {
        this._updatePeers(peersMap, this.client.user?.id);
      });
      this.client.on("peer_join", () => {
        this._updatePeers(this.client.room?.peers, this.client.user?.id);
      });
      this.client.on("peer_leave", () => {
        this._updatePeers(this.client.room?.peers, this.client.user?.id);
      });
      this.client.on("chat", (msg) => {
        const item = document.createElement("div");
        item.className = "streamsync-msg";
        item.innerHTML = `
        <span class="streamsync-msg-sender">${escapeHtml(msg.display_name || "Guest")}</span>
        <span class="streamsync-msg-text">${escapeHtml(msg.content)}</span>
      `;
        chatMessages.appendChild(item);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      });
      this.client.on("typing", (msg) => {
        if (msg.is_typing) {
          typingIndicator.textContent = `${msg.display_name} is typing...`;
        } else {
          typingIndicator.textContent = "";
        }
      });
    }
    _updatePeers(peersMap, localUserId) {
      const root = this.shadowRoot;
      if (!root) return;
      const peersCount = root.querySelector("#peers-count");
      const peersList = root.querySelector("#peers-list");
      let peers = [];
      if (peersMap instanceof Map) {
        peers = Array.from(peersMap.values());
      } else if (Array.isArray(peersMap)) {
        peers = peersMap;
      }
      if (peersCount) {
        peersCount.textContent = peers.length;
      }
      if (peersList) {
        peersList.innerHTML = "";
        peers.forEach((peer) => {
          const avatar = document.createElement("div");
          avatar.className = `streamsync-peer-avatar ${peer.is_owner ? "is-owner" : ""}`;
          avatar.title = `${peer.display_name}${peer.is_owner ? " (Host)" : ""}${peer.id === localUserId ? " (You)" : ""}`;
          avatar.textContent = (peer.display_name || "U").slice(0, 1).toUpperCase();
          peersList.appendChild(avatar);
        });
      }
    }
    showToast(text) {
      const toast = this.shadowRoot.querySelector("#toast");
      toast.textContent = text;
      toast.classList.add("show");
      setTimeout(() => {
        toast.classList.remove("show");
      }, 2e3);
    }
    destroy() {
      if (this.container) {
        this.container.remove();
        this.container = null;
      }
    }
  };
  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // src/content/index.js
  var OVERLAY_CSS = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #f1f5f9;
  z-index: 2147483647;
  position: fixed;
  top: 24px;
  right: 24px;
}
* { box-sizing: border-box; }
.streamsync-widget {
  width: 320px;
  background: rgba(15, 23, 42, 0.88);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 1px 1px rgba(255, 255, 255, 0.1);
  overflow: hidden;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), width 0.3s ease;
  user-select: none;
}
.streamsync-widget.collapsed {
  width: auto;
  border-radius: 9999px;
  background: rgba(15, 23, 42, 0.95);
}
.streamsync-widget.collapsed .streamsync-body { display: none; }
.streamsync-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  cursor: grab;
}
.streamsync-widget.collapsed .streamsync-header {
  border-bottom: none;
  padding: 8px 12px;
}
.streamsync-brand { display: flex; align-items: center; gap: 8px; }
.streamsync-logo {
  width: 22px; height: 22px;
  background: linear-gradient(135deg, #6366f1, #a855f7);
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 11px; color: #fff;
  box-shadow: 0 0 10px rgba(168, 85, 247, 0.4);
}
.streamsync-title { font-size: 13px; font-weight: 700; color: #fff; }
.streamsync-header-actions { display: flex; align-items: center; gap: 6px; }
.streamsync-btn-icon {
  background: transparent; border: none; color: #94a3b8;
  cursor: pointer; padding: 4px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s ease;
}
.streamsync-btn-icon:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
.streamsync-status-bar {
  padding: 10px 14px;
  display: flex; align-items: center; justify-content: space-between;
  background: rgba(0, 0, 0, 0.25);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.streamsync-pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 600; padding: 3px 8px;
  border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.04em;
}
.streamsync-pill.in_sync {
  background: rgba(34, 197, 94, 0.15); color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.streamsync-pill.slewing {
  background: rgba(234, 179, 8, 0.15); color: #facc15;
  border: 1px solid rgba(234, 179, 8, 0.3);
}
.streamsync-pill.seeking, .streamsync-pill.buffering {
  background: rgba(239, 68, 68, 0.15); color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.streamsync-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.streamsync-pill.slewing .streamsync-dot,
.streamsync-pill.seeking .streamsync-dot {
  animation: streamsync-pulse 1.2s infinite ease-in-out;
}
@keyframes streamsync-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}
.streamsync-room-chip {
  display: flex; align-items: center; gap: 6px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 3px 8px; border-radius: 8px; cursor: pointer;
  transition: all 0.15s ease;
}
.streamsync-room-chip:hover { background: rgba(255, 255, 255, 0.15); }
.streamsync-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 700; font-size: 12px; letter-spacing: 0.06em; color: #e2e8f0;
}
.streamsync-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
.streamsync-peers-wrap { display: flex; flex-direction: column; gap: 6px; }
.streamsync-section-label { font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
.streamsync-peers-list { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.streamsync-peer-avatar {
  width: 28px; height: 28px; border-radius: 50%;
  background: linear-gradient(135deg, #3b82f6, #06b6d4);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 12px; color: #fff;
  border: 1.5px solid rgba(255, 255, 255, 0.2); position: relative;
}
.streamsync-peer-avatar.is-owner::after {
  content: '\u{1F451}'; position: absolute; top: -6px; right: -4px; font-size: 10px;
}
.streamsync-chat-box {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px; display: flex; flex-direction: column;
  height: 140px; overflow: hidden;
}
.streamsync-messages {
  flex: 1; padding: 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; font-size: 11px;
}
.streamsync-msg { display: flex; flex-direction: column; gap: 2px; line-height: 1.35; }
.streamsync-msg-sender { font-weight: 700; font-size: 10px; color: #94a3b8; }
.streamsync-msg-text { color: #f1f5f9; word-break: break-word; }
.streamsync-typing { font-size: 10px; color: #64748b; font-style: italic; padding: 2px 8px; min-height: 16px; }
.streamsync-chat-input-row {
  display: flex; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.02);
}
.streamsync-chat-input {
  flex: 1; background: transparent; border: none; padding: 8px 10px; color: #fff; font-size: 11px; outline: none;
}
.streamsync-chat-input::placeholder { color: #64748b; }
.streamsync-send-btn {
  background: transparent; border: none; color: #818cf8; padding: 6px 10px; cursor: pointer; font-size: 12px; display: flex; align-items: center;
}
.streamsync-send-btn:hover { color: #a5b4fc; }
.streamsync-toast {
  position: absolute; bottom: 8px; left: 50%;
  transform: translateX(-50%) translateY(20px);
  background: rgba(16, 185, 129, 0.95); color: #fff;
  padding: 4px 10px; border-radius: 9999px; font-size: 10px; font-weight: 700;
  opacity: 0; pointer-events: none; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.streamsync-toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
`;
  var StreamSyncRuntime = class {
    constructor() {
      this.client = null;
      this.adapter = null;
      this.overlay = null;
      this.serverUrl = "http://localhost:3001";
      this.userId = "u_" + Math.random().toString(36).slice(2, 10);
      this.init();
    }
    async init() {
      this._bindExtensionMessages();
      this.adapter = createPlayerAdapter({ targetWindow: window });
      this.client = new SyncClient({
        player: this.adapter
      });
      if (typeof this.adapter.waitForPlayer === "function") {
        this.adapter.waitForPlayer(1e4).catch(() => {
        });
      }
      const params = new URLSearchParams(window.location.search);
      const autoParty = params.get("streamsync_party");
      if (autoParty) {
        await this.joinParty(autoParty);
      }
      console.log("[StreamSync] Content script active on:", window.location.hostname);
    }
    async createParty(displayName = "Host") {
      try {
        const res = await fetch(`${this.serverUrl}/api/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: this.userId,
            display_name: displayName,
            shared_controls: true,
            video: {
              url: window.location.href,
              provider: this._detectProvider(),
              title: document.title
            }
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.party_id) {
          throw new Error(data.message || data.error || "Failed to create party");
        }
        await this.client.connect({
          url: this.serverUrl,
          partyId: data.party_id,
          userId: data.user?.id || this.userId,
          displayName: data.user?.display_name || displayName
        });
        this._mountOverlay(data.short_id);
        return data;
      } catch (err) {
        console.error("[StreamSync] Create party error:", err);
        throw err;
      }
    }
    async joinParty(shortCodeOrId, displayName = "Guest") {
      try {
        const res = await fetch(`${this.serverUrl}/api/join/${shortCodeOrId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: this.userId,
            display_name: displayName
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.party_id) {
          throw new Error(data.message || data.error || "Party not found");
        }
        await this.client.connect({
          url: this.serverUrl,
          partyId: data.party_id,
          userId: data.user?.id || this.userId,
          displayName: data.user?.display_name || displayName
        });
        this._mountOverlay(data.short_id || shortCodeOrId);
        return data;
      } catch (err) {
        console.error("[StreamSync] Join party error:", err);
        throw err;
      }
    }
    _mountOverlay(shortId = null) {
      if (this.overlay) {
        this.overlay.destroy();
      }
      this.overlay = new StreamSyncOverlay({
        client: this.client,
        cssText: OVERLAY_CSS,
        serverUrl: this.serverUrl,
        shortId: shortId || this.client?.room?.shortId
      });
    }
    _detectProvider() {
      const host = window.location.hostname;
      if (host.includes("netflix")) return "netflix";
      if (host.includes("primevideo") || host.includes("amazon")) return "prime";
      if (host.includes("youtube")) return "youtube";
      return "mp4";
    }
    _bindExtensionMessages() {
      if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
          if (request.action === "CREATE_PARTY") {
            this.createParty(request.displayName).then(sendResponse).catch((err) => sendResponse({ error: err.message }));
            return true;
          }
          if (request.action === "JOIN_PARTY") {
            this.joinParty(request.code, request.displayName).then(sendResponse).catch((err) => sendResponse({ error: err.message }));
            return true;
          }
          if (request.action === "GET_STATUS") {
            sendResponse({
              connected: this.client?.isConnected() || false,
              room: this.client?.room || null,
              provider: this._detectProvider()
            });
          }
        });
      }
    }
  };
  if (typeof window !== "undefined") {
    window.__STREAMSYNC_RUNTIME__ = new StreamSyncRuntime();
  }
})();
