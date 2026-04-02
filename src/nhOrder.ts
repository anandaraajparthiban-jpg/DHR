// nhOrder.ts — NiceHash order placement/cancel.
import { ensurePool } from './pool.js';
import { btcUsd } from './pricing.js';
import { getNhBuyInfo, getNhBestMarketPrice, buildNhOrderParams, getNhAlgorithmInfo } from './nh.js';
import { nhPrivateRequest } from './nhHttp.js';

export type NhOrderMode = 'standard' | 'business_fixed_speed';

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
  marketFactor?: string;
  priceFactor?: string;
}

export interface NhOrderInput {
  ph: number;
  hours: number;
  poolUrl: string;
  worker: string;
  usdPerPhDay: number;
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

export function resolveNhOrderMode(): NhOrderMode {
  const raw = (process.env.NICEHASH_ORDER_MODE ?? 'standard').trim().toLowerCase();
  if (raw === 'business_fixed_speed') return 'business_fixed_speed';
  return 'standard';
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
  if (orderMode === 'business_fixed_speed') {
    validateBusinessOrderLimits(economics.limit, economics.amount, economics.algoInfo);
  }
  return { host, port, ...economics };
}

export async function ensureNhOrderSatisfiesMinimum(opts: NhOrderInput): Promise<void> {
  await resolveNhOrderDraft(opts, resolveNhOrderMode());
}

export async function ensureNhQuotedOrderSatisfiesMinimum(opts: Pick<NhOrderInput, 'ph' | 'hours' | 'usdPerPhDay'>): Promise<void> {
  const economics = await resolveNhOrderEconomics(opts);
  if (resolveNhOrderMode() === 'business_fixed_speed') {
    validateBusinessOrderLimits(economics.limit, economics.amount, economics.algoInfo);
  }
}

export async function createNhOrder(opts: NhOrderInput): Promise<NhOrderResult> {
  const orderMode = resolveNhOrderMode();
  const { worker } = opts;
  const { host, port, market, price: finalPrice, limit, amount, buyInfo, best, algoInfo } = await resolveNhOrderDraft(opts, orderMode);

  const marketInfo = buyInfo.markets.find((m) => m.market === market || m.market.toUpperCase().startsWith(market.toUpperCase()));

  const poolId = await ensurePool({
    algorithm: 'SHA256ASICBOOST',
    host,
    port,
    username: worker,
    password: 'x',
    name: `auto-${worker}-${host}`,
  });

  const displayMarketFactor = algoInfo.displayMarketFactor || marketInfo?.displayMarketFactor || best.displayMarketFactor || 'EH';
  const displayPriceFactor = algoInfo.displayPriceFactor || marketInfo?.displayPriceFactor || best.displayPriceFactor || 'EH';
  const marketFactor =
    normalizeFactor(String(algoInfo.raw?.marketFactor ?? ''), algoInfo.marketFactor) ??
    normalizeFactor(best.marketFactorRaw, marketInfo?.marketFactor ?? best.marketFactor);
  const priceFactor =
    normalizeFactor(String(algoInfo.raw?.priceFactor ?? ''), algoInfo.priceFactor) ??
    normalizeFactor(best.priceFactorRaw, marketInfo?.priceFactor ?? best.priceFactor);

  let data: any;
  let payload: any;
  let endpoint = '/main/api/v2/hashpower/order';
  let orderType: 'standard' | 'business' = 'standard';
  let subType: string | undefined;
  let bottomLimit: number | undefined;
  if (orderMode === 'business_fixed_speed') {
    endpoint = '/main/api/v2/hashpower/business/order';
    orderType = 'business';
    subType = 'BUSINESS_FIXED_SPEED';
    payload = {
      market,
      algorithm: 'SHA256ASICBOOST',
      amount,
      limit,
      poolId,
      subType,
      displayMarketFactor,
      displayPriceFactor,
    };
    const envBottomLimit = Number(process.env.NICEHASH_BUSINESS_BOTTOM_LIMIT_EH ?? NaN);
    if (isFinite(envBottomLimit) && envBottomLimit > 0) {
      if (envBottomLimit > limit) throw new Error(`Business order bottomLimit ${envBottomLimit} cannot exceed limit ${limit}.`);
      const minSpeedLimit = Number(algoInfo.minSpeedLimit);
      if (isFinite(minSpeedLimit) && minSpeedLimit > 0 && envBottomLimit < minSpeedLimit) {
        throw new Error(`Business order bottomLimit ${envBottomLimit} is below minSpeedLimit ${minSpeedLimit}.`);
      }
      bottomLimit = envBottomLimit;
      payload.bottomLimit = envBottomLimit;
    }
  } else {
    payload = {
      market,
      algorithm: 'SHA256ASICBOOST',
      // Keep numeric values quantized in nh.ts to satisfy NH data scale validators.
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
  try {
    data = await nhPrivateRequest('POST', endpoint, { body: payload });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`NH order create failed endpoint=${endpoint} payload=${JSON.stringify(payload)} cause=${msg}`);
  }
  const id = data?.id ?? data?.orderId;
  if (!id) throw new Error('order create missing id');

  return { id: String(id), market, price: finalPrice, limit, amount, poolId, orderType, subType, bottomLimit, marketFactor, priceFactor };
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
