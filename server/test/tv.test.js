import test from 'node:test';
import assert from 'node:assert';

test('TV Series Season & Episodes Route', async () => {
  const res = await fetch('http://127.0.0.1:3001/api/media/tv/1396');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.title, 'Breaking Bad');
  assert.ok(data.seasons.length >= 5, 'Must have at least 5 seasons');
  
  const s1Res = await fetch('http://127.0.0.1:3001/api/media/tv/1396/season/1');
  assert.strictEqual(s1Res.status, 200);
  const s1 = await s1Res.json();
  assert.strictEqual(s1.seasonNumber, 1);
  assert.strictEqual(s1.episodes.length, 7);
  assert.strictEqual(s1.episodes[0].name, 'Pilot');
  assert.strictEqual(s1.episodes[1].name, "Cat's in the Bag...");

  const s2Res = await fetch('http://127.0.0.1:3001/api/media/tv/1396/season/2');
  assert.strictEqual(s2Res.status, 200);
  const s2 = await s2Res.json();
  assert.strictEqual(s2.seasonNumber, 2);
  assert.strictEqual(s2.episodes.length, 13);
  assert.strictEqual(s2.episodes[0].name, 'Seven Thirty-Seven');

  console.log('✓ TV Series & Season/Episodes Route verification test PASSED cleanly!');
});
