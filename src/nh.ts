// nh.ts — NiceHash quote/order helper utilities.
// - Fetch buy/info factors and public orderbook.
// - Build NH order params (price BTC/EH/day, limit EH/s, amount BTC) from USD/PH-day quotes.
import { nhPublicRequest } from './nhHttp.js';

export interface NhMarketInfo {
  market: string;
  marketFactor: number;
  displayMarketFactor: string;
  priceFactor: number;
  displayPriceFactor: string;
  minAmount?: number;
  minPrice?: number;
  fixedPrice?: number;
  algorithm?: string;
}

export interface NhBuyInfo {
  algo: string;
  markets: NhMarketInfo[];
  raw: any;
}

export function buildNhOrderParams({
  ph,
  hours,
  usdPerPhDay,
  market,
  algo = 'SHA256ASICBOOST',
  btcPrice,
  buyInfo,
}: {
  ph: number;
  hours: number;
  usdPerPhDay: number;
  market: string;
  algo?: string;
  btcPrice: number;
  buyInfo: NhBuyInfo;
}) {
  if (!isFinite(ph) || ph <= 0) throw new Error('bad ph');
  if (!isFinite(hours) || hours <= 0) throw new Error('bad hours');
  if (!isFinite(usdPerPhDay) || usdPerPhDay <= 0) throw new Error('bad usdPerPhDay');
  if (!isFinite(btcPrice) || btcPrice <= 0) throw new Error('bad btcPrice');

  const marketUpper = market.toUpperCase();
  let m = buyInfo.markets.find((x) => x.market.toUpperCase() === marketUpper || x.market.toUpperCase().startsWith(marketUpper));
  if (!m && buyInfo.markets.length) {
    m = buyInfo.markets[0];
  }
  if (!m) throw new Error(`market ${marketUpper} not in buyInfo and no fallback`);
  market = m.market;

  const priceBtcPerEhDay = (usdPerPhDay / btcPrice) * 1000;
  const limitEh = ph / 1000;
  const amountBtc = priceBtcPerEhDay * limitEh * (hours / 24);

  return {
    price: priceBtcPerEhDay,
    limit: limitEh,
    amount: amountBtc,
    market: market.toUpperCase(),
    algo,
  };
}

function algoCode(a: any): string {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (typeof a.algorithm === 'string') return a.algorithm;
  if (typeof a.algo === 'string') return a.algo;
  if (typeof a.code === 'string') return a.code;
  if (typeof a.name === 'string') return a.name;
  if (typeof a.enumCode === 'string') return a.enumCode;
  return '';
}

export async function getNhBuyInfo(algo: string = 'SHA256ASICBOOST'): Promise<NhBuyInfo> {
  const data: any = await nhPublicRequest('/main/api/v2/public/buy/info');
  const algos: any[] = data?.algorithms ?? data?.miningAlgorithms ?? [];
  const entry = algos.find((a) => algoCode(a).toUpperCase() === algo.toUpperCase());
  if (!entry) throw new Error(`algo ${algo} not found in buy/info`);
  const entryAlgo = algoCode(entry);
  const markets: NhMarketInfo[] = (entry?.markets || entry?.market || []).map((m: any) => ({
    market: String(m.market || m.name || '').toUpperCase(),
    marketFactor: Number(m.marketFactor || m.factor || m.market_factor || 0),
    displayMarketFactor: String(m.displayMarketFactor || m.marketDisplayFactor || ''),
    priceFactor: Number(m.priceFactor || m.price_factor || 0),
    displayPriceFactor: String(m.displayPriceFactor || m.priceDisplayFactor || ''),
    minAmount: Number(m.minAmount || m.minimumAmount || 0),
    minPrice: Number(m.minPrice || m.minimumPrice || 0),
    fixedPrice: Number(m.fixedPrice || m.fixed_price || 0) || undefined,
    algorithm: entryAlgo,
  }));
  return { algo: entryAlgo, markets, raw: data };
}

export async function fetchOrderbook(algo: string, market: string): Promise<number> {
  const data: any = await nhPublicRequest('/main/api/v2/hashpower/orderBook', {
    algorithm: algo,
    market,
    page: 0,
    pageSize: 50,
  });

  const marketUpper = market.toUpperCase();
  const orders = data?.stats?.[marketUpper]?.orders || data?.stats?.orders || data?.orderList || [];
  const prices = Array.isArray(orders)
    ? orders
        .map((o: any) => Number(o.price))
        .filter((n: number) => !isNaN(n))
    : [];
  if (!prices.length) throw new Error(`orderBook ${marketUpper} no prices`);
  return Math.min(...prices);
}

export async function getNhBestMarketPrice(algo: string = 'SHA256ASICBOOST'): Promise<{ market: string; btcPerEhDay: number }> {
  const markets = ['USA', 'EU'];
  const priced: Array<{ market: string; btcPerEhDay: number }> = [];

  for (const market of markets) {
    try {
      const btcPerEhDay = await fetchOrderbook(algo, market);
      priced.push({ market, btcPerEhDay });
    } catch {
      // ignore individual market fetch failures
    }
  }

  if (!priced.length) throw new Error('No market prices available');
  priced.sort((a, b) => a.btcPerEhDay - b.btcPerEhDay);
  return priced[0];
}
