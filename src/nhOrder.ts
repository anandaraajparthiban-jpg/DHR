// nhOrder.ts — NiceHash order placement/cancel.
import { ensurePool } from './pool.js';
import { btcUsd } from './pricing.js';
import { getNhBuyInfo, getNhBestMarketPrice, buildNhOrderParams, getNhAlgorithmInfo, fetchOrderbook } from './nh.js';
import { nhPrivateRequest } from './nhHttp.js';

export type NhOrderMode = 'auto' | 'standard' | 'business_fixed_speed' | 'business_fixed_duration';

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
  orderType: 'standard' | 'business';
  mode: NhOrderMode;
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

export type NhBusinessDurationVariant =
  | 'auto'
  | 'business_type_endts'
  | 'business_type_subtype_endts'
  | 'business_engine_duration'
  | 'business_engine_duration_endts'
  | 'business_engine_subtype_duration_endts';

interface NhDirectOrderPoolInput {
  poolId?: string;
  poolUrl?: string;
  worker?: string;
  poolPassword?: string;
  poolName?: string;
}

interface NhDirectOrderBaseInput extends NhDirectOrderPoolInput {
  market?: string;
  algorithm?: string;
  amount: number;
}

export interface NhDirectFixedSpeedInput extends NhDirectOrderBaseInput {
  limitEh: number;
  bottomLimitEh?: number;
}

export interface NhDirectFixedDurationInput extends NhDirectOrderBaseInput {
  hours: number;
  limitEh?: number;
  bottomLimitEh?: number;
  variant?: NhBusinessDurationVariant;
}

export interface NhDirectOrderResult {
  order: NhOrderResult;
  chosenMode: NhOrderMode;
  usedFallback: boolean;
  failures: string[];
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
  const raw = (override ?? 'auto').trim().toLowerCase();
  if (raw === 'auto') return 'auto';
  if (raw === 'business_fixed_speed') return 'business_fixed_speed';
  if (raw === 'business_fixed_duration') return 'business_fixed_duration';
  if (raw === 'standard') return 'standard';
  return 'auto';
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

function validateBusinessBottomLimit(bottomLimit: number, limit: number | undefined, algoInfo: Awaited<ReturnType<typeof getNhAlgorithmInfo>>) {
  if (!isFinite(bottomLimit) || bottomLimit <= 0) {
    throw new Error(`Business order bottomLimit must be > 0. Received ${bottomLimit}.`);
  }
  if (typeof limit === 'number' && isFinite(limit) && bottomLimit > limit) {
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

function normalizeDirectMarket(
  requestedMarket: string | undefined,
  algoInfo: Awaited<ReturnType<typeof getNhAlgorithmInfo>>
): string {
  const enabled = algoInfo.enabledMarkets.map((m) => m.toUpperCase()).filter(Boolean);
  if (requestedMarket && requestedMarket.trim()) {
    const desired = requestedMarket.trim().toUpperCase();
    if (enabled.length === 0 || enabled.includes(desired)) return desired;
    throw new Error(`Market ${desired} is not enabled for ${algoInfo.algorithm}. Enabled markets: ${enabled.join(', ')}`);
  }
  if (enabled.length > 0) return enabled[0];
  return 'EU';
}

function directMarketAndPriceFactors(
  algoInfo: Awaited<ReturnType<typeof getNhAlgorithmInfo>>
): { displayMarketFactor: string; displayPriceFactor: string; marketFactor?: string; priceFactor?: string } {
  const displayMarketFactor = algoInfo.displayMarketFactor || 'EH';
  const displayPriceFactor = algoInfo.displayPriceFactor || 'EH';
  const marketFactor = normalizeFactor(String(algoInfo.raw?.marketFactor ?? ''), algoInfo.marketFactor);
  const priceFactor = normalizeFactor(String(algoInfo.raw?.priceFactor ?? ''), algoInfo.priceFactor);
  return { displayMarketFactor, displayPriceFactor, marketFactor, priceFactor };
}

function withDirectFactors(
  basePayload: Record<string, unknown>,
  factors: { marketFactor?: string; priceFactor?: string }
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...basePayload };
  if (factors.marketFactor) payload.marketFactor = factors.marketFactor;
  if (factors.priceFactor) payload.priceFactor = factors.priceFactor;
  return payload;
}

async function resolveDirectPoolId(input: NhDirectOrderPoolInput, algorithm: string): Promise<string> {
  if (input.poolId && input.poolId.trim()) return input.poolId.trim();
  if (!input.poolUrl || !input.worker) {
    throw new Error('Provide either poolId or both poolUrl and worker.');
  }

  const parsed = new URL(input.poolUrl.replace('stratum+tcp://', 'http://').replace('stratum+ssl://', 'https://'));
  const host = parsed.hostname;
  const port = Number(parsed.port);
  if (!host || !port) throw new Error('Invalid pool URL');

  return ensurePool({
    algorithm,
    host,
    port,
    username: input.worker,
    password: input.poolPassword || 'x',
    name: input.poolName || `auto-${input.worker}-${host}`,
  });
}

async function resolveStandardFallbackPrice(algo: string, market: string): Promise<number> {
  const priceFloorMult = Math.max(1, Number(process.env.NICEHASH_ORDERBOOK_PREMIUM_MULT ?? '1.005'));
  let quote: Awaited<ReturnType<typeof fetchOrderbook>>;
  try {
    quote = await fetchOrderbook(algo, market);
  } catch {
    quote = await getNhBestMarketPrice(algo);
  }
  const price = Number((quote.btcPerEhDay * priceFloorMult).toFixed(4));
  if (!isFinite(price) || price <= 0) throw new Error(`Unable to resolve standard fallback price for ${algo}/${market}.`);
  return price;
}

interface NhDirectRequestCandidate {
  endpoint: string;
  payload: Record<string, unknown>;
  mode: NhOrderMode;
  orderType: 'standard' | 'business';
  subType?: string;
}

async function executeDirectCandidates(
  candidates: NhDirectRequestCandidate[],
  defaults: { market: string; limit: number; amount: number; poolId: string; price: number; bottomLimit?: number; endTs?: string }
): Promise<NhDirectOrderResult> {
  let chosenIndex = -1;
  let chosen: NhDirectRequestCandidate | undefined;
  let data: any;
  const failures: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      data = await nhPrivateRequest('POST', candidate.endpoint, { body: candidate.payload });
      chosenIndex = i;
      chosen = candidate;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(formatNhCreateFailure(candidate.endpoint, candidate.payload, msg));
    }
  }

  if (!data || !chosen) {
    if (failures.length > 0) throw new Error(failures.join('\n'));
    throw new Error('No NiceHash candidate could be executed.');
  }

  const id = data?.id ?? data?.orderId;
  if (!id) throw new Error('order create missing id');
  const orderId = String(id);
  let market = defaults.market;
  let amount = defaults.amount;
  let limit = defaults.limit;
  let price = defaults.price;
  let subType = typeof data?.subType === 'string' && data.subType.trim() ? data.subType : chosen.subType;
  let bottomLimit = toFiniteNumberOrUndefined(data?.bottomLimit) ?? defaults.bottomLimit;
  let endTs = (typeof data?.endTs === 'string' && data.endTs.trim() ? String(data.endTs) : undefined) ?? defaults.endTs;

  const dataAmount = Number(data?.amount);
  if (isFinite(dataAmount) && dataAmount > 0) amount = dataAmount;
  const dataLimit = Number(data?.limit);
  if (isFinite(dataLimit) && dataLimit > 0) limit = dataLimit;
  const dataPrice = Number(data?.price);
  if (isFinite(dataPrice) && dataPrice > 0) price = dataPrice;

  try {
    const snapshot = await fetchNhOrderSnapshot(orderId);
    if (snapshot) {
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
    order: {
      id: orderId,
      market,
      price,
      limit,
      amount,
      poolId: defaults.poolId,
      orderType: chosen.orderType,
      subType,
      bottomLimit,
      endTs,
    },
    chosenMode: chosen.mode,
    usedFallback: chosenIndex > 0,
    failures,
  };
}

function durationVariantOrder(variant?: NhBusinessDurationVariant): Exclude<NhBusinessDurationVariant, 'auto'>[] {
  if (variant && variant !== 'auto') return [variant];
  return [
    'business_type_endts',
    'business_type_subtype_endts',
    'business_engine_duration',
    'business_engine_duration_endts',
    'business_engine_subtype_duration_endts',
  ];
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

  const requestCandidates: NhOrderRequestCandidate[] = [];
  const envBottomLimit = Number(process.env.NICEHASH_BUSINESS_BOTTOM_LIMIT_EH ?? NaN);
  const minSpeedLimit = Number(algoInfo.minSpeedLimit);

  const withFactors = (basePayload: Record<string, unknown>): Record<string, unknown> => {
    const payload: Record<string, unknown> = { ...basePayload };
    if (marketFactor) payload.marketFactor = marketFactor;
    if (priceFactor) payload.priceFactor = priceFactor;
    return payload;
  };

  const addBusinessFixedSpeedCandidate = () => {
    validateBusinessOrderLimits(limit, amount, algoInfo);
    const payload = withFactors({
      market,
      algorithm: 'SHA256ASICBOOST',
      amount,
      poolId,
      type: 'BUSINESS',
      limit,
      displayMarketFactor,
      displayPriceFactor,
      subType: 'BUSINESS_FIXED_SPEED',
    });
    if (isFinite(envBottomLimit) && envBottomLimit > 0) {
      validateBusinessBottomLimit(envBottomLimit, limit, algoInfo);
      payload.bottomLimit = envBottomLimit;
    }
    requestCandidates.push({
      endpoint: '/main/api/v2/hashpower/business/order',
      payload,
      orderType: 'business',
      mode: 'business_fixed_speed',
      subType: 'BUSINESS_FIXED_SPEED',
    });
  };

  const addBusinessFixedDurationCandidate = () => {
    validateBusinessOrderLimits(limit, amount, algoInfo);
    validateBusinessDurationGuardrails(opts.hours);
    const endMs = Date.now() + opts.hours * 3600 * 1000;
    const endTs = new Date(endMs).toISOString();
    const bottomLimit =
      isFinite(envBottomLimit) && envBottomLimit > 0
        ? envBottomLimit
        : isFinite(minSpeedLimit) && minSpeedLimit > 0
          ? minSpeedLimit
          : limit;
    validateBusinessBottomLimit(bottomLimit, undefined, algoInfo);
    const payload = withFactors({
      market,
      algorithm: 'SHA256ASICBOOST',
      amount,
      poolId,
      type: 'BUSINESS',
      endTs,
      bottomLimit,
      displayMarketFactor,
      displayPriceFactor,
    });
    requestCandidates.push({
      endpoint: '/main/api/v2/hashpower/business/order',
      payload,
      orderType: 'business',
      mode: 'business_fixed_duration',
    });
  };

  const addStandardCandidate = () => {
    const payload = withFactors({
      market,
      algorithm: 'SHA256ASICBOOST',
      price: finalPrice,
      limit,
      amount,
      poolId,
      type: 'STANDARD',
      displayMarketFactor,
      displayPriceFactor,
    });
    requestCandidates.push({
      endpoint: '/main/api/v2/hashpower/order',
      payload,
      orderType: 'standard',
      mode: 'standard',
    });
  };

  if (orderMode === 'business_fixed_speed') {
    addBusinessFixedSpeedCandidate();
  } else if (orderMode === 'business_fixed_duration') {
    addBusinessFixedDurationCandidate();
  } else if (orderMode === 'standard') {
    addStandardCandidate();
  } else {
    // Old flow: try business fixed speed, then business duration, then standard orderbook.
    try {
      addBusinessFixedSpeedCandidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`NH auto-flow: skipping business_fixed_speed candidate cause=${msg}`);
    }
    try {
      addBusinessFixedDurationCandidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`NH auto-flow: skipping business_fixed_duration candidate cause=${msg}`);
    }
    addStandardCandidate();
  }

  if (requestCandidates.length === 0) {
    throw new Error('No valid NiceHash order request candidate could be constructed.');
  }

  const primaryCandidate = requestCandidates[0];
  const orderType = primaryCandidate.orderType;
  const bottomLimit = toFiniteNumberOrUndefined(primaryCandidate.payload.bottomLimit);
  const endTs =
    typeof primaryCandidate.payload.endTs === 'string' && primaryCandidate.payload.endTs.trim()
      ? String(primaryCandidate.payload.endTs)
      : undefined;

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
  let chosenOrderType: 'standard' | 'business' = plan.orderType;
  let chosenPayload: Record<string, unknown> | undefined;
  const failures: string[] = [];
  for (let i = 0; i < plan.requestCandidates.length; i++) {
    const candidate = plan.requestCandidates[i];
    try {
      data = await nhPrivateRequest('POST', candidate.endpoint, { body: candidate.payload });
      chosenSubType = candidate.subType;
      chosenOrderType = candidate.orderType;
      chosenPayload = candidate.payload;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(formatNhCreateFailure(candidate.endpoint, candidate.payload, msg));
    }
  }
  if (!data) {
    if (failures.length === 0) {
      const first = plan.requestCandidates[0];
      const endpoint = first?.endpoint ?? '/main/api/v2/hashpower/order';
      const payload = (first?.payload ?? {}) as Record<string, unknown>;
      throw new Error(formatNhCreateFailure(endpoint, payload, 'unknown error'));
    }
    throw new Error(failures.join('\n'));
  }
  const id = data?.id ?? data?.orderId;
  if (!id) throw new Error('order create missing id');
  const orderId = String(id);

  let market = plan.market;
  let amount = plan.amount;
  let limit = plan.limit;
  let price = plan.price;
  let subType = typeof data?.subType === 'string' && data.subType.trim() ? data.subType : chosenSubType;
  const chosenBottomLimit = toFiniteNumberOrUndefined(chosenPayload?.bottomLimit);
  const chosenEndTs =
    typeof chosenPayload?.endTs === 'string' && chosenPayload.endTs.trim() ? String(chosenPayload.endTs) : undefined;
  let bottomLimit = chosenBottomLimit ?? plan.bottomLimit;
  let endTs = chosenEndTs ?? plan.endTs;
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
    orderType: chosenOrderType,
    subType,
    bottomLimit,
    endTs,
    marketFactor: plan.marketFactor,
    priceFactor: plan.priceFactor,
  };
}

export async function createNhDirectFixedSpeedThenStandard(opts: NhDirectFixedSpeedInput): Promise<NhDirectOrderResult> {
  const algorithm = (opts.algorithm || 'SHA256ASICBOOST').trim().toUpperCase();
  if (!isFinite(opts.amount) || opts.amount <= 0) throw new Error(`Amount must be > 0 BTC. Received ${opts.amount}.`);
  if (!isFinite(opts.limitEh) || opts.limitEh <= 0) throw new Error(`Limit must be > 0 EH/s. Received ${opts.limitEh}.`);

  const algoInfo = await getNhAlgorithmInfo(algorithm);
  const market = normalizeDirectMarket(opts.market, algoInfo);
  const poolId = await resolveDirectPoolId(opts, algorithm);
  const factors = directMarketAndPriceFactors(algoInfo);
  validateBusinessOrderLimits(opts.limitEh, opts.amount, algoInfo);
  if (typeof opts.bottomLimitEh === 'number') {
    validateBusinessBottomLimit(opts.bottomLimitEh, opts.limitEh, algoInfo);
  }

  const businessPayloadBase: Record<string, unknown> = {
    market,
    algorithm,
    amount: opts.amount,
    poolId,
    type: 'BUSINESS',
    limit: opts.limitEh,
    subType: 'BUSINESS_FIXED_SPEED',
    displayMarketFactor: factors.displayMarketFactor,
    displayPriceFactor: factors.displayPriceFactor,
  };
  if (typeof opts.bottomLimitEh === 'number') businessPayloadBase.bottomLimit = opts.bottomLimitEh;

  const standardPrice = await resolveStandardFallbackPrice(algorithm, market);
  const standardPayload = withDirectFactors(
    {
      market,
      algorithm,
      amount: opts.amount,
      poolId,
      type: 'STANDARD',
      price: standardPrice,
      limit: opts.limitEh,
      displayMarketFactor: factors.displayMarketFactor,
      displayPriceFactor: factors.displayPriceFactor,
    },
    factors
  );

  const candidates: NhDirectRequestCandidate[] = [
    {
      endpoint: '/main/api/v2/hashpower/business/order',
      payload: withDirectFactors(businessPayloadBase, factors),
      mode: 'business_fixed_speed',
      orderType: 'business',
      subType: 'BUSINESS_FIXED_SPEED',
    },
    {
      endpoint: '/main/api/v2/hashpower/order',
      payload: standardPayload,
      mode: 'standard',
      orderType: 'standard',
    },
  ];

  return executeDirectCandidates(candidates, {
    market,
    limit: opts.limitEh,
    amount: opts.amount,
    poolId,
    price: standardPrice,
    bottomLimit: opts.bottomLimitEh,
  });
}

export async function createNhDirectFixedDurationThenStandard(opts: NhDirectFixedDurationInput): Promise<NhDirectOrderResult> {
  const algorithm = (opts.algorithm || 'SHA256ASICBOOST').trim().toUpperCase();
  if (!isFinite(opts.amount) || opts.amount <= 0) throw new Error(`Amount must be > 0 BTC. Received ${opts.amount}.`);
  if (!isFinite(opts.hours) || opts.hours <= 0) throw new Error(`Hours must be > 0. Received ${opts.hours}.`);

  const algoInfo = await getNhAlgorithmInfo(algorithm);
  const market = normalizeDirectMarket(opts.market, algoInfo);
  const poolId = await resolveDirectPoolId(opts, algorithm);
  const factors = directMarketAndPriceFactors(algoInfo);

  const minSpeedLimit = Number(algoInfo.minSpeedLimit);
  const bottomLimit =
    typeof opts.bottomLimitEh === 'number'
      ? opts.bottomLimitEh
      : isFinite(minSpeedLimit) && minSpeedLimit > 0
        ? minSpeedLimit
        : undefined;
  if (bottomLimit === undefined) {
    throw new Error('Bottom limit could not be derived. Provide bottomLimit explicitly.');
  }
  validateBusinessBottomLimit(bottomLimit, opts.limitEh, algoInfo);

  if (typeof opts.limitEh === 'number') {
    validateBusinessOrderLimits(opts.limitEh, opts.amount, algoInfo);
  } else if (isFinite(minSpeedLimit) && minSpeedLimit > 0) {
    validateBusinessOrderLimits(minSpeedLimit, opts.amount, algoInfo);
  } else {
    const maxSpeedLimit = Number(algoInfo.maxSpeedLimit);
    if (isFinite(maxSpeedLimit) && maxSpeedLimit > 0) {
      validateBusinessOrderLimits(Math.min(bottomLimit, maxSpeedLimit), opts.amount, algoInfo);
    }
  }

  const durationSec = Math.round(opts.hours * 3600);
  const endTs = new Date(Date.now() + opts.hours * 3600 * 1000).toISOString();
  const requestedSec = opts.hours * 3600;
  const minEndSec = resolveBusinessDurationMinEndSec();
  const canBuildDurationCandidates = requestedSec >= minEndSec;

  const candidates: NhDirectRequestCandidate[] = [];
  const buildFailures: string[] = [];
  if (canBuildDurationCandidates) {
    for (const variant of durationVariantOrder(opts.variant)) {
      const base: Record<string, unknown> = {
        market,
        algorithm,
        amount: opts.amount,
        poolId,
        bottomLimit,
        displayMarketFactor: factors.displayMarketFactor,
        displayPriceFactor: factors.displayPriceFactor,
      };
      if (typeof opts.limitEh === 'number') base.limit = opts.limitEh;

      if (variant === 'business_type_endts') {
        base.type = 'BUSINESS';
        base.endTs = endTs;
      } else if (variant === 'business_type_subtype_endts') {
        base.type = 'BUSINESS';
        base.subType = 'BUSINESS_FIXED_DURATION';
        base.endTs = endTs;
      } else if (variant === 'business_engine_duration') {
        base.type = 'BUSINESS_ENGINE';
        base.duration = durationSec;
      } else if (variant === 'business_engine_duration_endts') {
        base.type = 'BUSINESS_ENGINE';
        base.duration = durationSec;
        base.endTs = endTs;
      } else if (variant === 'business_engine_subtype_duration_endts') {
        base.type = 'BUSINESS_ENGINE';
        base.subType = 'BUSINESS_FIXED_DURATION';
        base.duration = durationSec;
        base.endTs = endTs;
      }

      candidates.push({
        endpoint: '/main/api/v2/hashpower/business/order',
        payload: withDirectFactors(base, factors),
        mode: 'business_fixed_duration',
        orderType: 'business',
        subType: typeof base.subType === 'string' ? base.subType : undefined,
      });
    }
  } else {
    buildFailures.push(
      `Business duration candidate skipped: requested duration ${Math.round(requestedSec)}s is below minimum ${minEndSec}s.`
    );
  }

  const standardLimit = typeof opts.limitEh === 'number' ? opts.limitEh : bottomLimit;
  if (!isFinite(standardLimit) || standardLimit <= 0) {
    throw new Error(`Unable to derive standard fallback limit. Received ${standardLimit}.`);
  }
  const standardPrice = await resolveStandardFallbackPrice(algorithm, market);
  const standardPayload = withDirectFactors(
    {
      market,
      algorithm,
      amount: opts.amount,
      poolId,
      type: 'STANDARD',
      price: standardPrice,
      limit: standardLimit,
      displayMarketFactor: factors.displayMarketFactor,
      displayPriceFactor: factors.displayPriceFactor,
    },
    factors
  );
  candidates.push({
    endpoint: '/main/api/v2/hashpower/order',
    payload: standardPayload,
    mode: 'standard',
    orderType: 'standard',
  });

  const result = await executeDirectCandidates(candidates, {
    market,
    limit: standardLimit,
    amount: opts.amount,
    poolId,
    price: standardPrice,
    bottomLimit,
    endTs,
  });
  result.failures = [...buildFailures, ...result.failures];
  return result;
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
