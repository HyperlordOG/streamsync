import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeAdapter } from '../src/youtube/index.js';

describe('YouTubeAdapter (HTML5 Player API & movie_player)', () => {
  function createMockYouTubeWindow() {
    let state = 2; // PAUSED
    let currentTime = 75;
    let rate = 1.0;
    let lastSeek = null;

    const mockMoviePlayer = {
      getCurrentTime: () => currentTime,
      getDuration: () => 600,
      getPlayerState: () => state,
      getPlaybackRate: () => rate,
      playVideo: () => { state = 1; }, // 1 = PLAYING
      pauseVideo: () => { state = 2; }, // 2 = PAUSED
      seekTo: (sec, allowSeekAhead) => {
        lastSeek = { sec, allowSeekAhead };
        currentTime = sec;
      },
      setPlaybackRate: (r) => { rate = r; },
    };

    const mockVideo = {
      currentTime: 75,
      duration: 600,
      paused: true,
      playbackRate: 1.0,
      readyState: 4,
      addEventListener: () => {},
    };

    const mockWindow = {
      document: {
        getElementById: (id) => (id === 'movie_player' ? mockMoviePlayer : null),
        querySelector: () => mockVideo,
      },
    };

    return { mockWindow, mockMoviePlayer, getLastSeek: () => lastSeek };
  }

  test('interacts with movie_player API and translates state codes', async () => {
    const { mockWindow } = createMockYouTubeWindow();
    const adapter = new YouTubeAdapter({ targetWindow: mockWindow });

    assert.equal(adapter.getCurrentTime(), 75);
    assert.equal(adapter.getDuration(), 600);
    assert.equal(adapter.isPaused(), true);

    await adapter.play();
    assert.equal(adapter.isPaused(), false);

    await adapter.pause();
    assert.equal(adapter.isPaused(), true);
  });

  test('calls movie_player.seekTo with allowSeekAhead = true', async () => {
    const { mockWindow, getLastSeek } = createMockYouTubeWindow();
    const adapter = new YouTubeAdapter({ targetWindow: mockWindow });

    await adapter.seekTo(150);
    const last = getLastSeek();
    assert.equal(last.sec, 150);
    assert.equal(last.allowSeekAhead, true);
  });
});
