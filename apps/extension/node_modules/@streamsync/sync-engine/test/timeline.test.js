import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualTimeline } from '../src/timeline.js';

describe('VirtualTimeline (Virtual Epoch Playback)', () => {
  test('returns constant position when paused', () => {
    const timeline = new VirtualTimeline({ paused: 12500, started: null });
    assert.equal(timeline.isPaused(), true);
    assert.equal(timeline.getPositionMs(100000), 12500);
    assert.equal(timeline.getPositionMs(999999), 12500);
    assert.equal(timeline.getPositionSeconds(100000), 12.5);
  });

  test('computes position linearly from started epoch when playing', () => {
    // started at NTP epoch 1,000,000 with 0ms offset
    const timeline = new VirtualTimeline({ started: 1000000, paused: null });
    assert.equal(timeline.isPaused(), false);

    // 5 seconds later
    assert.equal(timeline.getPositionMs(1005000), 5000);
    assert.equal(timeline.getPositionSeconds(1005000), 5.0);

    // 20.5 seconds later
    assert.equal(timeline.getPositionMs(1020500), 20500);
    assert.equal(timeline.getPositionSeconds(1020500), 20.5);
  });

  test('handles playback rate multipliers', () => {
    const timeline = new VirtualTimeline({ started: 1000000, paused: null, rate: 1.5 });
    // 10 seconds of elapsed time at 1.5x speed = 15 seconds of media position
    assert.equal(timeline.getPositionMs(1010000), 15000);
  });

  test('transitions smoothly on play()', () => {
    const timeline = new VirtualTimeline({ paused: 30000 }); // paused at 30s
    const ntpNow = 5000000;

    const payload = timeline.play(ntpNow);
    assert.equal(timeline.isPaused(), false);
    assert.equal(payload.paused, null);
    // started must equal ntpNow - 30000 = 4970000
    assert.equal(timeline.started, 4970000);
    assert.equal(payload.started, 4970000);

    // At the exact moment of play, position is 30s
    assert.equal(timeline.getPositionMs(ntpNow), 30000);
    // 2 seconds later, position is 32s
    assert.equal(timeline.getPositionMs(ntpNow + 2000), 32000);
  });

  test('transitions smoothly on pause()', () => {
    const timeline = new VirtualTimeline({ started: 4000000, paused: null });
    const ntpNow = 4045000; // 45s in

    const payload = timeline.pause(ntpNow);
    assert.equal(timeline.isPaused(), true);
    assert.equal(timeline.paused, 45000);
    assert.equal(payload.paused, 45000);

    // Position remains fixed at 45000 even as NTP advances
    assert.equal(timeline.getPositionMs(ntpNow + 50000), 45000);
  });

  test('seeks accurately during active playback without halting stream', () => {
    const timeline = new VirtualTimeline({ started: 1000000, paused: null });
    const ntpNow = 1010000; // currently at 10s

    // Host seeks to 120s (120,000ms)
    const payload = timeline.seek(ntpNow, 120000);
    assert.equal(timeline.isPaused(), false);
    // started = ntpNow - 120000 = 1010000 - 120000 = 890000
    assert.equal(timeline.started, 890000);
    assert.equal(timeline.getPositionMs(ntpNow), 120000);
    assert.equal(timeline.getPositionSeconds(ntpNow), 120);

    // 3 seconds later
    assert.equal(timeline.getPositionSeconds(ntpNow + 3000), 123);
  });

  test('seeks accurately while paused', () => {
    const timeline = new VirtualTimeline({ paused: 5000 });
    const ntpNow = 2000000;

    timeline.seek(ntpNow, 75000); // seek to 75s while paused
    assert.equal(timeline.isPaused(), true);
    assert.equal(timeline.paused, 75000);
    assert.equal(timeline.getPositionSeconds(ntpNow + 10000), 75);
  });

  test('applies inbound sync payload from room peer', () => {
    const timeline = new VirtualTimeline();
    timeline.applySync({ started: 990000, paused: null });

    assert.equal(timeline.isPaused(), false);
    assert.equal(timeline.started, 990000);
    assert.equal(timeline.getPositionMs(1000000), 10000);

    timeline.applySync({ paused: 15000 });
    assert.equal(timeline.isPaused(), true);
    assert.equal(timeline.getPositionMs(2000000), 15000);
  });
});
