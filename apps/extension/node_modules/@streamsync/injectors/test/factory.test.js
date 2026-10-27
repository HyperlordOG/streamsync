import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, createPlayerAdapter, NetflixAdapter, PrimeVideoAdapter, YouTubeAdapter, UniversalVideoAdapter } from '../src/index.js';

describe('Service Injectors Factory & Provider Detection', () => {
  test('detects provider from various URL formats', () => {
    assert.equal(detectProvider('https://www.netflix.com/watch/80057281'), 'netflix');
    assert.equal(detectProvider('https://netflix.com/title/123'), 'netflix');
    assert.equal(detectProvider('https://www.primevideo.com/detail/0S3...'), 'prime');
    assert.equal(detectProvider('https://www.amazon.com/gp/video/detail/...'), 'prime');
    assert.equal(detectProvider('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube');
    assert.equal(detectProvider('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
    assert.equal(detectProvider('https://example.com/video.mp4'), 'universal');
  });

  test('factory creates corresponding adapter instance', () => {
    const netflixAdapter = createPlayerAdapter({ provider: 'netflix' });
    assert.ok(netflixAdapter instanceof NetflixAdapter);

    const primeAdapter = createPlayerAdapter({ provider: 'prime' });
    assert.ok(primeAdapter instanceof PrimeVideoAdapter);

    const ytAdapter = createPlayerAdapter({ provider: 'youtube' });
    assert.ok(ytAdapter instanceof YouTubeAdapter);

    const universalAdapter = createPlayerAdapter({
      provider: 'universal',
      targetWindow: {
        document: {
          querySelector: () => null,
          createElement: () => ({ addEventListener: () => {} }),
        },
      },
    });
    assert.ok(universalAdapter instanceof UniversalVideoAdapter);
  });
});
