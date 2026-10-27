/**
 * StreamSync - YouTube Player Adapter
 * 
 * Interacts with YouTube's HTML5 Player API (document.getElementById('movie_player'))
 * or the underlying .html5-main-video element.
 */

import { BasePlayerAdapter } from '@streamsync/sync-engine';

export class YouTubeAdapter extends BasePlayerAdapter {
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

    /** @type {NodeJS.Timeout|number|null} */
    this.pollTimer = null;

    this._init();
  }

  _init() {
    if (!this.moviePlayer && this.targetWindow?.document) {
      this.moviePlayer = this.targetWindow.document.getElementById('movie_player');
    }

    if (!this.videoElement && this.targetWindow?.document) {
      this.videoElement = this.targetWindow.document.querySelector('.html5-main-video') ||
                          this.targetWindow.document.querySelector('video');
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
  async waitForPlayer(timeoutMs = 10000, intervalMs = 250) {
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
    if (this.moviePlayer && typeof this.moviePlayer.getCurrentTime === 'function') {
      return this.moviePlayer.getCurrentTime();
    }
    return this.videoElement ? this.videoElement.currentTime : 0;
  }

  getDuration() {
    if (this.moviePlayer && typeof this.moviePlayer.getDuration === 'function') {
      return this.moviePlayer.getDuration();
    }
    return this.videoElement ? (this.videoElement.duration || 0) : 0;
  }

  isPaused() {
    if (this.moviePlayer && typeof this.moviePlayer.getPlayerState === 'function') {
      const state = this.moviePlayer.getPlayerState();
      // 1 = PLAYING, 3 = BUFFERING
      return state !== 1 && state !== 3;
    }
    return this.videoElement ? this.videoElement.paused : true;
  }

  isBuffering() {
    if (this.moviePlayer && typeof this.moviePlayer.getPlayerState === 'function') {
      return this.moviePlayer.getPlayerState() === 3; // BUFFERING
    }
    return this.videoElement ? this.videoElement.readyState < 3 : false;
  }

  getPlaybackRate() {
    if (this.moviePlayer && typeof this.moviePlayer.getPlaybackRate === 'function') {
      return this.moviePlayer.getPlaybackRate();
    }
    return this.videoElement ? this.videoElement.playbackRate : 1.0;
  }

  async play() {
    if (!this.isPaused()) return;
    if (this.moviePlayer && typeof this.moviePlayer.playVideo === 'function') {
      this.moviePlayer.playVideo();
    } else if (this.videoElement) {
      await this.videoElement.play();
    }
  }

  async pause() {
    if (this.isPaused()) return;
    if (this.moviePlayer && typeof this.moviePlayer.pauseVideo === 'function') {
      this.moviePlayer.pauseVideo();
    } else if (this.videoElement) {
      this.videoElement.pause();
    }
  }

  async seekTo(seconds) {
    return this.withInternalAction(async () => {
      const target = Math.max(0, seconds);
      if (this.moviePlayer && typeof this.moviePlayer.seekTo === 'function') {
        // allowSeekAhead = true
        this.moviePlayer.seekTo(target, true);
      } else if (this.videoElement) {
        this.videoElement.currentTime = target;
      }
    });
  }

  setPlaybackRate(rate) {
    if (this.moviePlayer && typeof this.moviePlayer.setPlaybackRate === 'function') {
      this.moviePlayer.setPlaybackRate(rate);
    }
    if (this.videoElement && this.videoElement.playbackRate !== rate) {
      this.videoElement.playbackRate = rate;
    }
  }

  setPreservesPitch(enabled) {
    if (!this.videoElement) return;
    if ('preservesPitch' in this.videoElement) {
      this.videoElement.preservesPitch = enabled;
    } else if ('webkitPreservesPitch' in this.videoElement) {
      /** @type {any} */ (this.videoElement).webkitPreservesPitch = enabled;
    }
  }

  _bindEvents() {
    if (!this.videoElement) return;

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

    this.videoElement.addEventListener('waiting', () => {
      this.emit('waiting', this.getCurrentTime());
    });

    this.videoElement.addEventListener('playing', () => {
      this.emit('playing', this.getCurrentTime());
    });

    this.videoElement.addEventListener('ratechange', () => {
      this.emit('ratechange', this.getPlaybackRate());
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
}
