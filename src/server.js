// Chat backend — REST API + Socket.IO realtime.
// Run:  npm install  &&  npm start   (listens on PORT, default 3000)

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const store = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const publicUser = (u) => ({ id: u.id, phone: u.phone, name: u.name });

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => res.json({ ok: true, service: 'chat-backend' }));

// Register on first use, or log in if the phone number already exists.
app.post('/api/auth', (req, res) => {
  const { phone, name } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  let user = store.findUserByPhone(phone);
  if (!user) {
    user = store.addUser(phone, name || phone);
  } else if (name && name !== user.name) {
    user.name = name;
    store.save();
  }
  res.json({ token: user.token, user: publicUser(user) });
});

// Bearer-token middleware.
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = store.findUserByToken(token);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// Everyone except me — the contact list.
app.get('/api/users', auth, (req, res) => {
  const users = store.db.users.filter((u) => u.id !== req.user.id).map(publicUser);
  res.json({ users });
});

// Full conversation with one peer.
app.get('/api/messages/:peerId', auth, (req, res) => {
  res.json({ messages: store.conversation(req.user.id, req.params.peerId) });
});

// Send a message over plain HTTP (the app normally uses the socket).
app.post('/api/messages', auth, (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
  const msg = store.addMessage({ from: req.user.id, to, text });
  io.to(to).emit('message:new', msg);
  res.json({ message: msg });
});

// ---------------------------------------------------------------------------
// Realtime (Socket.IO)
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Authenticate every socket via the token sent in the handshake.
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const user = store.findUserByToken(token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.user;
  socket.join(user.id); // each user gets a private room named after their id

  socket.broadcast.emit('presence', { userId: user.id, online: true });

  socket.on('message:send', (payload, ack) => {
    const { to, text } = payload || {};
    if (!to || !text) return;
    const msg = store.addMessage({ from: user.id, to, text });
    io.to(to).emit('message:new', msg); // deliver to the recipient
    if (typeof ack === 'function') ack(msg); // confirm to the sender
  });

  socket.on('typing', ({ to, typing }) => {
    if (to) io.to(to).emit('typing', { from: user.id, typing: !!typing });
  });

  socket.on('disconnect', () => {
    socket.broadcast.emit('presence', { userId: user.id, online: false });
  });
});

server.listen(PORT, () => {
  console.log(`chat-backend listening on http://localhost:${PORT}`);
});
