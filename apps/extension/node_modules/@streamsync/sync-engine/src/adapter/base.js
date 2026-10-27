/**
 * StreamSync - Base Player Adapter Interface
 * 
 * Abstract base class for wrapping media players (HTML5 <video>, Netflix, Prime Video, YouTube).
 * Normalizes player controls, events, and pitch-preserving playback rates.
 */

export class BasePlayerAdapter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.events = new Map();

    /** @type {boolean} Flag indicating whether current seek or rate change is programmatically initiated by DriftEngine */
    this.isInternalAction = false;
  }

  /**
   * Current playback position in seconds.
   * @returns {number}
   */
  getCurrentTime() {
    throw new Error('getCurrentTime() not implemented');
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
    throw new Error('isPaused() not implemented');
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
    return 1.0;
  }

  /**
   * Start or resume playback.
   * @returns {Promise<void>}
   */
  async play() {
    throw new Error('play() not implemented');
  }

  /**
   * Pause playback.
   * @returns {Promise<void>}
   */
  async pause() {
    throw new Error('pause() not implemented');
  }

  /**
   * Seek player to target position in seconds.
   * @param {number} seconds
   * @returns {Promise<void>}
   */
  async seekTo(seconds) {
    throw new Error('seekTo() not implemented');
  }

  /**
   * Set playback rate for drift compensation (e.g. 0.95 or 1.05).
   * @param {number} rate
   */
  setPlaybackRate(rate) {
    throw new Error('setPlaybackRate() not implemented');
  }

  /**
   * Configure audio pitch preservation during rate changes.
   * @param {boolean} enabled
   */
  setPreservesPitch(enabled) {
    // Default no-op if player doesn't support
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
      // Yield to microtask queue before unsetting flag
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
      this.events.set(event, new Set());
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
}
