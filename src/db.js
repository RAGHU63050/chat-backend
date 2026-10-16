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
  await messagesCol.createIndex({ id: 1 }, { unique: true });
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

  // ------------------------------------------------------------------
  // Messages
  // ------------------------------------------------------------------
  async addMessage({ from, to, text }) {
    const msg = {
      id: newId(),
      from,
      to,
      text,
      createdAt: Date.now(),
      deliveredAt: 0,
      readAt: 0,
      editedAt: 0,
      deleted: false,
    };
    await messagesCol.insertOne(msg);
    return msg;
  },

  findMessageById: (id) => messagesCol.findOne({ id }, noId),

  editMessage: (id, text) =>
    messagesCol.updateOne({ id }, { $set: { text, editedAt: Date.now() } }),

  deleteMessage: (id) =>
    messagesCol.updateOne({ id }, { $set: { deleted: true, text: '' } }),

  // Who sent me messages that are still not delivered?
  pendingSenders: (me) =>
    messagesCol.distinct('from', { to: me, deliveredAt: 0 }),

  // Mark every message waiting for 'me' as delivered.
  markAllDelivered: (me) =>
    messagesCol.updateMany(
      { to: me, deliveredAt: 0 },
      { $set: { deliveredAt: Date.now() } },
    ),

  markRead: (from, me) =>
    messagesCol.updateMany(
      { from, to: me, readAt: 0 },
      { $set: { readAt: Date.now(), deliveredAt: Date.now() } },
    ),

  unreadCounts: async (me) => {
    const rows = await messagesCol
      .aggregate([
        { $match: { to: me, readAt: 0 } },
        { $group: { _id: '$from', count: { $sum: 1 } } },
      ])
      .toArray();
    const out = {};
    for (const r of rows) out[r._id] = r.count;
    return out;
  },

  conversation: (a, b) =>
    messagesCol
      .find({ $or: [{ from: a, to: b }, { from: b, to: a }] }, noId)
      .sort({ createdAt: 1 })
      .toArray(),

  // The last message exchanged with every other user (for the home list).
  lastMessages: async (me) => {
    const rows = await messagesCol
      .aggregate([
        { $match: { $or: [{ from: me }, { to: me }] } },
        { $sort: { createdAt: 1 } },
        {
          $group: {
            _id: {
              $cond: [{ $eq: ['$from', me] }, '$to', '$from'],
            },
            last: { $last: '$$ROOT' },
          },
        },
      ])
      .toArray();
    const out = {};
    for (const r of rows) out[r._id] = r.last;
    return out;
  },

  search: (me, q) =>
    messagesCol
      .find({
        $or: [{ from: me }, { to: me }],
        deleted: false,
        text: { $regex: q, $options: 'i' },
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray(),
};
