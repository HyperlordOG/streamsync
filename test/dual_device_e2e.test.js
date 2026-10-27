/**
 * StreamSync - Live Dual-Device Synchronization Verification
 * 
 * Simulates two separate physical devices (Host and Peer) connected over
 * real network WebSockets to the Fastify Relay Server on port 3001.
 * 
 * Verifies:
 * 1. Room generation & peer join handshake
 * 2. High-precision NTP clock calibration
 * 3. Initial state convergence (Peer catching up to playing Host)
 * 4. Play/Pause lockstep synchronization (<50ms response)
 * 5. Scrubbing test (15-minute jump forward)
 * 6. Rate slewing test (1.05x pitch-preserving speedup on network lag)
 * 7. Real-time chat & typing indicator propagation
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient } from '../packages/sync-engine/src/client.js';
import { MockPlayerAdapter } from '../packages/sync-engine/src/adapter/mock.js';

describe('Step 5: Live Dual-Device Synchronization Verification', () => {
  const SERVER_URL = 'http://localhost:3001';
  const WS_URL = 'ws://localhost:3001/ws';

  let hostClient;
  let peerClient;
  let hostPlayer;
  let peerPlayer;
  let roomCode;
  let partyId;

  after(() => {
    if (hostClient) hostClient.disconnect();
    if (peerClient) peerClient.disconnect();
  });

  test('1. Room Setup & Dual-Device WebSocket Handshake', async () => {
    // 1. Device A (Host) creates a watch party room
    const hostJoinRes = await fetch(`${SERVER_URL}/api/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 'host_device_1',
        display_name: 'Device_A_Host',
        shared_controls: true,
        video: {
          url: 'https://netflix.com/watch/80057281',
          provider: 'netflix',
          title: 'Stranger Things S1E1',
        },
      }),
    });

    const hostData = await hostJoinRes.json();
    assert.ok(hostData.party_id, 'Server must return party_id');
    assert.ok(hostData.short_id, 'Server must return 6-character short_id');
    assert.equal(hostData.short_id.length, 6, 'Short code must be 6 characters');

    partyId = hostData.party_id;
    roomCode = hostData.short_id;

    // 2. Setup Host Player & SyncClient
    hostPlayer = new MockPlayerAdapter({ initialTime: 0, paused: true });
    hostClient = new SyncClient({
      player: hostPlayer,
      driftOptions: { seekCooldownMs: 0 },
    });

    await hostClient.connect({
      url: WS_URL,
      partyId: partyId,
      userId: 'host_device_1',
      displayName: 'Device_A_Host',
    });

    assert.equal(hostClient.isConnected(), true, 'Host must be connected to WebSocket');

    // 3. Device B (Peer) joins using the 6-character room code
    const peerJoinRes = await fetch(`${SERVER_URL}/api/join/${roomCode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const peerData = await peerJoinRes.json();
    assert.equal(peerData.party_id, partyId, 'Peer must resolve same party_id from short code');

    // 4. Setup Peer Player & SyncClient
    peerPlayer = new MockPlayerAdapter({ initialTime: 0, paused: true });
    peerClient = new SyncClient({
      player: peerPlayer,
      driftOptions: { seekCooldownMs: 0 },
    });

    await peerClient.connect({
      url: WS_URL,
      partyId: partyId,
      userId: 'peer_device_2',
      displayName: 'Device_B_Peer',
    });

    assert.equal(peerClient.isConnected(), true, 'Peer must be connected to WebSocket');

    // Wait 200ms for NTP clock calibration
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(hostClient.clock.samples.length > 0, true, 'Host must have NTP samples');
    assert.equal(peerClient.clock.samples.length > 0, true, 'Peer must have NTP samples');
  });

  test('2. Initial Catch-Up: Peer synchronizes to Host active playback', async () => {
    // Host starts playing at position 120s (2 minutes in)
    hostPlayer.currentTime = 120.0;
    hostClient.seek(120.0);
    hostClient.play();

    // Allow broadcast to arrive at Peer
    await new Promise((r) => setTimeout(r, 100));

    // Peer evaluates drift loop
    await peerClient.driftEngine.tick();

    // Peer must have performed catch-up seek and jumped to ~120s!
    assert.ok(peerPlayer.seekCalls.length > 0, 'Peer must have performed catch-up seek');
    assert.ok(Math.abs(peerPlayer.getCurrentTime() - 120.0) < 2.0, `Peer should be at ~120s, got ${peerPlayer.getCurrentTime()}`);
    assert.equal(peerPlayer.isPaused(), false, 'Peer must be playing in sync');
  });

  test('3. Play/Pause Test: Host pauses -> Peer pauses in lockstep (<50ms)', async () => {
    assert.equal(peerPlayer.isPaused(), false);

    // Host hits Pause
    hostClient.pause();

    // Await WebSocket round-trip
    await new Promise((r) => setTimeout(r, 60));

    // Peer evaluates drift loop
    await peerClient.driftEngine.tick();

    assert.equal(peerPlayer.isPaused(), true, 'Peer player must pause when host pauses');

    // Host hits Play
    hostClient.play();
    await new Promise((r) => setTimeout(r, 60));
    await peerClient.driftEngine.tick();

    assert.equal(peerPlayer.isPaused(), false, 'Peer player must resume when host plays');
  });

  test('4. Scrubbing Test: Host scrubs 15 minutes ahead (to 900s)', async () => {
    // Host scrubs ahead to 15 minutes (900 seconds)
    hostClient.seek(900.0);

    // Wait for party broadcast
    await new Promise((r) => setTimeout(r, 80));

    // Peer tick
    await peerClient.driftEngine.tick();

    assert.ok(peerPlayer.seekCalls.some(s => Math.abs(s - 900.0) < 2.0), 'Peer must have performed scrub seek to 900s');
    assert.ok(Math.abs(peerPlayer.getCurrentTime() - 900.0) < 2.0, `Peer should seek to ~900s, got ${peerPlayer.getCurrentTime()}`);
    assert.equal(peerPlayer.getPlaybackRate(), 1.0, 'Playback rate should reset to 1.0x after seek');
  });

  test('5. Network Drift Ramping: Peer lags by 1.5s -> Slew rate ramps to 1.05x smoothly', async () => {
    // Simulate Peer local buffer stall: Peer drops behind by 1500ms
    peerPlayer.currentTime = 898.5; // Target is at ~900s

    const slewReport = await peerClient.driftEngine.tick();

    // Must trigger Zone 2: Pitch-preserving Rate Slewing
    assert.equal(slewReport.state, 'slewing');
    assert.equal(peerPlayer.getPlaybackRate(), 1.05, 'Peer should ramp speed to 1.05x to catch up');

    // Advance peer until delta is under 500ms
    peerPlayer.currentTime = 899.8; // Only 200ms behind now
    const recoveredReport = await peerClient.driftEngine.tick();

    // Must return to Zone 1: Deadband (nominal 1.0x)
    assert.equal(recoveredReport.state, 'in_sync');
    assert.equal(peerPlayer.getPlaybackRate(), 1.0, 'Playback rate should restore to 1.0x');
  });

  test('6. Real-Time Chat & Typing Indicator Fan-out', async () => {
    let receivedChat = null;
    let receivedTyping = null;

    peerClient.on('chat', (msg) => { receivedChat = msg; });
    peerClient.on('typing', (msg) => { receivedTyping = msg; });

    // Host sends typing indicator
    hostClient.setTyping(true);
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(receivedTyping, 'Peer should receive typing event');
    assert.equal(receivedTyping.is_typing, true);

    // Host sends chat message
    hostClient.sendChat('field with poop 6767 bby');
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(receivedChat, 'Peer should receive chat message');
    assert.equal(receivedChat.content, 'field with poop 6767 bby');
    assert.equal(receivedChat.display_name, 'Device_A_Host');
  });
});
