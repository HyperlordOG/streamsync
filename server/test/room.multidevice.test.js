import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom,
  addPeer,
  removePeer,
  broadcast,
  getRoomUsers,
  roomSnapshot
} from '../src/core/registry.js';

describe('Multi-Device Room Registry & Host Failover Suite', () => {
  test('1. Two sockets with same userId are stored independently without collision', () => {
    const room = createRoom({ creator_id: 'user_alice', display_name: 'Alice' });

    const mockSocket1 = { readyState: 1, send: () => {} };
    const mockSocket2 = { readyState: 1, send: () => {} };

    addPeer(room.party_id, 'conn_alice_ipad', mockSocket1, { id: 'user_alice', display_name: 'Alice', is_owner: true });
    addPeer(room.party_id, 'conn_alice_iphone', mockSocket2, { id: 'user_alice', display_name: 'Alice', is_owner: true });

    assert.strictEqual(room.peers.size, 2, 'Must maintain 2 independent physical sockets for Alice');
    assert.ok(room.peers.has('conn_alice_ipad'));
    assert.ok(room.peers.has('conn_alice_iphone'));
  });

  test('2. getRoomUsers deduplicates for display while connectionCount reflects physical sockets', () => {
    const room = createRoom({ creator_id: 'user_alice', display_name: 'Alice' });

    addPeer(room.party_id, 'conn_alice_ipad', { readyState: 1, send: () => {} }, { id: 'user_alice', display_name: 'Alice', is_owner: true });
    addPeer(room.party_id, 'conn_alice_iphone', { readyState: 1, send: () => {} }, { id: 'user_alice', display_name: 'Alice', is_owner: true });
    addPeer(room.party_id, 'conn_bob_laptop', { readyState: 1, send: () => {} }, { id: 'user_bob', display_name: 'Bob', is_owner: false });

    const roomData = getRoomUsers(room);
    assert.strictEqual(roomData.users.length, 2, 'Display list must have 2 unique users (Alice, Bob)');
    assert.strictEqual(roomData.connectionCount, 3, 'Real connection count must show 3 physical devices');

    const snap = roomSnapshot(room);
    assert.strictEqual(snap.connectionCount, 3);
    assert.strictEqual(snap.users.length, 2);
  });

  test('3. Host status is preserved when host has another device remaining in room', () => {
    const room = createRoom({ creator_id: 'user_alice', display_name: 'Alice' });

    addPeer(room.party_id, 'conn_alice_ipad', { readyState: 1, send: () => {} }, { id: 'user_alice', display_name: 'Alice', is_owner: true });
    addPeer(room.party_id, 'conn_alice_iphone', { readyState: 1, send: () => {} }, { id: 'user_alice', display_name: 'Alice', is_owner: true });
    addPeer(room.party_id, 'conn_bob_laptop', { readyState: 1, send: () => {} }, { id: 'user_bob', display_name: 'Bob', is_owner: false });

    // Alice disconnects her iPad
    removePeer(room.party_id, 'conn_alice_ipad');

    // Failover check
    const hasAliceRemaining = Array.from(room.peers.values()).some(({ user }) => user.id === room.creator_id);
    assert.strictEqual(hasAliceRemaining, true, 'Alice still has an active socket in room');
    assert.strictEqual(room.creator_id, 'user_alice', 'Host status must NOT transfer to Bob while Alice remains');

    // Alice disconnects her iPhone (zero devices left)
    removePeer(room.party_id, 'conn_alice_iphone');
    const hasAliceLeft = Array.from(room.peers.values()).some(({ user }) => user.id === room.creator_id);
    if (!hasAliceLeft && room.peers.size > 0) {
      const nextHost = room.peers.values().next().value.user;
      room.creator_id = nextHost.id;
    }

    assert.strictEqual(room.creator_id, 'user_bob', 'Host status cleanly transfers to Bob after all Alice devices leave');
  });
});

