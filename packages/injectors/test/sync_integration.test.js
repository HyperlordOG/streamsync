import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NetflixAdapter } from '../src/netflix/index.js';
import { SyncClient } from '@streamsync/sync-engine';
import { EventEmitter } from 'node:events';

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];
    setTimeout(() => { if (this.onopen) this.onopen(); }, 5);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
  simulateServerMessage(msg) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
}

describe('Netflix Player <-> StreamSync Engine End-to-End Alignment', () => {
  test('Netflix Cadmium player synchronizes to remote Room Timeline via SyncClient', async () => {
    let mockTimeMs = 0;
    let mockPaused = true;
    const cadmiumSeekHistory = [];

    const mockCadmium = {
      getCurrentTime: () => mockTimeMs,
      getDuration: () => 5400000,
      isPaused: () => mockPaused,
      isPlaying: () => !mockPaused,
      getBusy: () => ({ buffering: false }),
      play: async () => { mockPaused = false; },
      pause: async () => { mockPaused = true; },
      seek: async (ms) => {
        cadmiumSeekHistory.push(ms);
        mockTimeMs = ms;
      },
      setPlaybackRate: () => {},
      addEventListener: () => {},
    };

    const mockWindow = {
      netflix: {
        appContext: {
          state: {
            playerApp: {
              getAPI: () => ({
                videoPlayer: {
                  getAllPlayerSessionIds: () => ['watch-stranger-things'],
                  getVideoPlayerBySessionId: () => mockCadmium,
                },
              }),
            },
          },
        },
      },
      document: { querySelector: () => null },
    };

    // 1. Create NetflixAdapter
    const netflixAdapter = new NetflixAdapter({ targetWindow: mockWindow });

    // 2. Attach NetflixAdapter to SyncClient
    let serverEpoch = 3000000;
    let mockSocket;

    const client = new SyncClient({
      player: netflixAdapter,
      clockOptions: {
        minSamples: 1,
        nowProvider: () => serverEpoch,
      },
      driftOptions: {
        seekCooldownMs: 0,
      },
      WebSocketImpl: class extends MockWebSocket {
        constructor(url) {
          super(url);
          mockSocket = this;
        }
      },
    });

    await client.connect({
      url: 'ws://localhost:3001/ws',
      partyId: 'NETFLIX67',
      userId: 'user_bby',
      displayName: 'Streamer',
    });

    // Calibrate clock
    const ping = JSON.parse(mockSocket.sent[0]);
    mockSocket.simulateServerMessage({
      type: 'pong',
      client_time: ping.client_time,
      server_time: serverEpoch,
    });

    // 3. Room Host is playing at 120 seconds into movie!
    // started = serverEpoch - 120,000ms
    mockSocket.simulateServerMessage({
      type: 'joined',
      party_id: 'p_netflix',
      short_id: 'NETFLIX67',
      creator_id: 'user_host',
      shared_controls: true,
      sync: {
        started: serverEpoch - 120000,
        paused: null,
      },
      peers: [],
    });

    // 4. Run drift correction tick
    await client.driftEngine.tick();

    // Netflix Cadmium must have been seeked to 120,000ms!
    assert.equal(cadmiumSeekHistory.length, 1);
    assert.equal(cadmiumSeekHistory[0], 120000, 'Cadmium seek must receive 120,000ms');
    assert.equal(netflixAdapter.getCurrentTime(), 120.0);
    assert.equal(netflixAdapter.isPaused(), false);

    client.disconnect();
  });
});
