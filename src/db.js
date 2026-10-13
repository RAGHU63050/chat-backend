// MongoDB-backed data store.
// Data lives in MongoDB Atlas (a real database), so it is NEVER lost when the
// Render service restarts, redeploys, or spins down. Requires MONGODB_URI.

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

module.exports = {
  connect,
  newToken,
  newId,

  findUserByPhone: (phone) => usersCol.findOne({ phone }, noId),
  findUserById: (id) => usersCol.findOne({ id }, noId),
  findUserByToken: (token) => usersCol.findOne({ token }, noId),

  allUsersExcept: (id) => usersCol.find({ id: { $ne: id } }, noId).toArray(),

  async addUser(phone, name) {
    const user = { id: newId(), phone, name, token: newToken(), createdAt: Date.now() };
    await usersCol.insertOne(user);
    return user;
  },

  updateUserName: (id, name) => usersCol.updateOne({ id }, { $set: { name } }),

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
