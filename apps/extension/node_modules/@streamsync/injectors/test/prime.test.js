import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PrimeVideoAdapter } from '../src/prime/index.js';

describe('PrimeVideoAdapter (Prime Video Player & Dwell Button Fallback)', () => {
  function createMockPrimeWindow() {
    let clicked = false;
    const mockButton = {
      click: () => { clicked = true; },
    };

    const mockVideo = {
      currentTime: 100,
      duration: 3600,
      paused: true,
      playbackRate: 1.0,
      readyState: 4,
      preservesPitch: true,
      play: async () => { mockVideo.paused = false; },
      pause: () => { mockVideo.paused = true; },
      addEventListener: () => {},
    };

    const mockWindow = {
      document: {
        querySelector: (sel) => {
          if (sel.includes('.webPlayerContainer video')) return mockVideo;
          if (sel.includes('dwell-play-pause-button')) return mockButton;
          return null;
        },
      },
    };

    return { mockWindow, mockVideo, mockButton, wasButtonClicked: () => clicked };
  }

  test('locates Prime Video stream inside container and reads properties', () => {
    const { mockWindow } = createMockPrimeWindow();
    const adapter = new PrimeVideoAdapter({ targetWindow: mockWindow });

    assert.ok(adapter.videoElement);
    assert.equal(adapter.getCurrentTime(), 100);
    assert.equal(adapter.getDuration(), 3600);
    assert.equal(adapter.isPaused(), true);
    assert.equal(adapter.getPlaybackRate(), 1.0);
  });

  test('seeks and alters playback rate with pitch preservation', async () => {
    const { mockWindow, mockVideo } = createMockPrimeWindow();
    const adapter = new PrimeVideoAdapter({ targetWindow: mockWindow });

    await adapter.seekTo(250.5);
    assert.equal(mockVideo.currentTime, 250.5);

    adapter.setPlaybackRate(1.05);
    assert.equal(mockVideo.playbackRate, 1.05);
  });

  test('falls back to clicking dwell button if programmatic play throws', async () => {
    const { mockWindow, mockVideo, wasButtonClicked } = createMockPrimeWindow();
    mockVideo.play = async () => { throw new Error('Autoplay blocked'); };

    const adapter = new PrimeVideoAdapter({ targetWindow: mockWindow });
    await adapter.play();

    assert.equal(wasButtonClicked(), true, 'Should click dwell button when programmatic play fails');
  });
});
