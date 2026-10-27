import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ClockSynchronizer } from '../src/clock.js';

describe('ClockSynchronizer (NTP)', () => {
  test('creates valid ping payload with t0 timestamp', () => {
    let mockTime = 1700000000000;
    const clock = new ClockSynchronizer({ nowProvider: () => mockTime });

    const ping = clock.createPingPayload();
    assert.equal(ping.type, 'ping');
    assert.equal(ping.client_time, 1700000000000);
  });

  test('calculates RTT and offset θ accurately on pong', () => {
    // Simulated scenario:
    // Local clock is 1000ms BEHIND server clock.
    // Client sends at t0 = 1000
    // Server receives & stamps at t1 = 2050 (server time when client sent was 2000, +50ms one-way delay)
    // Client receives pong at t3 = 1100 (total round trip = 100ms)
    // Formula: RTT = 1100 - 1000 = 100ms
    // Offset θ = 2050 + (100 / 2) - 1100 = 2050 + 50 - 1100 = +1000ms!

    let currentTime = 1100;
    const clock = new ClockSynchronizer({
      minSamples: 1,
      nowProvider: () => currentTime,
    });

    const res = clock.handlePong({ client_time: 1000, server_time: 2050 });

    assert.equal(res.rtt, 100);
    assert.equal(res.offset, 1000);
    assert.equal(clock.offset, 1000);
    assert.equal(clock.now(), 2100); // 1100 + 1000 = 2100 server time
    assert.equal(clock.isCalibrated, true);
  });

  test('filters out jitter and latency spikes using moving median', () => {
    let currentTime = 1000;
    const clock = new ClockSynchronizer({
      sampleSize: 5,
      minSamples: 3,
      nowProvider: () => currentTime,
    });

    // Sample 1: RTT = 40ms, server ahead by +500ms
    // t0 = 1000, t1 = 1520, t3 = 1040 -> offset = 1520 + 20 - 1040 = 500
    currentTime = 1040;
    clock.handlePong({ client_time: 1000, server_time: 1520 });

    // Sample 2: RTT = 42ms, server ahead by +502ms
    // t0 = 1100, t1 = 1621, t3 = 1142 -> offset = 1621 + 21 - 1142 = 500
    currentTime = 1142;
    clock.handlePong({ client_time: 1100, server_time: 1621 });

    // Sample 3: A massive packet congestion spike! RTT = 500ms (10x normal)
    // t0 = 1200, t1 = 1950, t3 = 1700 -> skewed offset
    currentTime = 1700;
    clock.handlePong({ client_time: 1200, server_time: 1950 });

    // Sample 4: Back to normal. RTT = 38ms
    currentTime = 1838;
    clock.handlePong({ client_time: 1800, server_time: 2319 });

    const status = clock.getStatus();
    assert.equal(status.isCalibrated, true);
    // Offset must still be around 500ms despite the 500ms lag spike
    assert.ok(Math.abs(clock.offset - 500) <= 2, `Expected offset ~500, got ${clock.offset}`);
    assert.ok(status.bestRtt <= 42, `Best RTT should be <= 42, got ${status.bestRtt}`);
  });

  test('marks calibrated only when minSamples threshold is satisfied', () => {
    const clock = new ClockSynchronizer({ minSamples: 3 });
    assert.equal(clock.isCalibrated, false);

    clock.handlePong({ client_time: 100, server_time: 200 }, 150);
    assert.equal(clock.isCalibrated, false);

    clock.handlePong({ client_time: 200, server_time: 300 }, 250);
    assert.equal(clock.isCalibrated, false);

    clock.handlePong({ client_time: 300, server_time: 400 }, 350);
    assert.equal(clock.isCalibrated, true);
  });
});
