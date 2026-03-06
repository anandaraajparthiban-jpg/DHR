import crypto from 'node:crypto';
import { db } from './db.js';

export type PaymentIntentStatus = 'pending' | 'confirmed' | 'expired';
export type PaymentMethod = 'btc_onchain' | 'usdc_base' | 'usdc_solana';

export interface PaymentIntent {
  id: string;
  orderId: string;
  userId: string;
  status: PaymentIntentStatus;
  reference: string;
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

const insertIntentStmt = db.prepare(
  `INSERT INTO payment_intents
   (id, orderId, userId, status, reference, usdAmount, usdcBaseAmount, usdcSolAmount, btcAmount, confirmedMethod, confirmedTxId, createdAt, expiresAt, confirmedAt, notes)
   VALUES (@id, @orderId, @userId, @status, @reference, @usdAmount, @usdcBaseAmount, @usdcSolAmount, @btcAmount, @confirmedMethod, @confirmedTxId, @createdAt, @expiresAt, @confirmedAt, @notes)`
);
const getIntentByOrderStmt = db.prepare('SELECT * FROM payment_intents WHERE orderId = ?');
const getIntentByIdStmt = db.prepare('SELECT * FROM payment_intents WHERE id = ?');
const listPendingIntentsStmt = db.prepare(
  'SELECT * FROM payment_intents WHERE status = ? AND expiresAt >= ? ORDER BY createdAt ASC'
);
const expireIntentsStmt = db.prepare("UPDATE payment_intents SET status = 'expired' WHERE status = 'pending' AND expiresAt < ?");
const confirmIntentStmt = db.prepare(
  "UPDATE payment_intents SET status = 'confirmed', confirmedMethod = ?, confirmedTxId = ?, confirmedAt = ? WHERE id = ? AND status = 'pending'"
);

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function amountBumpUsd(orderId: string): number {
  // Assign tiny per-order amount bumps so scanner can match transfers more reliably.
  const digest = crypto.createHash('sha256').update(orderId).digest();
  const micros = 100 + (digest[0] % 900); // 0.000100 to 0.000999
  return micros / 1_000_000;
}

function paymentReference(orderId: string): string {
  return `DHR-${orderId.split('-')[0].toUpperCase()}`;
}

export async function getPaymentIntentByOrder(orderId: string): Promise<PaymentIntent | undefined> {
  return getIntentByOrderStmt.get(orderId) as PaymentIntent | undefined;
}

export async function getPaymentIntentById(id: string): Promise<PaymentIntent | undefined> {
  return getIntentByIdStmt.get(id) as PaymentIntent | undefined;
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

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const usdWithBump = roundTo(input.totalUsd + amountBumpUsd(input.orderId), 6);
  const btcAmount =
    typeof input.btcUsd === 'number' && isFinite(input.btcUsd) && input.btcUsd > 0
      ? roundTo(usdWithBump / input.btcUsd, 8)
      : null;

  const row: PaymentIntent = {
    id,
    orderId: input.orderId,
    userId: input.userId,
    status: 'pending',
    reference: paymentReference(input.orderId),
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
  try {
    insertIntentStmt.run(row as any);
    return row;
  } catch {
    const after = await getPaymentIntentByOrder(input.orderId);
    if (after) return after;
    throw new Error(`failed to create payment intent for order ${input.orderId}`);
  }
}

export async function listPendingPaymentIntents(nowMs: number = Date.now()): Promise<PaymentIntent[]> {
  return listPendingIntentsStmt.all('pending', nowMs) as PaymentIntent[];
}

export async function expireStalePaymentIntents(nowMs: number = Date.now()): Promise<number> {
  const res = expireIntentsStmt.run(nowMs);
  return res.changes;
}

export async function confirmPaymentIntent(input: {
  intentId: string;
  method: PaymentMethod;
  txId?: string;
  confirmedAt?: number;
}): Promise<boolean> {
  const res = confirmIntentStmt.run(input.method, input.txId ?? null, input.confirmedAt ?? Date.now(), input.intentId);
  return res.changes > 0;
}
