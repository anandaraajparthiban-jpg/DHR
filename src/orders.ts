import crypto from 'node:crypto';
import { db } from './db.js';

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
  proxySessionId?: string;
}

// Prepared statements for CRUD
const insertStmt = db.prepare(
  'INSERT INTO orders (id, ph, hours, pool, worker, requestedProvider, user, status, totalUsd, createdAt, nhOrderId, nhMarket, nhPrice, nhLimit, nhAmount, expiresAt, fulfillmentProvider, proxySessionId) VALUES (@id,@ph,@hours,@pool,@worker,@requestedProvider,@user,@status,@totalUsd,@createdAt,@nhOrderId,@nhMarket,@nhPrice,@nhLimit,@nhAmount,@expiresAt,@fulfillmentProvider,@proxySessionId)'
);
const getStmt = db.prepare('SELECT * FROM orders WHERE id = ?');
const updateStatusStmt = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
const updateNhStmt = db.prepare('UPDATE orders SET nhOrderId=?, nhMarket=?, nhPrice=?, nhLimit=?, nhAmount=? WHERE id=?');
const updateExpiresStmt = db.prepare('UPDATE orders SET expiresAt=? WHERE id=?');
const listActiveExpiringStmt = db.prepare('SELECT * FROM orders WHERE status = ? AND expiresAt IS NOT NULL');
const beginFulfillmentStmt = db.prepare(
  "UPDATE orders SET status = 'fulfilling' WHERE id = ? AND (status = 'payment_required' OR status = 'pending')"
);
const activateFulfillmentStmt = db.prepare("UPDATE orders SET status = 'active' WHERE id = ? AND status = 'fulfilling'");
const rollbackFulfillmentStmt = db.prepare(
  `UPDATE orders
   SET status = CASE
     WHEN EXISTS (SELECT 1 FROM payment_intents p WHERE p.orderId = orders.id AND p.status = 'confirmed')
       THEN 'pending'
     ELSE 'payment_required'
   END
   WHERE id = ? AND status = 'fulfilling'`
);
const markPendingPaymentStmt = db.prepare("UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'payment_required'");
const updateFulfillmentProviderStmt = db.prepare('UPDATE orders SET fulfillmentProvider = ? WHERE id = ?');
const updateProxyInfoStmt = db.prepare('UPDATE orders SET fulfillmentProvider = ?, proxySessionId = ? WHERE id = ?');

// Create a new order in DB with default status payment_required and computed expiry.
export async function createOrder(input: OrderInput): Promise<Order> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + input.hours * 3600 * 1000;
  const order: any = {
    id,
    status: 'payment_required',
    createdAt: now,
    nhOrderId: null,
    nhMarket: null,
    nhPrice: null,
    nhLimit: null,
    nhAmount: null,
    expiresAt,
    fulfillmentProvider: null,
    proxySessionId: null,
    ...input,
  };
  insertStmt.run(order);
  return order as Order;
}

// Fetch single order
export async function getOrder(id: string): Promise<Order | undefined> {
  const row = getStmt.get(id) as Order | undefined;
  return row;
}

// Human-readable status string
export async function getOrderStatus(id: string): Promise<string> {
  const o = await getOrder(id);
  if (!o) return 'Not found';
  return `Order ${id}: ${o.status}, ${o.ph} PH for ${o.hours}h to ${o.pool} worker ${o.worker}`;
}

// Cancel if not active
export async function cancelOrder(id: string): Promise<string> {
  const o = await getOrder(id);
  if (!o) return 'Not found';
  if (o.status === 'active' || o.status === 'fulfilling') return `Cannot cancel order in status ${o.status}`;
  updateStatusStmt.run('canceled', id);
  return `Order ${id} canceled`;
}

// Mark paid -> active
export async function markPaid(id: string): Promise<string> {
  const o = await getOrder(id);
  if (!o) return 'Not found';
  if (o.status !== 'fulfilling') return `Order ${id} not in fulfillment`;
  activateFulfillmentStmt.run(id);
  return `Order ${id} marked paid and active`;
}

// Complete order after rental window closes.
export async function completeOrder(id: string): Promise<void> {
  db.prepare("UPDATE orders SET status = 'complete' WHERE id = ? AND status = 'active'").run(id);
}

// Store NH order metadata
export async function saveNhInfo(id: string, info: { nhOrderId: string; nhMarket: string; nhPrice: number; nhLimit: number; nhAmount: number }) {
  updateNhStmt.run(info.nhOrderId, info.nhMarket, info.nhPrice, info.nhLimit, info.nhAmount, id);
  updateFulfillmentProviderStmt.run('nicehash', id);
}

// Store proxy session metadata
export async function saveProxyInfo(id: string, info: { proxySessionId: string }) {
  updateProxyInfoStmt.run('proxy', info.proxySessionId, id);
}

// Store fulfillment provider only
export async function saveFulfillmentProvider(id: string, provider: string) {
  updateFulfillmentProviderStmt.run(provider, id);
}

// Store expiry timestamp
export async function updateExpiry(id: string, expiresAt: number) {
  updateExpiresStmt.run(expiresAt, id);
}

// Active NH-backed orders that should be canceled at expiry.
export async function listActiveExpiringOrders(): Promise<Order[]> {
  return listActiveExpiringStmt.all('active') as Order[];
}

// Move order into fulfillment atomically to prevent duplicate provider placements.
export async function beginFulfillment(id: string): Promise<'ok' | 'not_found' | 'already_processing' | 'not_awaiting_payment'> {
  const updated = beginFulfillmentStmt.run(id);
  if (updated.changes > 0) return 'ok';
  const o = await getOrder(id);
  if (!o) return 'not_found';
  if (o.status === 'fulfilling') return 'already_processing';
  return 'not_awaiting_payment';
}

// Roll fulfillment back to payment-required when provider placement fails.
export async function rollbackFulfillment(id: string): Promise<void> {
  rollbackFulfillmentStmt.run(id);
}

// Mark that payment has been observed and order is waiting admin activation.
export async function markOrderPaymentObserved(id: string): Promise<void> {
  markPendingPaymentStmt.run(id);
}
