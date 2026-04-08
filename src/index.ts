// index.ts — Discord bot main:
// - Registers slash commands (/quote, /rent-with-fixed-speed, /rent-with-fixed-duration, /status, /time_left, /cancel, /payment_status, /mark_paid, /verify_payments, /verify_payments_debug, /nh_payload_preview, /finance_summary).
// - Legacy /rent can be re-enabled via SHOW_LEGACY_RENT_COMMAND=true.
// - /rent collects pool + worker, creates payment intent, and waits for payment.
// - On payment confirmation, orders can auto-activate; admin can still trigger /mark_paid manually.
// - Fulfillment uses NiceHash only.
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import bcrypt from 'bcryptjs';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { quoteHashrate, btcUsd } from './pricing.js';
import { ensureDbReady, dbBackend, dbGet } from './db.js';
import {
  createOrder,
  cancelOrder,
  beginFulfillment,
  markPaid,
  rollbackFulfillment,
  getOrder,
  saveNhInfo,
  updateExpiry,
  completeOrder,
  listActiveExpiringOrders,
} from './orders.js';
import { validatePool } from './pools.js';
import { nicehashBalanceUsd } from './balances.js';
import {
  createNhOrder,
  cancelNhOrder,
  ensureNhOrderSatisfiesMinimum,
  ensureNhQuotedOrderSatisfiesMinimum,
  previewNhOrderPlacement,
  resolveNhOrderMode,
  createNhDirectFixedSpeedThenStandard,
  createNhDirectFixedDurationThenStandard,
  type NhBusinessDurationVariant,
  type NhOrderMode,
} from './nhOrder.js';
import { ensurePaymentIntent, getPaymentIntentByOrder } from './payments.js';
import { runPaymentVerificationTick, runPaymentVerificationDebug, startPaymentVerificationLoop } from './paymentVerifier.js';
import {
  ApiUserAccount,
  apiUsernameKey,
  createApiUser,
  getApiUserByUsername,
  listApiUsers,
  touchApiUserLastLogin,
  updateApiUser,
  upsertApiUserIfMissing,
} from './apiUsers.js';

type FulfillmentProvider = 'nicehash';
type SupportedJwtAlgorithm = 'HS256' | 'RS256';

interface ApiRuntimeConfig {
  host: string;
  port: number;
  basePath: string;
  jwtAlgorithm: SupportedJwtAlgorithm;
  jwtVerifierKey: string;
  jwtSigningKey: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtAccessTtlSec: number;
  jwtClockToleranceSec: number;
  jwtRequireJti: boolean;
  trustProxy: boolean;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  loginRateLimitPerMinute: number;
  adminRoles: Set<string>;
  adminScopes: Set<string>;
  bootstrapCredentials: Map<string, ApiAuthCredential>;
}

interface ApiAuthContext {
  userId: string;
  isAdmin: boolean;
  roles: Set<string>;
  scopes: Set<string>;
  tokenId?: string;
}

interface ApiAuthCredential {
  username: string;
  subject: string;
  passwordHash: string;
  roles: Set<string>;
  scopes: Set<string>;
}

interface ResolvedLoginCredential {
  credential: ApiAuthCredential;
  dbUserId?: string;
}

type NhDirectOrderKind = 'direct_fixed_speed' | 'direct_fixed_duration';

interface NhDirectFixedSpeedConfig {
  kind: 'direct_fixed_speed';
  amount: number;
  limitEh: number;
  bottomLimitEh?: number;
  market?: string;
  poolId?: string;
}

interface NhDirectFixedDurationConfig {
  kind: 'direct_fixed_duration';
  amount: number;
  hours: number;
  limitEh?: number;
  bottomLimitEh?: number;
  market?: string;
  poolId?: string;
  variant?: NhBusinessDurationVariant;
}

type NhDirectOrderConfig = NhDirectFixedSpeedConfig | NhDirectFixedDurationConfig;

class ApiHttpError extends Error {
  statusCode: number;
  errorCode: string;
  details?: unknown;

  constructor(statusCode: number, errorCode: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

const DEFAULT_FULFILLMENT_PROVIDER: FulfillmentProvider = 'nicehash';
const NICEHASH_MIN_START_AMOUNT_BTC = (() => {
  const n = Number(process.env.NICEHASH_MIN_START_AMOUNT_BTC ?? '0.0011');
  return isFinite(n) && n > 0 ? n : 0.0011;
})();
const FINANCE_SUMMARY_START_AT_MS = Date.UTC(2026, 2, 13, 0, 0, 0, 0);
const FINANCE_SUMMARY_START_LABEL = '2026-03-13';
const REST_API_ENABLED = (process.env.REST_API_ENABLED ?? 'false').toLowerCase() === 'true';
const API_RATE_WINDOW_MS = 60_000;
const apiRateBuckets = new Map<string, { count: number; windowStartMs: number }>();
const API_LOGIN_RATE_WINDOW_MS = 60_000;
const apiLoginRateBuckets = new Map<string, { count: number; windowStartMs: number }>();

const token = process.env.DISCORD_TOKEN ?? '';
const appId = process.env.DISCORD_APP_ID ?? '';

if (!token || !appId) {
  throw new Error('Missing DISCORD_TOKEN or DISCORD_APP_ID');
}

const adminUserIds = new Set((process.env.ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const orderExpiryTimers = new Map<string, NodeJS.Timeout>();
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map(BASE58_ALPHABET.split('').map((c, i) => [c, i]));
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_MAP = new Map(BECH32_CHARSET.split('').map((c, i) => [c, i]));
const BECH32M_CONST = 0x2bc830a3;
const TH_PER_EH = 1_000_000;
const SHOW_LEGACY_RENT_COMMAND = (process.env.SHOW_LEGACY_RENT_COMMAND ?? 'false').toLowerCase() === 'true';

console.log(`Routing config: NiceHash only, minimum start ${NICEHASH_MIN_START_AMOUNT_BTC.toFixed(8)} BTC`);
console.log('NiceHash order mode: auto (business fixed speed -> business fixed duration -> standard fallback)');
console.log(`Legacy /rent command visibility: ${SHOW_LEGACY_RENT_COMMAND ? 'enabled' : 'hidden'}`);

const commands = [
  new SlashCommandBuilder()
    .setName('quote')
    .setDescription('Get a hashrate quote')
    .addNumberOption((opt) => opt.setName('ph').setDescription('Petahash requested').setRequired(true))
    .addIntegerOption((opt) => opt.setName('hours').setDescription('Duration in hours').setRequired(true).setMaxValue(72)),
  ...(SHOW_LEGACY_RENT_COMMAND
    ? [
        new SlashCommandBuilder()
          .setName('rent')
          .setDescription('Place a hashrate rental')
          .addNumberOption((opt) => opt.setName('ph').setDescription('Petahash requested').setRequired(true))
          .addIntegerOption((opt) => opt.setName('hours').setDescription('Duration in hours').setRequired(true).setMaxValue(72))
          .addStringOption((opt) => opt.setName('pool').setDescription('Pool URL').setRequired(true))
          .addStringOption((opt) => opt.setName('worker').setDescription('BTC address only (no suffix)').setRequired(true)),
      ]
    : []),
  new SlashCommandBuilder()
    .setName('rent-with-fixed-speed')
    .setDescription('Place fixed-speed business order request (payment first, then business->standard)')
    .addNumberOption((opt) => opt.setName('amount').setDescription('Order amount in BTC').setRequired(true))
    .addNumberOption((opt) => opt.setName('limit_th').setDescription('Speed limit in TH/s').setRequired(true))
    .addStringOption((opt) => opt.setName('pool').setDescription('Pool URL, e.g. stratum+tcp://host:3334').setRequired(true))
    .addStringOption((opt) => opt.setName('worker').setDescription('BTC address / worker').setRequired(true))
    .addNumberOption((opt) => opt.setName('bottom_limit_th').setDescription('Optional bottom limit in TH/s').setRequired(false)),
  new SlashCommandBuilder()
    .setName('rent-with-fixed-duration')
    .setDescription('Place fixed-duration business order request (payment first, then business->standard)')
    .addNumberOption((opt) => opt.setName('amount').setDescription('Order amount in BTC').setRequired(true))
    .addIntegerOption((opt) => opt.setName('hours').setDescription('Duration in hours').setRequired(true).setMaxValue(72))
    .addStringOption((opt) => opt.setName('pool').setDescription('Pool URL, e.g. stratum+tcp://host:3334').setRequired(true))
    .addStringOption((opt) => opt.setName('worker').setDescription('BTC address / worker').setRequired(true))
    .addNumberOption((opt) => opt.setName('bottom_limit_th').setDescription('Optional bottom limit in TH/s').setRequired(false))
    .addNumberOption((opt) => opt.setName('limit_th').setDescription('Optional speed cap in TH/s').setRequired(false))
    .addStringOption((opt) =>
      opt
        .setName('variant')
        .setDescription('Duration payload variant (default auto)')
        .setRequired(false)
        .addChoices(
          { name: 'Auto', value: 'auto' },
          { name: 'Type=BUSINESS + endTs', value: 'business_type_endts' },
          { name: 'Type=BUSINESS + subType + endTs', value: 'business_type_subtype_endts' },
          { name: 'Type=BUSINESS_ENGINE + duration', value: 'business_engine_duration' },
          { name: 'Type=BUSINESS_ENGINE + duration + endTs', value: 'business_engine_duration_endts' },
          { name: 'Type=BUSINESS_ENGINE + subType + duration + endTs', value: 'business_engine_subtype_duration_endts' }
        )
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check rental status')
    .addStringOption((opt) => opt.setName('id').setDescription('Order ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('time_left')
    .setDescription('Show remaining time for an active rental')
    .addStringOption((opt) => opt.setName('id').setDescription('Order ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel a rental (if allowed)')
    .addStringOption((opt) => opt.setName('id').setDescription('Order ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('mark_paid')
    .setDescription('Admin: mark order paid')
    .addStringOption((opt) => opt.setName('id').setDescription('Order ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('payment_status')
    .setDescription('Check payment status for an order')
    .addStringOption((opt) => opt.setName('id').setDescription('Order ID').setRequired(true)),
  new SlashCommandBuilder().setName('verify_payments').setDescription('Admin: run payment verification scan now'),
  new SlashCommandBuilder()
    .setName('verify_payments_debug')
    .setDescription('Admin: run payment verification diagnostics')
    .addIntegerOption((opt) =>
      opt
        .setName('limit')
        .setDescription('How many pending intents to include (default 10, max 20)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(20)
    ),
  new SlashCommandBuilder()
    .setName('nh_payload_preview')
    .setDescription('Admin: preview NiceHash payload without placing order')
    .addNumberOption((opt) => opt.setName('ph').setDescription('Petahash requested').setRequired(true))
    .addIntegerOption((opt) => opt.setName('hours').setDescription('Duration in hours').setRequired(true).setMaxValue(72))
    .addStringOption((opt) => opt.setName('pool').setDescription('Pool URL').setRequired(true))
    .addStringOption((opt) => opt.setName('worker').setDescription('BTC address only (no suffix)').setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName('order_mode')
        .setDescription('NiceHash order mode for preview only (default: auto fallback)')
        .setRequired(false)
        .addChoices(
          { name: 'Automatic Fallback', value: 'auto' },
          { name: 'Standard', value: 'standard' },
          { name: 'Business Fixed Speed', value: 'business_fixed_speed' },
          { name: 'Business Fixed Duration', value: 'business_fixed_duration' }
        )
    )
    .addBooleanOption((opt) =>
      opt.setName('resolve_pool_id').setDescription('If true, resolve/create actual NiceHash poolId (side effect)')
    ),
  new SlashCommandBuilder().setName('finance_summary').setDescription('Admin: revenue vs NiceHash spend summary'),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(appId), { body: commands.map((c) => c.toJSON()) });
  console.log('Slash commands registered');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('clientReady', () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

function isAdmin(userId: string): boolean {
  return adminUserIds.has(userId);
}

function canAccessOrder(userId: string, orderUserId: string): boolean {
  return isAdmin(userId) || userId === orderUserId;
}

function providerLabel(provider: string | undefined): string {
  if (provider === 'nicehash') return 'NiceHash';
  if (provider === 'braiins') return 'Braiins';
  return String(provider || 'unknown');
}

function durationFactor(ph: number, hours: number): number {
  return ph * (hours / 24);
}

async function resolveFulfillmentQuote(input: {
  ph: number;
  hours: number;
  pool: string;
  worker: string;
}): Promise<{
  btcPrice: number;
  provider: FulfillmentProvider;
  routingQuote: Awaited<ReturnType<typeof quoteHashrate>>;
  pricedQuote: Awaited<ReturnType<typeof quoteHashrate>>;
}> {
  const routingQuote = await quoteHashrate({ ...input, preferredSource: 'nicehash' });
  if (routingQuote.source !== 'nicehash') {
    throw new Error('NiceHash quote unavailable right now. Please retry shortly.');
  }

  const btcPrice = await btcUsd().catch(() => NaN);
  if (!isFinite(btcPrice) || btcPrice <= 0) {
    throw new Error('BTC price unavailable; unable to price NiceHash orders right now.');
  }

  return {
    btcPrice,
    provider: DEFAULT_FULFILLMENT_PROVIDER,
    routingQuote,
    pricedQuote: routingQuote,
  };
}

function sha256(data: Uint8Array): Uint8Array {
  return createHash('sha256').update(data).digest();
}

function decodeBase58(value: string): Uint8Array | undefined {
  if (!value) return undefined;
  const bytes = [0];
  for (const c of value) {
    const digit = BASE58_MAP.get(c);
    if (digit === undefined) return undefined;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      const x = bytes[i] * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < value.length && value[i] === '1'; i++) {
    bytes.push(0);
  }
  bytes.reverse();
  return Uint8Array.from(bytes);
}

function isValidBase58BitcoinAddress(value: string): boolean {
  if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(value)) return false;
  const decoded = decodeBase58(value);
  if (!decoded || decoded.length !== 25) return false;
  const payload = decoded.slice(0, 21);
  const checksum = decoded.slice(21);
  const expected = sha256(sha256(payload)).slice(0, 4);
  if (!checksum.every((v, idx) => v === expected[idx])) return false;
  const version = payload[0];
  return version === 0x00 || version === 0x05;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function bech32Polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < generators.length; i++) {
      if ((top >>> i) & 1) chk ^= generators[i];
    }
  }
  return chk >>> 0;
}

function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] | undefined {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of data) {
    if (value < 0 || value >= (1 << fromBits)) return undefined;
    acc = ((acc << fromBits) | value) & maxAcc;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return undefined;
  }
  return out;
}

function isValidBech32BitcoinAddress(value: string): boolean {
  const hasLower = value !== value.toUpperCase();
  const hasUpper = value !== value.toLowerCase();
  if (hasLower && hasUpper) return false;
  const addr = value.toLowerCase();
  if (!addr.startsWith('bc1')) return false;
  const sep = addr.lastIndexOf('1');
  if (sep < 1 || sep + 7 > addr.length) return false;
  const hrp = addr.slice(0, sep);
  if (hrp !== 'bc') return false;
  const dataPart = addr.slice(sep + 1);
  const values: number[] = [];
  for (const c of dataPart) {
    const v = BECH32_MAP.get(c);
    if (v === undefined) return false;
    values.push(v);
  }
  if (values.length < 7) return false;

  const witnessVersion = values[0];
  if (witnessVersion < 0 || witnessVersion > 16) return false;
  const checkConst = bech32Polymod([...bech32HrpExpand(hrp), ...values]);
  if (witnessVersion === 0 && checkConst !== 1) return false;
  if (witnessVersion > 0 && checkConst !== BECH32M_CONST) return false;

  const program = convertBits(values.slice(1, -6), 5, 8, false);
  if (!program) return false;
  if (program.length < 2 || program.length > 40) return false;
  if (witnessVersion === 0 && program.length !== 20 && program.length !== 32) return false;
  return true;
}

function isValidWorkerName(worker: string): boolean {
  if (worker.length < 14 || worker.length > 90) return false;
  if (worker.includes('.')) return false;
  if (worker.includes(':')) return false;
  if (worker !== worker.trim()) return false;
  return isValidBase58BitcoinAddress(worker) || isValidBech32BitcoinAddress(worker);
}

function usdBtcLine(usd: number, btcPrice: number, usdDecimals: number = 2): string {
  const usdPart = `$${usd.toFixed(usdDecimals)}`;
  if (!isFinite(btcPrice) || btcPrice <= 0) return `${usdPart} (BTC price unavailable)`;
  return `${usdPart} (${(usd / btcPrice).toFixed(8)} BTC)`;
}

function envTrimmed(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function envFirst(names: readonly string[]): string | undefined {
  for (const n of names) {
    const v = envTrimmed(n);
    if (v) return v;
  }
  return undefined;
}

function paymentUsdcBaseAddress(): string | undefined {
  return envFirst(['PAYMENT_USDC_BASE', 'PAYMENT_USDC_BASE_ADDRESS', 'USDC_BASE_ADDRESS']);
}

function paymentUsdcSolAddress(): string | undefined {
  return envFirst(['PAYMENT_USDC_SOL', 'PAYMENT_USDC_SOL_ADDRESS', 'USDC_SOL_ADDRESS']);
}

function paymentBtcAddress(): string | undefined {
  return envFirst(['PAYMENT_BTC_ONCHAIN', 'PAYMENT_BTC_ADDRESS', 'BTC_ONCHAIN_ADDRESS']);
}

function envRequired(name: string): string {
  const value = envTrimmed(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function normalizeApiBasePath(input: string): string {
  const raw = input.trim();
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  if (prefixed.length <= 1) return '/api/v1';
  return prefixed.endsWith('/') ? prefixed.slice(0, -1) : prefixed;
}

function splitToSet(raw: string | undefined, fallback: string): Set<string> {
  const source = raw && raw.trim().length > 0 ? raw : fallback;
  return new Set(
    source
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parsePositiveIntegerOrDefault(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function normalizeCredentialUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeBcryptHash(value: string): string {
  return value.trim();
}

function parseCredentialFromObject(
  row: Record<string, unknown>,
  indexLabel: string,
  fallbackRoles: Set<string>,
  fallbackScopes: Set<string>
): ApiAuthCredential {
  const usernameRaw = String(row.username ?? '').trim();
  if (!usernameRaw) {
    throw new Error(`Credential ${indexLabel}: missing username`);
  }
  const passwordHashRaw = normalizeBcryptHash(String(row.passwordHash ?? ''));
  if (!passwordHashRaw) {
    throw new Error(`Credential ${indexLabel}: missing passwordHash`);
  }
  if (!/^\$2[aby]\$\d{2}\$/.test(passwordHashRaw)) {
    throw new Error(`Credential ${indexLabel}: passwordHash must be a bcrypt hash`);
  }
  const subjectRaw = String(row.subject ?? usernameRaw).trim();
  if (!subjectRaw) {
    throw new Error(`Credential ${indexLabel}: missing subject`);
  }

  const roles = parseClaimSet(row.roles);
  const scopes = parseClaimSet(row.scopes ?? row.scope);
  const normalizedRoles = roles.size > 0 ? roles : fallbackRoles;
  const normalizedScopes = scopes.size > 0 ? scopes : fallbackScopes;

  return {
    username: usernameRaw,
    subject: subjectRaw,
    passwordHash: passwordHashRaw,
    roles: new Set(normalizedRoles),
    scopes: new Set(normalizedScopes),
  };
}

function loadApiBootstrapCredentials(fallbackRoles: Set<string>, fallbackScopes: Set<string>): Map<string, ApiAuthCredential> {
  const out = new Map<string, ApiAuthCredential>();
  const credentialsJson = envTrimmed('API_AUTH_CREDENTIALS_JSON');

  if (credentialsJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(credentialsJson);
    } catch {
      throw new Error('API_AUTH_CREDENTIALS_JSON is not valid JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('API_AUTH_CREDENTIALS_JSON must be a JSON array');
    }
    parsed.forEach((entry, idx) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Credential ${idx}: must be a JSON object`);
      }
      const credential = parseCredentialFromObject(entry as Record<string, unknown>, String(idx), fallbackRoles, fallbackScopes);
      const key = normalizeCredentialUsername(credential.username);
      if (out.has(key)) throw new Error(`Duplicate API auth username '${credential.username}'`);
      out.set(key, credential);
    });
    if (out.size > 0) return out;
  }

  const singleUsername = envTrimmed('API_AUTH_USERNAME');
  const singlePasswordHash = envTrimmed('API_AUTH_PASSWORD_HASH');
  if (singleUsername || singlePasswordHash) {
    if (!singleUsername || !singlePasswordHash) {
      throw new Error('Set both API_AUTH_USERNAME and API_AUTH_PASSWORD_HASH for single-user auth');
    }
    const singleSubject = envTrimmed('API_AUTH_SUBJECT') ?? singleUsername;
    const singleRoles = splitToSet(envTrimmed('API_AUTH_ROLES'), Array.from(fallbackRoles).join(','));
    const singleScopes = splitToSet(envTrimmed('API_AUTH_SCOPES'), Array.from(fallbackScopes).join(','));
    const credential = parseCredentialFromObject(
      {
        username: singleUsername,
        passwordHash: singlePasswordHash,
        subject: singleSubject,
        roles: Array.from(singleRoles),
        scopes: Array.from(singleScopes),
      },
      'single',
      singleRoles,
      singleScopes
    );
    out.set(normalizeCredentialUsername(credential.username), credential);
    return out;
  }

  return out;
}

function loadApiRuntimeConfig(): ApiRuntimeConfig | undefined {
  if (!REST_API_ENABLED) return undefined;

  const host = envTrimmed('REST_API_HOST') ?? '127.0.0.1';
  const port = parsePositiveIntegerOrDefault(envTrimmed('REST_API_PORT'), 8080, 1, 65535);
  const basePath = normalizeApiBasePath(envTrimmed('REST_API_BASE_PATH') ?? '/api/v1');

  const algRaw = (envTrimmed('API_JWT_ALGORITHM') ?? 'HS256').toUpperCase();
  if (algRaw !== 'HS256' && algRaw !== 'RS256') {
    throw new Error(`Unsupported API_JWT_ALGORITHM '${algRaw}'. Supported: HS256, RS256`);
  }
  const jwtAlgorithm = algRaw as SupportedJwtAlgorithm;
  const jwtVerifierKeyRaw = jwtAlgorithm === 'HS256' ? envRequired('API_JWT_SECRET') : envRequired('API_JWT_PUBLIC_KEY');
  if (jwtAlgorithm === 'HS256' && jwtVerifierKeyRaw.length < 32) {
    throw new Error('API_JWT_SECRET must be at least 32 characters for HS256');
  }
  const jwtVerifierKey = jwtVerifierKeyRaw.includes('\\n') ? jwtVerifierKeyRaw.replace(/\\n/g, '\n') : jwtVerifierKeyRaw;
  const jwtSigningKeyRaw = jwtAlgorithm === 'HS256' ? jwtVerifierKeyRaw : envRequired('API_JWT_PRIVATE_KEY');
  const jwtSigningKey = jwtSigningKeyRaw.includes('\\n') ? jwtSigningKeyRaw.replace(/\\n/g, '\n') : jwtSigningKeyRaw;

  const jwtIssuer = envRequired('API_JWT_ISSUER');
  const jwtAudience = envRequired('API_JWT_AUDIENCE');
  const jwtAccessTtlSec = parsePositiveIntegerOrDefault(envTrimmed('API_JWT_ACCESS_TTL_SEC'), 1800, 60, 86_400);
  const jwtClockToleranceSec = parsePositiveIntegerOrDefault(envTrimmed('API_JWT_CLOCK_TOLERANCE_SEC'), 5, 0, 300);
  const jwtRequireJti = (envTrimmed('API_JWT_REQUIRE_JTI') ?? 'true').toLowerCase() !== 'false';
  const trustProxy = (envTrimmed('API_TRUST_PROXY') ?? 'false').toLowerCase() === 'true';
  const maxBodyBytes = parsePositiveIntegerOrDefault(envTrimmed('API_MAX_BODY_BYTES'), 32_768, 1_024, 1_048_576);
  const rateLimitPerMinute = parsePositiveIntegerOrDefault(envTrimmed('API_RATE_LIMIT_PER_MIN'), 120, 1, 10_000);
  const loginRateLimitPerMinute = parsePositiveIntegerOrDefault(envTrimmed('API_AUTH_LOGIN_RATE_LIMIT_PER_MIN'), 20, 1, 1_000);
  const adminRoles = splitToSet(envTrimmed('API_ADMIN_ROLES'), 'admin');
  const adminScopes = splitToSet(envTrimmed('API_ADMIN_SCOPES'), 'admin');
  const bootstrapCredentials = loadApiBootstrapCredentials(adminRoles, adminScopes);

  return {
    host,
    port,
    basePath,
    jwtAlgorithm,
    jwtVerifierKey,
    jwtSigningKey,
    jwtIssuer,
    jwtAudience,
    jwtAccessTtlSec,
    jwtClockToleranceSec,
    jwtRequireJti,
    trustProxy,
    maxBodyBytes,
    rateLimitPerMinute,
    loginRateLimitPerMinute,
    adminRoles,
    adminScopes,
    bootstrapCredentials,
  };
}

function validateSizeDuration(ph: number, hours: number): string | undefined {
  const minPh = Number(process.env.MIN_PH ?? '0');
  const maxPh = Number(process.env.MAX_PH ?? '0');
  const minHours = Number(process.env.MIN_HOURS ?? '0');
  const maxHours = Number(process.env.MAX_HOURS ?? '0');
  if (minPh > 0 && ph < minPh) return `Minimum size is ${minPh} PH`;
  if (maxPh > 0 && ph > maxPh) return `Maximum size is ${maxPh} PH`;
  if (minHours > 0 && hours < minHours) return `Minimum duration is ${minHours} hours`;
  if (maxHours > 0 && hours > maxHours) return `Maximum duration is ${maxHours} hours`;
  if (hours > 72) return 'Maximum duration is 72 hours';
  return undefined;
}

function parseNhOrderModeInput(raw: unknown): NhOrderMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  if (
    normalized !== 'auto' &&
    normalized !== 'standard' &&
    normalized !== 'business_fixed_speed' &&
    normalized !== 'business_fixed_duration'
  ) {
    return undefined;
  }
  return resolveNhOrderMode(normalized);
}

function nhOrderModeLabel(mode: NhOrderMode): string {
  if (mode === 'auto') return 'Automatic Fallback';
  if (mode === 'business_fixed_speed') return 'Business Fixed Speed';
  if (mode === 'business_fixed_duration') return 'Business Fixed Duration';
  return 'Standard';
}

function requestedOrderModeLabel(raw?: string): string {
  const normalized = String(raw || '').trim().toLowerCase();
  if (normalized === 'direct_fixed_speed') return 'Direct Fixed Speed (business -> standard fallback)';
  if (normalized === 'direct_fixed_duration') return 'Direct Fixed Duration (business -> standard fallback)';
  return nhOrderModeLabel(resolveNhOrderMode(raw));
}

function parseNhDirectOrderConfig(raw?: string): NhDirectOrderConfig | undefined {
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.kind === 'direct_fixed_speed') {
    const amount = Number(obj.amount);
    const limitEh = Number(obj.limitEh);
    if (!isFinite(amount) || amount <= 0 || !isFinite(limitEh) || limitEh <= 0) return undefined;
    const cfg: NhDirectFixedSpeedConfig = {
      kind: 'direct_fixed_speed',
      amount,
      limitEh,
    };
    if (isFinite(Number(obj.bottomLimitEh))) cfg.bottomLimitEh = Number(obj.bottomLimitEh);
    if (typeof obj.market === 'string' && obj.market.trim()) cfg.market = obj.market.trim().toUpperCase();
    if (typeof obj.poolId === 'string' && obj.poolId.trim()) cfg.poolId = obj.poolId.trim();
    return cfg;
  }
  if (obj.kind === 'direct_fixed_duration') {
    const amount = Number(obj.amount);
    const hours = Number(obj.hours);
    if (!isFinite(amount) || amount <= 0 || !isFinite(hours) || hours <= 0) return undefined;
    const cfg: NhDirectFixedDurationConfig = {
      kind: 'direct_fixed_duration',
      amount,
      hours,
    };
    if (isFinite(Number(obj.limitEh))) cfg.limitEh = Number(obj.limitEh);
    if (isFinite(Number(obj.bottomLimitEh))) cfg.bottomLimitEh = Number(obj.bottomLimitEh);
    if (typeof obj.market === 'string' && obj.market.trim()) cfg.market = obj.market.trim().toUpperCase();
    if (typeof obj.poolId === 'string' && obj.poolId.trim()) cfg.poolId = obj.poolId.trim();
    const variant = parseDurationVariantInput(obj.variant);
    if (variant) cfg.variant = variant;
    return cfg;
  }
  return undefined;
}

function estimateExpiryFromNhOrder(nh: { amount: number; limit: number; price: number; endTs?: string }, fallbackHours: number): number {
  const now = Date.now();
  if (nh.endTs) {
    const endMs = Date.parse(nh.endTs);
    if (isFinite(endMs) && endMs > now) return endMs;
  }
  if (isFinite(nh.amount) && nh.amount > 0 && isFinite(nh.limit) && nh.limit > 0 && isFinite(nh.price) && nh.price > 0) {
    const estimatedHours = (nh.amount / (nh.price * nh.limit)) * 24;
    const boundedHours = Math.max(0.25, Math.min(24 * 30, estimatedHours));
    return now + boundedHours * 3600 * 1000;
  }
  const safeFallback = isFinite(fallbackHours) && fallbackHours > 0 ? fallbackHours : 24;
  return now + safeFallback * 3600 * 1000;
}

function nhOrderModeBehavior(mode: NhOrderMode): string {
  if (mode === 'auto') {
    return 'Try Business Fixed Speed first, then Business Fixed Duration, then Standard orderbook fallback.';
  }
  if (mode === 'business_fixed_speed') {
    return 'Speed target stays fixed (within market availability); order completion time can vary.';
  }
  if (mode === 'business_fixed_duration') {
    return 'End time is targeted; speed can vary over time based on market conditions and available funds.';
  }
  return 'Standard marketplace order with fixed price/limit parameters.';
}

function parseDurationVariantInput(raw: unknown): NhBusinessDurationVariant | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'auto' ||
    normalized === 'business_type_endts' ||
    normalized === 'business_type_subtype_endts' ||
    normalized === 'business_engine_duration' ||
    normalized === 'business_engine_duration_endts' ||
    normalized === 'business_engine_subtype_duration_endts'
  ) {
    return normalized;
  }
  return undefined;
}

function ehFromTh(th: number): number {
  if (!isFinite(th) || th <= 0) throw new Error(`TH/s value must be > 0. Received ${th}.`);
  return th / TH_PER_EH;
}

function parseClaimSet(value: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof value === 'string') {
    const parts = value.includes(' ') ? value.split(' ') : value.split(',');
    for (const part of parts) {
      const normalized = part.trim().toLowerCase();
      if (normalized) out.add(normalized);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v !== 'string') continue;
      const normalized = v.trim().toLowerCase();
      if (normalized) out.add(normalized);
    }
  }
  return out;
}

function parseApiAuth(req: IncomingMessage, cfg: ApiRuntimeConfig): ApiAuthContext {
  const authz = req.headers.authorization;
  if (!authz || typeof authz !== 'string') {
    throw new ApiHttpError(401, 'unauthorized', 'Missing Authorization header');
  }
  const match = authz.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new ApiHttpError(401, 'unauthorized', 'Authorization header must be Bearer token');
  }
  const token = match[1].trim();
  if (!token) {
    throw new ApiHttpError(401, 'unauthorized', 'Bearer token is empty');
  }

  let verified: string | JwtPayload;
  try {
    verified = jwt.verify(token, cfg.jwtVerifierKey, {
      algorithms: [cfg.jwtAlgorithm],
      issuer: cfg.jwtIssuer,
      audience: cfg.jwtAudience,
      clockTolerance: cfg.jwtClockToleranceSec,
    });
  } catch {
    throw new ApiHttpError(401, 'unauthorized', 'Token verification failed');
  }
  if (!verified || typeof verified === 'string') {
    throw new ApiHttpError(401, 'unauthorized', 'Token payload is invalid');
  }

  if (typeof verified.sub !== 'string' || verified.sub.trim().length === 0) {
    throw new ApiHttpError(401, 'unauthorized', 'Token must include a non-empty sub claim');
  }
  if (typeof verified.exp !== 'number') {
    throw new ApiHttpError(401, 'unauthorized', 'Token must include exp claim');
  }
  if (cfg.jwtRequireJti && (typeof verified.jti !== 'string' || verified.jti.trim().length === 0)) {
    throw new ApiHttpError(401, 'unauthorized', 'Token must include jti claim');
  }

  const roles = new Set<string>([
    ...parseClaimSet(verified.role),
    ...parseClaimSet((verified as JwtPayload & { roles?: unknown }).roles),
  ]);
  const scopes = new Set<string>([
    ...parseClaimSet(verified.scope),
    ...parseClaimSet((verified as JwtPayload & { scopes?: unknown }).scopes),
  ]);

  const isAdminByRole = Array.from(cfg.adminRoles).some((r) => roles.has(r));
  const isAdminByScope = Array.from(cfg.adminScopes).some((s) => scopes.has(s));
  return {
    userId: verified.sub.trim(),
    isAdmin: isAdminByRole || isAdminByScope,
    roles,
    scopes,
    tokenId: typeof verified.jti === 'string' ? verified.jti : undefined,
  };
}

function requestIp(req: IncomingMessage, cfg: ApiRuntimeConfig): string {
  if (cfg.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string') {
      const first = fwd.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  const socketIp = req.socket.remoteAddress?.trim();
  return socketIp && socketIp.length > 0 ? socketIp : 'unknown';
}

function enforceApiRateLimit(auth: ApiAuthContext, ip: string, cfg: ApiRuntimeConfig): void {
  const now = Date.now();
  const key = `${auth.userId}|${ip}`;
  const bucket = apiRateBuckets.get(key);
  if (!bucket || now - bucket.windowStartMs >= API_RATE_WINDOW_MS) {
    apiRateBuckets.set(key, { count: 1, windowStartMs: now });
    return;
  }
  if (bucket.count >= cfg.rateLimitPerMinute) {
    const retryAfterSec = Math.max(1, Math.ceil((API_RATE_WINDOW_MS - (now - bucket.windowStartMs)) / 1000));
    throw new ApiHttpError(429, 'rate_limited', 'Rate limit exceeded', { retryAfterSec });
  }
  bucket.count += 1;
}

function enforceLoginRateLimit(ip: string, cfg: ApiRuntimeConfig): void {
  const now = Date.now();
  const bucket = apiLoginRateBuckets.get(ip);
  if (!bucket || now - bucket.windowStartMs >= API_LOGIN_RATE_WINDOW_MS) {
    apiLoginRateBuckets.set(ip, { count: 1, windowStartMs: now });
    return;
  }
  if (bucket.count >= cfg.loginRateLimitPerMinute) {
    const retryAfterSec = Math.max(1, Math.ceil((API_LOGIN_RATE_WINDOW_MS - (now - bucket.windowStartMs)) / 1000));
    throw new ApiHttpError(429, 'rate_limited', 'Too many login attempts', { retryAfterSec });
  }
  bucket.count += 1;
}

function issueAccessToken(credential: ApiAuthCredential, cfg: ApiRuntimeConfig): { accessToken: string; expiresInSec: number } {
  const roles = Array.from(credential.roles);
  const scopes = Array.from(credential.scopes);
  const payload: Record<string, unknown> = {
    username: credential.username,
  };
  if (roles.length > 0) {
    payload.roles = roles;
    payload.role = roles[0];
  }
  if (scopes.length > 0) {
    payload.scopes = scopes;
    payload.scope = scopes.join(' ');
  }
  const accessToken = jwt.sign(payload, cfg.jwtSigningKey, {
    algorithm: cfg.jwtAlgorithm,
    subject: credential.subject,
    issuer: cfg.jwtIssuer,
    audience: cfg.jwtAudience,
    expiresIn: cfg.jwtAccessTtlSec,
    jwtid: randomUUID(),
  });
  return { accessToken, expiresInSec: cfg.jwtAccessTtlSec };
}

function claimsFromBodyValue(value: unknown): Set<string> {
  return parseClaimSet(value);
}

function boolFromBodyValue(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  throw new ApiHttpError(400, 'bad_request', `Field '${field}' must be boolean`);
}

function credentialFromApiUser(user: ApiUserAccount): ApiAuthCredential {
  return {
    username: user.username,
    subject: user.subject,
    passwordHash: user.passwordHash,
    roles: new Set(user.roles),
    scopes: new Set(user.scopes),
  };
}

function publicApiUser(user: ApiUserAccount): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    subject: user.subject,
    roles: Array.from(user.roles),
    scopes: Array.from(user.scopes),
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

async function resolveLoginCredential(username: string, cfg: ApiRuntimeConfig): Promise<ResolvedLoginCredential | undefined> {
  const normalized = apiUsernameKey(username);
  const dbUser = await getApiUserByUsername(normalized);
  if (dbUser) {
    if (!dbUser.isActive) return undefined;
    return { credential: credentialFromApiUser(dbUser), dbUserId: dbUser.id };
  }
  const bootstrap = cfg.bootstrapCredentials.get(normalized);
  if (!bootstrap) return undefined;
  return { credential: bootstrap };
}

async function seedBootstrapApiUsers(cfg: ApiRuntimeConfig): Promise<void> {
  if (cfg.bootstrapCredentials.size === 0) return;
  let seeded = 0;
  for (const credential of cfg.bootstrapCredentials.values()) {
    const before = await getApiUserByUsername(credential.username);
    if (before) continue;
    await upsertApiUserIfMissing({
      username: credential.username,
      subject: credential.subject,
      passwordHash: credential.passwordHash,
      roles: new Set(credential.roles),
      scopes: new Set(credential.scopes),
      isActive: true,
    });
    seeded += 1;
  }
  if (seeded > 0) {
    console.log(`Seeded ${seeded} API auth user(s) from environment bootstrap`);
  }
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new ApiHttpError(413, 'payload_too_large', `Request body exceeds ${maxBodyBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve());
    req.on('error', (err) => reject(err));
  });

  if (size === 0) return {};
  const bodyRaw = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyRaw);
  } catch {
    throw new ApiHttpError(400, 'bad_request', 'Body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiHttpError(400, 'bad_request', 'Body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function bodyNumber(body: Record<string, unknown>, field: string): number {
  const n = Number(body[field]);
  if (!isFinite(n)) throw new ApiHttpError(400, 'bad_request', `Field '${field}' must be a number`);
  return n;
}

function bodyInteger(body: Record<string, unknown>, field: string): number {
  const n = Number(body[field]);
  if (!isFinite(n) || Math.floor(n) !== n) throw new ApiHttpError(400, 'bad_request', `Field '${field}' must be an integer`);
  return n;
}

function bodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiHttpError(400, 'bad_request', `Field '${field}' must be a non-empty string`);
  }
  return value.trim();
}

function optionalBodyNumber(body: Record<string, unknown>, ...fields: string[]): number | undefined {
  for (const field of fields) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number(raw);
    if (!isFinite(n)) {
      throw new ApiHttpError(400, 'bad_request', `Field '${field}' must be a number`);
    }
    return n;
  }
  return undefined;
}

function bodyStringAny(body: Record<string, unknown>, ...fields: string[]): string {
  for (const field of fields) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  const first = fields[0] ?? 'field';
  throw new ApiHttpError(400, 'bad_request', `Field '${first}' must be a non-empty string`);
}

function optionalBodyString(body: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new ApiHttpError(400, 'bad_request', `Field '${field}' must be a non-empty string`);
    }
    return raw.trim();
  }
  return undefined;
}

function optionalBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!isFinite(n) || Math.floor(n) !== n || n < min || n > max) {
    throw new ApiHttpError(400, 'bad_request', `Integer value must be within [${min}, ${max}]`);
  }
  return n;
}

function sendApiJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const json = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(json);
}

function requireAdmin(auth: ApiAuthContext): void {
  if (!auth.isAdmin && !isAdmin(auth.userId)) {
    throw new ApiHttpError(403, 'forbidden', 'Admin role/scope or configured admin user is required');
  }
}

function parseOrderId(path: string, suffix: '' | '/time_left' | '/cancel' | '/payment_status' | '/mark_paid' = ''): string | undefined {
  if (!path.startsWith('/orders/')) return undefined;
  const rest = path.slice('/orders/'.length);
  if (!suffix) {
    if (!rest || rest.includes('/')) return undefined;
    return decodeURIComponent(rest);
  }
  if (!rest.endsWith(suffix)) return undefined;
  const orderId = rest.slice(0, -suffix.length);
  if (!orderId || orderId.includes('/')) return undefined;
  return decodeURIComponent(orderId);
}

function asApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  return new ApiHttpError(500, 'internal_error', err instanceof Error ? err.message : 'Internal server error');
}

async function notifyUser(userId: string, message: string) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(message);
  } catch (err) {
    console.error(`notify user failed for ${userId}`, err);
  }
}

function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function scheduleOrderExpiry(orderId: string, expiresAt: number) {
  const existing = orderExpiryTimers.get(orderId);
  if (existing) clearTimeout(existing);

  const delayMs = expiresAt - Date.now();
  if (delayMs <= 0) {
    void expireOrder(orderId);
    return;
  }

  const timer = setTimeout(() => {
    void expireOrder(orderId);
  }, delayMs);
  timer.unref();
  orderExpiryTimers.set(orderId, timer);
}

async function expireOrder(orderId: string) {
  orderExpiryTimers.delete(orderId);
  const current = await getOrder(orderId);
  if (!current || current.status !== 'active') return;

  let terminated = true;
  if (current.fulfillmentProvider === 'nicehash' && current.nhOrderId) {
    try {
      await cancelNhOrder(current.nhOrderId);
    } catch (err) {
      terminated = false;
      console.error(`cancel NH order failed for ${orderId}/${current.nhOrderId}`, err);
    }
  }

  if (!terminated) {
    const retryMs = Math.max(30, Number(process.env.FULFILLMENT_TERMINATION_RETRY_SEC ?? '300')) * 1000;
    const retryAt = Date.now() + retryMs;
    await updateExpiry(orderId, retryAt);
    scheduleOrderExpiry(orderId, retryAt);
    return;
  }

  await completeOrder(orderId);
  await notifyUser(
    current.user,
    `Your DHR order ${orderId} has ended and was terminated successfully.\nProvider: ${providerLabel(
      current.fulfillmentProvider
    )}\nPool: ${current.pool}\nWorker: ${current.worker}`
  );
}

async function restoreOrderExpirySchedules() {
  const activeOrders = await listActiveExpiringOrders();
  for (const o of activeOrders) {
    if (!o.expiresAt) continue;
    scheduleOrderExpiry(o.id, o.expiresAt);
  }
  if (activeOrders.length > 0) {
    console.log(`Restored ${activeOrders.length} order expiry timer(s)`);
  }
}

async function fulfillOrder(orderId: string, requirePaymentConfirmed: boolean): Promise<string> {
  const o = await getOrder(orderId);
  if (!o) throw new Error('Not found');
  const selectedProvider: FulfillmentProvider = DEFAULT_FULFILLMENT_PROVIDER;
  const requestedModeRaw = String(o.nhRequestedMode || '').trim().toLowerCase();
  const effectiveOrderMode = resolveNhOrderMode(o.nhRequestedMode);

  if (requirePaymentConfirmed) {
    const payment = await getPaymentIntentByOrder(orderId);
    if (!payment || payment.status !== 'confirmed') {
      throw new Error(`Order ${orderId} has no confirmed payment yet`);
    }
  }

  let nh: Awaited<ReturnType<typeof createNhOrder>>;
  let chosenModeLabel = nhOrderModeLabel(effectiveOrderMode);
  let placedFailures: string[] = [];
  if (requestedModeRaw === 'direct_fixed_speed') {
    const cfg = parseNhDirectOrderConfig(o.nhDirectConfig);
    if (!cfg || cfg.kind !== 'direct_fixed_speed') {
      throw new Error('Direct fixed speed order missing/invalid nhDirectConfig.');
    }
    const direct = await createNhDirectFixedSpeedThenStandard({
      market: cfg.market,
      amount: cfg.amount,
      limitEh: cfg.limitEh,
      bottomLimitEh: cfg.bottomLimitEh,
      poolId: cfg.poolId,
      poolUrl: o.pool,
      worker: o.worker,
    });
    nh = direct.order;
    chosenModeLabel = nhOrderModeLabel(direct.chosenMode);
    placedFailures = direct.failures;
  } else if (requestedModeRaw === 'direct_fixed_duration') {
    const cfg = parseNhDirectOrderConfig(o.nhDirectConfig);
    if (!cfg || cfg.kind !== 'direct_fixed_duration') {
      throw new Error('Direct fixed duration order missing/invalid nhDirectConfig.');
    }
    const direct = await createNhDirectFixedDurationThenStandard({
      market: cfg.market,
      amount: cfg.amount,
      hours: cfg.hours,
      limitEh: cfg.limitEh,
      bottomLimitEh: cfg.bottomLimitEh,
      variant: cfg.variant,
      poolId: cfg.poolId,
      poolUrl: o.pool,
      worker: o.worker,
    });
    nh = direct.order;
    chosenModeLabel = nhOrderModeLabel(direct.chosenMode);
    placedFailures = direct.failures;
  } else {
    const usdPerPhDay = await latestBaseUsdPerPhDay(o);
    nh = await createNhOrder({
      ph: o.ph,
      hours: o.hours,
      poolUrl: o.pool,
      worker: o.worker,
      usdPerPhDay,
      orderMode: effectiveOrderMode,
    });
  }

  const expiresAt = estimateExpiryFromNhOrder(nh, o.hours);
  await saveNhInfo(orderId, {
    nhOrderId: nh.id,
    nhMarket: nh.market,
    nhPrice: nh.price,
    nhLimit: nh.limit,
    nhAmount: nh.amount,
    nhOrderType: nh.orderType,
    nhSubType: nh.subType,
    nhBottomLimit: nh.bottomLimit,
    nhEndTs: nh.endTs,
    nhMarketFactor: nh.marketFactor,
    nhPriceFactor: nh.priceFactor,
  });
  const placedBase =
    nh.orderType === 'business'
      ? `NiceHash business order placed: ${nh.id} (market ${nh.market}, subtype ${nh.subType ?? 'n/a'}, limit ${nh.limit.toFixed(
          6
        )} EH/s${typeof nh.bottomLimit === 'number' ? `, bottomLimit ${nh.bottomLimit.toFixed(6)} EH/s` : ''}${
          nh.endTs ? `, endTs ${nh.endTs}` : ''
        }, amount ${nh.amount.toFixed(8)} BTC).`
      : `NiceHash order placed: ${nh.id} (market ${nh.market}, price ${nh.price.toFixed(8)} BTC/EH/day, limit ${nh.limit.toFixed(6)} EH/s).`;
  const placed =
    placedFailures.length > 0 ? `${placedBase}\nFallback details: ${placedFailures[0]}` : placedBase;

  await updateExpiry(orderId, expiresAt);
  const msg = await markPaid(orderId);
  scheduleOrderExpiry(orderId, expiresAt);

  const refreshed = await getOrder(orderId);
  await notifyUser(
    o.user,
    `Your DHR order ${orderId} is now active.\nProvider: ${providerLabel(
      refreshed?.fulfillmentProvider ?? selectedProvider
    )}\nMode: ${requestedOrderModeLabel(o.nhRequestedMode)} (placed as ${chosenModeLabel})\nPool: ${o.pool}\nWorker: ${o.worker}\nEnds: ${new Date(
      expiresAt
    ).toISOString()}`
  );

  return `${msg}\n${placed}`;
}

async function autoActivateConfirmedOrders(orderIds: string[]): Promise<number> {
  const autoActivate = (process.env.AUTO_ACTIVATE_ON_PAYMENT ?? 'true').toLowerCase() !== 'false';
  if (!autoActivate) return 0;

  let activated = 0;
  for (const id of orderIds) {
    const begin = await beginFulfillment(id);
    if (begin !== 'ok') continue;
    try {
      await fulfillOrder(id, true);
      activated += 1;
    } catch (err) {
      await rollbackFulfillment(id).catch((rollbackErr) => console.error('auto-fulfillment rollback failed', rollbackErr));
      console.error(`auto activation failed for order ${id}`, err);
    }
  }
  return activated;
}

async function financeSummaryData(): Promise<{
  startLabel: string;
  confirmedPaymentsCount: number;
  revenueUsd: number;
  nicehashOrdersCount: number;
  spendBtc: number;
  spendUsd?: number;
  netUsd?: number;
}> {
  const revenue = await dbGet<{ totalUsd: number; count: number }>(
    `SELECT COALESCE(SUM("usdAmount"), 0) AS "totalUsd", COUNT(*) AS count
     FROM payment_intents
     WHERE status = 'confirmed'
       AND COALESCE("confirmedAt", "createdAt") >= ?`,
    [FINANCE_SUMMARY_START_AT_MS]
  );
  const spend = await dbGet<{ totalBtc: number; count: number }>(
    `SELECT COALESCE(SUM("nhAmount"), 0) AS "totalBtc", COUNT(*) AS count
     FROM orders
     WHERE "fulfillmentProvider" = 'nicehash'
       AND "nhAmount" IS NOT NULL
       AND "createdAt" >= ?`,
    [FINANCE_SUMMARY_START_AT_MS]
  );

  const revenueUsd = Number(revenue?.totalUsd ?? 0);
  const spendBtc = Number(spend?.totalBtc ?? 0);
  const btcPrice = await btcUsd().catch(() => NaN);
  const spendUsd = isFinite(btcPrice) ? spendBtc * btcPrice : undefined;
  const netUsd = typeof spendUsd === 'number' ? revenueUsd - spendUsd : undefined;

  return {
    startLabel: FINANCE_SUMMARY_START_LABEL,
    confirmedPaymentsCount: Number(revenue?.count ?? 0),
    revenueUsd,
    nicehashOrdersCount: Number(spend?.count ?? 0),
    spendBtc,
    spendUsd,
    netUsd,
  };
}

function canAccessOrderFromApi(auth: ApiAuthContext, orderUserId: string): boolean {
  return auth.isAdmin || canAccessOrder(auth.userId, orderUserId);
}

async function handleApiRequest(req: IncomingMessage, res: ServerResponse, cfg: ApiRuntimeConfig): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (method === 'GET' && pathname === `${cfg.basePath}/health`) {
    sendApiJson(res, 200, { ok: true, service: 'dhr-api', timestamp: new Date().toISOString() });
    return;
  }

  if (!pathname.startsWith(cfg.basePath)) {
    sendApiJson(res, 404, { ok: false, error: 'not_found', message: 'Route not found' });
    return;
  }
  const routePath = pathname.slice(cfg.basePath.length) || '/';

  try {
    if (method === 'POST' && routePath === '/auth/login') {
      const ip = requestIp(req, cfg);
      enforceLoginRateLimit(ip, cfg);
      const body = await readJsonBody(req, cfg.maxBodyBytes);
      const username = bodyString(body, 'username');
      const password = bodyString(body, 'password');
      const resolvedCredential = await resolveLoginCredential(username, cfg);
      if (!resolvedCredential) {
        throw new ApiHttpError(401, 'unauthorized', 'Invalid username or password');
      }
      const ok = await bcrypt.compare(password, resolvedCredential.credential.passwordHash);
      if (!ok) {
        throw new ApiHttpError(401, 'unauthorized', 'Invalid username or password');
      }
      const token = issueAccessToken(resolvedCredential.credential, cfg);
      if (resolvedCredential.dbUserId) {
        await touchApiUserLastLogin(resolvedCredential.dbUserId).catch((err) =>
          console.error('failed to update api user last login', err)
        );
      }
      sendApiJson(res, 200, {
        ok: true,
        tokenType: 'Bearer',
        accessToken: token.accessToken,
        expiresInSec: token.expiresInSec,
        expiresAt: Date.now() + token.expiresInSec * 1000,
        subject: resolvedCredential.credential.subject,
        username: resolvedCredential.credential.username,
        roles: Array.from(resolvedCredential.credential.roles),
        scopes: Array.from(resolvedCredential.credential.scopes),
      });
      return;
    }

    const auth = parseApiAuth(req, cfg);
    const ip = requestIp(req, cfg);
    enforceApiRateLimit(auth, ip, cfg);

    if (method === 'GET' && routePath === '/auth/users') {
      requireAdmin(auth);
      const users = await listApiUsers();
      sendApiJson(res, 200, {
        ok: true,
        users: users.map((u) => publicApiUser(u)),
      });
      return;
    }

    if (method === 'POST' && routePath === '/auth/users') {
      requireAdmin(auth);
      const body = await readJsonBody(req, cfg.maxBodyBytes);
      const username = bodyString(body, 'username');
      const password = bodyString(body, 'password');
      if (password.length < 8) {
        throw new ApiHttpError(400, 'validation_error', 'Password must be at least 8 characters');
      }
      const subject = body.subject === undefined ? username : bodyString(body, 'subject');
      const roles = body.roles === undefined ? new Set<string>(['user']) : claimsFromBodyValue(body.roles);
      const scopes = body.scopes === undefined ? new Set<string>() : claimsFromBodyValue(body.scopes);
      const isActive = body.isActive === undefined ? true : boolFromBodyValue(body.isActive, 'isActive');
      const passwordHash = await bcrypt.hash(password, 12);
      try {
        const created = await createApiUser({
          username,
          subject,
          passwordHash,
          roles,
          scopes,
          isActive,
        });
        sendApiJson(res, 201, { ok: true, user: publicApiUser(created) });
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        if (msg.includes('unique') || msg.includes('constraint') || msg.includes('duplicate')) {
          throw new ApiHttpError(409, 'conflict', `API user '${apiUsernameKey(username)}' already exists`);
        }
        throw err;
      }
      return;
    }

    const authUserRoute = routePath.startsWith('/auth/users/') ? decodeURIComponent(routePath.slice('/auth/users/'.length)) : undefined;
    if (method === 'PATCH' && authUserRoute !== undefined) {
      requireAdmin(auth);
      if (!authUserRoute || authUserRoute.includes('/')) {
        throw new ApiHttpError(404, 'not_found', 'Route not found');
      }
      const body = await readJsonBody(req, cfg.maxBodyBytes);
      const updatePayload: {
        subject?: string;
        passwordHash?: string;
        roles?: Set<string>;
        scopes?: Set<string>;
        isActive?: boolean;
      } = {};
      if (body.subject !== undefined) updatePayload.subject = bodyString(body, 'subject');
      if (body.password !== undefined) {
        const password = bodyString(body, 'password');
        if (password.length < 8) {
          throw new ApiHttpError(400, 'validation_error', 'Password must be at least 8 characters');
        }
        updatePayload.passwordHash = await bcrypt.hash(password, 12);
      }
      if (body.roles !== undefined) updatePayload.roles = claimsFromBodyValue(body.roles);
      if (body.scopes !== undefined) updatePayload.scopes = claimsFromBodyValue(body.scopes);
      if (body.isActive !== undefined) updatePayload.isActive = boolFromBodyValue(body.isActive, 'isActive');
      if (Object.keys(updatePayload).length === 0) {
        throw new ApiHttpError(400, 'bad_request', 'No updatable fields supplied');
      }

      const updated = await updateApiUser(authUserRoute, updatePayload);
      if (!updated) throw new ApiHttpError(404, 'not_found', `API user '${apiUsernameKey(authUserRoute)}' not found`);
      sendApiJson(res, 200, { ok: true, user: publicApiUser(updated) });
      return;
    }

    if (method === 'POST' && routePath === '/quote') {
      const body = await readJsonBody(req, cfg.maxBodyBytes);
      const ph = bodyNumber(body, 'ph');
      const hours = bodyInteger(body, 'hours');
      const validationError = validateSizeDuration(ph, hours);
      if (validationError) throw new ApiHttpError(400, 'validation_error', validationError);

      let resolved: Awaited<ReturnType<typeof resolveFulfillmentQuote>>;
      try {
        resolved = await resolveFulfillmentQuote({ ph, hours, pool: 'quote', worker: 'quote' });
        await ensureNhQuotedOrderSatisfiesMinimum({
          ph,
          hours,
          usdPerPhDay: resolved.routingQuote.baseUsdPerPhDay,
          orderMode: 'auto',
        });
      } catch (err) {
        throw new ApiHttpError(503, 'quote_unavailable', err instanceof Error ? err.message : 'Quote unavailable');
      }

      const q = resolved.pricedQuote;
      const units = durationFactor(ph, hours);
      const baseTotal = q.baseUsdPerPhDay * units;
      const feeTotal = q.feeUsdPerPhDay * units;
      const marginTotal = q.marginUsdPerPhDay * units;
      const bufferTotal = q.bufferUsdPerPhDay * units;
      const feePct = q.baseUsdPerPhDay > 0 ? (q.feeUsdPerPhDay / q.baseUsdPerPhDay) * 100 : 0;

      sendApiJson(res, 200, {
        ok: true,
        provider: resolved.provider,
        quote: {
          ph,
          hours,
          orderMode: 'auto',
          orderModeLabel: nhOrderModeLabel('auto'),
          orderModeBehavior: nhOrderModeBehavior('auto'),
          source: q.source,
          totalUsd: q.totalUsd,
          unitUsdPerPhDay: q.usdPerPhDay,
          btcPriceUsd: resolved.btcPrice,
          breakdown: {
            baseUsdPerPhDay: q.baseUsdPerPhDay,
            feeUsdPerPhDay: q.feeUsdPerPhDay,
            marginUsdPerPhDay: q.marginUsdPerPhDay,
            bufferUsdPerPhDay: q.bufferUsdPerPhDay,
            baseTotalUsd: baseTotal,
            feeTotalUsd: feeTotal,
            marginTotalUsd: marginTotal,
            bufferTotalUsd: bufferTotal,
            feePercent: feePct,
          },
        },
        paymentMethods: {
          usdcBaseAddress: paymentUsdcBaseAddress(),
          usdcSolAddress: paymentUsdcSolAddress(),
          btcOnchainAddress: paymentBtcAddress(),
          estimatedUsdcAmount: Number(q.totalUsd.toFixed(6)),
          estimatedBtcAmount: Number((q.totalUsd / resolved.btcPrice).toFixed(8)),
        },
      });
      return;
    }

    if (method === 'POST' && routePath === '/rent') {
      const body = await readJsonBody(req, cfg.maxBodyBytes);
      const ph = bodyNumber(body, 'ph');
      const hours = bodyInteger(body, 'hours');
      const pool = bodyString(body, 'pool');
      const worker = bodyString(body, 'worker');

      const validationError = validateSizeDuration(ph, hours);
      if (validationError) throw new ApiHttpError(400, 'validation_error', validationError);
      if (!isValidWorkerName(worker)) {
        throw new ApiHttpError(400, 'validation_error', 'Worker must be a valid BTC mainnet address only (no suffix like .worker, no dots)');
      }
      const poolOk = validatePool(pool);
      if (!poolOk.valid) {
        throw new ApiHttpError(400, 'validation_error', `Pool not allowed: ${poolOk.reason ?? 'invalid pool'}`);
      }

      let resolved: Awaited<ReturnType<typeof resolveFulfillmentQuote>>;
      try {
        resolved = await resolveFulfillmentQuote({ ph, hours, pool, worker });
      } catch (err) {
        throw new ApiHttpError(503, 'quote_unavailable', err instanceof Error ? err.message : 'No valid quote available');
      }

      if (resolved.provider === 'nicehash') {
        const nhBal = await nicehashBalanceUsd();
        const nhGate = (process.env.NICEHASH_GATE_ENABLED ?? 'true').toLowerCase() !== 'false';
        if (nhGate && (!isFinite(nhBal.usd) || nhBal.usd < 50)) {
          throw new ApiHttpError(503, 'provider_unavailable', 'NiceHash account balance is low. Please check back later.');
        }
        try {
          await ensureNhOrderSatisfiesMinimum({
            ph,
            hours,
            poolUrl: pool,
            worker,
            usdPerPhDay: resolved.routingQuote.baseUsdPerPhDay,
            orderMode: 'auto',
          });
        } catch (err) {
          throw new ApiHttpError(
            400,
            'validation_error',
            `Order rejected before creation: ${err instanceof Error ? err.message : 'minimum requirements not met'}`
          );
        }
      }

      const order = await createOrder({
        ph,
        hours,
        pool,
        worker,
        requestedProvider: resolved.provider,
        nhRequestedMode: 'auto',
        user: auth.userId,
        totalUsd: resolved.pricedQuote.totalUsd,
      });
      const payment = await ensurePaymentIntent({
        orderId: order.id,
        userId: auth.userId,
        totalUsd: order.totalUsd,
        btcUsd: resolved.btcPrice,
        expiresAt: order.expiresAt ?? Date.now() + hours * 3600 * 1000,
      });

      sendApiJson(res, 201, {
        ok: true,
        message: 'Order created',
        order,
        orderMode: 'auto',
        orderModeLabel: nhOrderModeLabel('auto'),
        orderModeBehavior: nhOrderModeBehavior('auto'),
        payment: {
          id: payment.id,
          status: payment.status,
          reference: payment.reference,
          expiresAt: payment.expiresAt,
          usdcBaseAddress: paymentUsdcBaseAddress(),
          usdcSolAddress: paymentUsdcSolAddress(),
          btcOnchainAddress: paymentBtcAddress(),
          usdcBaseAmount: payment.usdcBaseAmount,
          usdcSolAmount: payment.usdcSolAmount,
          btcAmount: payment.btcAmount,
        },
      });
      return;
    }

    if (method === 'POST' && routePath === '/rent/fixed_speed') {
      const body = await readJsonBody(req, cfg.maxBodyBytes);
      const amount = bodyNumber(body, 'amount');
      const limitTh = optionalBodyNumber(body, 'limit_th', 'limitTh');
      const bottomLimitTh = optionalBodyNumber(body, 'bottom_limit_th', 'bottomLimitTh');
      const pool = bodyStringAny(body, 'pool');
      const worker = bodyStringAny(body, 'worker');

      if (!isFinite(amount) || amount <= 0) {
        throw new ApiHttpError(400, 'validation_error', 'Field \'amount\' must be > 0');
      }
      if (limitTh === undefined) {
        throw new ApiHttpError(400, 'bad_request', "Field 'limit_th' is required");
      }

      const poolOk = validatePool(pool);
      if (!poolOk.valid) {
        throw new ApiHttpError(400, 'validation_error', `Pool not allowed: ${poolOk.reason ?? 'invalid pool'}`);
      }
      if (!isValidWorkerName(worker)) {
        throw new ApiHttpError(400, 'validation_error', 'Worker must be a valid BTC mainnet address only (no suffix like .worker, no dots)');
      }

      let limitEh: number;
      let bottomLimitEh: number | undefined;
      try {
        limitEh = ehFromTh(limitTh);
        bottomLimitEh = typeof bottomLimitTh === 'number' ? ehFromTh(bottomLimitTh) : undefined;
      } catch (err) {
        throw new ApiHttpError(400, 'validation_error', err instanceof Error ? err.message : 'Invalid TH/s value');
      }

      const btcPrice = await btcUsd().catch(() => NaN);
      if (!isFinite(btcPrice) || btcPrice <= 0) {
        throw new ApiHttpError(503, 'quote_unavailable', 'BTC price unavailable; unable to create payment intent');
      }
      const totalUsd = Number((amount * btcPrice).toFixed(6));
      const configuredHours = Number(process.env.NH_DIRECT_SPEED_ORDER_HOURS ?? '24');
      const hoursForOrder = isFinite(configuredHours) ? Math.min(72, Math.max(1, Math.round(configuredHours))) : 24;
      const phFromLimit = limitEh * 1000;
      const directConfig: NhDirectFixedSpeedConfig = {
        kind: 'direct_fixed_speed',
        amount,
        limitEh,
        bottomLimitEh,
      };

      const order = await createOrder({
        ph: phFromLimit,
        hours: hoursForOrder,
        pool,
        worker,
        requestedProvider: DEFAULT_FULFILLMENT_PROVIDER,
        nhRequestedMode: 'direct_fixed_speed',
        nhDirectConfig: JSON.stringify(directConfig),
        user: auth.userId,
        totalUsd,
      });
      const payment = await ensurePaymentIntent({
        orderId: order.id,
        userId: auth.userId,
        totalUsd: order.totalUsd,
        btcUsd: btcPrice,
        expiresAt: order.expiresAt ?? Date.now() + hoursForOrder * 3600 * 1000,
      });

      sendApiJson(res, 201, {
        ok: true,
        message: 'Fixed-speed order request created',
        order,
        orderMode: 'direct_fixed_speed',
        orderModeLabel: requestedOrderModeLabel('direct_fixed_speed'),
        orderModeBehavior: 'After payment confirmation: business fixed speed first, then standard fallback.',
        request: {
          amountBtc: amount,
          limitTh,
          bottomLimitTh: bottomLimitTh ?? null,
        },
        payment: {
          id: payment.id,
          status: payment.status,
          reference: payment.reference,
          expiresAt: payment.expiresAt,
          usdcBaseAddress: paymentUsdcBaseAddress(),
          usdcSolAddress: paymentUsdcSolAddress(),
          btcOnchainAddress: paymentBtcAddress(),
          usdcBaseAmount: payment.usdcBaseAmount,
          usdcSolAmount: payment.usdcSolAmount,
          btcAmount: payment.btcAmount,
        },
      });
      return;
    }

    if (method === 'POST' && routePath === '/rent/fixed_duration') {
      const body = await readJsonBody(req, cfg.maxBodyBytes);
      const amount = bodyNumber(body, 'amount');
      const hours = bodyInteger(body, 'hours');
      const pool = bodyStringAny(body, 'pool');
      const worker = bodyStringAny(body, 'worker');
      const limitTh = optionalBodyNumber(body, 'limit_th', 'limitTh');
      const bottomLimitTh = optionalBodyNumber(body, 'bottom_limit_th', 'bottomLimitTh');
      const variantRaw = optionalBodyString(body, 'variant');
      const variant = variantRaw ? parseDurationVariantInput(variantRaw) : 'auto';

      if (!isFinite(amount) || amount <= 0) {
        throw new ApiHttpError(400, 'validation_error', 'Field \'amount\' must be > 0');
      }
      if (!isFinite(hours) || hours <= 0 || hours > 72) {
        throw new ApiHttpError(400, 'validation_error', 'Field \'hours\' must be an integer within [1, 72]');
      }
      if (variantRaw && !variant) {
        throw new ApiHttpError(
          400,
          'bad_request',
          "Field 'variant' must be one of: auto, business_type_endts, business_type_subtype_endts, business_engine_duration, business_engine_duration_endts, business_engine_subtype_duration_endts"
        );
      }

      const poolOk = validatePool(pool);
      if (!poolOk.valid) {
        throw new ApiHttpError(400, 'validation_error', `Pool not allowed: ${poolOk.reason ?? 'invalid pool'}`);
      }
      if (!isValidWorkerName(worker)) {
        throw new ApiHttpError(400, 'validation_error', 'Worker must be a valid BTC mainnet address only (no suffix like .worker, no dots)');
      }

      let limitEh: number | undefined;
      let bottomLimitEh: number | undefined;
      try {
        limitEh = typeof limitTh === 'number' ? ehFromTh(limitTh) : undefined;
        bottomLimitEh = typeof bottomLimitTh === 'number' ? ehFromTh(bottomLimitTh) : undefined;
      } catch (err) {
        throw new ApiHttpError(400, 'validation_error', err instanceof Error ? err.message : 'Invalid TH/s value');
      }

      const btcPrice = await btcUsd().catch(() => NaN);
      if (!isFinite(btcPrice) || btcPrice <= 0) {
        throw new ApiHttpError(503, 'quote_unavailable', 'BTC price unavailable; unable to create payment intent');
      }
      const totalUsd = Number((amount * btcPrice).toFixed(6));
      const phApprox = (limitEh ?? bottomLimitEh ?? 0.001) * 1000;
      const directConfig: NhDirectFixedDurationConfig = {
        kind: 'direct_fixed_duration',
        amount,
        hours,
        limitEh,
        bottomLimitEh,
        variant: variant ?? 'auto',
      };

      const order = await createOrder({
        ph: phApprox,
        hours,
        pool,
        worker,
        requestedProvider: DEFAULT_FULFILLMENT_PROVIDER,
        nhRequestedMode: 'direct_fixed_duration',
        nhDirectConfig: JSON.stringify(directConfig),
        user: auth.userId,
        totalUsd,
      });
      const payment = await ensurePaymentIntent({
        orderId: order.id,
        userId: auth.userId,
        totalUsd: order.totalUsd,
        btcUsd: btcPrice,
        expiresAt: order.expiresAt ?? Date.now() + hours * 3600 * 1000,
      });

      sendApiJson(res, 201, {
        ok: true,
        message: 'Fixed-duration order request created',
        order,
        orderMode: 'direct_fixed_duration',
        orderModeLabel: requestedOrderModeLabel('direct_fixed_duration'),
        orderModeBehavior:
          'After payment confirmation: business fixed duration variant(s) first, then standard fallback.',
        request: {
          amountBtc: amount,
          hours,
          limitTh: limitTh ?? null,
          bottomLimitTh: bottomLimitTh ?? null,
          variant: variant ?? 'auto',
        },
        payment: {
          id: payment.id,
          status: payment.status,
          reference: payment.reference,
          expiresAt: payment.expiresAt,
          usdcBaseAddress: paymentUsdcBaseAddress(),
          usdcSolAddress: paymentUsdcSolAddress(),
          btcOnchainAddress: paymentBtcAddress(),
          usdcBaseAmount: payment.usdcBaseAmount,
          usdcSolAmount: payment.usdcSolAmount,
          btcAmount: payment.btcAmount,
        },
      });
      return;
    }

    const orderStatusId = method === 'GET' ? parseOrderId(routePath) : undefined;
    if (method === 'GET' && orderStatusId) {
      const o = await getOrder(orderStatusId);
      if (!o) throw new ApiHttpError(404, 'not_found', 'Order not found');
      if (!canAccessOrderFromApi(auth, o.user)) throw new ApiHttpError(403, 'forbidden', 'Not authorized');
      sendApiJson(res, 200, {
        ok: true,
        order: {
          id: o.id,
          status: o.status,
          requestedProvider: o.requestedProvider,
          orderMode: o.nhRequestedMode ?? null,
          fulfillmentProvider: o.fulfillmentProvider,
          ph: o.ph,
          hours: o.hours,
          pool: o.pool,
          worker: o.worker,
          expiresAt: o.expiresAt,
          createdAt: o.createdAt,
        },
      });
      return;
    }

    const orderTimeLeftId = method === 'GET' ? parseOrderId(routePath, '/time_left') : undefined;
    if (method === 'GET' && orderTimeLeftId) {
      const o = await getOrder(orderTimeLeftId);
      if (!o) throw new ApiHttpError(404, 'not_found', 'Order not found');
      if (!canAccessOrderFromApi(auth, o.user)) throw new ApiHttpError(403, 'forbidden', 'Not authorized');
      if (o.status !== 'active') {
        throw new ApiHttpError(409, 'invalid_state', `Order ${orderTimeLeftId} is not active (status: ${o.status})`);
      }
      if (!o.expiresAt) throw new ApiHttpError(409, 'invalid_state', `Order ${orderTimeLeftId} has no expiry timestamp`);
      const leftMs = o.expiresAt - Date.now();
      sendApiJson(res, 200, {
        ok: true,
        orderId: orderTimeLeftId,
        active: leftMs > 0,
        timeLeftMs: Math.max(0, leftMs),
        timeLeftHuman: formatRemaining(Math.max(0, leftMs)),
        endsAt: o.expiresAt,
      });
      return;
    }

    const orderCancelId = method === 'POST' ? parseOrderId(routePath, '/cancel') : undefined;
    if (method === 'POST' && orderCancelId) {
      const o = await getOrder(orderCancelId);
      if (!o) throw new ApiHttpError(404, 'not_found', 'Order not found');
      if (!canAccessOrderFromApi(auth, o.user)) throw new ApiHttpError(403, 'forbidden', 'Not authorized');
      const message = await cancelOrder(orderCancelId);
      sendApiJson(res, 200, { ok: true, orderId: orderCancelId, message });
      return;
    }

    const orderPaymentStatusId = method === 'GET' ? parseOrderId(routePath, '/payment_status') : undefined;
    if (method === 'GET' && orderPaymentStatusId) {
      const o = await getOrder(orderPaymentStatusId);
      if (!o) throw new ApiHttpError(404, 'not_found', 'Order not found');
      if (!canAccessOrderFromApi(auth, o.user)) throw new ApiHttpError(403, 'forbidden', 'Not authorized');
      const p = await getPaymentIntentByOrder(orderPaymentStatusId);
      if (!p) throw new ApiHttpError(404, 'not_found', 'Payment intent not found for order');
      sendApiJson(res, 200, {
        ok: true,
        orderId: orderPaymentStatusId,
        payment: {
          id: p.id,
          status: p.status,
          reference: p.reference,
          usdcBaseAddress: paymentUsdcBaseAddress(),
          usdcSolAddress: paymentUsdcSolAddress(),
          btcOnchainAddress: paymentBtcAddress(),
          usdcBaseAmount: p.usdcBaseAmount,
          usdcSolAmount: p.usdcSolAmount,
          btcAmount: p.btcAmount,
          expiresAt: p.expiresAt,
          confirmedMethod: p.confirmedMethod,
          confirmedTxId: p.confirmedTxId,
          confirmedAt: p.confirmedAt,
          notes: p.notes,
        },
      });
      return;
    }

    const orderMarkPaidId = method === 'POST' ? parseOrderId(routePath, '/mark_paid') : undefined;
    if (method === 'POST' && orderMarkPaidId) {
      requireAdmin(auth);
      const begin = await beginFulfillment(orderMarkPaidId);
      if (begin === 'not_found') throw new ApiHttpError(404, 'not_found', 'Order not found');
      if (begin === 'already_processing') throw new ApiHttpError(409, 'invalid_state', `Order ${orderMarkPaidId} fulfillment already in progress`);
      if (begin === 'not_awaiting_payment') {
        const current = await getOrder(orderMarkPaidId);
        throw new ApiHttpError(409, 'invalid_state', `Order ${orderMarkPaidId} not awaiting payment (status ${current?.status ?? 'unknown'})`);
      }
      try {
        const requireVerified = (process.env.REQUIRE_PAYMENT_CONFIRMATION_FOR_MARK_PAID ?? 'false').toLowerCase() === 'true';
        const message = await fulfillOrder(orderMarkPaidId, requireVerified);
        sendApiJson(res, 200, { ok: true, orderId: orderMarkPaidId, message });
      } catch (err) {
        await rollbackFulfillment(orderMarkPaidId).catch((rollbackErr) => console.error('fulfillment rollback failed', rollbackErr));
        throw new ApiHttpError(500, 'fulfillment_error', err instanceof Error ? err.message : 'Fulfillment error');
      }
      return;
    }

    if (method === 'POST' && routePath === '/payments/verify') {
      requireAdmin(auth);
      const summary = await runPaymentVerificationTick();
      const activated = await autoActivateConfirmedOrders(summary.confirmedOrderIds);
      sendApiJson(res, 200, {
        ok: true,
        checked: summary.checked,
        confirmed: summary.confirmed,
        expired: summary.expired,
        autoActivated: activated,
      });
      return;
    }

    if (method === 'POST' && routePath === '/payments/verify_debug') {
      requireAdmin(auth);
      const body = await readJsonBody(req, cfg.maxBodyBytes);
      const limit = optionalBoundedInteger(body.limit ?? requestUrl.searchParams.get('limit'), 10, 1, 20);
      const debug = await runPaymentVerificationDebug({ maxIntents: limit });
      sendApiJson(res, 200, { ok: true, debug });
      return;
    }

    if (method === 'GET' && routePath === '/finance/summary') {
      requireAdmin(auth);
      const summary = await financeSummaryData();
      sendApiJson(res, 200, { ok: true, summary });
      return;
    }

    sendApiJson(res, 404, { ok: false, error: 'not_found', message: 'Route not found' });
  } catch (err) {
    const apiErr = asApiError(err);
    const payload: Record<string, unknown> = {
      ok: false,
      error: apiErr.errorCode,
      message: apiErr.message,
    };
    if (apiErr.details !== undefined) payload.details = apiErr.details;
    sendApiJson(res, apiErr.statusCode, payload);
  }
}

async function startRestApiServer(): Promise<void> {
  const cfg = loadApiRuntimeConfig();
  if (!cfg) {
    console.log('REST API disabled (REST_API_ENABLED=false)');
    return;
  }
  await seedBootstrapApiUsers(cfg);

  const server = createServer((req, res) => {
    void handleApiRequest(req, res, cfg);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`REST API listening on http://${cfg.host}:${cfg.port}${cfg.basePath}`);
  });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case 'quote':
        await handleQuote(interaction);
        break;
      case 'rent':
        await handleRent(interaction);
        break;
      case 'rent-with-fixed-speed':
        await handleRentWithFixedSpeed(interaction);
        break;
      case 'rent-with-fixed-duration':
        await handleRentWithFixedDuration(interaction);
        break;
      case 'status':
        await handleStatus(interaction);
        break;
      case 'time_left':
        await handleTimeLeft(interaction);
        break;
      case 'cancel':
        await handleCancel(interaction);
        break;
      case 'mark_paid':
        await handleMarkPaid(interaction);
        break;
      case 'payment_status':
        await handlePaymentStatus(interaction);
        break;
      case 'verify_payments':
        await handleVerifyPayments(interaction);
        break;
      case 'verify_payments_debug':
        await handleVerifyPaymentsDebug(interaction);
        break;
      case 'nh_payload_preview':
        await handleNhPayloadPreview(interaction);
        break;
      case 'finance_summary':
        await handleFinanceSummary(interaction);
        break;
      default:
        await interaction.reply({ content: 'Unknown command', ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'Error processing request', ephemeral: true }).catch(() => {});
    }
  }
});

async function handleQuote(interaction: ChatInputCommandInteraction) {
  const ph = interaction.options.getNumber('ph', true);
  const hours = interaction.options.getInteger('hours', true);
  const pool = 'quote';
  const worker = 'quote';

  const minPh = Number(process.env.MIN_PH ?? '0');
  const maxPh = Number(process.env.MAX_PH ?? '0');
  const minHours = Number(process.env.MIN_HOURS ?? '0');
  const maxHours = Number(process.env.MAX_HOURS ?? '0');
  if (minPh > 0 && ph < minPh) {
    await interaction.reply({ content: `Minimum size is ${minPh} PH`, ephemeral: true });
    return;
  }
  if (maxPh > 0 && ph > maxPh) {
    await interaction.reply({ content: `Maximum size is ${maxPh} PH`, ephemeral: true });
    return;
  }
  if (minHours > 0 && hours < minHours) {
    await interaction.reply({ content: `Minimum duration is ${minHours} hours`, ephemeral: true });
    return;
  }
  if (maxHours > 0 && hours > maxHours) {
    await interaction.reply({ content: `Maximum duration is ${maxHours} hours`, ephemeral: true });
    return;
  }
  if (hours > 72) {
    await interaction.reply({ content: 'Maximum duration is 72 hours', ephemeral: true });
    return;
  }

  let q;
  let provider: FulfillmentProvider;
  let btcPrice: number;
  try {
    const resolved = await resolveFulfillmentQuote({ ph, hours, pool, worker });
    q = resolved.pricedQuote;
    provider = resolved.provider;
    btcPrice = resolved.btcPrice;
    await ensureNhQuotedOrderSatisfiesMinimum({
      ph,
      hours,
      usdPerPhDay: resolved.routingQuote.baseUsdPerPhDay,
      orderMode: 'auto',
    });
  } catch (err) {
    const msg = (err as Error).message || 'No valid quote available right now.';
    await interaction.reply({ content: msg, ephemeral: true });
    return;
  }
  const units = durationFactor(ph, hours);
  const baseTotal = q.baseUsdPerPhDay * units;
  const feeTotal = q.feeUsdPerPhDay * units;
  const marginTotal = q.marginUsdPerPhDay * units;
  const bufferTotal = q.bufferUsdPerPhDay * units;
  const marginBps = Number(process.env.PRICE_MARGIN_BPS ?? '1000');
  const bufferBps = Number(process.env.BETA_BUFFER_BPS ?? '1000');
  const feePct = q.baseUsdPerPhDay > 0 ? (q.feeUsdPerPhDay / q.baseUsdPerPhDay) * 100 : 0;
  const feeLineBps = `  Platform fee (${feePct.toFixed(2)}%): ${usdBtcLine(q.feeUsdPerPhDay, btcPrice)} / PH-day -> ${usdBtcLine(
    feeTotal,
    btcPrice
  )}`;
  const marginLineBps = `  Margin (${(marginBps / 100).toFixed(2)}%): ${usdBtcLine(q.marginUsdPerPhDay, btcPrice)} / PH-day -> ${usdBtcLine(
    marginTotal,
    btcPrice
  )}`;
  const bufferLine = `  BETA buffer funding (${(bufferBps / 100).toFixed(2)}%): ${usdBtcLine(
    q.bufferUsdPerPhDay,
    btcPrice
  )} / PH-day -> ${usdBtcLine(bufferTotal, btcPrice)}`;
  const lines = [
    `Quote: ${ph} PH for ${hours}h -> ${usdBtcLine(q.totalUsd, btcPrice)} (unit: ${usdBtcLine(q.usdPerPhDay, btcPrice)} / PH-day).`,
    `Estimated provider: ${providerLabel(provider)}.`,
    `Order mode: ${nhOrderModeLabel('auto')}.`,
    `Mode behavior: ${nhOrderModeBehavior('auto')}`,
    `  Base: ${usdBtcLine(q.baseUsdPerPhDay, btcPrice)} / PH-day -> ${usdBtcLine(baseTotal, btcPrice)}`,
    feeLineBps,
    marginLineBps,
    bufferLine,
  ];
  const quoteUsdcBaseAddr = paymentUsdcBaseAddress();
  const quoteUsdcSolAddr = paymentUsdcSolAddress();
  const quoteBtcAddr = paymentBtcAddress();
  lines.push('Estimated payment methods (exact unique amount is generated at /rent):');
  lines.push(`USDC (Base): ${quoteUsdcBaseAddr ?? 'not configured'} (est amount: ${q.totalUsd.toFixed(6)} USDC)`);
  lines.push(`USDC (Solana): ${quoteUsdcSolAddr ?? 'not configured'} (est amount: ${q.totalUsd.toFixed(6)} USDC)`);
  lines.push(
    `BTC on-chain: ${quoteBtcAddr ?? 'not configured'}${
      isFinite(btcPrice) && btcPrice > 0 ? ` (est amount: ${(q.totalUsd / btcPrice).toFixed(8)} BTC)` : ''
    }`
  );
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleNhPayloadPreview(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: 'Admins only.', ephemeral: true });
    return;
  }

  const ph = interaction.options.getNumber('ph', true);
  const hours = interaction.options.getInteger('hours', true);
  const pool = interaction.options.getString('pool', true);
  const worker = interaction.options.getString('worker', true);
  const requestedOrderMode = parseNhOrderModeInput(interaction.options.getString('order_mode'));
  const effectiveOrderMode = resolveNhOrderMode(requestedOrderMode);
  const resolvePoolId = interaction.options.getBoolean('resolve_pool_id') ?? false;

  if (!isValidWorkerName(worker)) {
    await interaction.reply({
      content: 'Worker must be a valid BTC mainnet address only (no suffix like `.worker`, no dots).',
      ephemeral: true,
    });
    return;
  }

  const minPh = Number(process.env.MIN_PH ?? '0');
  const maxPh = Number(process.env.MAX_PH ?? '0');
  const minHours = Number(process.env.MIN_HOURS ?? '0');
  const maxHours = Number(process.env.MAX_HOURS ?? '0');
  if (minPh > 0 && ph < minPh) {
    await interaction.reply({ content: `Minimum size is ${minPh} PH`, ephemeral: true });
    return;
  }
  if (maxPh > 0 && ph > maxPh) {
    await interaction.reply({ content: `Maximum size is ${maxPh} PH`, ephemeral: true });
    return;
  }
  if (minHours > 0 && hours < minHours) {
    await interaction.reply({ content: `Minimum duration is ${minHours} hours`, ephemeral: true });
    return;
  }
  if (maxHours > 0 && hours > maxHours) {
    await interaction.reply({ content: `Maximum duration is ${maxHours} hours`, ephemeral: true });
    return;
  }
  if (hours > 72) {
    await interaction.reply({ content: 'Maximum duration is 72 hours', ephemeral: true });
    return;
  }

  const poolOk = validatePool(pool);
  if (!poolOk.valid) {
    await interaction.reply({ content: `Pool not allowed: ${poolOk.reason}`, ephemeral: true });
    return;
  }

  try {
    const routingQuote = await quoteHashrate({ ph, hours, pool, worker, preferredSource: 'nicehash' });
    if (routingQuote.source !== 'nicehash') {
      await interaction.reply({ content: 'NiceHash quote unavailable right now. Please retry shortly.', ephemeral: true });
      return;
    }
    const plan = await previewNhOrderPlacement(
      {
        ph,
        hours,
        poolUrl: pool,
        worker,
        usdPerPhDay: routingQuote.baseUsdPerPhDay,
        orderMode: effectiveOrderMode,
      },
      { resolvePoolId, poolIdPlaceholder: '<resolved_at_order_time>' }
    );

    const body = JSON.stringify(
      {
        mode: plan.mode,
        modeLabel: nhOrderModeLabel(plan.mode),
        modeBehavior: nhOrderModeBehavior(plan.mode),
        orderType: plan.orderType,
        market: plan.market,
        limit: plan.limit,
        amount: plan.amount,
        poolId: plan.poolId,
        poolIdResolved: plan.poolIdResolved,
        bottomLimit: plan.bottomLimit,
        endTs: plan.endTs,
        requestCandidates: plan.requestCandidates,
      },
      null,
      2
    );
    const prefix = resolvePoolId
      ? 'Preview generated (poolId resolved/created).'
      : 'Preview generated (poolId placeholder used; pass `resolve_pool_id=true` for exact poolId).';
    const maxContent = 1800;
    const payloadBlock = body.length > maxContent ? `${body.slice(0, maxContent)}\n...<truncated>` : body;
    await interaction.reply({ content: `${prefix}\n\`\`\`json\n${payloadBlock}\n\`\`\``, ephemeral: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.reply({ content: `Preview failed: ${msg}`, ephemeral: true });
  }
}

async function handleRent(interaction: ChatInputCommandInteraction) {
  const ph = interaction.options.getNumber('ph', true);
  const hours = interaction.options.getInteger('hours', true);
  const pool = interaction.options.getString('pool', true);
  const worker = interaction.options.getString('worker', true);

  if (!isValidWorkerName(worker)) {
    await interaction.reply({
      content: 'Worker must be a valid BTC mainnet address only (no suffix like `.worker`, no dots).',
      ephemeral: true,
    });
    return;
  }

  const minPh = Number(process.env.MIN_PH ?? '0');
  const maxPh = Number(process.env.MAX_PH ?? '0');
  const minHours = Number(process.env.MIN_HOURS ?? '0');
  const maxHours = Number(process.env.MAX_HOURS ?? '0');
  if (minPh > 0 && ph < minPh) {
    await interaction.reply({ content: `Minimum size is ${minPh} PH`, ephemeral: true });
    return;
  }
  if (maxPh > 0 && ph > maxPh) {
    await interaction.reply({ content: `Maximum size is ${maxPh} PH`, ephemeral: true });
    return;
  }
  if (minHours > 0 && hours < minHours) {
    await interaction.reply({ content: `Minimum duration is ${minHours} hours`, ephemeral: true });
    return;
  }
  if (maxHours > 0 && hours > maxHours) {
    await interaction.reply({ content: `Maximum duration is ${maxHours} hours`, ephemeral: true });
    return;
  }
  if (hours > 72) {
    await interaction.reply({ content: 'Maximum duration is 72 hours', ephemeral: true });
    return;
  }

  const poolOk = validatePool(pool);
  if (!poolOk.valid) {
    await interaction.reply({ content: `Pool not allowed: ${poolOk.reason}`, ephemeral: true });
    return;
  }

  let q;
  let provider: FulfillmentProvider;
  let btcPrice: number;
  let routingQuote: Awaited<ReturnType<typeof quoteHashrate>>;
  try {
    const resolved = await resolveFulfillmentQuote({ ph, hours, pool, worker });
    q = resolved.pricedQuote;
    provider = resolved.provider;
    btcPrice = resolved.btcPrice;
    routingQuote = resolved.routingQuote;
  } catch (err) {
    await interaction.reply({ content: (err as Error).message || 'No valid quote available right now. Please retry shortly.', ephemeral: true });
    return;
  }

  if (provider === 'nicehash') {
    const nhBal = await nicehashBalanceUsd();
    const nhGate = (process.env.NICEHASH_GATE_ENABLED ?? 'true').toLowerCase() !== 'false';
    if (nhGate && (!isFinite(nhBal.usd) || nhBal.usd < 50)) {
      await interaction.reply({ content: 'NiceHash account balance is low. Please check back later.', ephemeral: true });
      return;
    }
  }

  if (provider === 'nicehash') {
    try {
      await ensureNhOrderSatisfiesMinimum({
        ph,
        hours,
        poolUrl: pool,
        worker,
        // NiceHash order funding must use the raw base quote only.
        usdPerPhDay: routingQuote.baseUsdPerPhDay,
        orderMode: 'auto',
      });
    } catch (err) {
      const msg = (err as Error).message || 'Order does not satisfy NiceHash minimum requirements.';
      await interaction.reply({
        content: `Order rejected before creation: ${msg}`,
        ephemeral: true,
      });
      return;
    }
  }

  const order = await createOrder({
    ph,
    hours,
    pool,
    worker,
    requestedProvider: provider,
    nhRequestedMode: 'auto',
    user: interaction.user.id,
    totalUsd: q.totalUsd,
  });
  const payment = await ensurePaymentIntent({
    orderId: order.id,
    userId: interaction.user.id,
    totalUsd: order.totalUsd,
    btcUsd: btcPrice,
    expiresAt: order.expiresAt ?? Date.now() + hours * 3600 * 1000,
  });

  const usdcAddr = paymentUsdcBaseAddress();
  const usdcSolAddr = paymentUsdcSolAddress();
  const btcAddr = paymentBtcAddress();
  const expiryIso = new Date(payment.expiresAt).toISOString();

  const paymentMethods: string[] = [
    `USDC (Base): ${usdcAddr ?? 'not configured'} (amount: ${payment.usdcBaseAmount.toFixed(6)} USDC)`,
    `USDC (Solana): ${usdcSolAddr ?? 'not configured'} (amount: ${payment.usdcSolAmount.toFixed(6)} USDC)`,
    `BTC on-chain: ${btcAddr ?? 'not configured'}${payment.btcAmount ? ` (amount: ${payment.btcAmount.toFixed(8)} BTC)` : ''}`,
  ];

  const lines = [
    `Order ${order.id} accepted. Status: ${order.status}. Provider selected: ${providerLabel(provider)}.`,
    `Order mode: ${nhOrderModeLabel('auto')}.`,
    `Mode behavior: ${nhOrderModeBehavior('auto')}`,
    `Payment reference: ${payment.reference} (expires ${expiryIso})`,
    ...paymentMethods,
    'Important: pay the exact amount shown (all decimals). Underpayment keeps the order pending.',
    `Once payment is confirmed, the order will auto-start on ${providerLabel(provider)}.`
  ];
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleRentWithFixedSpeed(interaction: ChatInputCommandInteraction) {
  const amount = interaction.options.getNumber('amount', true);
  if (!isFinite(amount) || amount <= 0) {
    await interaction.reply({ content: 'Amount must be > 0 BTC.', ephemeral: true });
    return;
  }

  const pool = interaction.options.getString('pool', true);
  const worker = interaction.options.getString('worker', true);
  const poolOk = validatePool(pool);
  if (!poolOk.valid) {
    await interaction.reply({ content: `Pool not allowed: ${poolOk.reason}`, ephemeral: true });
    return;
  }
  if (!isValidWorkerName(worker)) {
    await interaction.reply({
      content: 'Worker must be a valid BTC mainnet address only (no suffix like `.worker`, no dots).',
      ephemeral: true,
    });
    return;
  }

  let limitEh: number;
  let bottomLimitEh: number | undefined;
  try {
    limitEh = ehFromTh(interaction.options.getNumber('limit_th', true));
    const bottomLimitTh = interaction.options.getNumber('bottom_limit_th');
    bottomLimitEh = typeof bottomLimitTh === 'number' ? ehFromTh(bottomLimitTh) : undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.reply({ content: `Input error: ${msg}`, ephemeral: true });
    return;
  }

  try {
    const btcPrice = await btcUsd();
    if (!isFinite(btcPrice) || btcPrice <= 0) {
      throw new Error('BTC price unavailable; unable to create payment intent right now.');
    }
    const totalUsd = Number((amount * btcPrice).toFixed(6));
    const configuredHours = Number(process.env.NH_DIRECT_SPEED_ORDER_HOURS ?? '24');
    const hoursForOrder = isFinite(configuredHours) ? Math.min(72, Math.max(1, Math.round(configuredHours))) : 24;
    const phFromLimit = limitEh * 1000;
    const directConfig: NhDirectFixedSpeedConfig = {
      kind: 'direct_fixed_speed',
      amount,
      limitEh,
      bottomLimitEh,
    };

    const order = await createOrder({
      ph: phFromLimit,
      hours: hoursForOrder,
      pool,
      worker,
      requestedProvider: DEFAULT_FULFILLMENT_PROVIDER,
      nhRequestedMode: 'direct_fixed_speed',
      nhDirectConfig: JSON.stringify(directConfig),
      user: interaction.user.id,
      totalUsd,
    });
    const payment = await ensurePaymentIntent({
      orderId: order.id,
      userId: interaction.user.id,
      totalUsd: order.totalUsd,
      btcUsd: btcPrice,
      expiresAt: order.expiresAt ?? Date.now() + hoursForOrder * 3600 * 1000,
    });

    const expiryIso = new Date(payment.expiresAt).toISOString();
    const lines = [
      `Order ${order.id} accepted. Status: ${order.status}. Provider selected: NiceHash.`,
      `Order mode: ${requestedOrderModeLabel('direct_fixed_speed')}.`,
      `Execution after payment: business fixed speed first, then standard fallback if needed.`,
      `Requested amount: ${amount.toFixed(8)} BTC. Limit: ${(limitEh * TH_PER_EH).toFixed(2)} TH/s${
        typeof bottomLimitEh === 'number' ? `, bottomLimit ${(bottomLimitEh * TH_PER_EH).toFixed(2)} TH/s` : ''
      }.`,
      `Payment reference: ${payment.reference} (expires ${expiryIso})`,
      `USDC (Base): ${paymentUsdcBaseAddress() ?? 'not configured'} (amount: ${payment.usdcBaseAmount.toFixed(6)} USDC)`,
      `USDC (Solana): ${paymentUsdcSolAddress() ?? 'not configured'} (amount: ${payment.usdcSolAmount.toFixed(6)} USDC)`,
      `BTC on-chain: ${paymentBtcAddress() ?? 'not configured'}${payment.btcAmount ? ` (amount: ${payment.btcAmount.toFixed(8)} BTC)` : ''}`,
      'Important: pay the exact amount shown (all decimals). Underpayment keeps the order pending.',
      'Once payment is confirmed, the order will auto-start on NiceHash.',
    ];
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.reply({ content: `Fixed-speed request failed: ${msg}`, ephemeral: true });
  }
}

async function handleRentWithFixedDuration(interaction: ChatInputCommandInteraction) {
  const amount = interaction.options.getNumber('amount', true);
  const hours = interaction.options.getInteger('hours', true);
  if (!isFinite(amount) || amount <= 0) {
    await interaction.reply({ content: 'Amount must be > 0 BTC.', ephemeral: true });
    return;
  }
  if (!isFinite(hours) || hours <= 0) {
    await interaction.reply({ content: 'Hours must be > 0.', ephemeral: true });
    return;
  }

  const pool = interaction.options.getString('pool', true);
  const worker = interaction.options.getString('worker', true);
  const variant = parseDurationVariantInput(interaction.options.getString('variant')) ?? 'auto';

  const poolOk = validatePool(pool);
  if (!poolOk.valid) {
    await interaction.reply({ content: `Pool not allowed: ${poolOk.reason}`, ephemeral: true });
    return;
  }
  if (!isValidWorkerName(worker)) {
    await interaction.reply({
      content: 'Worker must be a valid BTC mainnet address only (no suffix like `.worker`, no dots).',
      ephemeral: true,
    });
    return;
  }

  let limitEh: number | undefined;
  let bottomLimitEh: number | undefined;
  try {
    const limitTh = interaction.options.getNumber('limit_th');
    const bottomLimitTh = interaction.options.getNumber('bottom_limit_th');
    limitEh = typeof limitTh === 'number' ? ehFromTh(limitTh) : undefined;
    bottomLimitEh = typeof bottomLimitTh === 'number' ? ehFromTh(bottomLimitTh) : undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.reply({ content: `Input error: ${msg}`, ephemeral: true });
    return;
  }

  try {
    const btcPrice = await btcUsd();
    if (!isFinite(btcPrice) || btcPrice <= 0) {
      throw new Error('BTC price unavailable; unable to create payment intent right now.');
    }
    const totalUsd = Number((amount * btcPrice).toFixed(6));
    const phApprox = (limitEh ?? bottomLimitEh ?? 0.001) * 1000;
    const directConfig: NhDirectFixedDurationConfig = {
      kind: 'direct_fixed_duration',
      amount,
      hours,
      limitEh,
      bottomLimitEh,
      variant,
    };

    const order = await createOrder({
      ph: phApprox,
      hours,
      pool,
      worker,
      requestedProvider: DEFAULT_FULFILLMENT_PROVIDER,
      nhRequestedMode: 'direct_fixed_duration',
      nhDirectConfig: JSON.stringify(directConfig),
      user: interaction.user.id,
      totalUsd,
    });
    const payment = await ensurePaymentIntent({
      orderId: order.id,
      userId: interaction.user.id,
      totalUsd: order.totalUsd,
      btcUsd: btcPrice,
      expiresAt: order.expiresAt ?? Date.now() + hours * 3600 * 1000,
    });

    const expiryIso = new Date(payment.expiresAt).toISOString();
    const lines = [
      `Order ${order.id} accepted. Status: ${order.status}. Provider selected: NiceHash.`,
      `Order mode: ${requestedOrderModeLabel('direct_fixed_duration')}.`,
      `Execution after payment: business fixed duration${variant !== 'auto' ? ` (${variant})` : ' (auto variants)'} first, then standard fallback if needed.`,
      `Requested amount: ${amount.toFixed(8)} BTC. Duration: ${hours}h.${typeof limitEh === 'number' ? ` Limit: ${(limitEh * TH_PER_EH).toFixed(2)} TH/s.` : ''}${
        typeof bottomLimitEh === 'number' ? ` Bottom limit: ${(bottomLimitEh * TH_PER_EH).toFixed(2)} TH/s.` : ''
      }`,
      `Payment reference: ${payment.reference} (expires ${expiryIso})`,
      `USDC (Base): ${paymentUsdcBaseAddress() ?? 'not configured'} (amount: ${payment.usdcBaseAmount.toFixed(6)} USDC)`,
      `USDC (Solana): ${paymentUsdcSolAddress() ?? 'not configured'} (amount: ${payment.usdcSolAmount.toFixed(6)} USDC)`,
      `BTC on-chain: ${paymentBtcAddress() ?? 'not configured'}${payment.btcAmount ? ` (amount: ${payment.btcAmount.toFixed(8)} BTC)` : ''}`,
      'Important: pay the exact amount shown (all decimals). Underpayment keeps the order pending.',
      'Once payment is confirmed, the order will auto-start on NiceHash.',
    ];
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.reply({ content: `Fixed-duration request failed: ${msg}`, ephemeral: true });
  }
}

async function handleMarkPaid(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized', ephemeral: true });
    return;
  }

  const id = interaction.options.getString('id', true);
  const begin = await beginFulfillment(id);
  if (begin === 'not_found') {
    await interaction.reply({ content: 'Not found', ephemeral: true });
    return;
  }
  if (begin === 'already_processing') {
    await interaction.reply({ content: `Order ${id} fulfillment already in progress`, ephemeral: true });
    return;
  }
  if (begin === 'not_awaiting_payment') {
    const current = await getOrder(id);
    await interaction.reply({ content: `Order ${id} not awaiting payment (status ${current?.status ?? 'unknown'})`, ephemeral: true });
    return;
  }

  try {
    const requireVerified = (process.env.REQUIRE_PAYMENT_CONFIRMATION_FOR_MARK_PAID ?? 'false').toLowerCase() === 'true';
    const result = await fulfillOrder(id, requireVerified);
    await interaction.reply({ content: result, ephemeral: true });
  } catch (err) {
    await rollbackFulfillment(id).catch((rollbackErr) => console.error('fulfillment rollback failed', rollbackErr));
    await interaction.reply({ content: `Fulfillment error: ${(err as Error).message}`, ephemeral: true });
  }
}

async function latestBaseUsdPerPhDay(
  o: { ph: number; hours: number; pool: string; worker: string }
): Promise<number> {
  try {
    const q = await quoteHashrate({
      ph: o.ph,
      hours: o.hours,
      pool: o.pool,
      worker: o.worker,
      preferredSource: 'nicehash',
    });
    if (q.source !== 'nicehash') return NaN;
    return q.baseUsdPerPhDay;
  } catch {
    return NaN;
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
  const id = interaction.options.getString('id', true);
  const o = await getOrder(id);
  if (!o) {
    await interaction.reply({ content: 'Not found', ephemeral: true });
    return;
  }
  if (!canAccessOrder(interaction.user.id, o.user)) {
    await interaction.reply({ content: 'Not authorized', ephemeral: true });
    return;
  }

  const status = [
    `Order ${id}: ${o.status}`,
    `Requested provider: ${providerLabel(o.requestedProvider)}`,
    `Order mode: ${requestedOrderModeLabel(o.nhRequestedMode)}`,
    `Active provider: ${providerLabel(o.fulfillmentProvider)}`,
    `Size: ${o.ph} PH for ${o.hours}h`,
    `Pool: ${o.pool}`,
    `Worker: ${o.worker}`,
    `Expires: ${o.expiresAt ? new Date(o.expiresAt).toISOString() : 'n/a'}`,
  ];
  await interaction.reply({ content: status.join('\n'), ephemeral: true });
}

async function handleTimeLeft(interaction: ChatInputCommandInteraction) {
  const id = interaction.options.getString('id', true);
  const o = await getOrder(id);
  if (!o) {
    await interaction.reply({ content: 'Not found', ephemeral: true });
    return;
  }
  if (!canAccessOrder(interaction.user.id, o.user)) {
    await interaction.reply({ content: 'Not authorized', ephemeral: true });
    return;
  }
  if (o.status !== 'active') {
    await interaction.reply({ content: `Order ${id} is not active (status: ${o.status})`, ephemeral: true });
    return;
  }
  if (!o.expiresAt) {
    await interaction.reply({ content: `Order ${id} has no expiry timestamp`, ephemeral: true });
    return;
  }

  const leftMs = o.expiresAt - Date.now();
  if (leftMs <= 0) {
    await interaction.reply({ content: `Order ${id} has ended.`, ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `Order ${id} time left: ${formatRemaining(leftMs)} (ends ${new Date(o.expiresAt).toISOString()})`,
    ephemeral: true,
  });
}

async function handleCancel(interaction: ChatInputCommandInteraction) {
  const id = interaction.options.getString('id', true);
  const o = await getOrder(id);
  if (!o) {
    await interaction.reply({ content: 'Not found', ephemeral: true });
    return;
  }
  if (!canAccessOrder(interaction.user.id, o.user)) {
    await interaction.reply({ content: 'Not authorized', ephemeral: true });
    return;
  }
  const res = await cancelOrder(id);
  await interaction.reply({ content: res, ephemeral: true });
}

async function handlePaymentStatus(interaction: ChatInputCommandInteraction) {
  const id = interaction.options.getString('id', true);
  const o = await getOrder(id);
  if (!o) {
    await interaction.reply({ content: 'Not found', ephemeral: true });
    return;
  }
  if (!canAccessOrder(interaction.user.id, o.user)) {
    await interaction.reply({ content: 'Not authorized', ephemeral: true });
    return;
  }

  const p = await getPaymentIntentByOrder(id);
  if (!p) {
    await interaction.reply({ content: `Order ${id} has no payment intent`, ephemeral: true });
    return;
  }

  const lines = [
    `Order ${id} payment status: ${p.status}`,
    `Reference: ${p.reference}`,
    `USDC (Base): ${paymentUsdcBaseAddress() ?? 'not configured'} (amount: ${p.usdcBaseAmount.toFixed(6)} USDC)`,
    `USDC (Solana): ${paymentUsdcSolAddress() ?? 'not configured'} (amount: ${p.usdcSolAmount.toFixed(6)} USDC)`,
    `BTC on-chain: ${paymentBtcAddress() ?? 'not configured'}${
      p.btcAmount ? ` (amount: ${p.btcAmount.toFixed(8)} BTC)` : ''
    }`,
    `Expires: ${new Date(p.expiresAt).toISOString()}`,
    `Confirmed method: ${p.confirmedMethod ?? 'n/a'}`,
    p.notes ? `Notes: ${p.notes}` : 'Notes: n/a',
    p.confirmedTxId ? `Confirmed tx: ${p.confirmedTxId}` : 'Confirmed tx: n/a',
  ];
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleVerifyPayments(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized', ephemeral: true });
    return;
  }

  const summary = await runPaymentVerificationTick();
  const activated = await autoActivateConfirmedOrders(summary.confirmedOrderIds);
  await interaction.reply({
    content: `Verification complete: checked=${summary.checked}, confirmed=${summary.confirmed}, expired=${summary.expired}, auto_activated=${activated}`,
    ephemeral: true,
  });
}

async function handleVerifyPaymentsDebug(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized', ephemeral: true });
    return;
  }

  const limit = interaction.options.getInteger('limit') ?? 10;
  const debug = await runPaymentVerificationDebug({ maxIntents: limit });

  const lines: string[] = [
    `Debug scan: checked=${debug.checked}, btc_txs=${debug.scan.btcTxs}, usdc_base_transfers=${debug.scan.usdcBaseTransfers}, usdc_sol_transfers=${debug.scan.usdcSolTransfers}`,
  ];

  for (const d of debug.intents) {
    const idShort = d.orderId.slice(0, 8);
    const matched = d.matched
      ? `matched ${d.matchedMethod} tx=${d.matchedTxId ?? 'n/a'}`
      : 'no match';
    lines.push(`[${idShort}] ${matched}`);
    lines.push(`  btc_expected=${d.expectedBtc ? d.expectedBtc.toFixed(8) : 'n/a'} usdc_base=${d.expectedUsdcBase.toFixed(6)} usdc_sol=${d.expectedUsdcSol.toFixed(6)}`);
    lines.push(`  ${d.checks.join(' | ')}`);
  }

  let out = lines.join('\n');
  if (out.length > 1900) {
    out = `${out.slice(0, 1850)}\n...truncated`;
  }
  await interaction.reply({ content: out, ephemeral: true });
}

async function handleFinanceSummary(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized', ephemeral: true });
    return;
  }

  const summary = await financeSummaryData();

  const lines = [
    `Finance summary since ${summary.startLabel}`,
    `Confirmed payments: ${summary.confirmedPaymentsCount} -> $${summary.revenueUsd.toFixed(2)} revenue`,
    `NiceHash orders: ${summary.nicehashOrdersCount} -> ${summary.spendBtc.toFixed(8)} BTC spent${
      typeof summary.spendUsd === 'number' ? ` (~$${summary.spendUsd.toFixed(2)})` : ' (USD conversion unavailable)'
    }`,
    typeof summary.netUsd === 'number' ? `Net (revenue - spend): $${summary.netUsd.toFixed(2)}` : 'Net (revenue - spend): unavailable',
  ];
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function start() {
  await ensureDbReady();
  console.log(`Database backend: ${dbBackend()}`);
  await startRestApiServer();
  await registerCommands();
  await client.login(token);
  await restoreOrderExpirySchedules();
  startPaymentVerificationLoop({
    onConfirmedOrders: async (orderIds) => {
      const activated = await autoActivateConfirmedOrders(orderIds);
      if (activated > 0) {
        console.log(`Auto-activated ${activated} order(s) from payment confirmations`);
      }
    },
  });
}

start().catch((err) => {
  console.error('Bot start failed', err);
});
