/**
 * @streamsync/injectors
 * 
 * Streaming Service Adapters and Injectors for Netflix, Prime Video, YouTube,
 * and Universal HTML5 / HLS / DASH Streams.
 */

import { NetflixAdapter } from './netflix/index.js';
import { PrimeVideoAdapter } from './prime/index.js';
import { YouTubeAdapter } from './youtube/index.js';
import { UniversalVideoAdapter } from './universal/index.js';
import { BridgePlayerAdapter, getMainWorldBridgeScript, installMainWorldBridge, BRIDGE_CHANNELS } from './bridge/index.js';

export {
  NetflixAdapter,
  PrimeVideoAdapter,
  YouTubeAdapter,
  UniversalVideoAdapter,
  BridgePlayerAdapter,
  getMainWorldBridgeScript,
  installMainWorldBridge,
  BRIDGE_CHANNELS,
};

/**
 * Detect streaming provider from host URL or Location object.
 * @param {string|Location} [locationInput]
 * @returns {'netflix'|'prime'|'youtube'|'universal'}
 */
export function detectProvider(locationInput) {
  let hostname = '';

  if (typeof locationInput === 'string') {
    try {
      hostname = new URL(locationInput).hostname.toLowerCase();
    } catch {
      hostname = locationInput.toLowerCase();
    }
  } else if (locationInput && typeof locationInput.hostname === 'string') {
    hostname = locationInput.hostname.toLowerCase();
  } else if (typeof globalThis.window !== 'undefined' && globalThis.window.location) {
    hostname = globalThis.window.location.hostname.toLowerCase();
  }

  if (hostname.includes('netflix.com')) return 'netflix';
  if (hostname.includes('primevideo.com') || hostname.includes('amazon.')) return 'prime';
  if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return 'youtube';

  return 'universal';
}

/**
 * Factory to instantiate the matching player adapter for the current page context.
 * @param {Object} [options]
 * @param {Window} [options.targetWindow=globalThis.window]
 * @param {string} [options.provider] Override detected provider ('netflix'|'prime'|'youtube'|'universal')
 * @returns {NetflixAdapter|PrimeVideoAdapter|YouTubeAdapter|UniversalVideoAdapter}
 */
export function createPlayerAdapter(options = {}) {
  const targetWindow = options.targetWindow || globalThis.window;
  const provider = options.provider || detectProvider(targetWindow?.location);

  switch (provider) {
    case 'netflix':
      return new NetflixAdapter({ targetWindow });
    case 'prime':
      return new PrimeVideoAdapter({ targetWindow });
    case 'youtube':
      return new YouTubeAdapter({ targetWindow });
    default:
      const video = targetWindow?.document?.querySelector('video');
      return new UniversalVideoAdapter(video || targetWindow?.document?.createElement('video'));
  }
}
