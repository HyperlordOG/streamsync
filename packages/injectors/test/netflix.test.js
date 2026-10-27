import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NetflixAdapter } from '../src/netflix/index.js';

describe('NetflixAdapter (Cadmium Player & DOM Fallback)', () => {
  function createMockNetflixWindow(cadmiumConfig = {}) {
    let mockCurrentTimeMs = 45000;
    let mockPaused = true;
    let mockRate = 1.0;
    const seekCalls = [];

    const mockCadmiumPlayer = {
      getCurrentTime: () => mockCurrentTimeMs,
      getDuration: () => 7200000, // 2 hours in ms
      isPaused: () => mockPaused,
      isPlaying: () => !mockPaused,
      getBusy: () => ({ buffering: cadmiumConfig.buffering || false }),
      play: async () => { mockPaused = false; },
      pause: async () => { mockPaused = true; },
      seek: async (ms) => {
        seekCalls.push(ms);
        mockCurrentTimeMs = ms;
      },
      setPlaybackRate: (rate) => { mockRate = rate; },
      addEventListener: () => {},
    };

    const mockVideoElement = {
      currentTime: 45,
      duration: 7200,
      paused: true,
      playbackRate: 1.0,
      readyState: 4,
      play: async () => {},
      pause: () => {},
      addEventListener: () => {},
    };

    const mockWindow = {
      netflix: {
        appContext: {
          state: {
            playerApp: {
              getAPI: () => ({
                videoPlayer: {
                  getAllPlayerSessionIds: () => ['watch-123456789'],
                  getVideoPlayerBySessionId: (id) => (id === 'watch-123456789' ? mockCadmiumPlayer : null),
                  EVENTS: {
                    CURRENT_TIME_CHANGE: 'currentTimeChange',
                    PAUSED_CHANGE: 'pausedChange',
                  },
                },
              }),
            },
          },
        },
      },
      document: {
        querySelector: () => mockVideoElement,
      },
    };

    return { mockWindow, mockCadmiumPlayer, mockVideoElement, seekCalls };
  }

  test('successfully attaches to Netflix Cadmium player and normalizes time units', () => {
    const { mockWindow } = createMockNetflixWindow();
    const adapter = new NetflixAdapter({ targetWindow: mockWindow });

    assert.ok(adapter.cadmiumPlayer, 'Should find active Cadmium player');
    assert.equal(adapter.sessionId, 'watch-123456789');

    // Cadmium has 45000ms -> adapter must return 45.0 seconds
    assert.equal(adapter.getCurrentTime(), 45.0);
    // Cadmium has 7,200,000ms -> adapter must return 7200.0 seconds
    assert.equal(adapter.getDuration(), 7200.0);
    assert.equal(adapter.isPaused(), true);
  });

  test('converts seconds to integer milliseconds on seekTo() for Cadmium', async () => {
    const { mockWindow, seekCalls } = createMockNetflixWindow();
    const adapter = new NetflixAdapter({ targetWindow: mockWindow });

    // Client seeks to 123.456 seconds
    await adapter.seekTo(123.456);

    // Netflix Cadmium API must receive integer milliseconds: 123456ms!
    assert.equal(seekCalls.length, 1);
    assert.equal(seekCalls[0], 123456);
    assert.equal(adapter.getCurrentTime(), 123.456);
  });

  test('controls play and pause on Cadmium player', async () => {
    const { mockWindow } = createMockNetflixWindow();
    const adapter = new NetflixAdapter({ targetWindow: mockWindow });

    assert.equal(adapter.isPaused(), true);
    await adapter.play();
    assert.equal(adapter.isPaused(), false);

    await adapter.pause();
    assert.equal(adapter.isPaused(), true);
  });

  test('reports buffering state from Cadmium getBusy()', () => {
    const { mockWindow } = createMockNetflixWindow({ buffering: true });
    const adapter = new NetflixAdapter({ targetWindow: mockWindow });

    assert.equal(adapter.isBuffering(), true);
  });

  test('falls back to video element if window.netflix is missing', async () => {
    let videoTime = 10;
    const mockVideo = {
      currentTime: 10,
      duration: 300,
      paused: true,
      playbackRate: 1.0,
      readyState: 4,
      play: async () => { mockVideo.paused = false; },
      pause: () => { mockVideo.paused = true; },
      addEventListener: () => {},
    };

    const mockWindowWithoutNetflix = {
      document: {
        querySelector: () => mockVideo,
      },
    };

    const adapter = new NetflixAdapter({ targetWindow: mockWindowWithoutNetflix });
    assert.equal(adapter.cadmiumPlayer, null);
    assert.equal(adapter.getCurrentTime(), 10);

    await adapter.seekTo(50);
    assert.equal(mockVideo.currentTime, 50);

    await adapter.play();
    assert.equal(adapter.isPaused(), false);
  });
});
