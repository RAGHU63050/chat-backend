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
    // New account
    user = await store.addUser(phone, name || phone, password);
  } else {
    // Existing account — password MUST match
    if (!store.verifyPassword(password, user.passwordHash)) {
      return res
        .status(401)
        .json({ error: 'Wrong password for this number.' });
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

// Everyone except me — the contact list (includes lastSeen).
app.get('/api/users', auth, async (req, res) => {
  const users = (await store.allUsersExcept(req.user.id)).map(publicUser);
  res.json({ users });
});

// Full conversation with one peer.
app.get('/api/messages/:peerId', auth, async (req, res) => {
  res.json({ messages: await store.conversation(req.user.id, req.params.peerId) });
});

// Send a message over plain HTTP (the app normally uses the socket).
app.post('/api/messages', auth, async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
  const msg = await store.addMessage({ from: req.user.id, to, text });
  io.to(to).emit('message:new', msg);
  res.json({ message: msg });
});

// ---------------------------------------------------------------------------
// Realtime (Socket.IO)
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Authenticate every socket via the token sent in the handshake.
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

io.on('connection', (socket) => {
  const user = socket.user;
  socket.join(user.id); // private room named after the user id

  socket.broadcast.emit('presence', { userId: user.id, online: true });

  socket.on('message:send', async (payload, ack) => {
    const { to, text } = payload || {};
    if (!to || !text) return;
    const msg = await store.addMessage({ from: user.id, to, text });
    io.to(to).emit('message:new', msg);
    if (typeof ack === 'function') ack(msg);
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

// Connect to MongoDB first, then start listening.
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
