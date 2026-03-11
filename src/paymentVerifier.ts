import fetch from 'node-fetch';
import {
  confirmPaymentIntent,
  expireStalePaymentIntents,
  listPendingPaymentIntents,
  PaymentIntent,
  setPaymentIntentNotes,
} from './payments.js';
import { markOrderPaymentObserved } from './orders.js';

export interface VerifySummary {
  checked: number;
  confirmed: number;
  expired: number;
  confirmedOrderIds: string[];
}

export interface VerifyDebugIntent {
  orderId: string;
  intentId: string;
  reference: string;
  createdAt: number;
  expectedBtc?: number | null;
  expectedUsdcBase: number;
  expectedUsdcSol: number;
  matched: boolean;
  matchedMethod?: 'btc_onchain' | 'usdc_base' | 'usdc_solana';
  matchedTxId?: string;
  matchedAt?: number;
  checks: string[];
}

export interface VerifyDebugSummary {
  checked: number;
  scan: {
    btcTxs: number;
    usdcBaseTransfers: number;
    usdcSolTransfers: number;
  };
  intents: VerifyDebugIntent[];
}

interface BtcTxMatch {
  txId: string;
  confirmedAt?: number;
}

interface UsdcBaseTransfer {
  txId: string;
  amountUnits: bigint;
  blockTimeMs?: number;
}

interface UsdcSolTransfer {
  txId: string;
  amountUnits: bigint;
  blockTimeMs?: number;
}

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SOL_USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_USDC_MAINNET_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function fetchAddressTxs(address: string): Promise<any[]> {
  const res = await fetch(`https://mempool.space/api/address/${address}/txs`);
  if (!res.ok) throw new Error(`mempool tx fetch http ${res.status}`);
  const data: any = await res.json();
  return Array.isArray(data) ? data : [];
}

function isHex(value: string): boolean {
  return /^0x[0-9a-f]+$/i.test(value);
}

function toUsdcUnits(amount: number): bigint | undefined {
  if (!isFinite(amount) || amount <= 0) return undefined;
  return BigInt(Math.round(amount * 1_000_000));
}

function usdcUnitsToFixed6(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = units % 1_000_000n;
  return `${whole.toString()}.${frac.toString().padStart(6, '0')}`;
}

function topicForEvmAddress(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error('invalid evm address');
  return `0x${clean.padStart(64, '0')}`;
}

async function rpcJson(url: string, method: string, params: any[]): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
  const payload: any = await res.json();
  if (payload?.error) throw new Error(`rpc ${method} error: ${payload.error?.message ?? 'unknown'}`);
  return payload?.result;
}

async function fetchBaseUsdcTransfers(toAddress: string): Promise<UsdcBaseTransfer[]> {
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const tokenAddress = process.env.USDC_BASE_TOKEN || BASE_USDC_MAINNET_TOKEN;
  const latestHex = String(await rpcJson(rpcUrl, 'eth_blockNumber', []));
  if (!isHex(latestHex)) throw new Error('invalid eth_blockNumber result');
  const latest = Number(BigInt(latestHex));
  const scanBlocks = Math.max(500, Number(process.env.PAYMENT_BASE_SCAN_BLOCKS ?? '5000'));
  const from = Math.max(0, latest - scanBlocks);
  const filter = {
    address: tokenAddress,
    topics: [ERC20_TRANSFER_TOPIC, null, topicForEvmAddress(toAddress)],
    fromBlock: `0x${from.toString(16)}`,
    toBlock: `0x${latest.toString(16)}`,
  };
  const logs: any[] = (await rpcJson(rpcUrl, 'eth_getLogs', [filter])) ?? [];
  if (!Array.isArray(logs) || logs.length === 0) return [];

  const blockNums = Array.from(
    new Set(
      logs
        .map((l) => String(l?.blockNumber || ''))
        .filter((h) => isHex(h))
        .map((h) => Number(BigInt(h)))
    )
  );
  const blockTimeMap = new Map<number, number>();
  await Promise.all(
    blockNums.map(async (n) => {
      const hex = `0x${n.toString(16)}`;
      try {
        const block: any = await rpcJson(rpcUrl, 'eth_getBlockByNumber', [hex, false]);
        const ts = String(block?.timestamp || '');
        if (!isHex(ts)) return;
        blockTimeMap.set(n, Number(BigInt(ts)) * 1000);
      } catch {
        // best-effort timestamp enrichment
      }
    })
  );

  return logs
    .map((log) => {
      const txId = String(log?.transactionHash || '').toLowerCase();
      const valueHex = String(log?.data || '0x0');
      const blockNumHex = String(log?.blockNumber || '');
      if (!txId || !isHex(valueHex) || !isHex(blockNumHex)) return undefined;
      const blockNum = Number(BigInt(blockNumHex));
      return {
        txId,
        amountUnits: BigInt(valueHex),
        blockTimeMs: blockTimeMap.get(blockNum),
      } as UsdcBaseTransfer;
    })
    .filter((t): t is UsdcBaseTransfer => Boolean(t));
}

function getSolAccountKey(tx: any, accountIndex: number): string {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys) || accountIndex < 0 || accountIndex >= keys.length) return '';
  const k = keys[accountIndex];
  if (typeof k === 'string') return k;
  if (k && typeof k.pubkey === 'string') return k.pubkey;
  return '';
}

function parseSolTransferDeltaUnits(tx: any, recipientAddress: string, mint: string): bigint {
  const pre = Array.isArray(tx?.meta?.preTokenBalances) ? tx.meta.preTokenBalances : [];
  const post = Array.isArray(tx?.meta?.postTokenBalances) ? tx.meta.postTokenBalances : [];
  const entries = new Map<number, { pre: bigint; post: bigint }>();

  for (const b of pre) {
    const idx = Number(b?.accountIndex ?? -1);
    if (idx < 0) continue;
    if (String(b?.mint || '') !== mint) continue;
    const key = getSolAccountKey(tx, idx);
    if (key !== recipientAddress) continue;
    const amt = BigInt(String(b?.uiTokenAmount?.amount ?? '0'));
    const e = entries.get(idx) ?? { pre: 0n, post: 0n };
    e.pre = amt;
    entries.set(idx, e);
  }
  for (const b of post) {
    const idx = Number(b?.accountIndex ?? -1);
    if (idx < 0) continue;
    if (String(b?.mint || '') !== mint) continue;
    const key = getSolAccountKey(tx, idx);
    if (key !== recipientAddress) continue;
    const amt = BigInt(String(b?.uiTokenAmount?.amount ?? '0'));
    const e = entries.get(idx) ?? { pre: 0n, post: 0n };
    e.post = amt;
    entries.set(idx, e);
  }

  let delta = 0n;
  for (const { pre: p, post: q } of entries.values()) {
    if (q > p) delta += q - p;
  }
  return delta;
}

async function fetchSolUsdcTransfers(recipientAddress: string): Promise<UsdcSolTransfer[]> {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const mint = process.env.USDC_SOL_MINT || SOL_USDC_MAINNET_MINT;
  const limit = Math.max(20, Number(process.env.PAYMENT_SOL_SCAN_LIMIT ?? '200'));

  const sigs: any[] =
    (await rpcJson(rpcUrl, 'getSignaturesForAddress', [
      recipientAddress,
      {
        limit,
      },
    ])) ?? [];
  if (!Array.isArray(sigs) || sigs.length === 0) return [];

  const transfers: UsdcSolTransfer[] = [];
  for (const s of sigs) {
    const signature = String(s?.signature || '');
    if (!signature) continue;
    try {
      const tx: any = await rpcJson(rpcUrl, 'getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
      if (!tx || tx?.meta?.err) continue;
      const delta = parseSolTransferDeltaUnits(tx, recipientAddress, mint);
      if (delta <= 0n) continue;
      const blockTimeSec = Number(tx?.blockTime || 0);
      transfers.push({
        txId: signature,
        amountUnits: delta,
        blockTimeMs: blockTimeSec > 0 ? blockTimeSec * 1000 : undefined,
      });
    } catch {
      // skip malformed/unavailable tx
    }
  }
  return transfers;
}

function satsFromTxToAddress(tx: any, address: string): number {
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  return outs
    .filter((o: any) => o?.scriptpubkey_address === address)
    .reduce((sum: number, o: any) => sum + Number(o?.value || 0), 0);
}

function matchBtcPayment(intent: PaymentIntent, txs: any[], address: string, usedTxIds: Set<string>): BtcTxMatch | undefined {
  if (!intent.btcAmount || !isFinite(intent.btcAmount) || intent.btcAmount <= 0) return undefined;
  const expectedSats = Math.round(intent.btcAmount * 1e8);
  const tolerance = Math.max(0, Number(process.env.PAYMENT_BTC_SAT_TOLERANCE ?? '3'));
  const acceptUnconfirmed = (process.env.PAYMENT_ACCEPT_UNCONFIRMED ?? 'false').toLowerCase() === 'true';
  const maxBackSkewMs = Math.max(0, Number(process.env.PAYMENT_MAX_BACK_SKEW_SEC ?? '900')) * 1000;

  for (const tx of txs) {
    const txId = String(tx?.txid || '');
    if (!txId || usedTxIds.has(txId)) continue;
    const status = tx?.status ?? {};
    const confirmed = Boolean(status?.confirmed);
    if (!confirmed && !acceptUnconfirmed) continue;
    const confirmedAt = Number(status?.block_time || 0) > 0 ? Number(status.block_time) * 1000 : undefined;
    if (confirmedAt && confirmedAt + maxBackSkewMs < intent.createdAt) continue;

    const paidSats = satsFromTxToAddress(tx, address);
    if (Math.abs(paidSats - expectedSats) <= tolerance) {
      usedTxIds.add(txId);
      return { txId, confirmedAt };
    }
  }
  return undefined;
}

function btcUnderpaymentNote(intent: PaymentIntent, txs: any[], address: string): string | undefined {
  if (!intent.btcAmount || !isFinite(intent.btcAmount) || intent.btcAmount <= 0) return undefined;
  const expectedSats = Math.round(intent.btcAmount * 1e8);
  const acceptUnconfirmed = (process.env.PAYMENT_ACCEPT_UNCONFIRMED ?? 'false').toLowerCase() === 'true';
  const maxBackSkewMs = Math.max(0, Number(process.env.PAYMENT_MAX_BACK_SKEW_SEC ?? '900')) * 1000;
  let bestShortfall: number | undefined;

  for (const tx of txs) {
    const status = tx?.status ?? {};
    const confirmed = Boolean(status?.confirmed);
    if (!confirmed && !acceptUnconfirmed) continue;
    const confirmedAt = Number(status?.block_time || 0) > 0 ? Number(status.block_time) * 1000 : undefined;
    if (confirmedAt && confirmedAt + maxBackSkewMs < intent.createdAt) continue;
    const paidSats = satsFromTxToAddress(tx, address);
    if (paidSats <= 0 || paidSats >= expectedSats) continue;
    // Only flag likely underpayment attempts (ignore tiny unrelated transfers).
    if (paidSats * 2 < expectedSats) continue;
    const shortfall = expectedSats - paidSats;
    if (bestShortfall === undefined || shortfall < bestShortfall) bestShortfall = shortfall;
  }

  if (bestShortfall === undefined) return undefined;
  return `Detected BTC payment below required amount by ${bestShortfall} sats. This payment will not auto-confirm; send the exact required amount or contact admin.`;
}

function shouldTryBtcScan(intents: PaymentIntent[]): boolean {
  return intents.some((i) => typeof i.btcAmount === 'number' && isFinite(i.btcAmount) && i.btcAmount > 0);
}

function shouldTryUsdcBase(intents: PaymentIntent[]): boolean {
  return intents.some((i) => typeof i.usdcBaseAmount === 'number' && isFinite(i.usdcBaseAmount) && i.usdcBaseAmount > 0);
}

function shouldTryUsdcSol(intents: PaymentIntent[]): boolean {
  return intents.some((i) => typeof i.usdcSolAmount === 'number' && isFinite(i.usdcSolAmount) && i.usdcSolAmount > 0);
}

function matchUsdcBasePayment(
  intent: PaymentIntent,
  transfers: UsdcBaseTransfer[],
  usedTxIds: Set<string>
): { txId: string; confirmedAt?: number } | undefined {
  const expected = toUsdcUnits(intent.usdcBaseAmount);
  if (!expected) return undefined;
  const tolerance = BigInt(Math.max(0, Number(process.env.PAYMENT_USDC_BASE_TOLERANCE_UNITS ?? '2')));
  const maxBackSkewMs = Math.max(0, Number(process.env.PAYMENT_MAX_BACK_SKEW_SEC ?? '900')) * 1000;

  for (const tr of transfers) {
    if (usedTxIds.has(tr.txId)) continue;
    if (tr.blockTimeMs && tr.blockTimeMs + maxBackSkewMs < intent.createdAt) continue;
    const diff = tr.amountUnits >= expected ? tr.amountUnits - expected : expected - tr.amountUnits;
    if (diff > tolerance) continue;
    usedTxIds.add(tr.txId);
    return { txId: tr.txId, confirmedAt: tr.blockTimeMs };
  }
  return undefined;
}

function usdcBaseUnderpaymentNote(intent: PaymentIntent, transfers: UsdcBaseTransfer[]): string | undefined {
  const expected = toUsdcUnits(intent.usdcBaseAmount);
  if (!expected) return undefined;
  const maxBackSkewMs = Math.max(0, Number(process.env.PAYMENT_MAX_BACK_SKEW_SEC ?? '900')) * 1000;
  let bestShortfall: bigint | undefined;

  for (const tr of transfers) {
    if (tr.blockTimeMs && tr.blockTimeMs + maxBackSkewMs < intent.createdAt) continue;
    if (tr.amountUnits <= 0n || tr.amountUnits >= expected) continue;
    // Only flag likely underpayment attempts (ignore tiny unrelated transfers).
    if (tr.amountUnits * 2n < expected) continue;
    const shortfall = expected - tr.amountUnits;
    if (bestShortfall === undefined || shortfall < bestShortfall) bestShortfall = shortfall;
  }

  if (bestShortfall === undefined) return undefined;
  return `Detected USDC Base payment below required amount by ${usdcUnitsToFixed6(
    bestShortfall
  )} USDC. This payment will not auto-confirm; send the exact required amount or contact admin.`;
}

function matchUsdcSolPayment(
  intent: PaymentIntent,
  transfers: UsdcSolTransfer[],
  usedTxIds: Set<string>
): { txId: string; confirmedAt?: number } | undefined {
  const expected = toUsdcUnits(intent.usdcSolAmount);
  if (!expected) return undefined;
  const tolerance = BigInt(Math.max(0, Number(process.env.PAYMENT_USDC_SOL_TOLERANCE_UNITS ?? '2')));
  const maxBackSkewMs = Math.max(0, Number(process.env.PAYMENT_MAX_BACK_SKEW_SEC ?? '900')) * 1000;

  for (const tr of transfers) {
    if (usedTxIds.has(tr.txId)) continue;
    if (tr.blockTimeMs && tr.blockTimeMs + maxBackSkewMs < intent.createdAt) continue;
    const diff = tr.amountUnits >= expected ? tr.amountUnits - expected : expected - tr.amountUnits;
    if (diff > tolerance) continue;
    usedTxIds.add(tr.txId);
    return { txId: tr.txId, confirmedAt: tr.blockTimeMs };
  }
  return undefined;
}

function usdcSolUnderpaymentNote(intent: PaymentIntent, transfers: UsdcSolTransfer[]): string | undefined {
  const expected = toUsdcUnits(intent.usdcSolAmount);
  if (!expected) return undefined;
  const maxBackSkewMs = Math.max(0, Number(process.env.PAYMENT_MAX_BACK_SKEW_SEC ?? '900')) * 1000;
  let bestShortfall: bigint | undefined;

  for (const tr of transfers) {
    if (tr.blockTimeMs && tr.blockTimeMs + maxBackSkewMs < intent.createdAt) continue;
    if (tr.amountUnits <= 0n || tr.amountUnits >= expected) continue;
    // Only flag likely underpayment attempts (ignore tiny unrelated transfers).
    if (tr.amountUnits * 2n < expected) continue;
    const shortfall = expected - tr.amountUnits;
    if (bestShortfall === undefined || shortfall < bestShortfall) bestShortfall = shortfall;
  }

  if (bestShortfall === undefined) return undefined;
  return `Detected USDC Solana payment below required amount by ${usdcUnitsToFixed6(
    bestShortfall
  )} USDC. This payment will not auto-confirm; send the exact required amount or contact admin.`;
}

function checkBtcIntent(
  intent: PaymentIntent,
  txs: any[],
  address: string | undefined
): { ok: boolean; txId?: string; confirmedAt?: number; reason: string } {
  if (!address) return { ok: false, reason: 'btc: address not configured' };
  if (!intent.btcAmount || !isFinite(intent.btcAmount) || intent.btcAmount <= 0) {
    return { ok: false, reason: 'btc: expected amount unavailable' };
  }
  if (txs.length === 0) return { ok: false, reason: 'btc: no candidate transactions fetched' };

  const expectedSats = Math.round(intent.btcAmount * 1e8);
  const tolerance = Math.max(0, Number(process.env.PAYMENT_BTC_SAT_TOLERANCE ?? '3'));
  const acceptUnconfirmed = (process.env.PAYMENT_ACCEPT_UNCONFIRMED ?? 'false').toLowerCase() === 'true';
  const maxBackSkewMs = Math.max(0, Number(process.env.PAYMENT_MAX_BACK_SKEW_SEC ?? '900')) * 1000;
  let bestDiff: number | undefined;

  for (const tx of txs) {
    const txId = String(tx?.txid || '');
    if (!txId) continue;
    const status = tx?.status ?? {};
    const confirmed = Boolean(status?.confirmed);
    if (!confirmed && !acceptUnconfirmed) continue;
    const confirmedAt = Number(status?.block_time || 0) > 0 ? Number(status.block_time) * 1000 : undefined;
    if (confirmedAt && confirmedAt + maxBackSkewMs < intent.createdAt) continue;
    const paidSats = satsFromTxToAddress(tx, address);
    const diff = Math.abs(paidSats - expectedSats);
    if (bestDiff === undefined || diff < bestDiff) bestDiff = diff;
    if (diff <= tolerance) {
      return { ok: true, txId, confirmedAt, reason: `btc: matched within tolerance (${diff} sats)` };
    }
  }

  return {
    ok: false,
    reason: `btc: no match (best diff ${bestDiff ?? 'n/a'} sats, tolerance ${tolerance})`,
  };
}

function checkUsdcBaseIntent(
  intent: PaymentIntent,
  transfers: UsdcBaseTransfer[],
  address: string | undefined
): { ok: boolean; txId?: string; confirmedAt?: number; reason: string } {
  if (!address) return { ok: false, reason: 'usdc_base: address not configured' };
  const expected = toUsdcUnits(intent.usdcBaseAmount);
  if (!expected) return { ok: false, reason: 'usdc_base: expected amount unavailable' };
  if (transfers.length === 0) return { ok: false, reason: 'usdc_base: no transfer logs fetched' };

  const tolerance = BigInt(Math.max(0, Number(process.env.PAYMENT_USDC_BASE_TOLERANCE_UNITS ?? '2')));
  const maxBackSkewMs = Math.max(0, Number(process.env.PAYMENT_MAX_BACK_SKEW_SEC ?? '900')) * 1000;
  let bestDiff: bigint | undefined;

  for (const tr of transfers) {
    if (tr.blockTimeMs && tr.blockTimeMs + maxBackSkewMs < intent.createdAt) continue;
    const diff = tr.amountUnits >= expected ? tr.amountUnits - expected : expected - tr.amountUnits;
    if (bestDiff === undefined || diff < bestDiff) bestDiff = diff;
    if (diff <= tolerance) {
      return {
        ok: true,
        txId: tr.txId,
        confirmedAt: tr.blockTimeMs,
        reason: `usdc_base: matched within tolerance (${diff.toString()} units)`,
      };
    }
  }

  return {
    ok: false,
    reason: `usdc_base: no match (best diff ${bestDiff?.toString() ?? 'n/a'} units, tolerance ${tolerance.toString()})`,
  };
}

function checkUsdcSolIntent(
  intent: PaymentIntent,
  transfers: UsdcSolTransfer[],
  address: string | undefined
): { ok: boolean; txId?: string; confirmedAt?: number; reason: string } {
  if (!address) return { ok: false, reason: 'usdc_solana: address not configured' };
  const expected = toUsdcUnits(intent.usdcSolAmount);
  if (!expected) return { ok: false, reason: 'usdc_solana: expected amount unavailable' };
  if (transfers.length === 0) return { ok: false, reason: 'usdc_solana: no candidate transfers fetched' };

  const tolerance = BigInt(Math.max(0, Number(process.env.PAYMENT_USDC_SOL_TOLERANCE_UNITS ?? '2')));
  const maxBackSkewMs = Math.max(0, Number(process.env.PAYMENT_MAX_BACK_SKEW_SEC ?? '900')) * 1000;
  let bestDiff: bigint | undefined;

  for (const tr of transfers) {
    if (tr.blockTimeMs && tr.blockTimeMs + maxBackSkewMs < intent.createdAt) continue;
    const diff = tr.amountUnits >= expected ? tr.amountUnits - expected : expected - tr.amountUnits;
    if (bestDiff === undefined || diff < bestDiff) bestDiff = diff;
    if (diff <= tolerance) {
      return {
        ok: true,
        txId: tr.txId,
        confirmedAt: tr.blockTimeMs,
        reason: `usdc_solana: matched within tolerance (${diff.toString()} units)`,
      };
    }
  }

  return {
    ok: false,
    reason: `usdc_solana: no match (best diff ${bestDiff?.toString() ?? 'n/a'} units, tolerance ${tolerance.toString()})`,
  };
}

export async function runPaymentVerificationTick(): Promise<VerifySummary> {
  const expired = await expireStalePaymentIntents();
  const intents = await listPendingPaymentIntents();
  if (intents.length === 0) return { checked: 0, confirmed: 0, expired, confirmedOrderIds: [] };

  let btcTxs: any[] = [];
  const btcAddress = process.env.PAYMENT_BTC_ONCHAIN;
  if (btcAddress && shouldTryBtcScan(intents)) {
    try {
      btcTxs = await fetchAddressTxs(btcAddress);
    } catch (err) {
      console.error('payment verifier btc scan error', err);
    }
  }

  let usdcBaseTransfers: UsdcBaseTransfer[] = [];
  const usdcBaseAddress = process.env.PAYMENT_USDC_BASE;
  if (usdcBaseAddress && shouldTryUsdcBase(intents)) {
    try {
      usdcBaseTransfers = await fetchBaseUsdcTransfers(usdcBaseAddress);
    } catch (err) {
      console.error('payment verifier usdc base scan error', err);
    }
  }

  let usdcSolTransfers: UsdcSolTransfer[] = [];
  const usdcSolAddress = process.env.PAYMENT_USDC_SOL;
  if (usdcSolAddress && shouldTryUsdcSol(intents)) {
    try {
      usdcSolTransfers = await fetchSolUsdcTransfers(usdcSolAddress);
    } catch (err) {
      console.error('payment verifier usdc sol scan error', err);
    }
  }

  let confirmed = 0;
  const confirmedOrderIds: string[] = [];
  const usedTxIds = new Set<string>();
  for (const intent of intents) {
    let matched:
      | {
          method: 'btc_onchain' | 'usdc_base' | 'usdc_solana';
          txId: string;
          confirmedAt?: number;
        }
      | undefined;

    if (btcAddress && btcTxs.length > 0) {
      const btcMatch = matchBtcPayment(intent, btcTxs, btcAddress, usedTxIds);
      if (btcMatch) {
        matched = { method: 'btc_onchain', txId: btcMatch.txId, confirmedAt: btcMatch.confirmedAt };
      }
    }
    if (!matched && usdcBaseTransfers.length > 0) {
      const baseMatch = matchUsdcBasePayment(intent, usdcBaseTransfers, usedTxIds);
      if (baseMatch) matched = { method: 'usdc_base', txId: baseMatch.txId, confirmedAt: baseMatch.confirmedAt };
    }
    if (!matched && usdcSolTransfers.length > 0) {
      const solMatch = matchUsdcSolPayment(intent, usdcSolTransfers, usedTxIds);
      if (solMatch) matched = { method: 'usdc_solana', txId: solMatch.txId, confirmedAt: solMatch.confirmedAt };
    }
    if (!matched) {
      const notes: string[] = [];
      if (btcAddress && btcTxs.length > 0) {
        const note = btcUnderpaymentNote(intent, btcTxs, btcAddress);
        if (note) notes.push(note);
      }
      if (usdcBaseTransfers.length > 0) {
        const note = usdcBaseUnderpaymentNote(intent, usdcBaseTransfers);
        if (note) notes.push(note);
      }
      if (usdcSolTransfers.length > 0) {
        const note = usdcSolUnderpaymentNote(intent, usdcSolTransfers);
        if (note) notes.push(note);
      }
      await setPaymentIntentNotes(intent.id, notes.length > 0 ? notes.join(' | ') : null);
      continue;
    }

    const updated = await confirmPaymentIntent({
      intentId: intent.id,
      method: matched.method,
      txId: matched.txId,
      confirmedAt: matched.confirmedAt,
    });
    if (!updated) continue;
    await markOrderPaymentObserved(intent.orderId);
    confirmed += 1;
    confirmedOrderIds.push(intent.orderId);
  }

  return { checked: intents.length, confirmed, expired, confirmedOrderIds };
}

export async function runPaymentVerificationDebug(opts?: { maxIntents?: number }): Promise<VerifyDebugSummary> {
  const intentsRaw = await listPendingPaymentIntents();
  const maxIntents = Math.max(1, Math.min(100, Number(opts?.maxIntents ?? 10)));
  const intents = intentsRaw.slice(0, maxIntents);

  let btcTxs: any[] = [];
  const btcAddress = process.env.PAYMENT_BTC_ONCHAIN;
  if (btcAddress && shouldTryBtcScan(intents)) {
    try {
      btcTxs = await fetchAddressTxs(btcAddress);
    } catch (err) {
      console.error('payment verifier debug btc scan error', err);
    }
  }

  let usdcBaseTransfers: UsdcBaseTransfer[] = [];
  const usdcBaseAddress = process.env.PAYMENT_USDC_BASE;
  if (usdcBaseAddress && shouldTryUsdcBase(intents)) {
    try {
      usdcBaseTransfers = await fetchBaseUsdcTransfers(usdcBaseAddress);
    } catch (err) {
      console.error('payment verifier debug usdc base scan error', err);
    }
  }

  let usdcSolTransfers: UsdcSolTransfer[] = [];
  const usdcSolAddress = process.env.PAYMENT_USDC_SOL;
  if (usdcSolAddress && shouldTryUsdcSol(intents)) {
    try {
      usdcSolTransfers = await fetchSolUsdcTransfers(usdcSolAddress);
    } catch (err) {
      console.error('payment verifier debug usdc sol scan error', err);
    }
  }

  const details: VerifyDebugIntent[] = [];
  for (const intent of intents) {
    const btcCheck = checkBtcIntent(intent, btcTxs, btcAddress);
    const baseCheck = checkUsdcBaseIntent(intent, usdcBaseTransfers, usdcBaseAddress);
    const solCheck = checkUsdcSolIntent(intent, usdcSolTransfers, usdcSolAddress);

    const matched = btcCheck.ok ? btcCheck : baseCheck.ok ? baseCheck : solCheck.ok ? solCheck : undefined;
    details.push({
      orderId: intent.orderId,
      intentId: intent.id,
      reference: intent.reference,
      createdAt: intent.createdAt,
      expectedBtc: intent.btcAmount ?? null,
      expectedUsdcBase: intent.usdcBaseAmount,
      expectedUsdcSol: intent.usdcSolAmount,
      matched: Boolean(matched),
      matchedMethod: matched
        ? btcCheck.ok
          ? 'btc_onchain'
          : baseCheck.ok
            ? 'usdc_base'
            : 'usdc_solana'
        : undefined,
      matchedTxId: matched?.txId,
      matchedAt: matched?.confirmedAt,
      checks: [btcCheck.reason, baseCheck.reason, solCheck.reason],
    });
  }

  return {
    checked: intents.length,
    scan: {
      btcTxs: btcTxs.length,
      usdcBaseTransfers: usdcBaseTransfers.length,
      usdcSolTransfers: usdcSolTransfers.length,
    },
    intents: details,
  };
}

export function startPaymentVerificationLoop(opts?: { onConfirmedOrders?: (orderIds: string[]) => Promise<void> | void }) {
  const intervalSec = Number(process.env.PAYMENT_VERIFY_INTERVAL_SEC ?? '120');
  if (!isFinite(intervalSec) || intervalSec <= 0) {
    console.log('Payment verification loop disabled (PAYMENT_VERIFY_INTERVAL_SEC <= 0)');
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runPaymentVerificationTick();
      if (summary.confirmedOrderIds.length > 0 && opts?.onConfirmedOrders) {
        await opts.onConfirmedOrders(summary.confirmedOrderIds);
      }
      if (summary.confirmed > 0 || summary.expired > 0) {
        console.log(
          `Payment verifier: checked=${summary.checked} confirmed=${summary.confirmed} expired=${summary.expired}`
        );
      }
    } catch (err) {
      console.error('payment verifier tick failed', err);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalSec * 1000);
  timer.unref();
}
