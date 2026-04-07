import crypto from 'node:crypto';
import { dbAll, dbGet, dbRun } from './db.js';

export type OrderStatus = 'pending' | 'payment_required' | 'fulfilling' | 'active' | 'complete' | 'canceled';

interface OrderInput {
  ph: number;
  hours: number;
  pool: string;
  worker: string;
  requestedProvider: string;
  user: string;
  totalUsd: number;
}

export interface Order {
  id: string;
  ph: number;
  hours: number;
  pool: string;
  worker: string;
  requestedProvider?: string;
  user: string;
  status: OrderStatus;
  totalUsd: number;
  createdAt: number;
  nhOrderId?: string;
  nhMarket?: string;
  nhPrice?: number;
  nhLimit?: number;
  nhAmount?: number;
  expiresAt?: number;
  fulfillmentProvider?: string;
}

export async function createOrder(input: OrderInput): Promise<Order> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + input.hours * 3600 * 1000;

  await dbRun(
    `INSERT INTO orders
     (id, ph, hours, pool, worker, "requestedProvider", "user", status, "totalUsd", "createdAt", "nhOrderId", "nhMarket", "nhPrice", "nhLimit", "nhAmount", "expiresAt", "fulfillmentProvider")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.ph,
      input.hours,
      input.pool,
      input.worker,
      input.requestedProvider,
      input.user,
      'payment_required',
      input.totalUsd,
      now,
      null,
      null,
      null,
      null,
      null,
      expiresAt,
      null,
    ]
  );

  return {
    id,
    ph: input.ph,
    hours: input.hours,
    pool: input.pool,
    worker: input.worker,
    requestedProvider: input.requestedProvider,
    user: input.user,
    status: 'payment_required',
    totalUsd: input.totalUsd,
    createdAt: now,
    nhOrderId: undefined,
    nhMarket: undefined,
    nhPrice: undefined,
    nhLimit: undefined,
    nhAmount: undefined,
    expiresAt,
    fulfillmentProvider: undefined,
  };
}

export async function getOrder(id: string): Promise<Order | undefined> {
  return dbGet<Order>('SELECT * FROM orders WHERE id = ?', [id]);
}

export async function getOrderStatus(id: string): Promise<string> {
  const o = await getOrder(id);
  if (!o) return 'Not found';
  return `Order ${id}: ${o.status}, ${o.ph} PH for ${o.hours}h to ${o.pool} worker ${o.worker}`;
}

export async function cancelOrder(id: string): Promise<string> {
  const o = await getOrder(id);
  if (!o) return 'Not found';
  if (o.status === 'active' || o.status === 'fulfilling') return `Cannot cancel order in status ${o.status}`;
  await dbRun('UPDATE orders SET status = ? WHERE id = ?', ['canceled', id]);
  return `Order ${id} canceled`;
}

export async function cancelActiveOrderByAdmin(id: string): Promise<'canceled' | 'not_found' | 'not_active'> {
  const o = await getOrder(id);
  if (!o) return 'not_found';
  if (o.status !== 'active') return 'not_active';

  const changes = await dbRun("UPDATE orders SET status = 'canceled' WHERE id = ? AND status = 'active'", [id]);
  if (changes > 0) return 'canceled';

  const latest = await getOrder(id);
  if (!latest) return 'not_found';
  if (latest.status === 'canceled') return 'canceled';
  return 'not_active';
}

export async function markPaid(id: string): Promise<string> {
  const o = await getOrder(id);
  if (!o) return 'Not found';
  if (o.status !== 'fulfilling') return `Order ${id} not in fulfillment`;
  await dbRun("UPDATE orders SET status = 'active' WHERE id = ? AND status = 'fulfilling'", [id]);
  return `Order ${id} marked paid and active`;
}

export async function completeOrder(id: string): Promise<void> {
  await dbRun("UPDATE orders SET status = 'complete' WHERE id = ? AND status = 'active'", [id]);
}

export async function saveNhInfo(
  id: string,
  info: { nhOrderId: string; nhMarket: string; nhPrice: number; nhLimit: number; nhAmount: number }
): Promise<void> {
  await dbRun('UPDATE orders SET "nhOrderId"=?, "nhMarket"=?, "nhPrice"=?, "nhLimit"=?, "nhAmount"=? WHERE id=?', [
    info.nhOrderId,
    info.nhMarket,
    info.nhPrice,
    info.nhLimit,
    info.nhAmount,
    id,
  ]);
  await dbRun('UPDATE orders SET "fulfillmentProvider" = ? WHERE id = ?', ['nicehash', id]);
}

export async function updateExpiry(id: string, expiresAt: number): Promise<void> {
  await dbRun('UPDATE orders SET "expiresAt" = ? WHERE id = ?', [expiresAt, id]);
}

export async function listActiveExpiringOrders(): Promise<Order[]> {
  return dbAll<Order>('SELECT * FROM orders WHERE status = ? AND "expiresAt" IS NOT NULL', ['active']);
}

export async function beginFulfillment(id: string): Promise<'ok' | 'not_found' | 'already_processing' | 'not_awaiting_payment'> {
  const changes = await dbRun(
    "UPDATE orders SET status = 'fulfilling' WHERE id = ? AND (status = 'payment_required' OR status = 'pending')",
    [id]
  );
  if (changes > 0) return 'ok';

  const o = await getOrder(id);
  if (!o) return 'not_found';
  if (o.status === 'fulfilling') return 'already_processing';
  return 'not_awaiting_payment';
}

export async function rollbackFulfillment(id: string): Promise<void> {
  await dbRun(
    `UPDATE orders
     SET status = CASE
       WHEN EXISTS (SELECT 1 FROM payment_intents p WHERE p."orderId" = orders.id AND p.status = 'confirmed')
         THEN 'pending'
       ELSE 'payment_required'
     END
     WHERE id = ? AND status = 'fulfilling'`,
    [id]
  );
}

export async function markOrderPaymentObserved(id: string): Promise<void> {
  await dbRun("UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'payment_required'", [id]);
}
