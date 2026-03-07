import crypto from 'node:crypto';
import fetch from 'node-fetch';

type QueryValue = string | number | boolean | null | undefined;

function nhBase(): string {
  const base = process.env.NICEHASH_API_BASE || 'https://api2.nicehash.com';
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function buildQueryString(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    sp.append(key, String(value));
  }
  return sp.toString();
}

function requireNhCreds(): { apiKey: string; apiSecret: string; orgId: string } {
  const apiKey = process.env.NICEHASH_API_KEY;
  const apiSecret = process.env.NICEHASH_API_SECRET;
  const orgId = process.env.NICEHASH_ORG_ID;
  if (!apiKey || !apiSecret || !orgId) throw new Error('Missing NiceHash credentials');
  return { apiKey, apiSecret, orgId };
}

function buildAuthHeader(input: {
  apiKey: string;
  apiSecret: string;
  orgId: string;
  method: string;
  path: string;
  queryString: string;
  bodyString: string;
  timestamp: string;
  nonce: string;
}): string {
  const parts = [
    input.apiKey,
    '\u0000',
    input.timestamp,
    '\u0000',
    input.nonce,
    '\u0000',
    '\u0000',
    input.orgId,
    '\u0000',
    '\u0000',
    input.method.toUpperCase(),
    '\u0000',
    input.path,
    '\u0000',
    input.queryString,
  ];
  if (input.bodyString) {
    parts.push('\u0000', input.bodyString);
  }
  const message = parts.join('');
  const signature = crypto.createHmac('sha256', input.apiSecret).update(message).digest('hex');
  return `${input.apiKey}:${signature}`;
}

export async function nhPrivateRequest(method: string, path: string, opts?: {
  query?: Record<string, QueryValue>;
  body?: unknown;
}): Promise<any> {
  const { apiKey, apiSecret, orgId } = requireNhCreds();
  const normalizedPath = ensureLeadingSlash(path);
  const queryString = buildQueryString(opts?.query);
  const bodyString = opts?.body === undefined ? '' : JSON.stringify(opts.body);
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const auth = buildAuthHeader({
    apiKey,
    apiSecret,
    orgId,
    method,
    path: normalizedPath,
    queryString,
    bodyString,
    timestamp,
    nonce,
  });

  const qs = queryString ? `?${queryString}` : '';
  const res = await fetch(`${nhBase()}${normalizedPath}${qs}`, {
    method: method.toUpperCase(),
    headers: {
      'Content-Type': 'application/json',
      'X-Time': timestamp,
      'X-Nonce': nonce,
      'X-Organization-Id': orgId,
      'X-Request-Id': nonce,
      'X-Auth': auth,
      'X-User-Agent': 'DHRBot',
      'X-User-Lang': 'en',
    },
    body: bodyString || undefined,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`nicehash ${method.toUpperCase()} ${normalizedPath} http ${res.status} body=${txt}`);
  }

  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function nhPublicRequest(path: string, query?: Record<string, QueryValue>): Promise<any> {
  const normalizedPath = ensureLeadingSlash(path);
  const queryString = buildQueryString(query);
  const qs = queryString ? `?${queryString}` : '';
  const res = await fetch(`${nhBase()}${normalizedPath}${qs}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`nicehash public ${normalizedPath} http ${res.status} body=${txt}`);
  }
  return res.json();
}
