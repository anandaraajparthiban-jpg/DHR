// pricing.ts — quote logic.
// Converts market prices to USD/PH-day, applies platform fees, margin, and buffer.
// Sources: NiceHash orderbook, Braiins orderbook, internal capacity (stub).
// Returns a full breakdown: base, fee, margin, buffer, total.
import fetch from 'node-fetch';

interface QuoteInput {
  ph: number;
  hours: number;
  pool: string;
  worker: string;
  preferredSource?: 'nicehash' | 'braiins' | 'internal';
}

interface QuoteResult {
  usdPerPhDay: number;
  totalUsd: number;
  source: string;
  baseUsdPerPhDay: number;
  feeUsdPerPhDay: number;
  marginUsdPerPhDay: number;
  bufferUsdPerPhDay: number;
}

const marginBps = Number(process.env.PRICE_MARGIN_BPS ?? '100'); // default 1%
const bufferBps = Number(process.env.BETA_BUFFER_BPS ?? '1000'); // default 10%
const floorUsdPerPhDay = Number(process.env.FLOOR_USD_PER_PH_DAY ?? '0');
const nhFeeBps = Number(process.env.NICEHASH_FEE_BPS ?? '200'); // default 2%
const braiinsFeeBps = Number(process.env.BRAIINS_FEE_BPS ?? '200'); // default 2%
const staticInternalUsdPerPhDay = Number(process.env.INTERNAL_CAPACITY_USD_PER_PH_DAY ?? '0');
const disableNicehash = false; // re-enable NiceHash

// quoteHashrate: gather quotes from NiceHash, Braiins, internal; pick cheapest after fees/margin/buffer.
export async function quoteHashrate(input: QuoteInput): Promise<QuoteResult> {
  const marketQuotes = await Promise.allSettled([
    disableNicehash ? Promise.resolve(skipQuote('nicehash')) : quoteNicehash(input, nhFeeBps),
    quoteBraiinshash(input, braiinsFeeBps),
    quoteInternal(input),
  ]);

  const valid = marketQuotes
    .filter((r) => r.status === 'fulfilled')
    .map((r) => (r as PromiseFulfilledResult<QuoteResult>).value)
    .filter((q) => isFinite(q.usdPerPhDay) && isFinite(q.totalUsd));

  const preferred = input.preferredSource ? valid.filter((q) => q.source === input.preferredSource) : valid;
  const candidates = preferred.length > 0 ? preferred : valid;

  if (candidates.length === 0) {
    throw new Error(
      'No quotes available. Configure NiceHash/Braiins credentials or set INTERNAL_CAPACITY_USD_PER_PH_DAY.'
    );
  }

  // pick cheapest
  let best = candidates.reduce((a, b) => (a.usdPerPhDay <= b.usdPerPhDay ? a : b));

  // apply margin, buffer, and floor
  const marginMult = 1 + marginBps / 10_000;
  const marginUsdPerPhDay = best.usdPerPhDay * (marginMult - 1);
  const withMargin = best.usdPerPhDay * marginMult;
  const bufferMult = 1 + bufferBps / 10_000;
  const bufferUsdPerPhDay = withMargin * (bufferMult - 1);
  const adjusted = Math.max(withMargin * bufferMult, floorUsdPerPhDay);
  const totalUsd = adjusted * (input.ph * (input.hours / 24));

  best = {
    ...best,
    usdPerPhDay: adjusted,
    totalUsd,
    marginUsdPerPhDay,
    bufferUsdPerPhDay,
  };

  return best;
}

// Fetch BTC/USD with fallback and optional override.
export async function btcUsd(): Promise<number> {
  const override = process.env.BTC_USD_OVERRIDE ? Number(process.env.BTC_USD_OVERRIDE) : undefined;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    if (!res.ok) throw new Error('coingecko failed');
    const data: any = await res.json();
    const price = data?.bitcoin?.usd;
    if (typeof price !== 'number') throw new Error('coingecko missing price');
    return price;
  } catch (err) {
    console.error('btcUsd coingecko error', err);
    try {
      const res2 = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
      if (!res2.ok) throw new Error('coinbase failed');
      const data2: any = await res2.json();
      const price2 = Number(data2?.data?.amount);
      if (!isFinite(price2)) throw new Error('coinbase missing price');
      return price2;
    } catch (err2) {
      console.error('btcUsd coinbase error', err2);
      if (override && isFinite(override)) return override;
      throw new Error('btc price failed');
    }
  }
}

// Return a skip quote to represent an unavailable source.
function skipQuote(source: string): QuoteResult {
  return {
    usdPerPhDay: Number.POSITIVE_INFINITY,
    totalUsd: Number.POSITIVE_INFINITY,
    source,
    baseUsdPerPhDay: Number.POSITIVE_INFINITY,
    feeUsdPerPhDay: 0,
    marginUsdPerPhDay: 0,
    bufferUsdPerPhDay: 0,
  };
}

// Quote NiceHash: BTC/EH/day -> USD/PH-day, apply platform fee.
async function quoteNicehash(input: QuoteInput, feeBps: number): Promise<QuoteResult> {
  const key = process.env.NICEHASH_API_KEY;
  const secret = process.env.NICEHASH_API_SECRET;
  const org = process.env.NICEHASH_ORG_ID;
  if (!key || !secret || !org) {
    return {
      usdPerPhDay: Number.POSITIVE_INFINITY,
      totalUsd: Number.POSITIVE_INFINITY,
      source: 'nicehash',
      baseUsdPerPhDay: Number.POSITIVE_INFINITY,
      feeUsdPerPhDay: 0,
      marginUsdPerPhDay: 0,
      bufferUsdPerPhDay: 0,
    };
  }
  try {
    // Use public orderBook for SHA256ASICBOOST; price is BTC/TH/day. Convert to USD/PH/day.
    const res = await fetch('https://api2.nicehash.com/main/api/v2/hashpower/orderBook?algorithm=SHA256ASICBOOST&page=0&pageSize=10');
    if (!res.ok) throw new Error('nicehash orderBook failed');
    const data: any = await res.json();
    const marketObjs = data?.stats && typeof data.stats === 'object' ? Object.values(data.stats) : [];
    const orders = Array.isArray(data?.orderList)
      ? data.orderList
      : Array.isArray(marketObjs)
        ? marketObjs.flatMap((m: any) => (m?.orders ?? []))
        : [];
    const prices = Array.isArray(orders)
      ? orders
          .map((o: any) => Number(o.price))
          .filter((n: number) => !isNaN(n))
      : [];
    if (prices.length === 0) throw new Error('no prices');
    const bestBtcPerEhDay = Math.min(...prices); // NiceHash orderbook price is BTC per EH/day
    const btcPrice = await btcUsd();
    const baseUsdPerPhDay = (bestBtcPerEhDay / 1000) * btcPrice; // EH -> PH
    const feeMult = 1 + feeBps / 10_000;
    const feeUsdPerPhDay = baseUsdPerPhDay * (feeMult - 1);
    const usdPerPhDay = baseUsdPerPhDay * feeMult;
    return {
      usdPerPhDay,
      totalUsd: usdPerPhDay * (input.ph * (input.hours / 24)),
      source: 'nicehash',
      baseUsdPerPhDay,
      feeUsdPerPhDay,
      marginUsdPerPhDay: 0,
      bufferUsdPerPhDay: 0,
    };
  } catch (err) {
    console.error('nicehash quote error', err);
    return {
      usdPerPhDay: Number.POSITIVE_INFINITY,
      totalUsd: Number.POSITIVE_INFINITY,
      source: 'nicehash',
      baseUsdPerPhDay: Number.POSITIVE_INFINITY,
      feeUsdPerPhDay: 0,
      marginUsdPerPhDay: 0,
      bufferUsdPerPhDay: 0,
    };
  }
}

// Quote Braiins: sats/hr_unit -> USD/PH-day, apply platform fee.
async function quoteBraiinshash(input: QuoteInput, feeBps: number): Promise<QuoteResult> {
  const token = process.env.BRAIINS_READONLY_TOKEN || process.env.BRAIINS_OWNER_TOKEN;
  if (!token)
    return {
      usdPerPhDay: Number.POSITIVE_INFINITY,
      totalUsd: Number.POSITIVE_INFINITY,
      source: 'braiins',
      baseUsdPerPhDay: Number.POSITIVE_INFINITY,
      feeUsdPerPhDay: 0,
      marginUsdPerPhDay: 0,
      bufferUsdPerPhDay: 0,
    };
  try {
    const settings = await braiinsSettings(token);
    const orderbook = await braiinsOrderbook(token);
    if (!orderbook?.asks || orderbook.asks.length === 0) throw new Error('no asks');
    const bestPriceSat = Math.min(...orderbook.asks.map((a: any) => Number(a.price_sat)).filter((n: number) => !isNaN(n)));
    if (!isFinite(bestPriceSat)) throw new Error('bad price');
    const btcPrice = await btcUsd();
    const priceBtc = bestPriceSat * 1e-8; // sats -> BTC per hr_unit
    const usdPerHrUnit = priceBtc * btcPrice;
    const baseUsdPerPhDay = usdPerHrUnit * settings.hrUnitToPhDay;
    const feeMult = 1 + feeBps / 10_000;
    const feeUsdPerPhDay = baseUsdPerPhDay * (feeMult - 1);
    const usdPerPhDay = baseUsdPerPhDay * feeMult;
    return {
      usdPerPhDay,
      totalUsd: usdPerPhDay * (input.ph * (input.hours / 24)),
      source: 'braiins',
      baseUsdPerPhDay,
      feeUsdPerPhDay,
      marginUsdPerPhDay: 0,
      bufferUsdPerPhDay: 0,
    };
  } catch (err) {
    console.error('braiins quote error', err);
    return {
      usdPerPhDay: Number.POSITIVE_INFINITY,
      totalUsd: Number.POSITIVE_INFINITY,
      source: 'braiins',
      baseUsdPerPhDay: Number.POSITIVE_INFINITY,
      feeUsdPerPhDay: 0,
      marginUsdPerPhDay: 0,
      bufferUsdPerPhDay: 0,
    };
  }
}

async function braiinsSettings(token: string): Promise<{ hrUnit: string; hrUnitToPhDay: number }> {
  const res = await fetch('https://hashpower.braiins.com/api/v1/spot/settings', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('settings error');
  const data: any = await res.json();
  const hrUnit: string = data?.hr_unit ?? '';
  const toPhDay = parseHrUnit(hrUnit);
  if (!isFinite(toPhDay) || toPhDay <= 0) throw new Error('unknown hr_unit');
  return { hrUnit, hrUnitToPhDay: toPhDay };
}

function parseHrUnit(unit: string): number {
  // Convert hr_unit like "PH/day", "EH/day", "TH/day" to multiplier to PH/day
  const u = unit.toLowerCase();
  if (u.includes('ph/day')) return 1;
  if (u.includes('eh/day')) return 1000;
  if (u.includes('th/day')) return 0.001;
  return NaN;
}

async function braiinsOrderbook(token: string): Promise<any> {
  const res = await fetch('https://hashpower.braiins.com/api/v1/spot/orderbook', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('orderbook error');
  return res.json();
}

// Quote internal capacity API (stubbed).
async function quoteInternal(input: QuoteInput): Promise<QuoteResult> {
  if (isFinite(staticInternalUsdPerPhDay) && staticInternalUsdPerPhDay > 0) {
    const baseUsdPerPhDay = staticInternalUsdPerPhDay;
    return {
      usdPerPhDay: baseUsdPerPhDay,
      totalUsd: baseUsdPerPhDay * (input.ph * (input.hours / 24)),
      source: 'internal',
      baseUsdPerPhDay,
      feeUsdPerPhDay: 0,
      marginUsdPerPhDay: 0,
      bufferUsdPerPhDay: 0,
    };
  }

  // Stub: call your internal capacity API if available
  const url = process.env.INTERNAL_CAPACITY_API;
  const token = process.env.INTERNAL_CAPACITY_TOKEN;
  if (!url || !token) {
    return {
      usdPerPhDay: Number.POSITIVE_INFINITY,
      totalUsd: Number.POSITIVE_INFINITY,
      source: 'internal',
      baseUsdPerPhDay: Number.POSITIVE_INFINITY,
      feeUsdPerPhDay: 0,
      marginUsdPerPhDay: 0,
      bufferUsdPerPhDay: 0,
    };
  }
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('capacity api error');
    const data: any = await res.json();
    if (typeof data.usdPerPhDay !== 'number') throw new Error('bad capacity quote');
    const baseUsdPerPhDay = data.usdPerPhDay;
    return {
      usdPerPhDay: baseUsdPerPhDay,
      totalUsd: baseUsdPerPhDay * (input.ph * (input.hours / 24)),
      source: 'internal',
      baseUsdPerPhDay,
      feeUsdPerPhDay: 0,
      marginUsdPerPhDay: 0,
      bufferUsdPerPhDay: 0,
    };
  } catch (err) {
    console.error('internal quote error', err);
    return {
      usdPerPhDay: Number.POSITIVE_INFINITY,
      totalUsd: Number.POSITIVE_INFINITY,
      source: 'internal',
      baseUsdPerPhDay: Number.POSITIVE_INFINITY,
      feeUsdPerPhDay: 0,
      marginUsdPerPhDay: 0,
      bufferUsdPerPhDay: 0,
    };
  }
}
