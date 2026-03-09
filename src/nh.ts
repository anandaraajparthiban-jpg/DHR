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

export interface NhMarketQuote {
  market: string;
  btcPerEhDay: number;
  marketFactor?: number;
  displayMarketFactor?: string;
  priceFactor?: number;
  displayPriceFactor?: string;
  marketFactorRaw?: string;
  priceFactorRaw?: string;
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
  market = m ? m.market : marketUpper;

  const priceBtcPerEhDay = (usdPerPhDay / btcPrice) * 1000;
  const limitEh = ph / 1000;
  const amountBtc = priceBtcPerEhDay * limitEh * (hours / 24);
  const minAmount = m?.minAmount && isFinite(m.minAmount) ? m.minAmount : 0.001;

  // NiceHash order payload rejects overly precise decimals (PRICE_DATA_SCALE / etc).
  const roundedPrice = Number(priceBtcPerEhDay.toFixed(8));
  const roundedLimit = Number(limitEh.toFixed(8));
  const roundedAmount = Number(Math.max(amountBtc, minAmount).toFixed(8));

  return {
    price: roundedPrice,
    limit: roundedLimit,
    amount: roundedAmount,
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
  const legacyMarkets = Array.isArray(entry?.markets) ? entry.markets : Array.isArray(entry?.market) ? entry.market : [];
  let markets: NhMarketInfo[] = legacyMarkets.map((m: any) => ({
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
  if (markets.length === 0 && Array.isArray(entry?.enabledHashpowerMarkets)) {
    // New buy/info shape does not expose market/price factors in API-create format.
    // Keep them unset here; order creation can proceed without these optional fields.
    const marketFactor = 0;
    const priceFactor = 0;
    const displayMarketFactor = '';
    const displayPriceFactor = '';
    const minAmount = Number(entry?.minAmount ?? entry?.min_amount ?? 0);
    const minPrice = Number(entry?.minPrice ?? entry?.min_price ?? 0);
    markets = entry.enabledHashpowerMarkets
      .map((m: any) => String(m || '').toUpperCase())
      .filter(Boolean)
      .map((market: string) => ({
        market,
        marketFactor,
        displayMarketFactor,
        priceFactor,
        displayPriceFactor,
        minAmount,
        minPrice,
        algorithm: entryAlgo,
      }));
  }
  return { algo: entryAlgo, markets, raw: data };
}

export async function fetchOrderbook(algo: string, market: string): Promise<NhMarketQuote> {
  const data: any = await nhPublicRequest('/main/api/v2/hashpower/orderBook', {
    algorithm: algo,
    market,
    page: 0,
    pageSize: 50,
  });

  const marketUpper = market.toUpperCase();
  const stat = data?.stats?.[marketUpper] ?? data?.stats;
  const orders = stat?.orders || data?.orderList || [];
  const prices = Array.isArray(orders)
    ? orders
        .map((o: any) => Number(o.price))
        .filter((n: number) => !isNaN(n))
    : [];
  if (!prices.length) throw new Error(`orderBook ${marketUpper} no prices`);
  const marketFactor = Number(stat?.marketFactor);
  const priceFactor = Number(stat?.priceFactor);
  const marketFactorRaw = typeof stat?.marketFactor === 'string' ? stat.marketFactor : undefined;
  const priceFactorRaw = typeof stat?.priceFactor === 'string' ? stat.priceFactor : undefined;
  const displayMarketFactor = typeof stat?.displayMarketFactor === 'string' ? stat.displayMarketFactor : undefined;
  const displayPriceFactor = typeof stat?.displayPriceFactor === 'string' ? stat.displayPriceFactor : undefined;
  return {
    market: marketUpper,
    btcPerEhDay: Math.min(...prices),
    marketFactor: isFinite(marketFactor) && marketFactor > 0 ? marketFactor : undefined,
    displayMarketFactor,
    priceFactor: isFinite(priceFactor) && priceFactor > 0 ? priceFactor : undefined,
    displayPriceFactor,
    marketFactorRaw,
    priceFactorRaw,
  };
}

export async function getNhBestMarketPrice(algo: string = 'SHA256ASICBOOST'): Promise<NhMarketQuote> {
  const markets = ['USA', 'EU'];
  const priced: NhMarketQuote[] = [];

  for (const market of markets) {
    try {
      const quote = await fetchOrderbook(algo, market);
      priced.push(quote);
    } catch {
      // ignore individual market fetch failures
    }
  }

  if (!priced.length) throw new Error('No market prices available');
  priced.sort((a, b) => a.btcPerEhDay - b.btcPerEhDay);
  return priced[0];
}
