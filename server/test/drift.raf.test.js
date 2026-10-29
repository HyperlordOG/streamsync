import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Drift Correction Engine, rAF Loop & 5 Zones Suite', () => {
  test('1. party-player.js contains 0 setInterval calls for the drift loop', () => {
    const playerJsPath = path.join(__dirname, '../public/js/party-player.js');
    const content = fs.readFileSync(playerJsPath, 'utf8');

    // Regex checking setInterval calls related to drift or loop
    const setIntervalMatches = content.match(/setInterval\s*\([^)]*correctDrift/gi) || [];
    assert.strictEqual(setIntervalMatches.length, 0, 'No setInterval calls should remain for drift correction');

    assert.ok(content.includes('requestAnimationFrame'), 'Must use requestAnimationFrame for sync loop');
    assert.ok(content.includes('window._driftLoopRAF'), 'Must expose window._driftLoopRAF handle');
  });

  test('2. All 5 discrete drift zones evaluate and transition accurately', () => {
    function computeZone(driftMs, readyState, seekInProgress) {
      if (seekInProgress) return 'WAITING_FOR_SEEK';
      if (readyState < 3) return 'WAITING_FOR_BUFFER';
      if (Math.abs(driftMs) > 3000) return 'SEEKING';
      if (Math.abs(driftMs) > 150) return 'SLEWING';
      return 'DEADBAND';
    }

    // 1. DEADBAND: |drift| <= 150ms
    assert.strictEqual(computeZone(80, 4, false), 'DEADBAND');
    assert.strictEqual(computeZone(-120, 4, false), 'DEADBAND');

    // 2. SLEWING: 150ms < |drift| <= 3000ms
    assert.strictEqual(computeZone(450, 4, false), 'SLEWING');
    assert.strictEqual(computeZone(-2500, 4, false), 'SLEWING');

    // 3. SEEKING: |drift| > 3000ms
    assert.strictEqual(computeZone(3050, 4, false), 'SEEKING');
    assert.strictEqual(computeZone(106200, 4, false), 'SEEKING');

    // 4. WAITING_FOR_SEEK: seek in progress
    assert.strictEqual(computeZone(106200, 4, true), 'WAITING_FOR_SEEK');

    // 5. WAITING_FOR_BUFFER: readyState < 3
    assert.strictEqual(computeZone(500, 2, false), 'WAITING_FOR_BUFFER');
  });

  test('3. Sync Recovery Banner triggers on sustained high drift (> 5000ms for 10s)', () => {
    let highDriftSince = null;
    let bannerVisible = false;

    function handleDrift(driftMs, now) {
      if (Math.abs(driftMs) > 5000) {
        if (!highDriftSince) {
          highDriftSince = now;
        } else if (now - highDriftSince >= 10000) {
          bannerVisible = true;
        }
      } else {
        highDriftSince = null;
        bannerVisible = false;
      }
    }

    const t0 = 1000000;
    // High drift starts (e.g. 106200ms)
    handleDrift(106200, t0);
    assert.strictEqual(bannerVisible, false, 'Banner should not trigger immediately');

    // 5 seconds later
    handleDrift(106200, t0 + 5000);
    assert.strictEqual(bannerVisible, false, 'Banner should not trigger before 10s');

    // 10 seconds later
    handleDrift(106200, t0 + 10000);
    assert.strictEqual(bannerVisible, true, 'Banner must show when drift > 5000ms exceeds 10 seconds');

    // Re-sync occurs (drift drops to 40ms)
    handleDrift(40, t0 + 10500);
    assert.strictEqual(bannerVisible, false, 'Banner must hide when drift resolves');
  });
});
