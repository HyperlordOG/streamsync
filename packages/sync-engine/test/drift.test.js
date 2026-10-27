import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DriftEngine, DriftState } from '../src/drift.js';
import { VirtualTimeline } from '../src/timeline.js';
import { ClockSynchronizer } from '../src/clock.js';
import { MockPlayerAdapter } from '../src/adapter/mock.js';

describe('DriftEngine (Dual-Threshold Control Loop)', () => {
  function setup(initialTargetSec = 10, initialPlayerSec = 10) {
    let mockServerEpoch = 1000000;
    const clock = new ClockSynchronizer({
      nowProvider: () => mockServerEpoch,
    });
    // Calibrate clock with 0 offset for simplicity
    clock.handlePong({ client_time: mockServerEpoch, server_time: mockServerEpoch });

    // Timeline playing at initialTargetSec
    const started = mockServerEpoch - (initialTargetSec * 1000);
    const timeline = new VirtualTimeline({ started, paused: null });

    const player = new MockPlayerAdapter({
      initialTime: initialPlayerSec,
      paused: false,
    });

    const drift = new DriftEngine({
      timeline,
      clock,
      player,
      checkIntervalMs: 100,
      deadbandMs: 500,
      hardSeekThresholdMs: 5000,
      slewFastRate: 1.05,
      slewSlowRate: 0.95,
      seekCooldownMs: 500,
    });

    return { clock, timeline, player, drift, setServerTime: (t) => { mockServerEpoch = t; } };
  }

  test('Zone 1: Deadband (|Δ| < 500ms) preserves nominal rate 1.0x', async () => {
    // Target is at 10.0s, Player is at 10.2s (delta = -200ms)
    const { player, drift } = setup(10.0, 10.2);

    const report = await drift.tick();

    assert.equal(report.state, DriftState.IN_SYNC);
    assert.equal(report.deltaMs, -200);
    assert.equal(report.playbackRate, 1.0);
    assert.equal(player.getPlaybackRate(), 1.0);
    assert.equal(player.seekCalls.length, 0); // No unnecessary seeks
  });

  test('Zone 2: Slew Fast (500ms <= Δ < 5000ms) ramps rate to 1.05x when behind', async () => {
    // Target is at 12.0s, Player is at 10.0s (delta = +2000ms behind)
    const { player, drift } = setup(12.0, 10.0);

    const report = await drift.tick();

    assert.equal(report.state, DriftState.SLEWING);
    assert.equal(report.deltaMs, 2000);
    assert.equal(report.playbackRate, 1.05);
    assert.equal(player.getPlaybackRate(), 1.05);
    assert.equal(player.seekCalls.length, 0);
  });

  test('Zone 2: Slew Slow (500ms <= -Δ < 5000ms) slows rate to 0.95x when ahead', async () => {
    // Target is at 10.0s, Player is at 12.0s (delta = -2000ms ahead)
    const { player, drift } = setup(10.0, 12.0);

    const report = await drift.tick();

    assert.equal(report.state, DriftState.SLEWING);
    assert.equal(report.deltaMs, -2000);
    assert.equal(report.playbackRate, 0.95);
    assert.equal(player.getPlaybackRate(), 0.95);
    assert.equal(player.seekCalls.length, 0);
  });

  test('Zone 3: Hard Seek (|Δ| >= 5000ms) jumps directly and resets rate to 1.0x', async () => {
    // Target is at 60.0s, Player is at 10.0s (delta = +50,000ms)
    const { player, drift } = setup(60.0, 10.0);

    const report = await drift.tick();

    assert.equal(report.state, DriftState.SEEKING);
    assert.equal(player.seekCalls.length, 1);
    assert.equal(player.getCurrentTime(), 60.0); // Jumped to target
    assert.equal(player.getPlaybackRate(), 1.0); // Reset to 1.0x
  });

  test('respects seek cooldown to prevent infinite seek thrashing', async () => {
    const { player, drift } = setup(60.0, 10.0);

    await drift.tick(); // Seek 1 triggered
    assert.equal(player.seekCalls.length, 1);

    // Simulate player buffer delay: currentTime hasn't moved yet
    player.currentTime = 10.0;
    await drift.tick(); // Immediately ticked within cooldown

    // Seek count should remain 1 because seek cooldown is active
    assert.equal(player.seekCalls.length, 1);
  });

  test('pauses local player when virtual timeline is paused', async () => {
    const { timeline, player, drift } = setup(10.0, 10.0);
    assert.equal(player.isPaused(), false);

    // Host pauses at 10s
    timeline.pause(1000000, 10000);
    assert.equal(timeline.isPaused(), true);

    await drift.tick();
    assert.equal(player.isPaused(), true);
  });

  test('resumes local player when virtual timeline resumes playback', async () => {
    const { timeline, player, drift } = setup(10.0, 10.0);
    player.paused = true;
    timeline.play(1000000, 10000);

    await drift.tick();
    assert.equal(player.isPaused(), false);
  });

  test('does not fight player during active buffering stalls', async () => {
    const { player, drift } = setup(20.0, 10.0);
    player.setBuffering(true);

    const report = await drift.tick();
    assert.equal(report.state, DriftState.BUFFERING);
    assert.equal(player.seekCalls.length, 0); // No hard seek forced while buffering
  });
});
