// nhOrder.ts — NiceHash order placement/cancel.
import { ensurePool } from './pool.js';
import { btcUsd } from './pricing.js';
import { getNhBuyInfo, getNhBestMarketPrice, buildNhOrderParams } from './nh.js';
import { nhPrivateRequest } from './nhHttp.js';

export interface NhOrderResult {
  id: string;
  market: string;
  price: number;
  limit: number;
  amount: number;
  poolId: string;
}

export interface NhOrderInput {
  ph: number;
  hours: number;
  poolUrl: string;
  worker: string;
  usdPerPhDay: number;
}

async function resolveNhOrderDraft(opts: NhOrderInput): Promise<{
  host: string;
  port: number;
  market: string;
  price: number;
  limit: number;
  amount: number;
  buyInfo: Awaited<ReturnType<typeof getNhBuyInfo>>;
  best: Awaited<ReturnType<typeof getNhBestMarketPrice>>;
}> {
  const { ph, hours, poolUrl, worker, usdPerPhDay } = opts;

  const parsed = new URL(poolUrl.replace('stratum+tcp://', 'http://').replace('stratum+ssl://', 'https://'));
  const host = parsed.hostname;
  const port = Number(parsed.port);
  if (!host || !port) throw new Error('Invalid pool URL');

  const buyInfo = await getNhBuyInfo('SHA256ASICBOOST');
  const best = await getNhBestMarketPrice('SHA256ASICBOOST');
  const btcPrice = await btcUsd();
  const { price, limit, amount, market } = buildNhOrderParams({
    ph,
    hours,
    usdPerPhDay,
    market: best.market,
    algo: 'SHA256ASICBOOST',
    btcPrice,
    buyInfo,
  });
  const priceFloorMult = Math.max(1, Number(process.env.NICEHASH_ORDERBOOK_PREMIUM_MULT ?? '1.005'));
  const priceFromBook = Number((best.btcPerEhDay * priceFloorMult).toFixed(4));
  const finalPrice = Math.max(price, priceFromBook);

  return { host, port, market, price: finalPrice, limit, amount, buyInfo, best };
}

export async function ensureNhOrderSatisfiesMinimum(opts: NhOrderInput): Promise<void> {
  await resolveNhOrderDraft(opts);
}

export async function createNhOrder(opts: NhOrderInput): Promise<NhOrderResult> {
  const { worker } = opts;
  const { host, port, market, price: finalPrice, limit, amount, buyInfo, best } = await resolveNhOrderDraft(opts);

  const marketInfo = buyInfo.markets.find((m) => m.market === market || m.market.toUpperCase().startsWith(market.toUpperCase()));

  const poolId = await ensurePool({
    algorithm: 'SHA256ASICBOOST',
    host,
    port,
    username: worker,
    password: 'x',
    name: `auto-${worker}-${host}`,
  });

  const payload: any = {
    market,
    algorithm: 'SHA256ASICBOOST',
    // Keep numeric values quantized in nh.ts to satisfy NH data scale validators.
    price: finalPrice,
    limit,
    amount,
    poolId,
    type: 'STANDARD',
  };
  const normalizeFactor = (raw?: string, fallback?: number): string | undefined => {
    if (raw && raw.trim()) {
      // Keep full precision but strip no-op trailing zeros after decimal point.
      return raw.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    }
    if (Number.isFinite(fallback) && (fallback ?? 0) > 0) {
      const n = Number(fallback);
      return Number.isInteger(n) ? String(n) : n.toFixed(8).replace(/(\.\d*?)0+$/, '$1');
    }
    return undefined;
  };
  const displayMarketFactor = marketInfo?.displayMarketFactor || best.displayMarketFactor || 'EH';
  const displayPriceFactor = marketInfo?.displayPriceFactor || best.displayPriceFactor || 'EH';
  const marketFactor = normalizeFactor(best.marketFactorRaw, marketInfo?.marketFactor ?? best.marketFactor);
  const priceFactor = normalizeFactor(best.priceFactorRaw, marketInfo?.priceFactor ?? best.priceFactor);
  payload.displayMarketFactor = displayMarketFactor;
  payload.displayPriceFactor = displayPriceFactor;
  if (marketFactor) payload.marketFactor = marketFactor;
  if (priceFactor) payload.priceFactor = priceFactor;

  let data: any;
  try {
    data = await nhPrivateRequest('POST', '/main/api/v2/hashpower/order', { body: payload });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`NH order create failed payload=${JSON.stringify(payload)} cause=${msg}`);
  }
  const id = data?.id;
  if (!id) throw new Error('order create missing id');

  return { id: String(id), market, price: finalPrice, limit, amount, poolId };
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
