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

export async function createNhOrder(opts: {
  ph: number;
  hours: number;
  poolUrl: string;
  worker: string;
  usdPerPhDay: number;
}): Promise<NhOrderResult> {
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

  const marketInfo = buyInfo.markets.find((m) => m.market === market);
  if (!marketInfo) throw new Error(`market ${market} missing in buyInfo`);

  const poolId = await ensurePool({
    algorithm: 'SHA256ASICBOOST',
    host,
    port,
    username: worker,
    password: 'x',
    name: `auto-${worker}-${host}`,
  });

  const payload = {
    market,
    algorithm: 'SHA256ASICBOOST',
    price,
    limit,
    amount,
    poolId,
    type: 'STANDARD',
    displayMarketFactor: marketInfo.displayMarketFactor,
    marketFactor: marketInfo.marketFactor,
    displayPriceFactor: marketInfo.displayPriceFactor,
    priceFactor: marketInfo.priceFactor,
  };

  const data: any = await nhPrivateRequest('POST', '/main/api/v2/hashpower/order', { body: payload });
  const id = data?.id;
  if (!id) throw new Error('order create missing id');

  return { id: String(id), market, price, limit, amount, poolId };
}

export async function cancelNhOrder(orderId: string): Promise<void> {
  await nhPrivateRequest('DELETE', `/main/api/v2/hashpower/order/${encodeURIComponent(orderId)}`);
}
