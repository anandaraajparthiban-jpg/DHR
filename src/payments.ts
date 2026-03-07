import crypto from 'node:crypto';
import { dbAll, dbGet, dbRun, dbTransaction } from './db.js';

export type PaymentIntentStatus = 'pending' | 'confirmed' | 'expired';
export type PaymentMethod = 'btc_onchain' | 'usdc_base' | 'usdc_solana';

export interface PaymentIntent {
  id: string;
  orderId: string;
  userId: string;
  status: PaymentIntentStatus;
  reference: string;
  bumpMicros: number;
  usdAmount: number;
  usdcBaseAmount: number;
  usdcSolAmount: number;
  btcAmount?: number | null;
  confirmedMethod?: PaymentMethod | null;
  confirmedTxId?: string | null;
  createdAt: number;
  expiresAt: number;
  confirmedAt?: number | null;
  notes?: string | null;
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function amountBumpUsd(orderId: string): number {
  const digest = crypto.createHash('sha256').update(orderId).digest();
  const micros = 1 + (((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 999_999);
  return micros / 1_000_000;
}

function buildIntentRow(input: {
  orderId: string;
  userId: string;
  totalUsd: number;
  btcUsd?: number;
  expiresAt: number;
  bumpMicros: number;
}): PaymentIntent {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const usdWithBump = roundTo(input.totalUsd + input.bumpMicros / 1_000_000, 6);
  const btcAmount =
    typeof input.btcUsd === 'number' && isFinite(input.btcUsd) && input.btcUsd > 0
      ? roundTo(usdWithBump / input.btcUsd, 8)
      : null;
  return {
    id,
    orderId: input.orderId,
    userId: input.userId,
    status: 'pending',
    reference: paymentReference(input.orderId),
    bumpMicros: input.bumpMicros,
    usdAmount: usdWithBump,
    usdcBaseAmount: usdWithBump,
    usdcSolAmount: usdWithBump,
    btcAmount,
    confirmedMethod: null,
    confirmedTxId: null,
    createdAt,
    expiresAt: input.expiresAt,
    confirmedAt: null,
    notes: null,
  };
}

function randomBumpMicros(): number {
  return 1 + Math.floor(Math.random() * 999_999);
}

function paymentReference(orderId: string): string {
  return `DHR-${orderId.split('-')[0].toUpperCase()}`;
}

async function insertIntent(row: PaymentIntent): Promise<void> {
  await dbRun(
    `INSERT INTO payment_intents
     (id, "orderId", "userId", status, reference, "bumpMicros", "usdAmount", "usdcBaseAmount", "usdcSolAmount", "btcAmount", "confirmedMethod", "confirmedTxId", "createdAt", "expiresAt", "confirmedAt", notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.orderId,
      row.userId,
      row.status,
      row.reference,
      row.bumpMicros,
      row.usdAmount,
      row.usdcBaseAmount,
      row.usdcSolAmount,
      row.btcAmount ?? null,
      row.confirmedMethod ?? null,
      row.confirmedTxId ?? null,
      row.createdAt,
      row.expiresAt,
      row.confirmedAt ?? null,
      row.notes ?? null,
    ]
  );
}

export async function getPaymentIntentByOrder(orderId: string): Promise<PaymentIntent | undefined> {
  return dbGet<PaymentIntent>('SELECT * FROM payment_intents WHERE "orderId" = ?', [orderId]);
}

export async function getPaymentIntentById(id: string): Promise<PaymentIntent | undefined> {
  return dbGet<PaymentIntent>('SELECT * FROM payment_intents WHERE id = ?', [id]);
}

export async function ensurePaymentIntent(input: {
  orderId: string;
  userId: string;
  totalUsd: number;
  btcUsd?: number;
  expiresAt: number;
}): Promise<PaymentIntent> {
  const existing = await getPaymentIntentByOrder(input.orderId);
  if (existing) return existing;

  const deterministic = Math.round(amountBumpUsd(input.orderId) * 1_000_000);
  const candidateBumps = [deterministic];
  for (let i = 0; i < 9; i++) candidateBumps.push(randomBumpMicros());

  for (const bumpMicros of candidateBumps) {
    const row = buildIntentRow({ ...input, bumpMicros });
    try {
      await insertIntent(row);
      return row;
    } catch {
      const after = await getPaymentIntentByOrder(input.orderId);
      if (after) return after;
    }
  }

  throw new Error(`failed to create unique payment intent for order ${input.orderId}`);
}

export async function listPendingPaymentIntents(nowMs: number = Date.now()): Promise<PaymentIntent[]> {
  return dbAll<PaymentIntent>(
    'SELECT * FROM payment_intents WHERE status = ? AND "expiresAt" >= ? ORDER BY "createdAt" ASC',
    ['pending', nowMs]
  );
}

export async function expireStalePaymentIntents(nowMs: number = Date.now()): Promise<number> {
  return dbRun("UPDATE payment_intents SET status = 'expired' WHERE status = 'pending' AND \"expiresAt\" < ?", [nowMs]);
}

export async function confirmPaymentIntent(input: {
  intentId: string;
  method: PaymentMethod;
  txId?: string;
  confirmedAt?: number;
}): Promise<boolean> {
  return dbTransaction<boolean>(async (tx) => {
    const intent = await tx.get<PaymentIntent>('SELECT * FROM payment_intents WHERE id = ?', [input.intentId]);
    if (!intent || intent.status !== 'pending') return false;

    if (input.txId) {
      try {
        await tx.run('INSERT INTO payment_matches ("txId", method, "intentId", "orderId", "createdAt") VALUES (?, ?, ?, ?, ?)', [
          input.txId,
          input.method,
          intent.id,
          intent.orderId,
          Date.now(),
        ]);
      } catch {
        return false;
      }
    }

    const changes = await tx.run(
      "UPDATE payment_intents SET status = 'confirmed', \"confirmedMethod\" = ?, \"confirmedTxId\" = ?, \"confirmedAt\" = ? WHERE id = ? AND status = 'pending'",
      [input.method, input.txId ?? null, input.confirmedAt ?? Date.now(), input.intentId]
    );
    return changes > 0;
  });
}
