// Sunli — MongoDB-backed data store.
// Data lives in MongoDB Atlas, so it is NEVER lost when the service restarts.
// Requires MONGODB_URI.

const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI;
if (!URI) {
  console.error('MONGODB_URI is not set. Add it in your environment variables.');
  process.exit(1);
}

const client = new MongoClient(URI);
let usersCol;
let messagesCol;

async function connect() {
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'chat');
  usersCol = db.collection('users');
  messagesCol = db.collection('messages');
  await usersCol.createIndex({ phone: 1 }, { unique: true });
  await usersCol.createIndex({ token: 1 });
  await messagesCol.createIndex({ from: 1, to: 1, createdAt: 1 });
}

const newToken = () => crypto.randomBytes(24).toString('hex');
const newId = () => crypto.randomUUID();
const noId = { projection: { _id: 0 } };

// --- password hashing (scrypt, no external dependency) ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  connect,
  newToken,
  newId,
  hashPassword,
  verifyPassword,

  findUserByPhone: (phone) => usersCol.findOne({ phone }, noId),
  findUserById: (id) => usersCol.findOne({ id }, noId),
  findUserByToken: (token) => usersCol.findOne({ token }, noId),

  allUsersExcept: (id) => usersCol.find({ id: { $ne: id } }, noId).toArray(),

  async addUser(phone, name, password) {
    const user = {
      id: newId(),
      phone,
      name,
      passwordHash: hashPassword(password),
      token: newToken(),
      lastSeen: Date.now(),
      createdAt: Date.now(),
    };
    await usersCol.insertOne(user);
    return user;
  },

  updateUserName: (id, name) => usersCol.updateOne({ id }, { $set: { name } }),
  setLastSeen: (id, ts) => usersCol.updateOne({ id }, { $set: { lastSeen: ts } }),
  setToken: (id, token) => usersCol.updateOne({ id }, { $set: { token } }),

  async addMessage({ from, to, text }) {
    const msg = { id: newId(), from, to, text, createdAt: Date.now() };
    await messagesCol.insertOne(msg);
    return msg;
  },

  conversation: (a, b) =>
    messagesCol
      .find({ $or: [{ from: a, to: b }, { from: b, to: a }] }, noId)
      .sort({ createdAt: 1 })
      .toArray(),
};
