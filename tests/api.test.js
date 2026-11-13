'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitida-test-'));
process.env.DB_FILE = path.join(temp, 'database.sqlite');
process.env.NODE_ENV = 'development';
const { server, io, db } = require('../server/index');

const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const shutdown = () => new Promise(resolve => io.close(resolve));

async function request(pathname, method = 'GET', body = null, cookie = '') {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${pathname}`, {
    method, headers: { ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) })
  });
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] || '', data: await response.json() };
}

test('fluxo de conta, convidado, amizades, convites e salas', async t => {
  await listen();
  try {
    const a = await request('/auth/register', 'POST', { username: 'alice', email: 'alice@test.example', password: 'senhasegura2026' });
    const b = await request('/auth/register', 'POST', { username: 'bob', email: 'bob@test.example', password: 'senhasegura2026' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.data.user.username, 'alice');
    const duplicate = await request('/auth/register', 'POST', { username: 'alice', email: 'outro@test.example', password: 'senhasegura2026' });
    assert.equal(duplicate.status, 409);
    const guest = await request('/auth/guest', 'POST', { displayName: 'Visitante 1' });
    assert.equal(guest.status, 201);
    assert.equal(guest.data.user.guest, true);
    const noFriends = await request('/friends', 'GET', null, guest.cookie);
    assert.equal(noFriends.status, 403);

    const friendRequest = await request('/friends/requests', 'POST', { username: 'bob' }, a.cookie);
    assert.equal(friendRequest.status, 201);
    const pending = await request('/friends', 'GET', null, b.cookie);
    assert.equal(pending.data.incoming.length, 1);
    const accepted = await request(`/friends/requests/${pending.data.incoming[0].id}/accept`, 'POST', {}, b.cookie);
    assert.equal(accepted.status, 200);
    const friends = await request('/friends', 'GET', null, a.cookie);
    assert.equal(friends.data.friends.length, 1);
    assert.equal(friends.data.friends[0].username, 'bob');

    const created = await request('/rooms', 'POST', {}, a.cookie);
    assert.equal(created.status, 201);
    const roomId = created.data.room.id;
    const guestCanJoin = await request(`/rooms/${roomId}`, 'GET', null, guest.cookie);
    assert.equal(guestCanJoin.status, 200);
    const invite = await request(`/rooms/${roomId}/invites`, 'POST', { friendId: b.data.user.id }, a.cookie);
    assert.equal(invite.status, 200);
    const inbox = await request('/friends', 'GET', null, b.cookie);
    assert.equal(inbox.data.invitations[0].roomId, roomId);
    const closed = await request(`/rooms/${roomId}`, 'DELETE', null, a.cookie);
    assert.equal(closed.status, 200);
    const missing = await request(`/rooms/${roomId}`, 'GET', null, b.cookie);
    assert.equal(missing.status, 404);
    const invalidLogin = await request('/auth/login', 'POST', { identity: 'bob', password: 'senhaerrada' });
    assert.equal(invalidLogin.status, 401);
  } finally {
    await shutdown();
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
