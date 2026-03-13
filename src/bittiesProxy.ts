import fetch from 'node-fetch';

export interface ProxySessionResult {
  id: string;
  expiresAt?: number;
  raw: any;
}

let cachedToken: { token: string; expiresAt?: number } | undefined;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing ${name}`);
  return val;
}

function buildBaseUrl(): string {
  const base = requireEnv('BITTIES_PROXY_BASE');
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function authPath(): string {
  const path = process.env.BITTIES_PROXY_AUTH_PATH || '/auth/login';
  return path.startsWith('/') ? path : `/${path}`;
}

function poolsPath(): string {
  const path = process.env.BITTIES_PROXY_POOLS_PATH || '/pools';
  return path.startsWith('/') ? path : `/${path}`;
}

function toEpochMs(v: any): number | undefined {
  if (typeof v === 'number' && isFinite(v) && v > 0) {
    return v > 1_000_000_000_000 ? v : v * 1000;
  }
  if (typeof v === 'string') {
    const n = Number(v);
    if (isFinite(n) && n > 0) return n > 1_000_000_000_000 ? n : n * 1000;
    const d = Date.parse(v);
    if (isFinite(d)) return d;
  }
  return undefined;
}

async function loginForToken(): Promise<{ token: string; expiresAt?: number }> {
  const username = process.env.BITTIES_PROXY_USERNAME;
  const password = process.env.BITTIES_PROXY_PASSWORD;
  if (!username || !password) {
    throw new Error('Missing BITTIES_PROXY_TOKEN or BITTIES_PROXY_USERNAME/BITTIES_PROXY_PASSWORD');
  }

  const res = await fetch(`${buildBaseUrl()}${authPath()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`proxy auth http ${res.status} body=${txt}`);
  }

  const data: any = await res.json();
  const result = data?.result ?? data;
  const token = result?.token;
  if (!token) throw new Error('proxy auth missing token');
  const expiresAt = toEpochMs(result?.expires);
  return { token: String(token), expiresAt };
}

async function getBearerToken(): Promise<string | undefined> {
  const staticToken = process.env.BITTIES_PROXY_TOKEN;
  if (staticToken) return staticToken;

  const username = process.env.BITTIES_PROXY_USERNAME;
  const password = process.env.BITTIES_PROXY_PASSWORD;
  if (!username || !password) return undefined;

  const now = Date.now();
  if (cachedToken?.token && (!cachedToken.expiresAt || cachedToken.expiresAt - now > 60_000)) {
    return cachedToken.token;
  }

  cachedToken = await loginForToken();
  return cachedToken.token;
}

async function apiCall(path: string, method: string, body?: any): Promise<any> {
  const token = await getBearerToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${buildBaseUrl()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`proxy api ${method} ${path} http ${res.status} body=${txt}`);
  }
  const payload: any = await res.json().catch(() => ({}));
  return payload?.result ?? payload;
}

function providerWeightForPh(ph: number): number {
  const weightPerPh = Number(process.env.BITTIES_PROXY_WEIGHT_PER_PH ?? '1');
  const minWeight = Math.max(1, Number(process.env.BITTIES_PROXY_MIN_WEIGHT ?? '1'));
  const maxWeight = Math.max(minWeight, Number(process.env.BITTIES_PROXY_MAX_WEIGHT ?? '100000'));
  const w = Math.round(ph * (isFinite(weightPerPh) && weightPerPh > 0 ? weightPerPh : 1));
  return Math.min(maxWeight, Math.max(minWeight, w));
}

function validatePoolUrlForBitties(poolUrl: string): void {
  if (!poolUrl.toLowerCase().startsWith('stratum+tcp://')) {
    throw new Error('Bitties requires pool URL with stratum+tcp:// scheme');
  }
}

export function proxyEnabled(): boolean {
  const enabledFlag = (process.env.BITTIES_PROXY_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabledFlag) return false;
  return Boolean(process.env.BITTIES_PROXY_BASE);
}

export async function createProxySession(input: {
  orderId: string;
  userId: string;
  ph: number;
  hours: number;
  poolUrl: string;
  worker: string;
}): Promise<ProxySessionResult> {
  validatePoolUrlForBitties(input.poolUrl);

  const body = {
    name: `order-${input.orderId.slice(0, 8)}`,
    url: input.poolUrl,
    workerprefix: input.worker,
    workerpass: process.env.BITTIES_PROXY_WORKER_PASS || 'x',
    weight: providerWeightForPh(input.ph),
  };

  const data: any = await apiCall(poolsPath(), 'POST', body);
  const id = data?.ID ?? data?.id;
  if (id === undefined || id === null) throw new Error('proxy pool create missing id');

  const expiresAt = Date.now() + input.hours * 3600 * 1000;
  return { id: String(id), expiresAt, raw: data };
}

export async function terminateProxySession(sessionId: string): Promise<void> {
  await apiCall(`${poolsPath()}/${encodeURIComponent(sessionId)}`, 'DELETE');
}
