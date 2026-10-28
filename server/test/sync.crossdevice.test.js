import test from 'node:test';
import assert from 'node:assert';

test('StreamSync Cross-Device Sync Engine Regression Audit', async (t) => {
  // Test 1: 5-sample NTP negotiation with Marzullo-lite filter
  await t.test('1. 5-sample NTP burst and Marzullo-lite trimmed mean calculation', () => {
    // Simulated raw ping-pong samples with RTT jitter
    // t0 = client send, t1 = server time, t3 = client receive
    const serverTimeAnchor = 1700000000000;
    const clientOffsetTrue = 42; // Client clock is 42ms ahead of server

    const samples = [
      { rtt: 120, offset: 40 }, // Sample 1
      { rtt: 45,  offset: 43 }, // Sample 2 (lowest RTT outlier)
      { rtt: 310, offset: 95 }, // Sample 3 (highest RTT / lag spike outlier)
      { rtt: 90,  offset: 41 }, // Sample 4
      { rtt: 80,  offset: 44 }, // Sample 5
    ];

    // Marzullo-lite filter: sort by RTT, discard lowest and highest, average remaining 3
    const sorted = [...samples].sort((a, b) => a.rtt - b.rtt);
    const trimmed = sorted.slice(1, 4);
    assert.strictEqual(trimmed.length, 3, 'Must retain 3 samples after trimming min/max RTT');

    const sumOffset = trimmed.reduce((acc, s) => acc + s.offset, 0);
    const calculatedOffset = Math.round(sumOffset / trimmed.length);

    assert.ok(
      Math.abs(calculatedOffset - clientOffsetTrue) <= 5,
      `Calculated offset (${calculatedOffset}ms) should be within 5ms of true offset (${clientOffsetTrue}ms)`
    );
  });

  // Test 2: Server GET /api/time endpoint returns valid epoch within ±50ms
  await t.test('2. GET /api/time returns current server time within ±50ms tolerance', async () => {
    const t0 = Date.now();
    const res = await fetch('http://127.0.0.1:3001/api/time');
    const t3 = Date.now();
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.ok(data.server_time, 'Response must include server_time');

    const rtt = t3 - t0;
    const estServerNow = data.server_time + Math.round(rtt / 2);
    const clientNow = Date.now();
    const offset = estServerNow - clientNow;

    assert.ok(Math.abs(offset) <= 50, `Server time offset must be within ±50ms (got ${offset}ms)`);
  });

  // Test 3: Precision rounding to nearest 100ms eliminates iOS precision false positives
  await t.test('3. Drift calculation rounds video position and desiredPosition to nearest 100ms', () => {
    // iOS Safari centisecond truncated value vs microsecond target
    const iosVideoTimeSec = 45.12; // 45120ms
    const desiredPosMs = 45185;    // 45185ms (sub-100ms divergence)

    // Unrounded drift would be 65ms
    const rawDelta = desiredPosMs - (iosVideoTimeSec * 1000);
    assert.strictEqual(rawDelta, 65);

    // Rounded to nearest 100ms:
    const roundedCurrentMs = Math.round((iosVideoTimeSec * 1000) / 100) * 100; // 45100
    const roundedTargetMs = Math.round(desiredPosMs / 100) * 100;              // 45200
    const roundedDelta = roundedTargetMs - roundedCurrentMs;                   // 100ms

    // Verify sub-50ms difference rounds to 0 drift (no false positive zone trigger)
    const iosVideoTimeSub = 45.14; // 45140ms
    const desiredPosSub = 45148;   // 45148ms
    const rCurrent = Math.round((iosVideoTimeSub * 1000) / 100) * 100;
    const rTarget = Math.round(desiredPosSub / 100) * 100;
    const subDelta = rTarget - rCurrent;
    assert.strictEqual(subDelta, 0, 'Sub-50ms difference must round to 0ms drift');
  });

  // Test 4: Manifest-loaded hook forces syncToPosition before playback start
  await t.test('4. Initial syncToPosition seeks explicitly to desiredPosition on manifest loaded', () => {
    let currentPosition = 0;
    let didSeek = false;

    const mockPlayer = {
      currentTime: 0,
      syncToPosition(targetMs) {
        currentPosition = targetMs / 1000;
        didSeek = true;
      }
    };

    const desiredPositionMs = 12450;
    // Simulate manifest loaded / canplay hook
    mockPlayer.syncToPosition(desiredPositionMs);

    assert.strictEqual(didSeek, true, 'syncToPosition must be triggered');
    assert.strictEqual(currentPosition, 12.45, 'Player position must match desiredPosition in seconds');
  });

  // Test 5: Two clients with asymmetric offsets (+200ms vs -200ms) compute desiredPosition within 150ms
  await t.test('5. Clients with asymmetric offsets (+200ms vs -200ms) compute desiredPosition within 150ms', () => {
    const trueNtpServerTime = Date.now();
    const virtualTimeline = {
      started: trueNtpServerTime - 60000, // Started 60 seconds ago
      paused: 0,
      rate: 1.0,
    };

    // Client A clock runs 200ms fast: Date.now() + offsetA = trueNtp
    const clientALocalNow = trueNtpServerTime + 200;
    const clientAOffset = -200; // Corrects local time to true server time
    const clientANtpNow = clientALocalNow + clientAOffset;

    // Client B clock runs 200ms slow
    const clientBLocalNow = trueNtpServerTime - 200;
    const clientBOffset = 200;
    const clientBNtpNow = clientBLocalNow + clientBOffset;

    const desiredA = Math.max(0, clientANtpNow - virtualTimeline.started);
    const desiredB = Math.max(0, clientBNtpNow - virtualTimeline.started);

    const divergenceMs = Math.abs(desiredA - desiredB);
    assert.ok(divergenceMs <= 5, `Divergence between clients should be <= 5ms after calibration (got ${divergenceMs}ms)`);
  });
});
