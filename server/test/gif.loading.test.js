import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const chatCodePath = path.resolve('public/js/chat-rich.js');

test('StreamSync GIF Loading, Proxy & Layout Suite', async (t) => {
  const chatCode = fs.readFileSync(chatCodePath, 'utf8');

  // Test 1: GET /api/chat/gif/trending returns normalized array
  await t.test('1. GET /api/chat/gif/trending returns 200 with normalized GIF objects', async () => {
    const res = await fetch('http://127.0.0.1:3001/api/chat/gif/trending?limit=5');
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.ok(Array.isArray(data), 'Trending response must be an array');
    assert.ok(data.length > 0, 'Trending response should not be empty');

    const first = data[0];
    assert.ok(first.id, 'Item must have an id');
    assert.ok(first.url, 'Item must have a url');
    assert.ok(first.preview, 'Item must have a preview');
    assert.ok(typeof first.width === 'number', 'Item must have numeric width');
    assert.ok(typeof first.height === 'number', 'Item must have numeric height');
  });

  // Test 2: GET /api/chat/gif/search returns matching results
  await t.test('2. GET /api/chat/gif/search?q=popcorn returns matching results', async () => {
    const res = await fetch('http://127.0.0.1:3001/api/chat/gif/search?q=popcorn&limit=3');
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.ok(Array.isArray(data), 'Search response must be an array');
    assert.ok(data.length > 0, 'Search response should find matching items');
  });

  // Test 3: GET /api/chat/gif/proxy with verified Tenor media URL returns 200 and image bytes
  await t.test('3. GET /api/chat/gif/proxy streams media with CORS and Cache-Control', async () => {
    const targetUrl = 'https://media.tenor.com/wws9qeD0E74AAAAM/popcorn-guy-extra-butter.gif';
    const proxyUrl = `http://127.0.0.1:3001/api/chat/gif/proxy?url=${encodeURIComponent(targetUrl)}`;

    const res = await fetch(proxyUrl);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(res.headers.get('cache-control')?.includes('max-age=3600'), 'Must include 1h public cache header');
    assert.strictEqual(res.headers.get('content-type'), 'image/gif');

    const buffer = await res.arrayBuffer();
    assert.ok(buffer.byteLength > 10000, 'Must stream binary GIF bytes');
  });

  // Test 4: Proxy rejects untrusted domains with 403
  await t.test('4. GET /api/chat/gif/proxy rejects unapproved external domains with 403', async () => {
    const untrustedUrl = 'https://malicious-site.example.com/exploit.gif';
    const proxyUrl = `http://127.0.0.1:3001/api/chat/gif/proxy?url=${encodeURIComponent(untrustedUrl)}`;

    const res = await fetch(proxyUrl);
    assert.strictEqual(res.status, 403);
  });

  // Test 5: Proxy rejects missing URL with 400
  await t.test('5. GET /api/chat/gif/proxy rejects missing query param with 400', async () => {
    const res = await fetch('http://127.0.0.1:3001/api/chat/gif/proxy');
    assert.strictEqual(res.status, 400);
  });

  // Test 6: Client code renders aspect-ratio: 16/9 and error fallback
  await t.test('6. Chat client enforces 16/9 aspect-ratio and GIFs unavailable fallback', () => {
    assert.ok(chatCode.includes('aspect-ratio: 16/9 !important;'), 'Must enforce 16/9 aspect ratio on gif items');
    assert.ok(chatCode.includes('object-fit: cover !important;'), 'Must enforce object-fit: cover');
    assert.ok(chatCode.includes('GIFs unavailable'), 'Must render GIFs unavailable fallback on error');
  });
});
