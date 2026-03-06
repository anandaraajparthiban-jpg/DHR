// braiins.ts — Braiins spot helpers: settings, orderbook, price/limit conversion, bid placement.
import fetch from 'node-fetch';
import crypto from 'node:crypto';

export interface BraiinsSettings {
  hrUnit: string;
  hrUnitToPhDay: number;
  raw: any;
}

export interface BraiinsOrderbook {
  asks: { price_sat: number }[];
  raw: any;
}

export interface BraiinsOrderParams {
  priceSatPerUnit: number; // sats per hr_unit
  limitUnit: number; // hr_unit/s equivalent of requested PH
  amountBtc: number; // estimated cost for window at price cap
}

// Parse hr_unit (e.g., PH/day, EH/day, TH/day) to a PH/day multiplier.
function parseHrUnit(unit: string): number {
  const u = unit.toLowerCase();
  if (u.includes('ph/day')) return 1;
  if (u.includes('eh/day')) return 1000;
  if (u.includes('th/day')) return 0.001;
  return NaN;
}

const BRAIINS_BASE = process.env.BRAIINS_BASE || 'https://hashpower.braiins.com/api/v1';

// Generic authed fetch to Braiins base.
async function fetchJson(path: string, token: string): Promise<any> {
  const headers = { Authorization: `Bearer ${token}` } as any;
  const res = await fetch(`${BRAIINS_BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

// Fetch market settings (hr_unit) to convert prices/limits.
export async function getBraiinsSettings(token: string): Promise<BraiinsSettings> {
  const data: any = await fetchJson('/spot/settings', token);
  const hrUnit: string = data?.hr_unit ?? '';
  const hrUnitToPhDay = parseHrUnit(hrUnit);
  if (!isFinite(hrUnitToPhDay) || hrUnitToPhDay <= 0) throw new Error('braiins hr_unit unknown');
  return { hrUnit, hrUnitToPhDay, raw: data };
}

// Fetch spot orderbook; extract asks.
export async function getBraiinsOrderbook(token: string): Promise<BraiinsOrderbook> {
  const data: any = await fetchJson('/spot/orderbook', token);
  const asks = Array.isArray(data?.asks) ? data.asks.map((a: any) => ({ price_sat: Number(a.price_sat) })) : [];
  return { asks, raw: data };
}

// Convert quoted USD/PH-day to Braiins pricing units and limits (price sat/hr_unit, limit in hr_unit/s, amount BTC).
export function buildBraiinsOrderParams(opts: {
  ph: number;
  hours: number;
  usdPerPhDay: number;
  settings: BraiinsSettings;
  orderbook: BraiinsOrderbook;
  btcUsd: number;
}): BraiinsOrderParams {
  const { ph, hours, usdPerPhDay, settings, orderbook, btcUsd } = opts;
  if (!isFinite(ph) || ph <= 0) throw new Error('bad ph');
  if (!isFinite(hours) || hours <= 0) throw new Error('bad hours');
  if (!isFinite(usdPerPhDay) || usdPerPhDay <= 0) throw new Error('bad usdPerPhDay');
  if (!isFinite(btcUsd) || btcUsd <= 0) throw new Error('bad btcUsd');

  const bestAsk = orderbook.asks
    .map((a) => a.price_sat)
    .filter((n) => isFinite(n) && n > 0)
    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  if (!isFinite(bestAsk)) throw new Error('braiins no asks');

  // price cap in sats per hr_unit
  const targetSatPerUnit = (usdPerPhDay / btcUsd) * 1e8 / settings.hrUnitToPhDay; // (USD/PH-day -> BTC/PH-day -> sats/PH-day -> sats/hr_unit)
  const priceSatPerUnit = Math.min(bestAsk, targetSatPerUnit);

  // convert requested PH to hr_unit/s (hr_unit is per day), so limitUnit = (requested PH) / hrUnitToPhDay
  const limitUnit = ph / settings.hrUnitToPhDay;

  // estimate amount in BTC for the window at capped price
  const amountBtc = (priceSatPerUnit / 1e8) * limitUnit * (hours / 24) * settings.hrUnitToPhDay; // factor back to PH-day equivalent

  return { priceSatPerUnit, limitUnit, amountBtc };
}

// Create a Braiins spot bid: uses /spot/bid with quoted price cap and user pool/worker.
export async function createBraiinsOrder(opts: {
  ph: number;
  hours: number;
  poolUrl: string;
  worker: string;
  usdPerPhDay: number;
  token: string;
  memo?: string;
}): Promise<{ id: string; cl_order_id?: string }> {
  const { ph, hours, poolUrl, worker, usdPerPhDay, token, memo = 'auto' } = opts;
  const settings = await getBraiinsSettings(token);
  const ob = await getBraiinsOrderbook(token);
  const btcPrice = Number(process.env.BTC_USD_OVERRIDE) || (await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd')).json() as any).bitcoin.usd;
  const params = buildBraiinsOrderParams({ ph, hours, usdPerPhDay, settings, orderbook: ob, btcUsd: btcPrice });

  const parsed = new URL(poolUrl.replace('stratum+tcp://', 'tcp://').replace('stratum+ssl://', 'ssl://'));
  const body = {
    cl_order_id: crypto.randomUUID(),
    dest_upstream: {
      url: `${parsed.protocol.replace(':', '')}://${parsed.hostname}:${parsed.port || 3333}`,
      identity: worker,
    },
    speed_limit_ph: ph,
    amount_sat: Math.round(params.amountBtc * 1e8),
    price_sat: Math.round(params.priceSatPerUnit),
    memo,
  };

  const res = await fetch(`${BRAIINS_BASE}/spot/bid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`braiins order create http ${res.status} body=${txt}`);
  }
  const data: any = await res.json();
  if (!data?.id) throw new Error('braiins order create missing id');
  return { id: data.id, cl_order_id: data.cl_order_id };
}
