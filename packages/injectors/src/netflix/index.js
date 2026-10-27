/**
 * StreamSync - Netflix Player Adapter
 * 
 * Interacts directly with Netflix's internal Cadmium EME video player API:
 * window.netflix.appContext.state.playerApp.getAPI().videoPlayer
 * 
 * Supports both Main World and Isolated World (via BRIDGE_CHANNELS custom event bridge)
 * and falls back cleanly to native HTML5 video element with document-level capturing events.
 */

import { BasePlayerAdapter } from '@streamsync/sync-engine';
import { BRIDGE_CHANNELS } from '../bridge/index.js';

export class NetflixAdapter extends BasePlayerAdapter {
  /**
   * @param {Object} [options]
   * @param {Window} [options.targetWindow=globalThis.window] Target window object
   * @param {HTMLVideoElement} [options.videoElement] Optional direct video element reference
   */
  constructor(options = {}) {
    super();
    this.targetWindow = options.targetWindow || globalThis.window;
    this.videoElement = options.videoElement || null;

    /** @type {any|null} Netflix Cadmium Player API instance (in Main World) */
    this.cadmiumPlayer = null;
    this.sessionId = null;

    /** @type {NodeJS.Timeout|number|null} */
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
        const watchId = sessionIds.find(id => typeof id === 'string' && id.startsWith('watch-')) || sessionIds[sessionIds.length - 1] || sessionIds[0];

        if (watchId) {
          this.sessionId = watchId;
          this.cadmiumPlayer = videoPlayer.getVideoPlayerBySessionId(watchId);
          this._bindCadmiumEvents(videoPlayer);
          return true;
        }
      }
    } catch (err) {
      console.warn('[NetflixAdapter] Cadmium inspection warning:', err);
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

    const preferred = (typeof doc.querySelector === 'function')
      ? (doc.querySelector('.watch-video--player-view video') ||
         doc.querySelector('div[data-uia="video-canvas"] video') ||
         doc.querySelector('.nf-player-container video') ||
         doc.querySelector('video'))
      : null;
    if (preferred) return preferred;

    const all = typeof doc.querySelectorAll === 'function' ? Array.from(doc.querySelectorAll('video')) : [];
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];

    return all.find(v => (v.offsetWidth > 200 || v.offsetHeight > 200) && (v.duration > 0 || !v.paused))
        || all.find(v => v.offsetWidth > 200 || v.offsetHeight > 200)
        || all.find(v => v.duration > 0)
        || all[all.length - 1];
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
    if (!this.targetWindow || typeof this.targetWindow.addEventListener !== 'function' || typeof this.targetWindow.dispatchEvent !== 'function') {
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
        const evt = typeof CustomEvent !== 'undefined'
          ? new CustomEvent(BRIDGE_CHANNELS.COMMAND, { detail: { id, action, payload } })
          : { type: BRIDGE_CHANNELS.COMMAND, detail: { id, action, payload } };
        this.targetWindow.dispatchEvent(evt);
      } catch {
        this.targetWindow.removeEventListener(BRIDGE_CHANNELS.EVENT, handler);
        resolve(null);
        return;
      }
      setTimeout(() => {
        if (typeof this.targetWindow?.removeEventListener === 'function') {
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
  async waitForPlayer(timeoutMs = 15000, intervalMs = 250) {
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
    // 1. Cadmium player returns time in milliseconds
    if (this.cadmiumPlayer && typeof this.cadmiumPlayer.getCurrentTime === 'function') {
      const ms = this.cadmiumPlayer.getCurrentTime();
      if (typeof ms === 'number' && !isNaN(ms)) {
        return ms / 1000;
      }
    }
    // 2. Underlying video element
    const v = this._getVideo();
    return v ? v.currentTime : 0;
  }

  getDuration() {
    if (this.cadmiumPlayer && typeof this.cadmiumPlayer.getDuration === 'function') {
      const ms = this.cadmiumPlayer.getDuration();
      if (typeof ms === 'number' && !isNaN(ms)) {
        return ms / 1000;
      }
    }
    const v = this._getVideo();
    return v ? (v.duration || 0) : 0;
  }

  isPaused() {
    if (this.cadmiumPlayer) {
      if (typeof this.cadmiumPlayer.isPaused === 'function') {
        return this.cadmiumPlayer.isPaused();
      }
      if (typeof this.cadmiumPlayer.isPlaying === 'function') {
        return !this.cadmiumPlayer.isPlaying();
      }
    }
    const v = this._getVideo();
    return v ? v.paused : true;
  }

  isBuffering() {
    if (this.cadmiumPlayer && typeof this.cadmiumPlayer.getBusy === 'function') {
      const busy = this.cadmiumPlayer.getBusy();
      if (busy?.buffering) return true;
    }
    const v = this._getVideo();
    if (!v) return false;
    if (v.paused && !v.seeking) return false;
    // On MSE / DRM streaming, readyState is frequently 2 while playing.
    return v.seeking || v.readyState === 0;
  }

  getPlaybackRate() {
    const v = this._getVideo();
    return v ? v.playbackRate : 1.0;
  }

  async play() {
    if (!this.isPaused()) return;

    if (this.cadmiumPlayer && typeof this.cadmiumPlayer.play === 'function') {
      await this.cadmiumPlayer.play();
      return;
    }

    // Dispatch to Main World Bridge (controls Cadmium in Main World)
    const res = await this._sendBridgeCommand('play');
    if (!res?.success) {
      const v = this._getVideo();
      if (v) await v.play().catch(() => {});
    }
  }

  async pause() {
    if (this.isPaused()) return;

    if (this.cadmiumPlayer && typeof this.cadmiumPlayer.pause === 'function') {
      await this.cadmiumPlayer.pause();
      return;
    }

    const res = await this._sendBridgeCommand('pause');
    if (!res?.success) {
      const v = this._getVideo();
      if (v) v.pause();
    }
  }

  async seekTo(seconds) {
    return this.withInternalAction(async () => {
      const ms = Math.max(0, Math.round(seconds * 1000));

      if (this.cadmiumPlayer && typeof this.cadmiumPlayer.seek === 'function') {
        await this.cadmiumPlayer.seek(ms);
        return;
      }

      const res = await this._sendBridgeCommand('seek', { seconds });
      if (!res?.success) {
        const v = this._getVideo();
        if (v) v.currentTime = seconds;
      }
    });
  }

  setPlaybackRate(rate) {
    if (this.cadmiumPlayer && typeof this.cadmiumPlayer.setPlaybackRate === 'function') {
      try {
        this.cadmiumPlayer.setPlaybackRate(rate);
      } catch {
        // Ignored
      }
    } else {
      this._sendBridgeCommand('rate', { rate }).catch(() => {});
    }

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
   * Bind to Cadmium player event listener (Main World).
   * @private
   */
  _bindCadmiumEvents(videoPlayerApi) {
    if (!this.cadmiumPlayer || typeof this.cadmiumPlayer.addEventListener !== 'function') return;

    const EVENTS = videoPlayerApi.EVENTS || {};

    const onCurrentTimeChange = (e) => {
      if (!this.isInternalAction && e?.currentTime !== undefined) {
        this.emit('timeupdate', e.currentTime / 1000);
      }
    };

    const onPausedChange = (e) => {
      if (this.isInternalAction) return;
      const paused = e?.paused !== undefined ? e.paused : this.isPaused();
      if (paused) {
        this.emit('pause', this.getCurrentTime());
      } else {
        this.emit('play', this.getCurrentTime());
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
      console.warn('[NetflixAdapter] Failed binding Cadmium events:', err);
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

    if (typeof doc.addEventListener === 'function') {
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
}
