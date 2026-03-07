import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient } from 'pg';

export type DbBackend = 'sqlite' | 'postgres';

export interface DbExecutor {
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<number>;
}

interface DbAdapter extends DbExecutor {
  backend: DbBackend;
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
}

const configuredBackend = (process.env.DB_BACKEND ?? '').toLowerCase();
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
const backend: DbBackend = configuredBackend === 'postgres' || (!configuredBackend && hasDatabaseUrl) ? 'postgres' : 'sqlite';

let sqliteDb: Database.Database | undefined;
let pgPool: Pool | undefined;

function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function normalizeRowKeys<T>(row: any): T {
  if (!row || typeof row !== 'object') return row as T;
  if ('createdat' in row && !('createdAt' in row)) row.createdAt = row.createdat;
  if ('orderid' in row && !('orderId' in row)) row.orderId = row.orderid;
  if ('userid' in row && !('userId' in row)) row.userId = row.userid;
  if ('bumpmicros' in row && !('bumpMicros' in row)) row.bumpMicros = row.bumpmicros;
  if ('usdamount' in row && !('usdAmount' in row)) row.usdAmount = row.usdamount;
  if ('usdcbaseamount' in row && !('usdcBaseAmount' in row)) row.usdcBaseAmount = row.usdcbaseamount;
  if ('usdcsolamount' in row && !('usdcSolAmount' in row)) row.usdcSolAmount = row.usdcsolamount;
  if ('btcamount' in row && !('btcAmount' in row)) row.btcAmount = row.btcamount;
  if ('confirmedmethod' in row && !('confirmedMethod' in row)) row.confirmedMethod = row.confirmedmethod;
  if ('confirmedtxid' in row && !('confirmedTxId' in row)) row.confirmedTxId = row.confirmedtxid;
  if ('expiresat' in row && !('expiresAt' in row)) row.expiresAt = row.expiresat;
  if ('confirmedat' in row && !('confirmedAt' in row)) row.confirmedAt = row.confirmedat;
  if ('requestedprovider' in row && !('requestedProvider' in row)) row.requestedProvider = row.requestedprovider;
  if ('totalusd' in row && !('totalUsd' in row)) row.totalUsd = row.totalusd;
  if ('nhorderid' in row && !('nhOrderId' in row)) row.nhOrderId = row.nhorderid;
  if ('nhmarket' in row && !('nhMarket' in row)) row.nhMarket = row.nhmarket;
  if ('nhprice' in row && !('nhPrice' in row)) row.nhPrice = row.nhprice;
  if ('nhlimit' in row && !('nhLimit' in row)) row.nhLimit = row.nhlimit;
  if ('nhamount' in row && !('nhAmount' in row)) row.nhAmount = row.nhamount;
  if ('fulfillmentprovider' in row && !('fulfillmentProvider' in row)) row.fulfillmentProvider = row.fulfillmentprovider;
  if ('proxysessionid' in row && !('proxySessionId' in row)) row.proxySessionId = row.proxysessionid;
  if ('txid' in row && !('txId' in row)) row.txId = row.txid;
  if ('intentid' in row && !('intentId' in row)) row.intentId = row.intentid;

  const numericFields = [
    'ph',
    'hours',
    'totalUsd',
    'createdAt',
    'nhPrice',
    'nhLimit',
    'nhAmount',
    'expiresAt',
    'bumpMicros',
    'usdAmount',
    'usdcBaseAmount',
    'usdcSolAmount',
    'btcAmount',
    'confirmedAt',
  ];
  for (const key of numericFields) {
    if (!(key in row)) continue;
    const value = row[key];
    if (typeof value === 'string') {
      const n = Number(value);
      if (isFinite(n)) row[key] = n;
    }
  }
  return row as T;
}

function makeSqliteAdapter(db: Database.Database): DbAdapter {
  const exec: DbExecutor = {
    async get<T>(sql: string, params: unknown[] = []) {
      const row = db.prepare(sql).get(...params);
      return normalizeRowKeys<T>(row);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const rows = db.prepare(sql).all(...params);
      return rows.map((r) => normalizeRowKeys<T>(r));
    },
    async run(sql: string, params: unknown[] = []) {
      const res = db.prepare(sql).run(...params);
      return res.changes;
    },
  };

  return {
    backend: 'sqlite',
    ...exec,
    async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(exec);
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore rollback failure
        }
        throw err;
      }
    },
  };
}

function makePgExecutor(client: Pool | PoolClient): DbExecutor {
  return {
    async get<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(toPgPlaceholders(sql), params);
      return normalizeRowKeys<T>(res.rows[0]);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(toPgPlaceholders(sql), params);
      return res.rows.map((r) => normalizeRowKeys<T>(r));
    },
    async run(sql: string, params: unknown[] = []) {
      const res = await client.query(toPgPlaceholders(sql), params);
      return res.rowCount ?? 0;
    },
  };
}

function makePostgresAdapter(pool: Pool): DbAdapter {
  const baseExec = makePgExecutor(pool);
  return {
    backend: 'postgres',
    ...baseExec,
    async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const txExec = makePgExecutor(client);
      try {
        await client.query('BEGIN');
        const out = await fn(txExec);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure
        }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

const migrations = [
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    ph DOUBLE PRECISION NOT NULL,
    hours INTEGER NOT NULL,
    pool TEXT NOT NULL,
    worker TEXT NOT NULL,
    "requestedProvider" TEXT,
    "user" TEXT NOT NULL,
    status TEXT NOT NULL,
    "totalUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "nhOrderId" TEXT,
    "nhMarket" TEXT,
    "nhPrice" DOUBLE PRECISION,
    "nhLimit" DOUBLE PRECISION,
    "nhAmount" DOUBLE PRECISION,
    "expiresAt" BIGINT,
    "fulfillmentProvider" TEXT,
    "proxySessionId" TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS payment_intents (
    id TEXT PRIMARY KEY,
    "orderId" TEXT NOT NULL UNIQUE,
    "userId" TEXT NOT NULL,
    status TEXT NOT NULL,
    reference TEXT NOT NULL,
    "bumpMicros" INTEGER NOT NULL DEFAULT 0,
    "usdAmount" DOUBLE PRECISION NOT NULL,
    "usdcBaseAmount" DOUBLE PRECISION NOT NULL,
    "usdcSolAmount" DOUBLE PRECISION NOT NULL,
    "btcAmount" DOUBLE PRECISION,
    "confirmedMethod" TEXT,
    "confirmedTxId" TEXT,
    "createdAt" BIGINT NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    "confirmedAt" BIGINT,
    notes TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payment_intents_status_expires ON payment_intents(status, "expiresAt")`,
  `CREATE TABLE IF NOT EXISTS payment_matches (
    "txId" TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payment_matches_order_id ON payment_matches("orderId")`,
];

const orderUpgradeCols: Array<[string, string]> = [
  ['nhOrderId', 'TEXT'],
  ['nhMarket', 'TEXT'],
  ['nhPrice', 'DOUBLE PRECISION'],
  ['nhLimit', 'DOUBLE PRECISION'],
  ['nhAmount', 'DOUBLE PRECISION'],
  ['expiresAt', 'BIGINT'],
  ['requestedProvider', 'TEXT'],
  ['fulfillmentProvider', 'TEXT'],
  ['proxySessionId', 'TEXT'],
];

async function addColumnIfMissing(executor: DbExecutor, table: string, column: string, type: string): Promise<void> {
  try {
    await executor.run(`ALTER TABLE ${table} ADD COLUMN "${column}" ${type}`);
  } catch {
    // ignore if already exists
  }
}

async function normalizePendingIntentBumps(executor: DbExecutor) {
  const rows = await executor.all<{ id: string; bumpMicros: number | null }>(
    'SELECT id, "bumpMicros" as "bumpMicros" FROM payment_intents WHERE status = ? ORDER BY "createdAt" ASC',
    ['pending']
  );

  const used = new Set<number>();
  let next = 1;

  for (const row of rows) {
    let bump = Number(row.bumpMicros ?? 0);
    const invalid = !isFinite(bump) || bump <= 0 || bump > 999_999 || used.has(bump);
    if (invalid) {
      while (used.has(next)) {
        next += 1;
        if (next > 999_999) next = 1;
      }
      bump = next;
      next += 1;
      if (next > 999_999) next = 1;
      await executor.run('UPDATE payment_intents SET "bumpMicros" = ? WHERE id = ?', [bump, row.id]);
    }
    used.add(bump);
  }
}

async function initSqlite(): Promise<DbAdapter> {
  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = join(dataDir, 'bot.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const adapter = makeSqliteAdapter(db);

  for (const sql of migrations) {
    await adapter.run(sql);
  }

  for (const [column, type] of orderUpgradeCols) {
    await addColumnIfMissing(adapter, 'orders', column, type);
  }
  await addColumnIfMissing(adapter, 'payment_intents', 'bumpMicros', 'INTEGER NOT NULL DEFAULT 0');

  await normalizePendingIntentBumps(adapter);
  await adapter.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_pending_bump ON payment_intents("bumpMicros") WHERE status = 'pending'`
  );

  sqliteDb = db;
  return adapter;
}

async function initPostgres(): Promise<DbAdapter> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing DATABASE_URL for Postgres backend');

  const sslMode = (process.env.PGSSLMODE ?? '').toLowerCase();
  const ssl = sslMode === 'disable' ? undefined : process.env.PGSSL === 'true' || sslMode === 'require' ? { rejectUnauthorized: false } : undefined;

  const pool = new Pool({ connectionString: databaseUrl, ssl });
  const adapter = makePostgresAdapter(pool);

  for (const sql of migrations) {
    await adapter.run(sql);
  }

  for (const [column, type] of orderUpgradeCols) {
    await addColumnIfMissing(adapter, 'orders', column, type);
  }
  await addColumnIfMissing(adapter, 'payment_intents', 'bumpMicros', 'INTEGER NOT NULL DEFAULT 0');

  await normalizePendingIntentBumps(adapter);
  await adapter.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_pending_bump ON payment_intents("bumpMicros") WHERE status = 'pending'`
  );

  pgPool = pool;
  return adapter;
}

let adapterPromise: Promise<DbAdapter> | undefined;

function initAdapter(): Promise<DbAdapter> {
  if (!adapterPromise) {
    adapterPromise = backend === 'postgres' ? initPostgres() : initSqlite();
  }
  return adapterPromise;
}

export async function ensureDbReady(): Promise<void> {
  await initAdapter();
}

async function getAdapter(): Promise<DbAdapter> {
  return initAdapter();
}

export async function dbGet<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
  const adapter = await getAdapter();
  return adapter.get<T>(sql, params);
}

export async function dbAll<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const adapter = await getAdapter();
  return adapter.all<T>(sql, params);
}

export async function dbRun(sql: string, params?: unknown[]): Promise<number> {
  const adapter = await getAdapter();
  return adapter.run(sql, params);
}

export async function dbTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  const adapter = await getAdapter();
  return adapter.transaction(fn);
}

export function dbBackend(): DbBackend {
  return backend;
}

export async function closeDb(): Promise<void> {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = undefined;
  }
  if (pgPool) {
    await pgPool.end();
    pgPool = undefined;
  }
}
