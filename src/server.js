// Sunli — chat backend (REST API + Socket.IO realtime).
// Run:  npm install  &&  npm start   (listens on PORT, default 3000)
// Data is stored in MongoDB Atlas (see db.js).

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const store = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const publicUser = (u) => ({
  id: u.id,
  phone: u.phone,
  name: u.name,
  lastSeen: u.lastSeen || 0,
});

// --- Only Indian mobile numbers are allowed (10 digits, starting 6-9) ---
function normalizePhone(input) {
  if (!input) return null;
  let digits = String(input).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return '+91' + digits;
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => res.json({ ok: true, service: 'sunli' }));

// Register (new number) or log in (existing number) — always with a password.
app.post('/api/auth', async (req, res) => {
  const body = req.body || {};
  const phone = normalizePhone(body.phone);
  const password = String(body.password || '');
  const name = (body.name || '').trim();

  if (!phone) {
    return res
      .status(400)
      .json({ error: 'Enter a valid Indian mobile number (10 digits).' });
  }
  if (password.length < 4) {
    return res
      .status(400)
      .json({ error: 'Password must be at least 4 characters.' });
  }

  let user = await store.findUserByPhone(phone);
  const isNew = !user;

  if (!user) {
    user = await store.addUser(phone, name || phone, password);
  } else {
    if (!store.verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Wrong password for this number.' });
    }
    if (name && name !== user.name) {
      await store.updateUserName(user.id, name);
      user.name = name;
    }
  }

  res.json({ token: user.token, isNew, user: publicUser(user) });
});

// Bearer-token middleware.
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = await store.findUserByToken(token);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// Everyone except me — the plain contact list.
app.get('/api/users', auth, async (req, res) => {
  const users = (await store.allUsersExcept(req.user.id)).map(publicUser);
  res.json({ users });
});

// Chat list — every contact with their last message + unread count.
app.get('/api/chats', auth, async (req, res) => {
  const me = req.user.id;
  const [users, lasts, unread] = await Promise.all([
    store.allUsersExcept(me),
    store.lastMessages(me),
    store.unreadCounts(me),
  ]);
  const chats = users.map((u) => ({
    user: publicUser(u),
    lastMessage: lasts[u.id] || null,
    unread: unread[u.id] || 0,
  }));
  // Most recent conversation first.
  chats.sort((a, b) => {
    const ta = a.lastMessage ? a.lastMessage.createdAt : 0;
    const tb = b.lastMessage ? b.lastMessage.createdAt : 0;
    return tb - ta;
  });
  res.json({ chats });
});

// Full conversation with one peer — and mark their messages as read.
app.get('/api/messages/:peerId', auth, async (req, res) => {
  const me = req.user.id;
  const peer = req.params.peerId;
  const messages = await store.conversation(me, peer);
  await store.markRead(peer, me);
  io.to(peer).emit('message:read', { by: me });
  res.json({ messages });
});

// Send a message over plain HTTP (the app normally uses the socket).
app.post('/api/messages', auth, async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
  const msg = await store.addMessage({ from: req.user.id, to, text });
  io.to(to).emit('message:new', msg);
  res.json({ message: msg });
});

// Edit a message.
app.patch('/api/messages/:id', auth, async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const msg = await store.findMessageById(req.params.id);
  if (!msg || msg.from !== req.user.id) {
    return res.status(403).json({ error: 'not allowed' });
  }
  await store.editMessage(msg.id, text);
  const updated = { ...msg, text, editedAt: Date.now() };
  io.to(msg.to).emit('message:edited', updated);
  res.json({ message: updated });
});

// Delete a message (for everyone).
app.delete('/api/messages/:id', auth, async (req, res) => {
  const msg = await store.findMessageById(req.params.id);
  if (!msg || msg.from !== req.user.id) {
    return res.status(403).json({ error: 'not allowed' });
  }
  await store.deleteMessage(msg.id);
  io.to(msg.to).emit('message:deleted', { id: msg.id });
  res.json({ ok: true });
});

// Search my messages.
app.get('/api/search', auth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ messages: [] });
  res.json({ messages: await store.search(req.user.id, q) });
});

// ---------------------------------------------------------------------------
// Realtime (Socket.IO)
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const user = await store.findUserByToken(token);
    if (!user) return next(new Error('unauthorized'));
    socket.user = user;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

io.on('connection', async (socket) => {
  const user = socket.user;
  socket.join(user.id);

  // Messages waiting for me become "delivered".
  await store.markAllDelivered(user.id);
  socket.broadcast.emit('presence', { userId: user.id, online: true });

  socket.on('message:send', async (payload, ack) => {
    const { to, text } = payload || {};
    if (!to || !text) return;
    const msg = await store.addMessage({ from: user.id, to, text });
    io.to(to).emit('message:new', msg);
    if (typeof ack === 'function') ack(msg);
  });

  socket.on('message:read', async ({ from }) => {
    if (!from) return;
    await store.markRead(from, user.id);
    io.to(from).emit('message:read', { by: user.id });
  });

  socket.on('typing', ({ to, typing }) => {
    if (to) io.to(to).emit('typing', { from: user.id, typing: !!typing });
  });

  socket.on('disconnect', async () => {
    const ts = Date.now();
    await store.setLastSeen(user.id, ts);
    socket.broadcast.emit('presence', { userId: user.id, online: false, lastSeen: ts });
  });
});

store
  .connect()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`sunli-backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Failed to connect to MongoDB:', e);
    process.exit(1);
  });
