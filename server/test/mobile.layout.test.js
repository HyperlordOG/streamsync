import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const htmlPath = path.resolve('public/index.html');
const partyPlayerPath = path.resolve('public/js/party-player.js');
const chatRichPath = path.resolve('public/js/chat-rich.js');

test('StreamSync Mobile Viewport & Android Layout Regression Audit', async (t) => {
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const playerContent = fs.readFileSync(partyPlayerPath, 'utf8');
  const chatContent = fs.readFileSync(chatRichPath, 'utf8');

  // Test 1: Viewport meta tag with cover and user-scalable=no
  await t.test('1. Viewport meta includes viewport-fit=cover and maximum-scale=1.0', () => {
    assert.ok(
      htmlContent.includes('<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no">'),
      'Viewport meta tag must contain viewport-fit=cover and user-scalable=no'
    );
  });

  // Test 2: Safe area CSS variables in :root
  await t.test('2. Root contains safe-area CSS environment variables', () => {
    assert.ok(htmlContent.includes('--safe-top: env(safe-area-inset-top, 0px)'), 'Must define --safe-top');
    assert.ok(htmlContent.includes('--safe-bottom: env(safe-area-inset-bottom, 0px)'), 'Must define --safe-bottom');
    assert.ok(htmlContent.includes('--safe-left: env(safe-area-inset-left, 0px)'), 'Must define --safe-left');
    assert.ok(htmlContent.includes('--safe-right: env(safe-area-inset-right, 0px)'), 'Must define --safe-right');
    assert.ok(htmlContent.includes('padding-bottom: max(var(--safe-bottom)'), 'Container must apply --safe-bottom');
  });

  // Test 3: Android Chrome 100dvh / --vh fallback implementation
  await t.test('3. Dynamic viewport height (100dvh / --vh) implemented with JS fallback', () => {
    assert.ok(htmlContent.includes('function setVH()'), 'setVH helper function must be present');
    assert.ok(htmlContent.includes('--vh'), '--vh CSS custom property must be defined and manipulated');
    assert.ok(htmlContent.includes('100dvh'), 'Critical containers must use 100dvh');
    assert.ok(playerContent.includes('100dvh'), 'Pseudo-fullscreen must use 100dvh');
  });

  // Test 4: Minimum 44x44px touch targets
  await t.test('4. All interactive buttons enforce min-width: 44px and min-height: 44px', () => {
    assert.ok(htmlContent.includes('min-width: 44px'), 'Buttons in index.html must have min-width 44px');
    assert.ok(htmlContent.includes('min-height: 44px'), 'Buttons in index.html must have min-height 44px');
    assert.ok(playerContent.includes('min-width: 44px !important'), 'Player controls must have min-width 44px');
    assert.ok(chatContent.includes('min-width: 44px !important'), 'Chat tool buttons must have min-width 44px');
  });

  // Test 5: Grid columns enforce minmax(0, 1fr) preventing Android WebKit overflow
  await t.test('5. Responsive grid definitions eliminate bare 1fr in favor of minmax(0, 1fr)', () => {
    // Check that lobby-view, presets-row, and theater-view do not use bare '1fr 1fr'
    assert.ok(!htmlContent.includes('grid-template-columns: 1fr 1fr;'), 'index.html must not use bare 1fr 1fr');
    assert.ok(!playerContent.includes('grid-template-columns: 1fr 1fr;'), 'party-player.js must not use bare 1fr 1fr');
    assert.ok(htmlContent.includes('minmax(0, 1fr)'), 'index.html must use minmax(0, 1fr)');
    assert.ok(playerContent.includes('minmax(0, 1fr)'), 'party-player.js must use minmax(0, 1fr)');
  });

  // Test 6: Text rendering and font smoothing on Android
  await t.test('6. Body includes text-rendering: optimizeLegibility and font-smoothing', () => {
    assert.ok(htmlContent.includes('text-rendering: optimizeLegibility !important'), 'optimizeLegibility must be active');
    assert.ok(htmlContent.includes('-webkit-font-smoothing: antialiased !important'), 'antialiased smoothing must be active');
  });

  // Test 7: Android Brave / Firefox backdrop-filter fallback
  await t.test('7. Solid background fallback present for browsers lacking backdrop-filter', () => {
    assert.ok(htmlContent.includes('@supports not ((backdrop-filter: blur(1px))'), 'index.html must include @supports not fallback');
    assert.ok(htmlContent.includes('rgba(13, 13, 13, 0.95) !important'), 'Fallback background color must be opaque');
  });
});

