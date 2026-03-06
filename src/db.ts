import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const dataDir = join(process.cwd(), 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}
const dbPath = join(dataDir, 'bot.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.prepare(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  ph REAL NOT NULL,
  hours INTEGER NOT NULL,
  pool TEXT NOT NULL,
  worker TEXT NOT NULL,
  requestedProvider TEXT,
  user TEXT NOT NULL,
  status TEXT NOT NULL,
  totalUsd REAL NOT NULL,
  createdAt INTEGER NOT NULL,
  nhOrderId TEXT,
  nhMarket TEXT,
  nhPrice REAL,
  nhLimit REAL,
  nhAmount REAL,
  expiresAt INTEGER,
  fulfillmentProvider TEXT,
  proxySessionId TEXT
)
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  orderId TEXT NOT NULL UNIQUE,
  userId TEXT NOT NULL,
  status TEXT NOT NULL,
  reference TEXT NOT NULL,
  usdAmount REAL NOT NULL,
  usdcBaseAmount REAL NOT NULL,
  usdcSolAmount REAL NOT NULL,
  btcAmount REAL,
  confirmedMethod TEXT,
  confirmedTxId TEXT,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  confirmedAt INTEGER,
  notes TEXT
)
`).run();

db.prepare('CREATE INDEX IF NOT EXISTS idx_payment_intents_status_expires ON payment_intents(status, expiresAt)').run();

const upgradeCols = [
  ['nhOrderId', 'TEXT'],
  ['nhMarket', 'TEXT'],
  ['nhPrice', 'REAL'],
  ['nhLimit', 'REAL'],
  ['nhAmount', 'REAL'],
  ['expiresAt', 'INTEGER'],
  ['requestedProvider', 'TEXT'],
  ['fulfillmentProvider', 'TEXT'],
  ['proxySessionId', 'TEXT'],
];
for (const [col, type] of upgradeCols) {
  try {
    db.prepare(`ALTER TABLE orders ADD COLUMN ${col} ${type}`).run();
  } catch (_) {
    // ignore if already exists
  }
}

export { db };
