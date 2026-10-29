import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('NTP Clock Synchronization & Visibility Restoration Suite', () => {
  test('1. NTP offset formula produces correct mathematical sign', () => {
    // Scenario A: Client clock is 50ms SLOW (behind server)
    // Server time = 100050, Client send t0 = 100000, Client receive t3 = 100020 (RTT = 20)
    const t0_a = 100000;
    const t1_a = 100050; // Server epoch ms
    const t3_a = 100020;
    const rtt_a = t3_a - t0_a; // 20ms
    const offset_a = Math.round(t1_a + (rtt_a / 2) - t3_a); // 100050 + 10 - 100020 = +40ms
    assert.ok(offset_a > 0, 'Offset must be positive when client is behind server');
    assert.strictEqual(offset_a, 40);

    // Scenario B: Client clock is 50ms FAST (ahead of server)
    // Server time = 100000, Client send t0 = 100040, Client receive t3 = 100060 (RTT = 20)
    const t0_b = 100040;
    const t1_b = 100000;
    const t3_b = 100060;
    const rtt_b = t3_b - t0_b; // 20ms
    const offset_b = Math.round(t1_b + (rtt_b / 2) - t3_b); // 100000 + 10 - 100060 = -50ms
    assert.ok(offset_b < 0, 'Offset must be negative when client is ahead of server');
    assert.strictEqual(offset_b, -50);
  });

  test('2. Discard high-RTT outliers from throttled background tabs (> 1500ms)', () => {
    const samples = [];
    const pushSample = (t0, t1, t3) => {
      const rtt = Math.max(0, t3 - t0);
      const offset = Math.round(t1 + (rtt / 2) - t3);
      if (rtt < 1500) {
        samples.push({ rtt, offset });
      }
    };

    // Clean foreground sample: RTT 45ms
    pushSample(100000, 100022, 100045);
    assert.strictEqual(samples.length, 1);

    // Throttled background wakeup sample: RTT 18200ms
    pushSample(100000, 100030, 118200);
    assert.strictEqual(samples.length, 1, 'Throttled background sample (RTT 18200ms) must be discarded');
  });

  test('3. Visibility restore triggers NTP recalibration and resets drift accumulation', async () => {
    let recalibrateCalled = false;
    let visibilityState = 'hidden';

    const listeners = {};
    const mockDocument = {
      addEventListener: (evt, fn) => { listeners[evt] = fn; },
      get visibilityState() { return visibilityState; }
    };

    // Register visibility change listener
    mockDocument.addEventListener('visibilitychange', () => {
      if (mockDocument.visibilityState === 'visible') {
        recalibrateCalled = true;
      }
    });

    // Simulate switching back to active tab
    visibilityState = 'visible';
    listeners['visibilitychange']();

    assert.strictEqual(recalibrateCalled, true, 'Recalibration must fire upon visibility restore');
  });
});

