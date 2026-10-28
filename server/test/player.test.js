import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

class MockVideoElement {
  constructor() {
    this.currentTime = 0;
    this.paused = true;
    this.playbackRate = 1.0;
    this.preservesPitch = false;
    this.src = '';
    this.children = [];
    this.listeners = {};
  }

  addEventListener(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  removeEventListener(event, fn) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(h => h !== fn);
    }
  }

  dispatchEvent(event) {
    const type = typeof event === 'string' ? event : (event.type || '');
    const handlers = (this.listeners[type] || []).slice();
    for (const h of handlers) h();
  }

  appendChild(child) {
    this.children.push(child);
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  load() {
    queueMicrotask(() => {
      this.dispatchEvent('loadedmetadata');
    });
  }
}

class MockDomContainer {
  constructor() {
    this.children = [];
  }
  appendChild(child) {
    this.children.push(child);
  }
}

describe('PartyPlayer Client & Sync Integration', () => {
  let PartyPlayer;
  let originalDocument;
  let originalWindow;
  let originalFetch;
  let originalRaf;
  let originalCaf;

  before(async () => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    originalFetch = globalThis.fetch;
    originalRaf = globalThis.requestAnimationFrame;
    originalCaf = globalThis.cancelAnimationFrame;

    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

    globalThis.document = {
      createElement: (tag) => {
        if (tag === 'video') return new MockVideoElement();
        return {
          id: '',
          className: '',
          style: {},
          innerHTML: '',
          appendChild: () => {},
          remove: () => {}
        };
      },
      getElementById: (id) => ({
        textContent: '',
        style: {}
      }),
      head: { appendChild: () => {} },
      body: new MockDomContainer()
    };

    globalThis.window = {
      Hls: null, // Test native fallback mode in Node
      addEventListener: () => {}
    };

    const mod = await import('../public/js/party-player.js');
    PartyPlayer = mod.PartyPlayer;
  });

  after(() => {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
  });

  test('isRemoteSync ref flag blocks onSeeked from emitting WebSocket events when true', () => {
    const video = new MockVideoElement();
    const emittedEvents = [];
    const wsSend = (msg) => emittedEvents.push(msg);
    const getNtpNow = () => 1700000000000;

    const player = new PartyPlayer(video, { wsSend, getNtpNow });

    // Case 1: isRemoteSync is false -> user seeks -> WS event emitted
    player.isRemoteSync.current = false;
    video.currentTime = 42;
    video.dispatchEvent({ type: 'seeked' });

    assert.equal(emittedEvents.length, 1);
    assert.equal(emittedEvents[0].type, 'party');
    assert.equal(emittedEvents[0].party.sync.position, 42000);

    // Case 2: isRemoteSync is true -> remote sync seeks -> NO WS event emitted (prevents echo loop)
    player.isRemoteSync.current = true;
    video.currentTime = 84;
    video.dispatchEvent({ type: 'seeked' });

    assert.equal(emittedEvents.length, 1, 'onSeeked must NOT emit when isRemoteSync.current is true');
    player.destroy();
  });

  test('desiredPosition on guest matches host within 150ms after loadStream + play sequence', async () => {
    let mockNtpTime = 1700000000000;
    const getNtpNow = () => mockNtpTime;

    const hostVideo = new MockVideoElement();
    const guestVideo = new MockVideoElement();

    let capturedPartyBroadcast = null;

    // Mock fetch for loadStream
    globalThis.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/media/stream/27205')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            streamUrl: 'https://streamo.st/api/streaming/proxy?ref=inception-manifest.m3u8',
            provider: 'relay',
            quality: '1080p'
          })
        };
      }
      if (urlStr.includes('/api/media/subtitles')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            url: '/api/media/subtitles/proxy?url=https%3A%2F%2Fcache.vdrk.site%2Fv1%2Fvtt%2Fmovie%2F27205%2FEnglish.vtt'
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    // Instantiate Host Player
    const hostPlayer = new PartyPlayer(hostVideo, {
      wsSend: (msg) => {
        if (msg.type === 'party') {
          capturedPartyBroadcast = msg.party;
        }
      },
      getNtpNow
    });

    // Speed up countdown for tests
    hostPlayer.showCountdown = async () => {};

    // Instantiate Guest Player
    const guestPlayer = new PartyPlayer(guestVideo, {
      wsSend: () => {},
      getNtpNow
    });

    // 1. Host loads movie stream
    await hostPlayer.loadStream({
      tmdbId: 27205,
      type: 'movie',
      title: 'Inception'
    });

    assert.ok(capturedPartyBroadcast, 'Host should broadcast party state');

    // 2. Broadcast arrives at Guest via WebSocket
    await guestPlayer.handleRemoteVideoChange(capturedPartyBroadcast);

    // 3. Simulate 10 seconds of playback advancing across both clients
    mockNtpTime += 10000;

    const hostDesiredPosition = hostPlayer.getDesiredPositionMs();
    const guestDesiredPosition = guestPlayer.getDesiredPositionMs();

    const differenceMs = Math.abs(hostDesiredPosition - guestDesiredPosition);

    assert.ok(
      differenceMs <= 150,
      `Guest desiredPosition (${guestDesiredPosition}ms) must match host (${hostDesiredPosition}ms) within 150ms. Actual diff: ${differenceMs}ms`
    );

    hostPlayer.destroy();
    guestPlayer.destroy();
  });

  test('seekAbsolute and playback math does not double-count position or create runaway drift', () => {
    let mockNtpTime = 1700000050000;
    const getNtpNow = () => mockNtpTime;
    const video = new MockVideoElement();
    const emitted = [];
    const player = new PartyPlayer(video, {
      wsSend: (msg) => emitted.push(msg),
      getNtpNow
    });

    // 1. Seek to 8 seconds while playing
    video.paused = false;
    player.seekAbsolute(8);

    assert.equal(video.currentTime, 8);
    // Position should be 8000ms
    const posAtSeek = player.getDesiredPositionMs();
    assert.equal(posAtSeek, 8000, `Desired position at seek must be 8000ms, got ${posAtSeek}ms`);

    // 2. Advance time by 2 seconds (NTP + 2000ms)
    mockNtpTime += 2000;
    video.currentTime = 10; // Video advanced 2 seconds naturally

    // Desired position must be 10000ms (NOT 18000ms or 20000ms!)
    const posAfter2s = player.getDesiredPositionMs();
    assert.equal(posAfter2s, 10000, `Desired position after 2s must be 10000ms, got ${posAfter2s}ms`);

    // 3. checkDrift must detect 0ms drift and NOT trigger seek action
    player.isHlsManifestLoaded = true;
    video.readyState = 4;
    video.duration = 7200; // 2 hour movie
    player.checkDrift();

    // video.currentTime must remain at 10 (no jump)
    assert.equal(video.currentTime, 10, 'Video currentTime must not jump or runaway during checkDrift');

    player.destroy();
  });
});

