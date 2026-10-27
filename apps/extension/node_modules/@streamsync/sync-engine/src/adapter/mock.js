/**
 * StreamSync - Mock Player Adapter
 * 
 * In-memory simulated media player for unit tests and headless integration tests.
 * Accurately tracks currentTime progression, rates, seek history, and state changes.
 */

import { BasePlayerAdapter } from './base.js';

export class MockPlayerAdapter extends BasePlayerAdapter {
  /**
   * @param {Object} [config]
   * @param {number} [config.initialTime=0] Initial position in seconds
   * @param {number} [config.duration=3600] Total duration in seconds
   * @param {boolean} [config.paused=true] Initial paused state
   * @param {number} [config.playbackRate=1.0] Initial playback rate
   */
  constructor(config = {}) {
    super();
    this.currentTime = config.initialTime ?? 0;
    this.duration = config.duration ?? 3600;
    this.paused = config.paused ?? true;
    this.playbackRate = config.playbackRate ?? 1.0;
    this.buffering = false;
    this.preservesPitch = true;

    /** History of actions for assertions */
    this.seekCalls = [];
    this.rateChanges = [];
    this.playCalls = 0;
    this.pauseCalls = 0;
  }

  getCurrentTime() {
    return this.currentTime;
  }

  getDuration() {
    return this.duration;
  }

  isPaused() {
    return this.paused;
  }

  isBuffering() {
    return this.buffering;
  }

  getPlaybackRate() {
    return this.playbackRate;
  }

  setBuffering(buffering) {
    this.buffering = buffering;
    if (buffering) {
      this.emit('waiting', this.currentTime);
    } else {
      this.emit('playing', this.currentTime);
    }
  }

  async play() {
    this.paused = false;
    this.playCalls++;
    if (!this.isInternalAction) {
      this.emit('play', this.currentTime);
    }
  }

  async pause() {
    this.paused = true;
    this.pauseCalls++;
    if (!this.isInternalAction) {
      this.emit('pause', this.currentTime);
    }
  }

  async seekTo(seconds) {
    this.currentTime = Math.max(0, Math.min(this.duration, seconds));
    this.seekCalls.push(this.currentTime);
    if (!this.isInternalAction) {
      this.emit('seek', this.currentTime);
    }
    this.emit('seeked', this.currentTime);
  }

  setPlaybackRate(rate) {
    this.playbackRate = rate;
    this.rateChanges.push(rate);
    this.emit('ratechange', rate);
  }

  setPreservesPitch(enabled) {
    this.preservesPitch = enabled;
  }

  /**
   * Advance simulated playback time by deltaSeconds.
   * If not paused, currentTime increases by deltaSeconds * playbackRate.
   * @param {number} deltaSeconds
   */
  advanceTime(deltaSeconds) {
    if (!this.paused && !this.buffering) {
      this.currentTime = Math.min(this.duration, this.currentTime + (deltaSeconds * this.playbackRate));
      this.emit('timeupdate', this.currentTime);
    }
  }
}
