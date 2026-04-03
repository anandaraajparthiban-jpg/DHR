// nhOrder.ts — NiceHash order placement/cancel.
import { ensurePool } from './pool.js';
import { btcUsd } from './pricing.js';
import { getNhBuyInfo, getNhBestMarketPrice, buildNhOrderParams, getNhAlgorithmInfo } from './nh.js';
import { nhPrivateRequest } from './nhHttp.js';

export type NhOrderMode = 'standard' | 'business_fixed_speed' | 'business_fixed_duration';

export interface NhOrderResult {
  id: string;
  market: string;
  price: number;
  limit: number;
  amount: number;
  poolId: string;
  orderType: 'standard' | 'business';
  subType?: string;
  bottomLimit?: number;
  endTs?: string;
  marketFactor?: string;
  priceFactor?: string;
}

export interface NhOrderRequestCandidate {
  endpoint: string;
  payload: Record<string, unknown>;
  subType?: string;
}

export interface NhOrderPlacementPlan {
  mode: NhOrderMode;
  orderType: 'standard' | 'business';
  market: string;
  price: number;
  limit: number;
  amount: number;
  poolId: string;
  poolIdResolved: boolean;
  marketFactor?: string;
  priceFactor?: string;
  bottomLimit?: number;
  endTs?: string;
  requestCandidates: NhOrderRequestCandidate[];
}

export interface NhOrderInput {
  ph: number;
  hours: number;
  poolUrl: string;
  worker: string;
  usdPerPhDay: number;
  orderMode?: NhOrderMode;
}

interface BuildNhOrderPlanOptions {
  resolvePoolId: boolean;
  poolIdPlaceholder?: string;
}

interface NhOrderEconomics {
  market: string;
  price: number;
  limit: number;
  amount: number;
  buyInfo: Awaited<ReturnType<typeof getNhBuyInfo>>;
  best: Awaited<ReturnType<typeof getNhBestMarketPrice>>;
  algoInfo: Awaited<ReturnType<typeof getNhAlgorithmInfo>>;
}

export function resolveNhOrderMode(override?: string): NhOrderMode {
  const raw = (override ?? process.env.NICEHASH_ORDER_MODE ?? 'standard').trim().toLowerCase();
  if (raw === 'business_fixed_speed') return 'business_fixed_speed';
  if (raw === 'business_fixed_duration') return 'business_fixed_duration';
  return 'standard';
}

function resolveBusinessDurationMinEndSec(): number {
  const raw = Number(process.env.NICEHASH_BUSINESS_DURATION_MIN_END_SEC ?? '900');
  if (!isFinite(raw) || raw <= 0) return 900;
  return Math.max(60, Math.floor(raw));
}

async function resolveNhOrderEconomics(opts: Pick<NhOrderInput, 'ph' | 'hours' | 'usdPerPhDay'>): Promise<NhOrderEconomics> {
  const { ph, hours, usdPerPhDay } = opts;

  const buyInfo = await getNhBuyInfo('SHA256ASICBOOST');
  const best = await getNhBestMarketPrice('SHA256ASICBOOST');
  const algoInfo = await getNhAlgorithmInfo('SHA256ASICBOOST');
  const preferredMarket =
    algoInfo.enabledMarkets.length > 0 && !algoInfo.enabledMarkets.includes(best.market.toUpperCase())
      ? algoInfo.enabledMarkets[0]
      : best.market;
  const btcPrice = await btcUsd();
  const { price, limit, amount, market } = buildNhOrderParams({
    ph,
    hours,
    usdPerPhDay,
    market: preferredMarket,
    algo: 'SHA256ASICBOOST',
    btcPrice,
    buyInfo,
  });
  const priceFloorMult = Math.max(1, Number(process.env.NICEHASH_ORDERBOOK_PREMIUM_MULT ?? '1.005'));
  const priceFromBook = Number((best.btcPerEhDay * priceFloorMult).toFixed(4));
  const finalPrice = Math.max(price, priceFromBook);

  return { market, price: finalPrice, limit, amount, buyInfo, best, algoInfo };
}

function normalizeFactor(raw?: string, fallback?: number): string | undefined {
  if (raw && raw.trim()) {
    return raw.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }
  if (Number.isFinite(fallback) && (fallback ?? 0) > 0) {
    const n = Number(fallback);
    return Number.isInteger(n) ? String(n) : n.toFixed(8).replace(/(\.\d*?)0+$/, '$1');
  }
  return undefined;
}

function validateBusinessOrderLimits(limit: number, amount: number, algoInfo: Awaited<ReturnType<typeof getNhAlgorithmInfo>>) {
  const minSpeedLimit = Number(algoInfo.minSpeedLimit);
  const maxSpeedLimit = Number(algoInfo.maxSpeedLimit);
  const minimalOrderAmount = Number(algoInfo.minimalOrderAmount);

  if (isFinite(minSpeedLimit) && minSpeedLimit > 0 && limit < minSpeedLimit) {
    throw new Error(
      `Business order speed limit ${limit.toFixed(8)} EH is below minimum ${minSpeedLimit.toFixed(8)} EH for ${algoInfo.algorithm}.`
    );
  }
  if (isFinite(maxSpeedLimit) && maxSpeedLimit > 0 && limit > maxSpeedLimit) {
    throw new Error(
      `Business order speed limit ${limit.toFixed(8)} EH exceeds maximum ${maxSpeedLimit.toFixed(8)} EH for ${algoInfo.algorithm}.`
    );
  }
  if (isFinite(minimalOrderAmount) && minimalOrderAmount > 0 && amount < minimalOrderAmount) {
    throw new Error(
      `Business order amount ${amount.toFixed(8)} BTC is below minimum ${minimalOrderAmount.toFixed(8)} BTC for ${algoInfo.algorithm}.`
    );
  }
}

function validateBusinessBottomLimit(bottomLimit: number, limit: number, algoInfo: Awaited<ReturnType<typeof getNhAlgorithmInfo>>) {
  if (!isFinite(bottomLimit) || bottomLimit <= 0) {
    throw new Error(`Business order bottomLimit must be > 0. Received ${bottomLimit}.`);
  }
  if (bottomLimit > limit) {
    throw new Error(`Business order bottomLimit ${bottomLimit} cannot exceed limit ${limit}.`);
  }
  const minSpeedLimit = Number(algoInfo.minSpeedLimit);
  if (isFinite(minSpeedLimit) && minSpeedLimit > 0 && bottomLimit < minSpeedLimit) {
    throw new Error(`Business order bottomLimit ${bottomLimit} is below minSpeedLimit ${minSpeedLimit}.`);
  }
}

function validateBusinessDurationGuardrails(hours: number): void {
  if (!isFinite(hours) || hours <= 0) throw new Error(`Business duration mode requires hours > 0. Received ${hours}.`);
  const requestedSec = hours * 3600;
  const minEndSec = resolveBusinessDurationMinEndSec();
  if (requestedSec < minEndSec) {
    throw new Error(
      `Business duration order end window ${requestedSec}s is below minimum ${minEndSec}s (NICEHASH_BUSINESS_DURATION_MIN_END_SEC).`
    );
  }
}

function extractNhErrorCodes(message: string): number[] {
  const matches = [...message.matchAll(/"code"\s*:\s*(\d+)/g)];
  const codes = matches
    .map((m) => Number(m[1]))
    .filter((n) => isFinite(n))
    .map((n) => Math.trunc(n));
  return Array.from(new Set(codes));
}

function isNhAllocationCapacityError(message: string): boolean {
  const codes = extractNhErrorCodes(message);
  if (codes.includes(5191)) return true;
  return message.toLowerCase().includes('unable to allocate hashrate');
}

function formatNhCreateFailure(endpoint: string, payload: Record<string, unknown>, cause: string): string {
  if (isNhAllocationCapacityError(cause)) {
    return (
      `NiceHash capacity unavailable (code 5191): unable to allocate hashrate for this package right now. ` +
      `Try again later, reduce requested PH/duration, widen speed constraints, or switch mode/market. ` +
      `endpoint=${endpoint} payload=${JSON.stringify(payload)} cause=${cause}`
    );
  }
  return `NH order create failed endpoint=${endpoint} payload=${JSON.stringify(payload)} cause=${cause}`;
}

async function resolveNhOrderDraft(
  opts: NhOrderInput,
  orderMode: NhOrderMode
): Promise<NhOrderEconomics & { host: string; port: number }> {
  const { poolUrl } = opts;

  const parsed = new URL(poolUrl.replace('stratum+tcp://', 'http://').replace('stratum+ssl://', 'https://'));
  const host = parsed.hostname;
  const port = Number(parsed.port);
  if (!host || !port) throw new Error('Invalid pool URL');

  const economics = await resolveNhOrderEconomics(opts);
  if (orderMode === 'business_fixed_speed' || orderMode === 'business_fixed_duration') {
    validateBusinessOrderLimits(economics.limit, economics.amount, economics.algoInfo);
    if (orderMode === 'business_fixed_duration') {
      validateBusinessDurationGuardrails(opts.hours);
    }
  }
  return { host, port, ...economics };
}

export async function ensureNhOrderSatisfiesMinimum(opts: NhOrderInput): Promise<void> {
  await resolveNhOrderDraft(opts, resolveNhOrderMode(opts.orderMode));
}

export async function ensureNhQuotedOrderSatisfiesMinimum(
  opts: Pick<NhOrderInput, 'ph' | 'hours' | 'usdPerPhDay' | 'orderMode'>
): Promise<void> {
  const economics = await resolveNhOrderEconomics(opts);
  const orderMode = resolveNhOrderMode(opts.orderMode);
  if (orderMode === 'business_fixed_speed' || orderMode === 'business_fixed_duration') {
    validateBusinessOrderLimits(economics.limit, economics.amount, economics.algoInfo);
    if (orderMode === 'business_fixed_duration') {
      validateBusinessDurationGuardrails(opts.hours);
    }
  }
}

async function buildNhOrderPlacementPlan(opts: NhOrderInput, options: BuildNhOrderPlanOptions): Promise<NhOrderPlacementPlan> {
  const orderMode = resolveNhOrderMode(opts.orderMode);
  const { worker } = opts;
  const { host, port, market, price: finalPrice, limit, amount, buyInfo, best, algoInfo } = await resolveNhOrderDraft(opts, orderMode);

  const marketInfo = buyInfo.markets.find((m) => m.market === market || m.market.toUpperCase().startsWith(market.toUpperCase()));
  const poolId = options.resolvePoolId
    ? await ensurePool({
        algorithm: 'SHA256ASICBOOST',
        host,
        port,
        username: worker,
        password: 'x',
        name: `auto-${worker}-${host}`,
      })
    : (options.poolIdPlaceholder?.trim() || '<resolved_at_order_time>');

  const displayMarketFactor = algoInfo.displayMarketFactor || marketInfo?.displayMarketFactor || best.displayMarketFactor || 'EH';
  const displayPriceFactor = algoInfo.displayPriceFactor || marketInfo?.displayPriceFactor || best.displayPriceFactor || 'EH';
  const marketFactor =
    normalizeFactor(String(algoInfo.raw?.marketFactor ?? ''), algoInfo.marketFactor) ??
    normalizeFactor(best.marketFactorRaw, marketInfo?.marketFactor ?? best.marketFactor);
  const priceFactor =
    normalizeFactor(String(algoInfo.raw?.priceFactor ?? ''), algoInfo.priceFactor) ??
    normalizeFactor(best.priceFactorRaw, marketInfo?.priceFactor ?? best.priceFactor);

  let endpoint = '/main/api/v2/hashpower/order';
  let orderType: 'standard' | 'business' = 'standard';
  let payload: Record<string, unknown>;
  let bottomLimit: number | undefined;
  let endTs: string | undefined;
  if (orderMode === 'business_fixed_speed' || orderMode === 'business_fixed_duration') {
    endpoint = '/main/api/v2/hashpower/business/order';
    orderType = 'business';
    const envBottomLimit = Number(process.env.NICEHASH_BUSINESS_BOTTOM_LIMIT_EH ?? NaN);
    const minSpeedLimit = Number(algoInfo.minSpeedLimit);
    if (orderMode === 'business_fixed_duration') {
      const endMs = Date.now() + opts.hours * 3600 * 1000;
      endTs = new Date(endMs).toISOString();
      bottomLimit =
        isFinite(envBottomLimit) && envBottomLimit > 0
          ? envBottomLimit
          : isFinite(minSpeedLimit) && minSpeedLimit > 0
            ? minSpeedLimit
            : limit;
      validateBusinessBottomLimit(bottomLimit, limit, algoInfo);
    } else if (isFinite(envBottomLimit) && envBottomLimit > 0) {
      bottomLimit = envBottomLimit;
      validateBusinessBottomLimit(bottomLimit, limit, algoInfo);
    }
    payload = {
      market,
      algorithm: 'SHA256ASICBOOST',
      amount,
      limit,
      poolId,
      displayMarketFactor,
      displayPriceFactor,
    };
    if (typeof bottomLimit === 'number') payload.bottomLimit = bottomLimit;
    if (endTs) payload.endTs = endTs;
  } else {
    payload = {
      market,
      algorithm: 'SHA256ASICBOOST',
      price: finalPrice,
      limit,
      amount,
      poolId,
      type: 'STANDARD',
      displayMarketFactor,
      displayPriceFactor,
    };
  }
  if (marketFactor) payload.marketFactor = marketFactor;
  if (priceFactor) payload.priceFactor = priceFactor;

  const requestCandidates: NhOrderRequestCandidate[] =
    orderType === 'business'
      ? [
          {
            endpoint,
            subType: orderMode === 'business_fixed_duration' ? 'BUSINESS_FIXED_DURATION' : 'BUSINESS_FIXED_SPEED',
            payload: {
              ...payload,
              subType: orderMode === 'business_fixed_duration' ? 'BUSINESS_FIXED_DURATION' : 'BUSINESS_FIXED_SPEED',
            },
          },
        ]
      : [
          {
            endpoint,
            payload: { ...payload },
          },
        ];

  return {
    mode: orderMode,
    orderType,
    market,
    price: finalPrice,
    limit,
    amount,
    poolId,
    poolIdResolved: options.resolvePoolId,
    marketFactor,
    priceFactor,
    bottomLimit,
    endTs,
    requestCandidates,
  };
}

export async function previewNhOrderPlacement(
  opts: NhOrderInput,
  options: { resolvePoolId?: boolean; poolIdPlaceholder?: string } = {}
): Promise<NhOrderPlacementPlan> {
  return buildNhOrderPlacementPlan(opts, {
    resolvePoolId: options.resolvePoolId ?? false,
    poolIdPlaceholder: options.poolIdPlaceholder,
  });
}

function toFiniteNumberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return isFinite(n) ? n : undefined;
}

interface NhOrderSnapshot {
  id: string;
  market?: string;
  amount?: number;
  limit?: number;
  price?: number;
  subType?: string;
  bottomLimit?: number;
  endTs?: string;
}

function parseNhOrderSnapshot(data: any): NhOrderSnapshot | undefined {
  const order = data?.order ?? data?.body?.order ?? data?.body ?? data;
  const id = order?.id ?? order?.orderId;
  if (!id) return undefined;
  const parsed: NhOrderSnapshot = { id: String(id) };
  if (typeof order?.market === 'string' && order.market.trim()) parsed.market = order.market;
  const amount = toFiniteNumberOrUndefined(order?.amount);
  if (amount !== undefined) parsed.amount = amount;
  const limit = toFiniteNumberOrUndefined(order?.limit);
  if (limit !== undefined) parsed.limit = limit;
  const price = toFiniteNumberOrUndefined(order?.price);
  if (price !== undefined) parsed.price = price;
  if (typeof order?.subType === 'string' && order.subType.trim()) parsed.subType = order.subType;
  const bottomLimit = toFiniteNumberOrUndefined(order?.bottomLimit);
  if (bottomLimit !== undefined) parsed.bottomLimit = bottomLimit;
  if (typeof order?.endTs === 'string' && order.endTs.trim()) parsed.endTs = order.endTs;
  return parsed;
}

async function fetchNhOrderSnapshot(orderId: string): Promise<NhOrderSnapshot | undefined> {
  const data = await nhPrivateRequest('GET', `/main/api/v2/hashpower/order/${encodeURIComponent(orderId)}`);
  return parseNhOrderSnapshot(data);
}

function warnOrderMismatch(orderId: string, field: string, requested: string | number | undefined, actual: string | number | undefined): void {
  if (requested === undefined || actual === undefined) return;
  if (typeof requested === 'number' && typeof actual === 'number') {
    if (Math.abs(requested - actual) <= 1e-10) return;
  } else if (String(requested) === String(actual)) {
    return;
  }
  console.warn(`NiceHash post-create verification mismatch order=${orderId} field=${field} requested=${requested} actual=${actual}`);
}

export async function createNhOrder(opts: NhOrderInput): Promise<NhOrderResult> {
  const plan = await buildNhOrderPlacementPlan(opts, { resolvePoolId: true });
  let data: any;
  let chosenSubType: string | undefined;
  for (let i = 0; i < plan.requestCandidates.length; i++) {
    const candidate = plan.requestCandidates[i];
    try {
      data = await nhPrivateRequest('POST', candidate.endpoint, { body: candidate.payload });
      chosenSubType = candidate.subType;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(formatNhCreateFailure(candidate.endpoint, candidate.payload, msg));
    }
  }
  if (!data) {
    const first = plan.requestCandidates[0];
    const endpoint = first?.endpoint ?? '/main/api/v2/hashpower/order';
    const payload = (first?.payload ?? {}) as Record<string, unknown>;
    throw new Error(formatNhCreateFailure(endpoint, payload, 'unknown error'));
  }
  const id = data?.id ?? data?.orderId;
  if (!id) throw new Error('order create missing id');
  const orderId = String(id);

  let market = plan.market;
  let amount = plan.amount;
  let limit = plan.limit;
  let price = plan.price;
  let subType = typeof data?.subType === 'string' && data.subType.trim() ? data.subType : chosenSubType;
  let bottomLimit = plan.bottomLimit;
  let endTs = plan.endTs;
  const dataBottomLimit = Number(data?.bottomLimit);
  if (isFinite(dataBottomLimit) && dataBottomLimit > 0) bottomLimit = dataBottomLimit;
  if (typeof data?.endTs === 'string' && data.endTs.trim()) endTs = data.endTs;
  const dataAmount = Number(data?.amount);
  if (isFinite(dataAmount) && dataAmount > 0) amount = dataAmount;
  const dataLimit = Number(data?.limit);
  if (isFinite(dataLimit) && dataLimit > 0) limit = dataLimit;
  const dataPrice = Number(data?.price);
  if (isFinite(dataPrice) && dataPrice > 0) price = dataPrice;

  try {
    const snapshot = await fetchNhOrderSnapshot(orderId);
    if (snapshot) {
      warnOrderMismatch(orderId, 'market', market, snapshot.market);
      warnOrderMismatch(orderId, 'amount', amount, snapshot.amount);
      warnOrderMismatch(orderId, 'limit', limit, snapshot.limit);
      if (snapshot.market) market = snapshot.market;
      if (snapshot.amount !== undefined) amount = snapshot.amount;
      if (snapshot.limit !== undefined) limit = snapshot.limit;
      if (snapshot.price !== undefined) price = snapshot.price;
      if (snapshot.subType) subType = snapshot.subType;
      if (snapshot.bottomLimit !== undefined) bottomLimit = snapshot.bottomLimit;
      if (snapshot.endTs) endTs = snapshot.endTs;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`NiceHash post-create verification failed order=${orderId} cause=${msg}`);
  }

  return {
    id: orderId,
    market,
    price,
    limit,
    amount,
    poolId: plan.poolId,
    orderType: plan.orderType,
    subType,
    bottomLimit,
    endTs,
    marketFactor: plan.marketFactor,
    priceFactor: plan.priceFactor,
  };
}

export async function cancelNhOrder(orderId: string): Promise<void> {
  try {
    await nhPrivateRequest('DELETE', `/main/api/v2/hashpower/order/${encodeURIComponent(orderId)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('http 404') ||
      msg.toLowerCase().includes('not found') ||
      msg.includes('"code":5058') ||
      msg.toLowerCase().includes('order already expired')
    ) {
      return;
    }
    throw err;
  }
}
