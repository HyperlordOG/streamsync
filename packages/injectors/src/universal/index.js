/**
 * StreamSync - Universal Stream Adapter
 * 
 * Adapts arbitrary HTML5 <video> tags, HLS.js (.m3u8) streams,
 * and Dash.js (.mpd) streams for synchronized playback.
 */

import { HTML5VideoAdapter } from '@streamsync/sync-engine';

export class UniversalVideoAdapter extends HTML5VideoAdapter {
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
  async loadSource(url, type = 'mp4') {
    if (type === 'hls' && this.hls) {
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);
    } else if (type === 'dash' && this.dash) {
      this.dash.attachSource(url);
    } else {
      this.video.src = url;
      this.video.load();
    }
  }

  destroy() {
    super.destroy();
    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }
    if (this.dash) {
      try { this.dash.reset(); } catch {}
      this.dash = null;
    }
  }
}
