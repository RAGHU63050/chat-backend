// Tiny JSON-file data store. No native dependencies, so `npm install` never
// needs a compiler. Swap this for SQLite/Postgres when you go to production.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    return { users: [], messages: [] };
  }
}

const db = load();

function save() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

const newToken = () => crypto.randomBytes(24).toString('hex');
const newId = () => crypto.randomUUID();

module.exports = {
  db,
  save,
  newToken,
  newId,
  findUserByPhone: (phone) => db.users.find((u) => u.phone === phone),
  findUserById: (id) => db.users.find((u) => u.id === id),
  findUserByToken: (token) => db.users.find((u) => u.token === token),

  addUser(phone, name) {
    const user = { id: newId(), phone, name, token: newToken(), createdAt: Date.now() };
    db.users.push(user);
    save();
    return user;
  },

  addMessage({ from, to, text }) {
    const msg = { id: newId(), from, to, text, createdAt: Date.now() };
    db.messages.push(msg);
    save();
    return msg;
  },

  conversation(a, b) {
    return db.messages
      .filter((m) => (m.from === a && m.to === b) || (m.from === b && m.to === a))
      .sort((x, y) => x.createdAt - y.createdAt);
  },
};
