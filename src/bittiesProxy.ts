import fetch from 'node-fetch';

export interface ProxySessionResult {
  id: string;
  expiresAt?: number;
  raw: any;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing ${name}`);
  return val;
}

function authHeaders() {
  const token = process.env.BITTIES_PROXY_TOKEN;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function buildBaseUrl(): string {
  const base = requireEnv('BITTIES_PROXY_BASE');
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function connectPath(): string {
  const path = process.env.BITTIES_PROXY_CONNECT_PATH || '/v1/sessions';
  return path.startsWith('/') ? path : `/${path}`;
}

function terminatePath(sessionId: string): string {
  const template = process.env.BITTIES_PROXY_TERMINATE_PATH || '/v1/sessions/{id}/terminate';
  const path = template.replace('{id}', encodeURIComponent(sessionId));
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

export function proxyEnabled(): boolean {
  const enabledFlag = (process.env.BITTIES_PROXY_ENABLED ?? 'true').toLowerCase() !== 'false';
  return enabledFlag && Boolean(process.env.BITTIES_PROXY_BASE);
}

export async function createProxySession(input: {
  orderId: string;
  userId: string;
  ph: number;
  hours: number;
  poolUrl: string;
  worker: string;
}): Promise<ProxySessionResult> {
  const url = `${buildBaseUrl()}${connectPath()}`;
  const body = {
    orderId: input.orderId,
    userId: input.userId,
    hashratePh: input.ph,
    durationHours: input.hours,
    poolUrl: input.poolUrl,
    worker: input.worker,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`proxy session create http ${res.status} body=${txt}`);
  }
  const data: any = await res.json();
  const id = data?.id ?? data?.sessionId ?? data?.data?.id;
  if (!id) throw new Error('proxy session create missing id');
  const expiresAt = toEpochMs(data?.expiresAt ?? data?.endAt ?? data?.data?.expiresAt);
  return { id: String(id), expiresAt, raw: data };
}

export async function terminateProxySession(sessionId: string): Promise<void> {
  const method = (process.env.BITTIES_PROXY_TERMINATE_METHOD || 'POST').toUpperCase();
  const url = `${buildBaseUrl()}${terminatePath(sessionId)}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...authHeaders(),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`proxy session terminate http ${res.status} body=${txt}`);
  }
}
