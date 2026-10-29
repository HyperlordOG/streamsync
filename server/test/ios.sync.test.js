import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDriftAction } from '../public/js/party-player.js';

class MockVideoElement {
  constructor() {
    this.currentTime = 0;
    this.paused = true;
    this.playbackRate = 1.0;
    this.preservesPitch = false;
    this.src = '';
    this.readyState = 4;
    this.duration = 120;
    this.children = [];
    this.listeners = {};
  }

  canPlayType(type) {
    return type === 'application/vnd.apple.mpegurl' ? 'probably' : '';
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

describe('iOS Safari Sync Engine & Diagnostic HUD Suite', () => {
  let PartyPlayer;
  let originalDocument;
  let originalWindow;
  let originalRaf;
  let originalCaf;
  const elements = new Map();

  before(async () => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    originalRaf = globalThis.requestAnimationFrame;
    originalCaf = globalThis.cancelAnimationFrame;

    globalThis.requestAnimationFrame = (cb) => setTimeout(() => {
      if (globalThis.document) cb(Date.now());
    }, 16);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

    globalThis.document = {
      createElement: (tag) => {
        if (tag === 'video') return new MockVideoElement();
        const el = {
          id: '',
          className: '',
          style: {},
          innerHTML: '',
          children: [],
          appendChild: (c) => el.children.push(c),
          remove: () => {},
          querySelector: () => ({ addEventListener: () => {} }),
          querySelectorAll: () => [],
        };
        return el;
      },
      getElementById: (id) => elements.get(id) || null,
      head: { appendChild: () => {} },
      body: {
        appendChild: (el) => {
          if (el.id) elements.set(el.id, el);
        },
      },
      addEventListener: () => {},
    };

    globalThis.window = {
      location: { search: '?diag=1', pathname: '/room/TEST12' },
      addEventListener: () => {},
      _roomId: 'TEST12',
      _peerCount: 2,
      _ntpOffset: 25,
      Hls: null,
    };

    const mod = await import('../public/js/party-player.js');
    PartyPlayer = mod.PartyPlayer;
  });

  after(() => {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
  });

  test('1. getDriftAction enforces seek-only strategy on iOS native HLS with 800ms threshold', () => {
    // Under 800ms on iOS -> Deadband (in sync), no slewing
    const actionUnder = getDriftAction(10000, 10400, false, true);
    assert.equal(actionUnder.type, 'rate');
    assert.equal(actionUnder.rate, 1.0);
    assert.ok(actionUnder.zone.includes('In Sync (iOS)'));

    // Over 800ms on iOS -> Hard seek
    const actionOver = getDriftAction(10000, 11200, false, true);
    assert.equal(actionOver.type, 'seek');
    assert.equal(actionOver.targetMs, 11200);
    assert.ok(actionOver.zone.includes('Hard Seek (iOS)'));
  });

  test('2. Non-iOS (Android/Desktop) retains full 3-zone slewing (150ms-500ms)', () => {
    const actionSlew = getDriftAction(10000, 10300, false, false);
    assert.equal(actionSlew.type, 'rate');
    assert.equal(actionSlew.rate, 1.08);

    const actionHard = getDriftAction(10000, 10700, false, false);
    assert.equal(actionHard.type, 'seek');
    assert.equal(actionHard.targetMs, 10700);
  });

  test('3. PartyPlayer detects iOS native HLS streams properly', async () => {
    const video = new MockVideoElement();
    const player = new PartyPlayer(video);
    assert.equal(player._isIOSNativeHLS, false);

    await player.attachStream('https://cdn.example.com/master.m3u8');
    assert.equal(player._isIOSNativeHLS, true);
    player.destroy();
  });

  test('4. Diagnostic HUD elements created when diag=1 is active', () => {
    const video = new MockVideoElement();
    const player = new PartyPlayer(video);
    assert.equal(player.isDiagMode, true);
    assert.ok(elements.has('sync-diag-hud'), 'Expected #sync-diag-hud to be mounted');
    assert.ok(elements.has('sync-diag-bottom'), 'Expected #sync-diag-bottom comparison card to be mounted');
    player.destroy();
  });
});
