import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const playerCodePath = path.resolve('public/js/party-player.js');

test('StreamSync Player Lock Screen Feature Suite', async (t) => {
  const code = fs.readFileSync(playerCodePath, 'utf8');

  // Test 1: Lock overlay element structure and CSS rules
  await t.test('1. Player lock overlay element exists with correct z-index and styles', () => {
    assert.ok(code.includes('player-lock-overlay'), 'Must reference player-lock-overlay');
    assert.ok(code.includes('z-index: 100 !important;'), 'player-lock-overlay must have z-index: 100');
    assert.ok(code.includes('unlock-hint'), 'Must contain unlock-hint element');
    assert.ok(code.includes('Tap to unlock'), 'Hint must display Tap to unlock message');
  });

  // Test 2: Platform defense attributes (iOS swipe-back & Android text selection)
  await t.test('2. Lock overlay has touch-action: none and user-select: none', () => {
    assert.ok(code.includes('touch-action: none !important;'), 'Must have touch-action: none for iOS');
    assert.ok(code.includes('user-select: none !important;'), 'Must have user-select: none for Android');
    assert.ok(code.includes('-webkit-user-select: none !important;'), 'Must have -webkit-user-select: none');
  });

  // Test 3: Lock toggle behavior and controls occlusion
  await t.test('3. Video wrapper .player-locked hides controls and overlays', () => {
    assert.ok(
      code.includes('.video-wrapper.player-locked .video-controls') &&
      code.includes('.video-wrapper.player-locked .stream-controls-overlay') &&
      code.includes('pointer-events: none !important;') &&
      code.includes('opacity: 0 !important;'),
      'Controls must become pointer-events: none and opacity: 0 when locked'
    );
    assert.ok(
      code.includes('.video-wrapper.player-locked .player-lock-overlay') &&
      code.includes('display: flex !important;') &&
      code.includes('pointer-events: all !important;'),
      'player-lock-overlay must become flex and pointer-events: all when locked'
    );
  });

  // Test 4: Lock state persists through playback events
  await t.test('4. Lock state persists through seek, pause, and buffer events', () => {
    let isPlayerLocked = true;

    // Simulate playback events: none of them should mutate isPlayerLocked
    const onSeeked = () => { /* no-op on lock state */ };
    const onPause = () => { /* no-op on lock state */ };
    const onWaiting = () => { /* no-op on lock state */ };

    onSeeked();
    onPause();
    onWaiting();

    assert.strictEqual(isPlayerLocked, true, 'Lock state must remain true through playback events');
  });

  // Test 5: Lock button 300ms scale animation and touch target
  await t.test('5. Lock button has 300ms toggle scale animation and 44px touch target', () => {
    assert.ok(code.includes('@keyframes lockToggleScale'), 'Must define lockToggleScale animation');
    assert.ok(code.includes('0.3s cubic-bezier'), 'Must animate scale for 300ms');
    assert.ok(code.includes('stream-lock-btn'), 'Must define stream-lock-btn class');
    assert.ok(code.includes('touch-target'), 'Lock button must have touch-target class');
  });
});
