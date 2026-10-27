/**
 * StreamSync - Amazon Prime Video Player Adapter
 * 
 * Attaches to Prime Video's web player DOM container (.webPlayerContainer, .rendererContainer)
 * and controls playback rate, seeking, and play/pause state.
 */

import { BasePlayerAdapter } from '@streamsync/sync-engine';

export class PrimeVideoAdapter extends BasePlayerAdapter {
  /**
   * @param {Object} [options]
   * @param {Window} [options.targetWindow=globalThis.window] Target window
   * @param {HTMLVideoElement} [options.videoElement] Optional direct video element
   */
  constructor(options = {}) {
    super();
    this.targetWindow = options.targetWindow || globalThis.window;
    this.videoElement = options.videoElement || null;

    /** @type {NodeJS.Timeout|number|null} */
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

    const preferred = doc.querySelector('.webPlayerContainer video') ||
                      doc.querySelector('.rendererContainer video') ||
                      doc.querySelector('#dv-web-player video') ||
                      doc.querySelector('div[data-testid="video-player"] video') ||
                      doc.querySelector('.dv-player-fullscreen video');
    if (preferred) return preferred;

    const all = Array.from(doc.querySelectorAll('video'));
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];

    return all.find(v => (v.offsetWidth > 200 || v.offsetHeight > 200) && (v.duration > 0 || !v.paused))
        || all.find(v => v.offsetWidth > 200 || v.offsetHeight > 200)
        || all.find(v => v.duration > 0)
        || all[all.length - 1];
  }

  /**
   * Poll until Prime Video player is mounted.
   * @param {number} [timeoutMs=15000]
   * @param {number} [intervalMs=250]
   * @returns {Promise<boolean>}
   */
  async waitForPlayer(timeoutMs = 15000, intervalMs = 250) {
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
    if (this.videoElement && (this.videoElement.isConnected !== false)) {
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
    return v ? (v.duration || 0) : 0;
  }

  isPaused() {
    const v = this._getVideo();
    return v ? v.paused : true;
  }

  isBuffering() {
    const v = this._getVideo();
    if (!v) return false;
    if (v.paused && !v.seeking) return false;
    // On MSE/EME DRM streams, readyState is frequently 2 (HAVE_CURRENT_DATA) while playing smoothly.
    // Never treat readyState 2 as buffering. Only seeking or readyState 0 (HAVE_NOTHING).
    return v.seeking || v.readyState === 0;
  }

  getPlaybackRate() {
    const v = this._getVideo();
    return v ? v.playbackRate : 1.0;
  }

  async play() {
    const v = this._getVideo();
    if (!v || !v.paused) return;
    try {
      await v.play();
    } catch {
      // Fallback: Click Prime Video's dwell play button if programmatic play blocked
      const doc = this.targetWindow?.document;
      const btn = doc?.querySelector('button[data-testid="dwell-play-pause-button"]') ||
                  doc?.querySelector('.dwell-player-container button');
      if (btn && typeof btn.click === 'function') {
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
      const btn = doc?.querySelector('button[data-testid="dwell-play-pause-button"]') ||
                  doc?.querySelector('.dwell-player-container button');
      if (btn && typeof btn.click === 'function') {
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
    if ('preservesPitch' in v) {
      v.preservesPitch = enabled;
    } else if ('webkitPreservesPitch' in v) {
      /** @type {any} */ (v).webkitPreservesPitch = enabled;
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

    if (typeof doc.addEventListener === 'function') {
      // Use capturing phase so we catch play/pause/seeking from ANY video element on Prime Video!
      doc.addEventListener('play', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
          this.videoElement = e.target;
          if (!this.isInternalAction) this.emit('play', this.getCurrentTime());
        }
      }, true);

      doc.addEventListener('pause', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
          this.videoElement = e.target;
          if (!this.isInternalAction) this.emit('pause', this.getCurrentTime());
        }
      }, true);

      doc.addEventListener('seeking', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
          this.videoElement = e.target;
          if (!this.isInternalAction) this.emit('seek', this.getCurrentTime());
        }
      }, true);

      doc.addEventListener('seeked', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
          this.videoElement = e.target;
          this.emit('seeked', this.getCurrentTime());
        }
      }, true);

      doc.addEventListener('ratechange', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
          this.videoElement = e.target;
          this.emit('ratechange', this.getPlaybackRate());
        }
      }, true);
    } else if (this.videoElement && typeof this.videoElement.addEventListener === 'function') {
      this.videoElement.addEventListener('play', () => {
        if (!this.isInternalAction) this.emit('play', this.getCurrentTime());
      });
      this.videoElement.addEventListener('pause', () => {
        if (!this.isInternalAction) this.emit('pause', this.getCurrentTime());
      });
      this.videoElement.addEventListener('seeking', () => {
        if (!this.isInternalAction) this.emit('seek', this.getCurrentTime());
      });
      this.videoElement.addEventListener('seeked', () => {
        this.emit('seeked', this.getCurrentTime());
      });
      this.videoElement.addEventListener('ratechange', () => {
        this.emit('ratechange', this.getPlaybackRate());
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
}
