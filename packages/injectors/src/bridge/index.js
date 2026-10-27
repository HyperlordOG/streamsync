/**
 * StreamSync - Main World Bridge
 * 
 * Bridges Manifest V3 isolated-world content scripts to the page's MAIN execution world
 * so internal globals (such as window.netflix and window.Hls) are directly accessible.
 */

import { BasePlayerAdapter } from '@streamsync/sync-engine';

export const BRIDGE_CHANNELS = {
  COMMAND: 'STREAMSYNC_MAIN_COMMAND',
  EVENT: 'STREAMSYNC_MAIN_EVENT',
};

/**
 * Installs the Main World Bridge directly into the current window.
 * This runs directly in the target web page context with full access to window.netflix.
 */
export function installMainWorldBridge() {
  if (typeof window === 'undefined') return;
  if (window.__STREAMSYNC_BRIDGE_INSTALLED__) return;
  window.__STREAMSYNC_BRIDGE_INSTALLED__ = true;

  function getNetflixPlayer() {
    try {
      const netflix = window.netflix;
      const api = netflix?.appContext?.state?.playerApp?.getAPI?.();
      const videoPlayer = api?.videoPlayer;
      if (!videoPlayer) return null;
      const ids = videoPlayer.getAllPlayerSessionIds ? videoPlayer.getAllPlayerSessionIds() : [];
      const watchId = ids.find(id => typeof id === 'string' && id.startsWith('watch-')) || ids[ids.length - 1] || ids[0];
      return watchId ? videoPlayer.getVideoPlayerBySessionId(watchId) : null;
    } catch {
      return null;
    }
  }

  function getActivePlayer() {
    const netflix = getNetflixPlayer();
    if (netflix) return { type: 'netflix', player: netflix };

    const yt = document.getElementById('movie_player');
    if (yt && typeof yt.playVideo === 'function') return { type: 'youtube', player: yt };

    const video = document.querySelector('.webPlayerContainer video') ||
                  document.querySelector('.rendererContainer video') ||
                  document.querySelector('#dv-web-player video') ||
                  document.querySelector('video');
    if (video) return { type: 'html5', player: video };

    return null;
  }

  // Command listener from isolated world content script
  window.addEventListener(BRIDGE_CHANNELS.COMMAND, async (event) => {
    const { action, payload, id } = event.detail || {};
    const target = getActivePlayer();
    let response = { id, success: false };

    if (!target) {
      window.dispatchEvent(new CustomEvent(BRIDGE_CHANNELS.EVENT, { detail: { ...response, error: 'NO_PLAYER' } }));
      return;
    }

    try {
      const { type, player } = target;
      switch (action) {
        case 'play':
          if (type === 'netflix') await player.play();
          else if (type === 'youtube') player.playVideo();
          else await player.play();
          response.success = true;
          break;

        case 'pause':
          if (type === 'netflix') await player.pause();
          else if (type === 'youtube') player.pauseVideo();
          else player.pause();
          response.success = true;
          break;

        case 'seek': {
          const sec = Number(payload?.seconds || 0);
          if (type === 'netflix') await player.seek(Math.round(sec * 1000));
          else if (type === 'youtube') player.seekTo(sec, true);
          else player.currentTime = sec;
          response.success = true;
          break;
        }

        case 'rate': {
          const rate = Number(payload?.rate || 1.0);
          if (type === 'netflix' && typeof player.setPlaybackRate === 'function') {
            try { player.setPlaybackRate(rate); } catch {}
          }
          if (type === 'youtube' && typeof player.setPlaybackRate === 'function') {
            player.setPlaybackRate(rate);
          }
          const v = document.querySelector('video');
          if (v) v.playbackRate = rate;
          response.success = true;
          break;
        }

        case 'get_state': {
          let currentTime = 0;
          let duration = 0;
          let paused = true;
          let buffering = false;
          let playbackRate = 1.0;

          if (type === 'netflix') {
            currentTime = (player.getCurrentTime?.() || 0) / 1000;
            duration = (player.getDuration?.() || 0) / 1000;
            paused = player.isPaused?.() ?? true;
            buffering = !!player.getBusy?.()?.buffering;
          } else if (type === 'youtube') {
            currentTime = player.getCurrentTime?.() || 0;
            duration = player.getDuration?.() || 0;
            const s = player.getPlayerState?.();
            paused = (s !== 1 && s !== 3);
            buffering = (s === 3);
            playbackRate = player.getPlaybackRate?.() || 1.0;
          } else {
            currentTime = player.currentTime || 0;
            duration = player.duration || 0;
            paused = player.paused;
            buffering = player.seeking || player.readyState === 0;
            playbackRate = player.playbackRate || 1.0;
          }

          response = {
            id,
            success: true,
            data: { currentTime, duration, paused, buffering, playbackRate, provider: type }
          };
          break;
        }
      }
    } catch (err) {
      response.error = err.message;
    }

    window.dispatchEvent(new CustomEvent(BRIDGE_CHANNELS.EVENT, { detail: response }));
  });

  console.log('[StreamSync Bridge] Main World Bridge active');
}

/**
 * Returns raw JavaScript source string to be injected into the page's MAIN world.
 * @returns {string}
 */
export function getMainWorldBridgeScript() {
  return `(() => {
    (${installMainWorldBridge.toString()})();
  })();`;
}

/**
 * Proxy adapter that communicates with the Main World Bridge via CustomEvents.
 */
export class BridgePlayerAdapter extends BasePlayerAdapter {
  /**
   * @param {Object} [options]
   * @param {Window} [options.targetWindow=globalThis.window]
   */
  constructor(options = {}) {
    super();
    this.targetWindow = options.targetWindow || globalThis.window;

    this.state = {
      currentTime: 0,
      duration: 0,
      paused: true,
      buffering: false,
      playbackRate: 1.0,
      provider: 'unknown',
    };

    /** @type {Map<string, { resolve: Function, reject: Function }>} */
    this.pendingCommands = new Map();

    this._bindBridgeEvents();
  }

  _bindBridgeEvents() {
    if (!this.targetWindow) return;

    this.targetWindow.addEventListener(BRIDGE_CHANNELS.EVENT, (event) => {
      const { id, success, data, error } = event.detail || {};

      if (id && this.pendingCommands.has(id)) {
        const { resolve, reject } = this.pendingCommands.get(id);
        this.pendingCommands.delete(id);
        if (success) {
          if (data) Object.assign(this.state, data);
          resolve(data);
        } else {
          reject(new Error(error || 'Command failed'));
        }
      }
    });
  }

  /**
   * Send a command to the Main World Bridge.
   * @param {string} action
   * @param {Object} [payload]
   * @returns {Promise<any>}
   */
  async sendCommand(action, payload = {}) {
    const id = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject });
      this.targetWindow.dispatchEvent(new CustomEvent(BRIDGE_CHANNELS.COMMAND, {
        detail: { id, action, payload }
      }));

      // Timeout after 3 seconds
      setTimeout(() => {
        if (this.pendingCommands.has(id)) {
          this.pendingCommands.delete(id);
          reject(new Error(`Bridge command timed out: ${action}`));
        }
      }, 3000);
    });
  }

  getCurrentTime() {
    return this.state.currentTime;
  }

  getDuration() {
    return this.state.duration;
  }

  isPaused() {
    return this.state.paused;
  }

  isBuffering() {
    return this.state.buffering;
  }

  getPlaybackRate() {
    return this.state.playbackRate;
  }

  async play() {
    await this.sendCommand('play');
    this.state.paused = false;
  }

  async pause() {
    await this.sendCommand('pause');
    this.state.paused = true;
  }

  async seekTo(seconds) {
    return this.withInternalAction(async () => {
      await this.sendCommand('seek', { seconds });
      this.state.currentTime = seconds;
    });
  }

  setPlaybackRate(rate) {
    this.sendCommand('rate', { rate }).catch(() => {});
    this.state.playbackRate = rate;
  }

  async syncState() {
    const data = await this.sendCommand('get_state');
    if (data) Object.assign(this.state, data);
    return this.state;
  }
}
