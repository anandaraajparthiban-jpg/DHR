// index.ts — Discord bot main:
// - Registers slash commands (/quote, /rent, /status, /cancel, /payment_status, /mark_paid, /verify_payments, /verify_payments_debug).
// - /rent collects user provider choice + pool + worker, creates payment intent, and waits for payment.
// - On payment confirmation, orders can auto-activate; admin can still trigger /mark_paid manually.
// - Fulfillment providers: NiceHash, Braiins, Bitties Proxy.
import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { quoteHashrate, btcUsd } from './pricing.js';
import { ensureDbReady, dbBackend } from './db.js';
import {
  createOrder,
  cancelOrder,
  beginFulfillment,
  markPaid,
  rollbackFulfillment,
  getOrder,
  saveNhInfo,
  saveProxyInfo,
  saveFulfillmentProvider,
  updateExpiry,
  completeOrder,
  listActiveExpiringOrders,
} from './orders.js';
import { validatePool } from './pools.js';
import { braiinsBalanceUsd, nicehashBalanceUsd } from './balances.js';
import { createNhOrder, cancelNhOrder } from './nhOrder.js';
import { createBraiinsOrder } from './braiins.js';
import { ensurePaymentIntent, getPaymentIntentByOrder } from './payments.js';
import { runPaymentVerificationTick, runPaymentVerificationDebug, startPaymentVerificationLoop } from './paymentVerifier.js';
import { createProxySession, proxyEnabled, terminateProxySession } from './bittiesProxy.js';

type ProviderChoice = 'nicehash' | 'braiins' | 'bitties_proxy';

const token = process.env.DISCORD_TOKEN ?? '';
const appId = process.env.DISCORD_APP_ID ?? '';

if (!token || !appId) {
  throw new Error('Missing DISCORD_TOKEN or DISCORD_APP_ID');
}

const adminUserIds = new Set((process.env.ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const orderExpiryTimers = new Map<string, NodeJS.Timeout>();
const providerChoices = [
  { name: 'NiceHash', value: 'nicehash' },
  { name: 'Braiins', value: 'braiins' },
  { name: 'Bitties Proxy', value: 'bitties_proxy' },
] as const;

const commands = [
  new SlashCommandBuilder()
    .setName('quote')
    .setDescription('Get a hashrate quote')
    .addNumberOption((opt) => opt.setName('ph').setDescription('Petahash requested').setRequired(true))
    .addIntegerOption((opt) => opt.setName('hours').setDescription('Duration in hours').setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName('provider')
        .setDescription('Preferred provider')
        .setRequired(false)
        .addChoices(...providerChoices)
    ),
  new SlashCommandBuilder()
    .setName('rent')
    .setDescription('Place a hashrate rental')
    .addNumberOption((opt) => opt.setName('ph').setDescription('Petahash requested').setRequired(true))
    .addIntegerOption((opt) => opt.setName('hours').setDescription('Duration in hours').setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName('provider')
        .setDescription('Fulfillment provider')
        .setRequired(true)
        .addChoices(...providerChoices)
    )
    .addStringOption((opt) => opt.setName('pool').setDescription('Pool URL').setRequired(true))
    .addStringOption((opt) => opt.setName('worker').setDescription('Worker name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check rental status')
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
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(appId), { body: commands.map((c) => c.toJSON()) });
  console.log('Slash commands registered');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('ready', () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

function isAdmin(userId: string): boolean {
  return adminUserIds.has(userId);
}

function canAccessOrder(userId: string, orderUserId: string): boolean {
  return isAdmin(userId) || userId === orderUserId;
}

function asProvider(value: string | null): ProviderChoice {
  if (value === 'nicehash' || value === 'braiins' || value === 'bitties_proxy') return value;
  return 'bitties_proxy';
}

function providerLabel(provider: ProviderChoice | string | undefined): string {
  if (provider === 'nicehash') return 'NiceHash';
  if (provider === 'braiins') return 'Braiins';
  if (provider === 'proxy') return 'Bitties Proxy';
  if (provider === 'bitties_proxy') return 'Bitties Proxy';
  return String(provider || 'unknown');
}

function providerQuoteSource(provider: ProviderChoice | undefined): 'nicehash' | 'braiins' | 'internal' | undefined {
  if (!provider) return undefined;
  if (provider === 'nicehash') return 'nicehash';
  if (provider === 'braiins') return 'braiins';
  // Proxy pricing can use best market quote unless custom internal pricing is wired.
  return undefined;
}

async function notifyUser(userId: string, message: string) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(message);
  } catch (err) {
    console.error(`notify user failed for ${userId}`, err);
  }
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
  if ((current.fulfillmentProvider === 'proxy' || current.fulfillmentProvider === 'bitties_proxy') && current.proxySessionId) {
    try {
      await terminateProxySession(current.proxySessionId);
    } catch (err) {
      terminated = false;
      console.error(`proxy termination failed for ${orderId}/${current.proxySessionId}`, err);
    }
  } else if (current.fulfillmentProvider === 'nicehash' && current.nhOrderId) {
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

  if (requirePaymentConfirmed) {
    const payment = await getPaymentIntentByOrder(orderId);
    if (!payment || payment.status !== 'confirmed') {
      throw new Error(`Order ${orderId} has no confirmed payment yet`);
    }
  }

  const requestedProvider = asProvider(o.requestedProvider ?? null);
  const usdPerPhDay = await latestUsdPerPhDay(o, requestedProvider);
  let expiresAt = Date.now() + o.hours * 3600 * 1000;
  let placed = '';

  if (requestedProvider === 'bitties_proxy') {
    if (!proxyEnabled()) {
      throw new Error('Bitties proxy is not configured (set BITTIES_PROXY_BASE and optional token)');
    }
    const proxy = await createProxySession({
      orderId: o.id,
      userId: o.user,
      ph: o.ph,
      hours: o.hours,
      poolUrl: o.pool,
      worker: o.worker,
    });
    await saveProxyInfo(orderId, { proxySessionId: proxy.id });
    if (proxy.expiresAt && isFinite(proxy.expiresAt)) {
      expiresAt = proxy.expiresAt;
    }
    placed = `Bitties proxy session started: ${proxy.id}.`;
  } else if (requestedProvider === 'nicehash') {
    const nh = await createNhOrder({ ph: o.ph, hours: o.hours, poolUrl: o.pool, worker: o.worker, usdPerPhDay });
    await saveNhInfo(orderId, {
      nhOrderId: nh.id,
      nhMarket: nh.market,
      nhPrice: nh.price,
      nhLimit: nh.limit,
      nhAmount: nh.amount,
    });
    placed = `NiceHash order placed: ${nh.id} (market ${nh.market}, price ${nh.price.toFixed(8)} BTC/EH/day, limit ${nh.limit.toFixed(6)} EH/s).`;
  } else {
    const token = process.env.BRAIINS_OWNER_TOKEN || process.env.BRAIINS_READONLY_TOKEN;
    if (!token) throw new Error('Missing Braiins token');
    const br = await createBraiinsOrder({
      ph: o.ph,
      hours: o.hours,
      poolUrl: o.pool,
      worker: o.worker,
      usdPerPhDay,
      token,
      memo: `order-${orderId}`,
    });
    await saveFulfillmentProvider(orderId, 'braiins');
    placed = `Braiins order placed: ${br.id}`;
  }

  await updateExpiry(orderId, expiresAt);
  const msg = await markPaid(orderId);
  scheduleOrderExpiry(orderId, expiresAt);

  const refreshed = await getOrder(orderId);
  await notifyUser(
    o.user,
    `Your DHR order ${orderId} is now active.\nProvider: ${providerLabel(
      refreshed?.fulfillmentProvider ?? requestedProvider
    )}\nPool: ${o.pool}\nWorker: ${o.worker}\nEnds: ${new Date(expiresAt).toISOString()}`
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
      case 'status':
        await handleStatus(interaction);
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
  const providerRaw = interaction.options.getString('provider');
  const provider = providerRaw ? asProvider(providerRaw) : undefined;
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

  const q = await quoteHashrate({ ph, hours, pool, worker, preferredSource: providerQuoteSource(provider) });
  const durationFactor = ph * (hours / 24);
  const baseTotal = q.baseUsdPerPhDay * durationFactor;
  const feeTotal = q.feeUsdPerPhDay * durationFactor;
  const marginTotal = q.marginUsdPerPhDay * durationFactor;
  const bufferTotal = q.bufferUsdPerPhDay * durationFactor;
  const marginBps = Number(process.env.PRICE_MARGIN_BPS ?? '100');
  const bufferBps = Number(process.env.BETA_BUFFER_BPS ?? '1000');
  const nhFeeBps = Number(process.env.NICEHASH_FEE_BPS ?? '200');
  const braiinsFeeBps = Number(process.env.BRAIINS_FEE_BPS ?? '200');
  const feePct = q.source === 'nicehash' ? nhFeeBps / 100 : q.source === 'braiins' ? braiinsFeeBps / 100 : 0;
  const feeLineBps = `  Platform fee (${feePct.toFixed(2)}%): $${q.feeUsdPerPhDay.toFixed(2)} / PH-day -> $${feeTotal.toFixed(2)}`;
  const marginLineBps = `  Margin (${(marginBps / 100).toFixed(2)}%): $${q.marginUsdPerPhDay.toFixed(2)} / PH-day -> $${marginTotal.toFixed(2)}`;
  const bufferLine = `  BETA buffer funding (${(bufferBps / 100).toFixed(2)}%): $${q.bufferUsdPerPhDay.toFixed(2)} / PH-day -> $${bufferTotal.toFixed(2)}`;
  const lines = [
    `Quote: ${ph} PH for ${hours}h -> $${q.totalUsd.toFixed(2)} (unit: $${q.usdPerPhDay.toFixed(2)} / PH-day).`,
    `Requested provider: ${provider ? providerLabel(provider) : 'Auto (best available quote)'}.`,
    `  Base: $${q.baseUsdPerPhDay.toFixed(2)} / PH-day -> $${baseTotal.toFixed(2)}`,
    feeLineBps,
    marginLineBps,
    bufferLine,
  ];
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleRent(interaction: ChatInputCommandInteraction) {
  const ph = interaction.options.getNumber('ph', true);
  const hours = interaction.options.getInteger('hours', true);
  const provider = asProvider(interaction.options.getString('provider', true));
  const pool = interaction.options.getString('pool', true);
  const worker = interaction.options.getString('worker', true);

  const braiinsBal = await braiinsBalanceUsd();
  const nhBal = await nicehashBalanceUsd();
  const nhGate = (process.env.NICEHASH_GATE_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (provider === 'braiins' && (!isFinite(braiinsBal.usd) || braiinsBal.usd < 50)) {
    await interaction.reply({ content: 'Braiins account balance is low. Please check back later.', ephemeral: true });
    return;
  }
  if (provider === 'nicehash' && nhGate && (!isFinite(nhBal.usd) || nhBal.usd < 50)) {
    await interaction.reply({ content: 'NiceHash account balance is low. Please check back later.', ephemeral: true });
    return;
  }
  if (provider === 'bitties_proxy' && !proxyEnabled()) {
    await interaction.reply({ content: 'Bitties proxy is not configured yet. Please contact admin.', ephemeral: true });
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

  const poolOk = validatePool(pool);
  if (!poolOk.valid) {
    await interaction.reply({ content: `Pool not allowed: ${poolOk.reason}`, ephemeral: true });
    return;
  }
  if (provider === 'bitties_proxy' && !pool.toLowerCase().startsWith('stratum+tcp://')) {
    await interaction.reply({ content: 'Bitties provider supports only stratum+tcp:// pool URLs.', ephemeral: true });
    return;
  }

  let q;
  try {
    q = await quoteHashrate({ ph, hours, pool, worker, preferredSource: providerQuoteSource(provider) });
  } catch {
    await interaction.reply({ content: 'No valid quote available right now. Please retry shortly.', ephemeral: true });
    return;
  }

  const order = await createOrder({
    ph,
    hours,
    pool,
    worker,
    requestedProvider: provider,
    user: interaction.user.id,
    totalUsd: q.totalUsd,
  });
  const btcPrice = await btcUsd().catch(() => NaN);
  const payment = await ensurePaymentIntent({
    orderId: order.id,
    userId: interaction.user.id,
    totalUsd: order.totalUsd,
    btcUsd: isFinite(btcPrice) ? btcPrice : undefined,
    expiresAt: order.expiresAt ?? Date.now() + hours * 3600 * 1000,
  });

  const usdcAddr = process.env.PAYMENT_USDC_BASE || 'set PAYMENT_USDC_BASE';
  const usdcSolAddr = process.env.PAYMENT_USDC_SOL || 'set PAYMENT_USDC_SOL';
  const btcAddr = process.env.PAYMENT_BTC_ONCHAIN || 'set PAYMENT_BTC_ONCHAIN';
  const expiryIso = new Date(payment.expiresAt).toISOString();

  const lines = [
    `Order ${order.id} accepted. Status: ${order.status}. Provider selected: ${providerLabel(provider)}.`,
    `Payment reference: ${payment.reference} (expires ${expiryIso})`,
    `USDC (Base): ${usdcAddr} (amount: ${payment.usdcBaseAmount.toFixed(6)} USDC)`,
    `USDC (Solana): ${usdcSolAddr} (amount: ${payment.usdcSolAmount.toFixed(6)} USDC)`,
    `BTC on-chain: ${btcAddr}` + (payment.btcAmount ? ` (amount: ${payment.btcAmount.toFixed(8)} BTC)` : ''),
    `Once payment is confirmed, the order will auto-start on ${providerLabel(provider)}.`
  ];
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
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

async function latestUsdPerPhDay(
  o: { ph: number; hours: number; pool: string; worker: string },
  provider: ProviderChoice
): Promise<number> {
  try {
    const q = await quoteHashrate({
      ph: o.ph,
      hours: o.hours,
      pool: o.pool,
      worker: o.worker,
      preferredSource: providerQuoteSource(provider),
    });
    return q.usdPerPhDay;
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
    `Active provider: ${providerLabel(o.fulfillmentProvider)}`,
    `Size: ${o.ph} PH for ${o.hours}h`,
    `Pool: ${o.pool}`,
    `Worker: ${o.worker}`,
    `Expires: ${o.expiresAt ? new Date(o.expiresAt).toISOString() : 'n/a'}`,
  ];
  await interaction.reply({ content: status.join('\n'), ephemeral: true });
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
    `USDC Base: ${p.usdcBaseAmount.toFixed(6)}`,
    `USDC Solana: ${p.usdcSolAmount.toFixed(6)}`,
    `BTC: ${p.btcAmount ? p.btcAmount.toFixed(8) : 'n/a'}`,
    `Expires: ${new Date(p.expiresAt).toISOString()}`,
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

async function start() {
  await ensureDbReady();
  console.log(`Database backend: ${dbBackend()}`);
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
