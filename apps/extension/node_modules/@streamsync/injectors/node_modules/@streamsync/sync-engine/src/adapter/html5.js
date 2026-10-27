/**
 * StreamSync - HTML5 Video Player Adapter
 * 
 * Concrete adapter for standard HTML5 <video> elements, HLS.js, Dash.js,
 * or direct video streams.
 */

import { BasePlayerAdapter } from './base.js';

export class HTML5VideoAdapter extends BasePlayerAdapter {
  /**
   * @param {HTMLMediaElement|HTMLVideoElement} videoElement
   */
  constructor(videoElement) {
    super();
    if (!videoElement) {
      throw new Error('HTML5VideoAdapter requires a valid HTMLMediaElement');
    }
    this.video = videoElement;

    // Enable native pitch preservation when available
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
      // Browsers may reject play() if autoplay policy blocks unmuted audio
      console.warn('[HTML5VideoAdapter] play() rejected:', err.message);
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
    if ('preservesPitch' in this.video) {
      this.video.preservesPitch = enabled;
    } else if ('mozPreservesPitch' in this.video) {
      /** @type {any} */ (this.video).mozPreservesPitch = enabled;
    } else if ('webkitPreservesPitch' in this.video) {
      /** @type {any} */ (this.video).webkitPreservesPitch = enabled;
    }
  }

  /**
   * Attach native DOM event listeners and proxy to adapter events.
   * @private
   */
  _bindEvents() {
    this._onPlay = () => {
      if (!this.isInternalAction) this.emit('play', this.video.currentTime);
    };

    this._onPause = () => {
      if (!this.isInternalAction) this.emit('pause', this.video.currentTime);
    };

    this._onSeeking = () => {
      if (!this.isInternalAction) this.emit('seek', this.video.currentTime);
    };

    this._onSeeked = () => {
      this.emit('seeked', this.video.currentTime);
    };

    this._onWaiting = () => {
      this.emit('waiting', this.video.currentTime);
    };

    this._onPlaying = () => {
      this.emit('playing', this.video.currentTime);
    };

    this._onRateChange = () => {
      this.emit('ratechange', this.video.playbackRate);
    };

    this.video.addEventListener('play', this._onPlay);
    this.video.addEventListener('pause', this._onPause);
    this.video.addEventListener('seeking', this._onSeeking);
    this.video.addEventListener('seeked', this._onSeeked);
    this.video.addEventListener('waiting', this._onWaiting);
    this.video.addEventListener('playing', this._onPlaying);
    this.video.addEventListener('ratechange', this._onRateChange);
  }

  destroy() {
    super.destroy();
    if (this.video) {
      this.video.removeEventListener('play', this._onPlay);
      this.video.removeEventListener('pause', this._onPause);
      this.video.removeEventListener('seeking', this._onSeeking);
      this.video.removeEventListener('seeked', this._onSeeked);
      this.video.removeEventListener('waiting', this._onWaiting);
      this.video.removeEventListener('playing', this._onPlaying);
      this.video.removeEventListener('ratechange', this._onRateChange);
    }
  }
}
