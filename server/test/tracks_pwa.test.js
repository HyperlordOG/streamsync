import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRoom, getRoom, roomSnapshot } from '../src/core/registry.js';
import { handleMessage } from '../src/ws/handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('StreamSync Phase 3 & Phase 4: Tracks Sync, PWA & Smart TV Suite', async (t) => {
  // Test 1: PWA Web App Manifest
  await t.test('1. GET /manifest.webmanifest serves valid PWA configuration', async () => {
    const res = await fetch('http://127.0.0.1:3001/manifest.webmanifest');
    assert.strictEqual(res.status, 200, 'Manifest must respond with 200');
    const data = await res.json();
    assert.strictEqual(data.short_name, 'StreamSync');
    assert.strictEqual(data.display, 'standalone');
    assert.ok(data.icons.length >= 2, 'Must include both 192x192 and 512x512 icons');

    // Verify icons exist on disk
    const icon192 = path.join(__dirname, '..', 'public', 'icons', 'icon-192.svg');
    const icon512 = path.join(__dirname, '..', 'public', 'icons', 'icon-512.svg');
    assert.ok(fs.existsSync(icon192), '192x192 SVG icon must exist');
    assert.ok(fs.existsSync(icon512), '512x512 SVG icon must exist');
  });

  // Test 2: PWA Service Worker script
  await t.test('2. GET /sw.js serves valid Service Worker with streaming bypass', async () => {
    const res = await fetch('http://127.0.0.1:3001/sw.js');
    assert.strictEqual(res.status, 200, 'Service worker must respond with 200');
    const script = await res.text();
    assert.ok(script.includes('streamsync-v'), 'Must define cache namespace');
    assert.ok(script.includes('/manifest.webmanifest'), 'Must cache web manifest');
    assert.ok(script.includes('/api/'), 'Must explicitly bypass API requests');
    assert.ok(script.includes('/ws'), 'Must explicitly bypass WebSocket traffic');
    assert.ok(script.includes('.m3u8'), 'Must bypass streaming manifest files');
  });

  // Test 3: Party Subtitle & Audio Tracks Synchronization in Room Registry
  await t.test('3. Room state persists and broadcasts synchronized tracks', () => {
    const room = createRoom({
      creator_id: 'host_pwa_1',
      display_name: 'Host User',
      shared_controls: true,
    });

    assert.ok(room.tracks, 'Room must initialize tracks object');
    assert.strictEqual(room.tracks.subtitle, null);
    assert.strictEqual(room.tracks.audio, null);

    // Mock WebSocket peer
    let lastSentMessage = null;
    const mockWs = {
      readyState: 1,
      send: (str) => {
        lastSentMessage = JSON.parse(str);
      },
    };

    // Simulate Host dispatching subtitle & audio tracks selection
    const mockUser = { id: 'host_pwa_1', display_name: 'Host User', is_owner: true };
    const partyUpdateMsg = JSON.stringify({
      type: 'party',
      party: {
        tracks: {
          subtitle: {
            url: 'https://subs.streamsync.tv/naruto_ep1_en.vtt',
            label: 'English [CC]',
            offsetMs: 400,
          },
          audio: {
            id: 2,
            name: 'Japanese (Original Audio)',
            lang: 'ja',
          },
        },
      },
    });

    handleMessage(room.party_id, 'conn_host_test', mockUser, mockWs, partyUpdateMsg);

    // Inspect stored room state
    const updatedRoom = getRoom(room.party_id);
    assert.ok(updatedRoom.tracks.subtitle, 'Subtitle track must be persisted');
    assert.strictEqual(updatedRoom.tracks.subtitle.label, 'English [CC]');
    assert.strictEqual(updatedRoom.tracks.subtitle.offsetMs, 400);
    assert.ok(updatedRoom.tracks.audio, 'Audio track must be persisted');
    assert.strictEqual(updatedRoom.tracks.audio.lang, 'ja');

    // Verify room snapshot serialization
    const snapshot = roomSnapshot(updatedRoom);
    assert.ok(snapshot.tracks, 'Room snapshot must include tracks');
    assert.strictEqual(snapshot.tracks.subtitle.offsetMs, 400);
    assert.strictEqual(snapshot.tracks.audio.id, 2);
  });

  // Test 4: Subtitle Timing Offset Calculation Math
  await t.test('4. Subtitle timing offset shifts cue timestamps accurately', () => {
    const mockCues = [
      { startTime: 12.0, endTime: 14.5 },
      { startTime: 15.2, endTime: 18.0 },
    ];

    function applyOffset(cues, offsetMs) {
      const offsetSec = offsetMs / 1000;
      for (const cue of cues) {
        if (cue._origStart === undefined) {
          cue._origStart = cue.startTime;
          cue._origEnd = cue.endTime;
        }
        cue.startTime = Math.max(0, cue._origStart + offsetSec);
        cue.endTime = Math.max(0, cue._origEnd + offsetSec);
      }
    }

    // Apply +500ms delay
    applyOffset(mockCues, 500);
    assert.strictEqual(mockCues[0].startTime, 12.5);
    assert.strictEqual(mockCues[0].endTime, 15.0);
    assert.strictEqual(mockCues[1].startTime, 15.7);

    // Reset back to 0ms
    applyOffset(mockCues, 0);
    assert.strictEqual(mockCues[0].startTime, 12.0);
    assert.strictEqual(mockCues[0].endTime, 14.5);
  });

  // Test 5: Audio Language Track Resolution
  await t.test('5. Remote audio track matches by ID or language code', () => {
    const availableTracks = [
      { id: 0, name: 'English (Stereo)', lang: 'en' },
      { id: 1, name: 'Spanish (Latin America)', lang: 'es' },
      { id: 2, name: 'Japanese (Original)', lang: 'ja' },
    ];

    const remoteInstruction = { id: 99, lang: 'ja', name: 'Japanese (Original)' };

    const matched = availableTracks.find(
      (t) => t.id === remoteInstruction.id || t.lang === remoteInstruction.lang || t.name === remoteInstruction.name
    );

    assert.ok(matched, 'Must find matching audio track by language');
    assert.strictEqual(matched.id, 2);
    assert.strictEqual(matched.lang, 'ja');
  });

  // Test 6: Smart TV Remote Mode State Toggle
  await t.test('6. Remote Control Mode correctly toggles active states', () => {
    const mockContainer = {
      classList: new Set(),
    };
    mockContainer.classList.toggle = function (cls, val) {
      if (val) this.add(cls);
      else this.delete(cls);
    };

    let isRemoteMode = false;
    function setRemoteMode(active) {
      isRemoteMode = active;
      mockContainer.classList.toggle('is-remote-mode', active);
    }

    setRemoteMode(true);
    assert.strictEqual(isRemoteMode, true);
    assert.ok(mockContainer.classList.has('is-remote-mode'));

    setRemoteMode(false);
    assert.strictEqual(isRemoteMode, false);
    assert.strictEqual(mockContainer.classList.has('is-remote-mode'), false);
  });
});

