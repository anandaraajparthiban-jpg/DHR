import fetch from 'node-fetch';
import { confirmPaymentIntent, expireStalePaymentIntents, listPendingPaymentIntents, PaymentIntent } from './payments.js';
import { markOrderPaymentObserved } from './orders.js';

export interface VerifySummary {
  checked: number;
  confirmed: number;
  expired: number;
  confirmedOrderIds: string[];
}

interface BtcTxMatch {
  txId: string;
  confirmedAt?: number;
}

async function fetchAddressTxs(address: string): Promise<any[]> {
  const res = await fetch(`https://mempool.space/api/address/${address}/txs`);
  if (!res.ok) throw new Error(`mempool tx fetch http ${res.status}`);
  const data: any = await res.json();
  return Array.isArray(data) ? data : [];
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

function shouldTryBtcScan(intents: PaymentIntent[]): boolean {
  return intents.some((i) => typeof i.btcAmount === 'number' && isFinite(i.btcAmount) && i.btcAmount > 0);
}

// Placeholder hooks: keep these for provider wiring (Base/Solana indexers).
async function matchUsdcBasePayment(_intent: PaymentIntent): Promise<{ txId: string } | undefined> {
  return undefined;
}

async function matchUsdcSolPayment(_intent: PaymentIntent): Promise<{ txId: string } | undefined> {
  return undefined;
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

  let confirmed = 0;
  const confirmedOrderIds: string[] = [];
  const usedTxIds = new Set<string>();
  for (const intent of intents) {
    let matched:
      | { method: 'btc_onchain'; txId: string; confirmedAt?: number }
      | { method: 'usdc_base'; txId: string }
      | { method: 'usdc_solana'; txId: string }
      | undefined;

    if (btcAddress && btcTxs.length > 0) {
      const btcMatch = matchBtcPayment(intent, btcTxs, btcAddress, usedTxIds);
      if (btcMatch) {
        matched = { method: 'btc_onchain', txId: btcMatch.txId, confirmedAt: btcMatch.confirmedAt };
      }
    }
    if (!matched) {
      const baseMatch = await matchUsdcBasePayment(intent);
      if (baseMatch) matched = { method: 'usdc_base', txId: baseMatch.txId };
    }
    if (!matched) {
      const solMatch = await matchUsdcSolPayment(intent);
      if (solMatch) matched = { method: 'usdc_solana', txId: solMatch.txId };
    }
    if (!matched) continue;

    const updated = await confirmPaymentIntent({
      intentId: intent.id,
      method: matched.method,
      txId: matched.txId,
      confirmedAt: matched.method === 'btc_onchain' ? matched.confirmedAt : undefined,
    });
    if (!updated) continue;
    await markOrderPaymentObserved(intent.orderId);
    confirmed += 1;
    confirmedOrderIds.push(intent.orderId);
  }

  return { checked: intents.length, confirmed, expired, confirmedOrderIds };
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
