import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient } from '../src/client.js';
import { MockPlayerAdapter } from '../src/adapter/mock.js';
import { EventEmitter } from 'node:events';

/**
 * Lightweight mock WebSocket transport connecting two clients or mock server.
 */
class MockWebSocket extends EventEmitter {
  static OPEN = 1;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];

    // Trigger open on next tick
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 5);
  }

  send(data) {
    this.sent.push(data);
    this.emit('server_inbound', JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }

  // Simulate server sending message to client
  simulateServerMessage(msg) {
    const raw = JSON.stringify(msg);
    if (this.onmessage) {
      this.onmessage({ data: raw });
    }
  }
}

describe('Sync Engine Integration (Host <-> Peer Convergence)', () => {
  test('Peer joins active room and converges to Host via NTP Virtual Timeline', async () => {
    let serverEpoch = 2000000;

    // 1. Setup Peer's player and client
    const peerPlayer = new MockPlayerAdapter({
      initialTime: 0,
      paused: true,
    });

    let mockSocket;
    const client = new SyncClient({
      player: peerPlayer,
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

    // Connect peer to room 'TEST67'
    const connectPromise = client.connect({
      url: 'ws://localhost:3001/ws',
      partyId: 'TEST67',
      userId: 'user_peer_1',
      displayName: 'PeerOne',
    });

    await connectPromise;
    assert.ok(mockSocket);

    // 2. Server sends NTP pong to calibrate Peer's clock
    // Local send was at t0, server replies with t1 = serverEpoch
    const pingSent = mockSocket.sent.find(s => JSON.parse(s).type === 'ping');
    assert.ok(pingSent, 'Client should have sent NTP ping');
    const pingData = JSON.parse(pingSent);

    mockSocket.simulateServerMessage({
      type: 'pong',
      client_time: pingData.client_time,
      server_time: serverEpoch,
    });

    assert.equal(client.clock.isCalibrated, true);

    // 3. Server sends 'joined' room state: Host is already 60 seconds into playback!
    // started = serverEpoch - 60,000ms
    const hostStartedEpoch = serverEpoch - 60000;
    mockSocket.simulateServerMessage({
      type: 'joined',
      party_id: 'p_123',
      short_id: 'TEST67',
      creator_id: 'user_host',
      shared_controls: true,
      sync: {
        started: hostStartedEpoch,
        paused: null,
      },
      peers: [
        { id: 'user_host', display_name: 'HostUser', is_owner: true },
        { id: 'user_peer_1', display_name: 'PeerOne', is_owner: false },
      ],
    });

    assert.equal(client.timeline.isPaused(), false);
    assert.equal(client.timeline.getPositionSeconds(serverEpoch), 60);

    // 4. Drift Engine evaluates: Peer is at 0s, Room is at 60s (Delta = 60s, Zone 3 Hard Seek)
    await client.driftEngine.tick();

    // Peer player should have hard-seeked to 60s!
    assert.equal(peerPlayer.getCurrentTime(), 60);
    assert.equal(peerPlayer.isPaused(), false); // Started playing

    // 5. Normal Playback: Peer lags by 1.5 seconds (90s target vs 88.5s player)
    serverEpoch += 30000; // 30 seconds elapse
    peerPlayer.currentTime = 88.5; // peer is at 88.5 instead of 90.0 (delta = +1500ms)

    const slewReport = await client.driftEngine.tick();

    assert.equal(slewReport.state, 'slewing');
    assert.equal(peerPlayer.getPlaybackRate(), 1.05); // Speed up smoothly!

    // 6. Drift closes under 500ms -> Deadband restores 1.0x rate
    peerPlayer.currentTime = 89.8; // only 200ms behind now
    const deadbandReport = await client.driftEngine.tick();

    assert.equal(deadbandReport.state, 'in_sync');
    assert.equal(peerPlayer.getPlaybackRate(), 1.0); // Restored to nominal 1.0x

    // 7. Host Pauses: Server broadcasts party pause event
    mockSocket.simulateServerMessage({
      type: 'party',
      sync: {
        started: hostStartedEpoch,
        paused: 90000, // paused at 90s
      },
      sender_id: 'user_host',
    });

    await client.driftEngine.tick();
    assert.equal(peerPlayer.isPaused(), true); // Peer player paused in lockstep!

    client.disconnect();
  });
});
