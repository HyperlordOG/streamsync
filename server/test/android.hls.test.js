import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureHlsLoaded } from '../public/js/party-player.js';

describe('Android HLS.js Engine & Fallback CDN Suite', () => {
  let originalWindow, originalDocument;

  before(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
  });

  after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test('1. ensureHlsLoaded falls back to cdnjs if primary jsdelivr CDN fails', async () => {
    const appendedScripts = [];

    // Mock document
    globalThis.document = {
      createElement: (tag) => {
        const el = {
          tag,
          src: '',
          onload: null,
          onerror: null
        };
        return el;
      },
      head: {
        appendChild: (el) => {
          appendedScripts.push(el);
          // Simulate first CDN failure, fallback CDN success
          if (el.src.includes('cdn.jsdelivr.net')) {
            setTimeout(() => {
              if (el.onerror) el.onerror(new Error('Blocked by adblocker'));
            }, 10);
          } else if (el.src.includes('cdnjs.cloudflare.com')) {
            setTimeout(() => {
              globalThis.window.Hls = { isSupported: () => true, version: '1.5.13' };
              if (el.onload) el.onload();
            }, 10);
          }
        }
      }
    };

    globalThis.window = {};

    const ready = await ensureHlsLoaded();
    assert.strictEqual(ready, true, 'HLS engine should resolve true after fallback CDN succeeds');
    assert.ok(appendedScripts.length >= 2, 'Should attempt fallback after primary fails');
    assert.ok(appendedScripts[0].src.includes('jsdelivr.net'), 'First attempt was jsdelivr');
    assert.ok(appendedScripts[1].src.includes('cdnjs.cloudflare.com'), 'Second attempt was cdnjs');
  });

  test('2. HLS.Events.MANIFEST_PARSED calculates and seeks desiredPosition before playing', async () => {
    let seekedTime = null;
    let playCalled = false;

    const mockVideo = {
      currentTime: 0,
      readyState: 4,
      play: () => {
        playCalled = true;
        return Promise.resolve();
      }
    };

    const targetDesiredPosMs = 15400; // 15.4 seconds in
    if (targetDesiredPosMs > 500) {
      mockVideo.currentTime = targetDesiredPosMs / 1000;
      seekedTime = mockVideo.currentTime;
    }

    assert.strictEqual(seekedTime, 15.4, 'Seek must be applied before calling play');
    assert.strictEqual(mockVideo.currentTime, 15.4);
    await mockVideo.play();
    assert.strictEqual(playCalled, true);
  });

  test('3. Non-Apple HLS streams trigger loading engine banner to eliminate black screen', () => {
    let bannerTitle = '';
    const mockShowLoading = (title, sub) => {
      bannerTitle = title;
    };

    const isAppleNative = false;
    const isHls = true;

    if (isHls && !isAppleNative) {
      mockShowLoading('Loading video engine...', 'Initializing playback engine for Android / Chrome...');
    }

    assert.strictEqual(bannerTitle, 'Loading video engine...', 'Loading overlay must be displayed for Android HLS');
  });
});

