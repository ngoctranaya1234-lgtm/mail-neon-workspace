import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from './crypto.mjs';

export function openDatabase(path) {
  if (process.platform !== 'win32') process.umask(0o077);
  if (path !== ':memory:') {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      if (statSync(directory).mode & 0o077) throw new Error('DATA_DIR must be accessible only to its owner (chmod 700)');
      if (existsSync(path) && (statSync(path).mode & 0o077)) throw new Error('Database file must be accessible only to its owner (chmod 600)');
    }
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 5) throw new Error('Database version is newer than application');
  if (version === 0) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE mailboxes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK(provider IN ('google','microsoft','imap','domain')), address TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', credential_cipher TEXT, cursor TEXT, status TEXT NOT NULL DEFAULT 'connected', last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL, UNIQUE(user_id,provider,address));
      CREATE INDEX mailboxes_user ON mailboxes(user_id);
      CREATE TABLE aliases (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, address TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('dot','plus','domain')), purpose TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')), expires_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL, UNIQUE(user_id,address));
      CREATE INDEX aliases_mailbox ON aliases(mailbox_id);
      CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, provider_message_id TEXT NOT NULL, sender TEXT NOT NULL, recipients TEXT NOT NULL, subject TEXT NOT NULL, body_cipher TEXT NOT NULL, received_at TEXT NOT NULL, alias_id TEXT REFERENCES aliases(id) ON DELETE SET NULL, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(mailbox_id,provider_message_id));
      CREATE INDEX messages_user_date ON messages(user_id,received_at DESC,id DESC);
      CREATE INDEX messages_mailbox_date ON messages(mailbox_id,received_at DESC);
      CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL, verifier TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE audit_events (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL);
      CREATE INDEX audit_user_date ON audit_events(user_id,created_at DESC);
      PRAGMA user_version=1;
    COMMIT;`);
  }
  if (version < 2) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE aliases ADD COLUMN notes TEXT NOT NULL DEFAULT '';
      ALTER TABLE aliases ADD COLUMN leak_status TEXT NOT NULL DEFAULT 'unknown' CHECK(leak_status IN ('unknown','suspected','confirmed'));
      ALTER TABLE aliases ADD COLUMN spam_status TEXT NOT NULL DEFAULT 'none' CHECK(spam_status IN ('none','observed','high'));
      PRAGMA user_version=2;
    COMMIT;`);
  }
  if (version < 3) {
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 1) throw new Error('Database contains multiple owner accounts; resolve them before migration');
    const duplicates = db.prepare("SELECT address FROM aliases WHERE kind='domain' GROUP BY address HAVING COUNT(*)>1 LIMIT 1").get();
    if (duplicates) throw new Error('Database contains duplicate domain aliases; resolve them before migration');
    db.exec(`BEGIN IMMEDIATE;
      CREATE UNIQUE INDEX users_single_owner ON users ((1));
      CREATE UNIQUE INDEX aliases_domain_address ON aliases(address) WHERE kind='domain';
      PRAGMA user_version=3;
    COMMIT;`);
  }
  if (version < 4) {
    db.exec('PRAGMA user_version=4');
  }
  if (version < 5) {
    const hasSms = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sms_messages'").get();
    if (hasSms && db.prepare('SELECT COUNT(*) AS n FROM sms_messages').get().n) throw new Error('SMS data exists; export it before removing the canceled SMS feature');
    const hasDevices = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sms_devices'").get();
    if (hasDevices && db.prepare('SELECT COUNT(*) AS n FROM sms_devices').get().n) throw new Error('SMS device data exists; export it before removing the canceled SMS feature');
    db.exec(`BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS sms_messages;
      DROP TABLE IF EXISTS sms_devices;
      PRAGMA user_version=5;
    COMMIT;`);
  }
  return db;
}
export const now = () => new Date().toISOString();
export const MAX_MESSAGE_CHARS = 200_000;
export function audit(db, userId, action, targetId = null) {
  db.prepare('INSERT INTO audit_events(id,user_id,action,target_id,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), userId, action, targetId, now());
}
export function publicMailbox(row) {
  if (!row) return null;
  const { credential_cipher, cursor, user_id, ...safe } = row;
  const connected = row.provider === 'domain' || !!row.credential_cipher;
  return { ...safe, capabilities: {
    read: connected && row.provider !== 'domain',
    sync: connected && row.provider !== 'domain',
    inbound: connected && row.provider === 'domain',
    aliases: connected && row.provider === 'google' ? ['dot','plus'] : row.provider === 'domain' ? ['domain'] : [],
    send: false, createMailbox: false,
  }};
}
export function ingestMessage(db, key, input) {
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id=? AND user_id=?').get(input.mailboxId, input.userId);
  if (!mailbox) throw new Error('Mailbox not found');
  const recipients = [...new Set((input.recipients || []).slice(0,100).map(x => String(x).trim().toLowerCase().slice(0,320)).filter(Boolean))];
  const alias = recipients.length ? db.prepare(`SELECT * FROM aliases WHERE user_id=? AND mailbox_id=? AND status='active' AND address IN (${recipients.map(() => '?').join(',')}) LIMIT 1`).get(input.userId, input.mailboxId, ...recipients) : null;
  const providerMessageId = String(input.providerMessageId).slice(0,500);
  const id = randomUUID();
  const stamp = now();
  const result = db.prepare('INSERT OR IGNORE INTO messages(id,user_id,mailbox_id,provider_message_id,sender,recipients,subject,body_cipher,received_at,alias_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, input.userId, input.mailboxId, providerMessageId, String(input.sender || '').slice(0,320), JSON.stringify(recipients), String(input.subject || '').slice(0,500), encrypt(String(input.text || '').slice(0,MAX_MESSAGE_CHARS), key), input.receivedAt || stamp, alias?.id || null, stamp);
  if (alias && result.changes) db.prepare('UPDATE aliases SET last_used_at=? WHERE id=?').run(stamp, alias.id);
  return { inserted: !!result.changes, id: result.changes ? id : db.prepare('SELECT id FROM messages WHERE mailbox_id=? AND provider_message_id=?').get(input.mailboxId, providerMessageId)?.id };
}
export function messageForUser(db, key, userId, id) {
  const row = db.prepare('SELECT m.*, b.address AS mailbox_address, b.provider AS mailbox_provider, a.address AS alias_address FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id LEFT JOIN aliases a ON a.id=m.alias_id WHERE m.id=? AND m.user_id=?').get(id,userId);
  if (!row) return null;
  const { body_cipher, user_id, ...safe } = row;
  let recipients;
  try { recipients = JSON.parse(row.recipients); } catch { recipients = [row.recipients]; }
  return { ...safe, recipients, text: decrypt(body_cipher, key) };
}
