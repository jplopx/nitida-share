'use strict';
require('dotenv').config();
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Server } = require('socket.io');
const { db, cleanupExpired } = require('./db');

const scrypt = promisify(crypto.scrypt);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024, transports: ['websocket', 'polling'] });
const PORT = Number(process.env.PORT) || 3000;
const MAX_PEOPLE = Math.min(12, Math.max(2, Number(process.env.MAX_ROOM_PARTICIPANTS) || 4));
const SESSION_AGE = 30 * 86400000;
const ROOM_AGE = 24 * 3600000;
const production = process.env.NODE_ENV === 'production';
const online = new Map(); // userId => Set(socketId)
const occupants = new Map(); // roomId => Map(socketId, {id, displayName})
const sharers = new Map(); // roomId => socketId

app.set('trust proxy', production ? 1 : false);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'ws:', 'wss:'],
      mediaSrc: ["'self'", 'blob:'], objectSrc: ["'none'"],
      frameAncestors: ["'none'"], upgradeInsecureRequests: production ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '24kb' }));

function getCookies(header = '') {
  return Object.fromEntries(header.split(';').map(x => x.trim()).filter(Boolean).map(pair => {
    const n = pair.indexOf('=');
    if (n === -1) return [pair, ''];
    try { return [pair.slice(0, n), decodeURIComponent(pair.slice(n + 1))]; }
    catch { return [pair.slice(0, n), '']; }
  }));
}
function tokenDigest(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function getUser(req) {
  const token = getCookies(req.headers.cookie).nitida_sid;
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return null;
  return db.prepare(`SELECT u.id, u.username, u.display_name AS displayName, u.email, u.is_guest AS guest
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(tokenDigest(token), Date.now()) || null;
}
function publicUser(u) {
  return { id: u.id, username: u.guest ? null : u.username, displayName: u.displayName, guest: !!u.guest };
}
function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(tokenDigest(token), userId, now + SESSION_AGE, now);
  res.setHeader('Set-Cookie', `nitida_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_AGE / 1000)}${production ? '; Secure' : ''}`);
}
function clearSession(req, res) {
  const token = getCookies(req.headers.cookie).nitida_sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenDigest(token));
  res.setHeader('Set-Cookie', `nitida_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${production ? '; Secure' : ''}`);
}
function error(res, code, message) { return res.status(code).json({ error: message }); }
function auth(req, res, next) {
  req.user = getUser(req);
  if (!req.user) return error(res, 401, 'Entre na sua conta ou como convidado.');
  next();
}
function account(req, res, next) {
  if (req.user.guest) return error(res, 403, 'Amizades exigem conta cadastrada.');
  next();
}
const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
function usersAreFriends(a, b) {
  const [u1, u2] = [a, b].sort();
  return !!db.prepare('SELECT 1 FROM friendships WHERE user_a=? AND user_b=?').get(u1, u2);
}
function userSocketRoom(userId) { return `user:${userId}`; }
function roomSocketRoom(roomId) { return `room:${roomId}`; }
function refreshUsers(...ids) {
  [...new Set(ids)].forEach(id => io.to(userSocketRoom(id)).emit('data:refresh'));
}
function allFriendIds(userId) {
  return db.prepare(`SELECT CASE WHEN user_a=? THEN user_b ELSE user_a END AS id
    FROM friendships WHERE user_a=? OR user_b=?`).all(userId, userId, userId).map(x => x.id);
}
function refreshFriendPresence(userId) {
  allFriendIds(userId).forEach(id => io.to(userSocketRoom(id)).emit('data:refresh'));
}
function roomFromId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{22}$/.test(id)) return null;
  return db.prepare('SELECT id, creator_id AS creatorId, expires_at AS expiresAt FROM rooms WHERE id=? AND expires_at>?')
    .get(id, Date.now()) || null;
}
function emitPresence(roomId) {
  const people = [...(occupants.get(roomId)?.entries() || [])].map(([socketId, u]) => ({ socketId, ...u }));
  io.to(roomSocketRoom(roomId)).emit('room:presence', people);
}
function safeSocketAck(ack, value) { if (typeof ack === 'function') ack(value); }

// Protege rotas que alteram estado contra chamadas entre origens com cookies.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    const allowed = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== allowed) return error(res, 403, 'Origem não autorizada.');
  }
  next();
});
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 35, standardHeaders: 'draft-7', legacyHeaders: false });
const socialLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 45, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api/auth', authLimiter);
app.use('/api/friends/requests', socialLimiter);

app.get('/api/me', (req, res) => {
  const user = getUser(req);
  res.json({ user: user ? publicUser(user) : null });
});
app.get('/api/config', (req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL.split(',').map(v => v.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
  }
  res.json({ iceServers, maxParticipants: MAX_PEOPLE, hasTurn: !!process.env.TURN_URL });
});
app.post('/api/auth/register', wrap(async (req, res) => {
  const { username, email, password } = req.body || {};
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,20}$/.test(username))
    return error(res, 400, 'Usuário: 3–20 caracteres, letras, números, ponto, traço ou _.');
  if (typeof email !== 'string' || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return error(res, 400, 'Digite um e-mail válido.');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128)
    return error(res, 400, 'Senha deve ter de 8 a 128 caracteres.');
  const normalized = username.toLowerCase();
  const cleanEmail = email.toLowerCase().trim();
  if (db.prepare('SELECT 1 FROM users WHERE username=? OR email=?').get(normalized, cleanEmail))
    return error(res, 409, 'Usuário ou e-mail já está cadastrado.');
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  const id = crypto.randomUUID();
  try {
    db.prepare(`INSERT INTO users(id,username,display_name,email,password_hash,is_guest,created_at) VALUES(?,?,?,?,?,0,?)`)
      .run(id, normalized, username, cleanEmail, `${salt}:${derived.toString('hex')}`, Date.now());
  } catch (e) { if (e.code?.startsWith('SQLITE_CONSTRAINT')) return error(res, 409, 'Usuário ou e-mail já existe.'); throw e; }
  setSession(res, id);
  res.status(201).json({ user: publicUser(getUser({ headers: { cookie: res.getHeader('Set-Cookie') } })) });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const identity = typeof req.body?.identity === 'string' ? req.body.identity.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!identity || typeof password !== 'string') return error(res, 400, 'Informe usuário/e-mail e senha.');
  const user = db.prepare('SELECT * FROM users WHERE (username=? OR email=?) AND is_guest=0').get(identity, identity);
  if (!user) return error(res, 401, 'Credenciais inválidas.');
  const [salt, expectedHex] = user.password_hash.split(':');
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== derived.length || !crypto.timingSafeEqual(expected, derived))
    return error(res, 401, 'Credenciais inválidas.');
  setSession(res, user.id);
  res.json({ user: publicUser({ ...user, displayName: user.display_name, guest: 0 }) });
}));
app.post('/api/auth/guest', (req, res) => {
  let displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
  if (displayName.length > 26) return error(res, 400, 'Nome do convidado deve ter até 26 caracteres.');
  const id = crypto.randomUUID();
  const short = crypto.randomBytes(3).toString('hex');
  if (!displayName) displayName = `Convidado ${short.slice(0, 4).toUpperCase()}`;
  db.prepare('INSERT INTO users(id,username,display_name,is_guest,created_at) VALUES(?,?,?,?,?)')
    .run(id, `guest_${short}_${crypto.randomBytes(4).toString('hex')}`, displayName, 1, Date.now());
  setSession(res, id);
  res.status(201).json({ user: { id, username: null, displayName, guest: true } });
});
app.post('/api/auth/logout', auth, (req, res) => {
  clearSession(req, res);
  io.in(userSocketRoom(req.user.id)).disconnectSockets(true);
  res.json({ ok: true });
});

app.get('/api/friends', auth, account, (req, res) => {
  const id = req.user.id;
  const friends = db.prepare(`SELECT u.id, u.username, u.display_name AS displayName
    FROM friendships f JOIN users u ON u.id=(CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END)
    WHERE f.user_a=? OR f.user_b=? ORDER BY u.display_name COLLATE NOCASE`).all(id, id, id);
  const incoming = db.prepare(`SELECT r.id, u.id AS userId, u.username, u.display_name AS displayName
    FROM friend_requests r JOIN users u ON u.id=r.sender_id WHERE r.recipient_id=? ORDER BY r.created_at DESC`).all(id);
  const outgoing = db.prepare(`SELECT r.id, u.username, u.display_name AS displayName
    FROM friend_requests r JOIN users u ON u.id=r.recipient_id WHERE r.sender_id=? ORDER BY r.created_at DESC`).all(id);
  const invitations = db.prepare(`SELECT i.id, i.room_id AS roomId, u.display_name AS fromName,
    i.created_at AS createdAt FROM room_invites i
    JOIN users u ON u.id=i.sender_id JOIN rooms r ON r.id=i.room_id
    WHERE i.recipient_id=? AND r.expires_at>? ORDER BY i.created_at DESC`).all(id, Date.now());
  res.json({ friends: friends.map(f => ({ ...f, online: !!online.get(f.id)?.size })), incoming, outgoing, invitations });
});
app.post('/api/friends/requests', auth, account, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!username) return error(res, 400, 'Digite o nome de usuário.');
  const other = db.prepare('SELECT id, is_guest FROM users WHERE username=?').get(username);
  if (!other || other.is_guest) return error(res, 404, 'Usuário não encontrado.');
  if (other.id === req.user.id) return error(res, 400, 'Você não pode adicionar a si mesmo.');
  if (usersAreFriends(req.user.id, other.id)) return error(res, 409, 'Vocês já são amigos.');
  if (db.prepare(`SELECT 1 FROM friend_requests WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)`)
    .get(req.user.id, other.id, other.id, req.user.id)) return error(res, 409, 'Já existe um pedido entre vocês.');
  db.prepare('INSERT INTO friend_requests(sender_id,recipient_id,created_at) VALUES(?,?,?)')
    .run(req.user.id, other.id, Date.now());
  refreshUsers(other.id, req.user.id);
  res.status(201).json({ ok: true });
});
app.post('/api/friends/requests/:id/accept', auth, account, (req, res) => {
  const request = db.prepare('SELECT * FROM friend_requests WHERE id=? AND recipient_id=?').get(req.params.id, req.user.id);
  if (!request) return error(res, 404, 'Pedido não encontrado.');
  db.transaction(() => {
    const [a, b] = [request.sender_id, request.recipient_id].sort();
    db.prepare('INSERT OR IGNORE INTO friendships(user_a,user_b,created_at) VALUES(?,?,?)').run(a, b, Date.now());
    db.prepare('DELETE FROM friend_requests WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)')
      .run(a, b, b, a);
  })();
  refreshUsers(request.sender_id, request.recipient_id);
  res.json({ ok: true });
});
app.post('/api/friends/requests/:id/decline', auth, account, (req, res) => {
  const request = db.prepare('SELECT * FROM friend_requests WHERE id=? AND (sender_id=? OR recipient_id=?)')
    .get(req.params.id, req.user.id, req.user.id);
  if (!request) return error(res, 404, 'Pedido não encontrado.');
  db.prepare('DELETE FROM friend_requests WHERE id=?').run(request.id);
  refreshUsers(request.sender_id, request.recipient_id);
  res.json({ ok: true });
});
app.delete('/api/friends/:id', auth, account, (req, res) => {
  const [a, b] = [req.user.id, req.params.id].sort();
  const result = db.prepare('DELETE FROM friendships WHERE user_a=? AND user_b=?').run(a, b);
  if (!result.changes) return error(res, 404, 'Amizade não encontrada.');
  refreshUsers(a, b);
  res.json({ ok: true });
});

app.post('/api/rooms', auth, (req, res) => {
  const id = crypto.randomBytes(16).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO rooms(id,creator_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(id, req.user.id, now, now + ROOM_AGE);
  res.status(201).json({ room: { id, creatorId: req.user.id, expiresAt: now + ROOM_AGE } });
});
app.get('/api/rooms/:id', auth, (req, res) => {
  const room = roomFromId(req.params.id);
  if (!room) return error(res, 404, 'Sala não encontrada ou expirada.');
  res.json({ room });
});
app.post('/api/rooms/:id/invites', auth, account, (req, res) => {
  const room = roomFromId(req.params.id);
  if (!room) return error(res, 404, 'Sala não encontrada ou expirada.');
  // O remetente precisa estar na sala (ou ser seu criador).
  const isInRoom = [...(occupants.get(room.id)?.values() || [])].some(u => u.id === req.user.id);
  if (!isInRoom && room.creatorId !== req.user.id) return error(res, 403, 'Entre na sala antes de convidar.');
  const friendId = req.body?.friendId;
  if (typeof friendId !== 'string' || !usersAreFriends(req.user.id, friendId))
    return error(res, 403, 'Convite permitido somente para amigos.');
  db.prepare('INSERT OR IGNORE INTO room_invites(room_id,sender_id,recipient_id,created_at) VALUES(?,?,?,?)')
    .run(room.id, req.user.id, friendId, Date.now());
  refreshUsers(friendId);
  res.json({ ok: true });
});
app.delete('/api/invites/:id', auth, account, (req, res) => {
  db.prepare('DELETE FROM room_invites WHERE id=? AND recipient_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/rooms/:id', auth, (req, res) => {
  const room = roomFromId(req.params.id);
  if (!room) return error(res, 404, 'Sala não encontrada ou expirada.');
  if (room.creatorId !== req.user.id) return error(res, 403, 'Apenas quem criou pode encerrar a sala.');
  io.to(roomSocketRoom(room.id)).emit('room:closed');
  io.in(roomSocketRoom(room.id)).socketsLeave(roomSocketRoom(room.id));
  for (const socket of io.sockets.sockets.values()) if (socket.data.roomId === room.id) socket.data.roomId = null;
  occupants.delete(room.id);
  sharers.delete(room.id);
  const invited = db.prepare('SELECT recipient_id FROM room_invites WHERE room_id=?').all(room.id).map(x => x.recipient_id);
  db.prepare('DELETE FROM rooms WHERE id=?').run(room.id);
  refreshUsers(...invited);
  res.json({ ok: true });
});

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  if (sharers.get(roomId) === socket.id) {
    sharers.delete(roomId);
    io.to(roomSocketRoom(roomId)).emit('share:stopped', { socketId: socket.id });
  }
  socket.leave(roomSocketRoom(roomId));
  const members = occupants.get(roomId);
  members?.delete(socket.id);
  if (members && !members.size) occupants.delete(roomId);
  socket.data.roomId = null;
  io.to(roomSocketRoom(roomId)).emit('peer:left', { socketId: socket.id });
  emitPresence(roomId);
}
function peersShareRoom(a, b) {
  const from = io.sockets.sockets.get(a);
  const to = io.sockets.sockets.get(b);
  return !!from?.data.roomId && from.data.roomId === to?.data.roomId;
}

io.use((socket, next) => {
  const user = getUser({ headers: { cookie: socket.handshake.headers.cookie || '' } });
  if (!user) return next(new Error('Sessão inválida.'));
  socket.data.user = user;
  next();
});
io.on('connection', socket => {
  const user = socket.data.user;
  socket.join(userSocketRoom(user.id));
  const sessions = online.get(user.id) || new Set();
  const wasOffline = sessions.size === 0;
  sessions.add(socket.id);
  online.set(user.id, sessions);
  if (wasOffline) refreshFriendPresence(user.id);

  socket.on('room:join', ({ roomId } = {}, ack) => {
    const room = roomFromId(roomId);
    if (!room) return safeSocketAck(ack, { error: 'Sala inválida ou expirada.' });
    if (socket.data.roomId && socket.data.roomId !== room.id) leaveRoom(socket);
    let members = occupants.get(room.id);
    if (!members) { members = new Map(); occupants.set(room.id, members); }
    if (!members.has(socket.id) && members.size >= MAX_PEOPLE)
      return safeSocketAck(ack, { error: 'Esta sala está cheia.' });
    members.set(socket.id, { id: user.id, displayName: user.displayName });
    socket.data.roomId = room.id;
    socket.join(roomSocketRoom(room.id));
    safeSocketAck(ack, { ok: true, sharerId: sharers.get(room.id) || null });
    emitPresence(room.id);
  });
  socket.on('room:leave', (_value, ack) => { leaveRoom(socket); safeSocketAck(ack, { ok: true }); });
  socket.on('share:start', (_value, ack) => {
    const roomId = socket.data.roomId;
    if (!roomId || !roomFromId(roomId)) return safeSocketAck(ack, { error: 'Entre em uma sala válida.' });
    const current = sharers.get(roomId);
    if (current && current !== socket.id) return safeSocketAck(ack, { error: 'Outra pessoa já está transmitindo.' });
    sharers.set(roomId, socket.id);
    safeSocketAck(ack, { ok: true });
    io.to(roomSocketRoom(roomId)).emit('share:started', { socketId: socket.id, displayName: user.displayName });
  });
  socket.on('share:stop', (_value, ack) => {
    const roomId = socket.data.roomId;
    if (roomId && sharers.get(roomId) === socket.id) {
      sharers.delete(roomId);
      io.to(roomSocketRoom(roomId)).emit('share:stopped', { socketId: socket.id });
    }
    safeSocketAck(ack, { ok: true });
  });
  socket.on('viewer:ready', () => {
    const roomId = socket.data.roomId;
    const sharer = roomId && sharers.get(roomId);
    if (sharer && sharer !== socket.id && peersShareRoom(socket.id, sharer))
      io.to(sharer).emit('viewer:ready', { socketId: socket.id });
  });
  for (const kind of ['offer', 'answer', 'ice']) {
    socket.on(`signal:${kind}`, ({ to, data } = {}) => {
      if (typeof to !== 'string' || !data || typeof data !== 'object' || !peersShareRoom(socket.id, to)) return;
      const roomId = socket.data.roomId;
      const sharer = sharers.get(roomId);
      if (socket.id !== sharer && to !== sharer) return;
      if (kind === 'ice' && JSON.stringify(data).length > 8192) return;
      if (kind !== 'ice' && JSON.stringify(data).length > 30000) return;
      io.to(to).emit(`signal:${kind}`, { from: socket.id, data });
    });
  }
  socket.on('disconnect', () => {
    leaveRoom(socket);
    const all = online.get(user.id);
    all?.delete(socket.id);
    if (all && !all.size) { online.delete(user.id); refreshFriendPresence(user.id); }
  });
});

app.use('/api', (req, res) => error(res, 404, 'Endpoint não encontrado.'));
app.use(express.static(path.resolve(__dirname, '..', 'public'), { index: 'index.html', maxAge: production ? '1h' : 0 }));
app.use((err, req, res, next) => {
  console.error(err);
  if (!res.headersSent) error(res, 500, 'Ocorreu um erro interno.');
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Nítida no ar: http://localhost:${PORT}`));
  const timer = setInterval(() => {
    for (const roomId of occupants.keys()) {
      if (!roomFromId(roomId)) {
        io.to(roomSocketRoom(roomId)).emit('room:closed');
        io.in(roomSocketRoom(roomId)).socketsLeave(roomSocketRoom(roomId));
        for (const sock of io.sockets.sockets.values()) if (sock.data.roomId === roomId) sock.data.roomId = null;
        occupants.delete(roomId);
        sharers.delete(roomId);
      }
    }
    cleanupExpired();
  }, 10 * 60 * 1000);
  timer.unref();
}
module.exports = { app, server, io, db };
