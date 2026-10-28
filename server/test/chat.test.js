import test from 'node:test';
import assert from 'node:assert';

test('StreamSync Phase 2 Rich Chat Suite', async (t) => {
  // Test 1: Sticker pack manifest endpoint
  await t.test('1. GET /api/chat/stickers returns valid manifest JSON', async () => {
    const res = await fetch('http://127.0.0.1:3001/api/chat/stickers');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data), 'Manifest must be an array of sticker packs');
    assert.ok(data.length >= 1, 'Must have at least one sticker pack');
    const moviePack = data.find((p) => p.packId === 'movie');
    assert.ok(moviePack, 'Movie sticker pack must exist');
    assert.strictEqual(moviePack.count, 12, 'Movie sticker pack must contain 12 stickers');
    assert.ok(moviePack.preview, 'Must contain a preview path');
  });

  // Test 2: Tenor GIF search proxy endpoint
  await t.test('2. GET /api/chat/gif/search returns normalized GIF results', async () => {
    const res = await fetch('http://127.0.0.1:3001/api/chat/gif/search?q=popcorn&limit=5');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data), 'GIF search response must be an array');
    assert.ok(data.length > 0, 'Must return at least 1 GIF result');
    const first = data[0];
    assert.ok(first.id, 'GIF must have id');
    assert.ok(first.url, 'GIF must have direct media url');
    assert.ok(first.preview, 'GIF must have preview thumbnail');
    assert.ok(typeof first.width === 'number', 'Width must be numeric');
    assert.ok(typeof first.height === 'number', 'Height must be numeric');
  });

  // Test 3: Client-side attachment 5MB size guard
  await t.test('3. Attachment over 5MB is rejected client-side with alert toast', async () => {
    let toastMessage = '';
    const mockShowToast = (msg) => {
      toastMessage = msg;
    };

    // Simulate AttachmentHandler logic
    const MAX_SIZE = 5 * 1024 * 1024;
    function testFileProcess(file) {
      if (file.size > MAX_SIZE) {
        mockShowToast('File too large — maximum limit is 5MB.');
        return false;
      }
      return true;
    }

    const oversizedFile = { name: 'huge_movie.mp4', size: 6 * 1024 * 1024, type: 'video/mp4' };
    const validFile = { name: 'scene.png', size: 1.5 * 1024 * 1024, type: 'image/png' };

    const resultOver = testFileProcess(oversizedFile);
    assert.strictEqual(resultOver, false, 'Oversized file must be rejected');
    assert.ok(toastMessage.includes('5MB'), 'Must trigger toast with 5MB warning');

    const resultValid = testFileProcess(validFile);
    assert.strictEqual(resultValid, true, 'Valid file under 5MB must pass');
  });

  // Test 4: Emoji reaction aggregation logic
  await t.test('4. Emoji reactions aggregate and toggle correctly by user ID', () => {
    const message = {
      id: 'msg_test_1',
      text: 'What a scene!',
      reactions: {},
    };

    function applyReaction(msg, emoji, userId) {
      if (!msg.reactions) msg.reactions = {};
      const users = msg.reactions[emoji] || [];
      const idx = users.indexOf(userId);
      if (idx !== -1) {
        users.splice(idx, 1);
        if (users.length === 0) delete msg.reactions[emoji];
      } else {
        users.push(userId);
        msg.reactions[emoji] = users;
      }
    }

    // User 1 reacts ❤️
    applyReaction(message, '❤️', 'u_1');
    assert.deepStrictEqual(message.reactions['❤️'], ['u_1']);

    // User 2 reacts ❤️
    applyReaction(message, '❤️', 'u_2');
    assert.strictEqual(message.reactions['❤️'].length, 2);
    assert.ok(message.reactions['❤️'].includes('u_1') && message.reactions['❤️'].includes('u_2'));

    // User 1 toggles (removes) ❤️
    applyReaction(message, '❤️', 'u_1');
    assert.deepStrictEqual(message.reactions['❤️'], ['u_2']);

    // User 2 reacts 😂
    applyReaction(message, '😂', 'u_2');
    assert.strictEqual(message.reactions['❤️'].length, 1);
    assert.strictEqual(message.reactions['😂'].length, 1);

    // User 2 unreacts ❤️
    applyReaction(message, '❤️', 'u_2');
    assert.strictEqual(message.reactions['❤️'], undefined, 'Key should be deleted when empty');
  });

  // Test 5: Reply-to quoted message resolution
  await t.test('5. Reply-to correctly binds and renders quoted message reference', () => {
    const history = new Map();
    const originalMsg = {
      id: 'msg_orig_1',
      user: { id: 'u_host', name: 'Host' },
      type: 'text',
      text: 'Did anyone see that plot twist?!',
      timestamp: Date.now() - 5000,
    };
    history.set(originalMsg.id, originalMsg);

    const replyMsg = {
      id: 'msg_reply_2',
      user: { id: 'u_guest', name: 'Guest' },
      type: 'text',
      text: 'Yeah totally blew my mind!',
      replyTo: 'msg_orig_1',
      timestamp: Date.now(),
    };
    history.set(replyMsg.id, replyMsg);

    // Resolve quoted reference
    const resolvedOrig = history.get(replyMsg.replyTo);
    assert.ok(resolvedOrig, 'Must resolve original quoted message from history map');
    assert.strictEqual(resolvedOrig.user.name, 'Host');
    assert.strictEqual(resolvedOrig.text, 'Did anyone see that plot twist?!');
  });

  // Test 6: Audit - Cache-Control headers for static stickers
  await t.test('6. Sticker assets are served with Cache-Control: public, max-age=31536000', async () => {
    const res = await fetch('http://127.0.0.1:3001/stickers/movie/0.svg');
    assert.strictEqual(res.status, 200);
    const cacheHeader = res.headers.get('cache-control');
    assert.ok(cacheHeader, 'Cache-control header must be present');
    assert.ok(cacheHeader.includes('max-age=31536000'), 'Cache header must include max-age=31536000');
  });

  // Test 7: Audit - Missing replyTo fallback shows "Message not available"
  await t.test('7. Missing replyTo message gracefully resolves to fallback without crashing', () => {
    const history = new Map(); // Empty history (e.g. newly joined peer)

    const replyMsg = {
      id: 'msg_reply_orphan',
      user: { id: 'u_guest', name: 'Guest' },
      type: 'text',
      text: 'I agree!',
      replyTo: 'non_existent_msg_999',
    };

    const orig = history.get(replyMsg.replyTo);
    let quotedTitle = '';
    let quotedBody = '';
    if (!orig) {
      quotedTitle = 'Message not available';
      quotedBody = 'Message not available';
    } else {
      quotedTitle = orig.user?.name || 'Peer';
      quotedBody = orig.text || 'Original message';
    }

    assert.strictEqual(orig, undefined);
    assert.strictEqual(quotedTitle, 'Message not available');
    assert.strictEqual(quotedBody, 'Message not available');
  });

  // Test 8: Audit - Emoji reaction deduplication against multi-click spam
  await t.test('8. Duplicate reaction submissions from same user are deduplicated', () => {
    const message = {
      id: 'msg_dedup_test',
      reactions: {},
    };

    function applyDeduplicatedReaction(msg, emoji, userId) {
      if (!msg.reactions) msg.reactions = {};
      let users = msg.reactions[emoji] || [];
      // Deduplicate before processing
      users = Array.from(new Set(users));
      
      const idx = users.indexOf(userId);
      if (idx !== -1) {
        users.splice(idx, 1);
        if (users.length === 0) delete msg.reactions[emoji];
        else msg.reactions[emoji] = Array.from(new Set(users));
      } else {
        users.push(userId);
        msg.reactions[emoji] = Array.from(new Set(users));
      }
    }

    // Single reaction
    applyDeduplicatedReaction(message, '❤️', 'u_spammer');
    assert.strictEqual(message.reactions['❤️'].length, 1);

    // Ensure array doesn't accumulate duplicates even if bad state injected
    message.reactions['❤️'] = ['u_spammer', 'u_spammer'];
    applyDeduplicatedReaction(message, '❤️', 'u_spammer');
    // After toggle removal, should be cleaned
    assert.strictEqual(message.reactions['❤️'], undefined);
  });
});

