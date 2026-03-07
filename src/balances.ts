// balances.ts — balance checks for Braiins and NiceHash (gates /rent).
import fetch from 'node-fetch';
import { btcUsd } from './pricing.js';
import { nhPrivateRequest } from './nhHttp.js';

export interface WalletStatus {
  usd: number;
  raw: any;
}

const BRAIINS_BTC_ADDRESS = process.env.BRAIINS_BTC_ADDRESS || 'bc1qd7ghrtr0wc9xz3phn93gue8s0p9hxdgyt8htuj';

export async function braiinsBalanceUsd(): Promise<WalletStatus> {
  try {
    const res = await fetch(`https://mempool.space/api/address/${BRAIINS_BTC_ADDRESS}`);
    if (!res.ok) throw new Error('mempool address fetch failed');
    const data: any = await res.json();
    const sats = Number(data?.chain_stats?.funded_txo_sum || 0) - Number(data?.chain_stats?.spent_txo_sum || 0);
    const unconfirmed = Number(data?.mempool_stats?.funded_txo_sum || 0) - Number(data?.mempool_stats?.spent_txo_sum || 0);
    const totalSats = sats + unconfirmed;
    const btc = totalSats / 1e8;
    const usd = btc * (await btcUsd());
    return { usd, raw: data };
  } catch (err) {
    console.error('braiins balance error', err);
    return { usd: Number.POSITIVE_INFINITY, raw: null };
  }
}

function firstFinite(values: Array<unknown>): number | undefined {
  for (const v of values) {
    const n = Number(v);
    if (isFinite(n)) return n;
  }
  return undefined;
}

async function fetchNicehashBtcBalance(): Promise<{ btc: number; raw: any }> {
  const btcAccount: any = await nhPrivateRequest('GET', '/main/api/v2/accounting/account2/BTC', {
    query: { extendedResponse: false },
  });

  const direct = firstFinite([
    btcAccount?.available,
    btcAccount?.availableAmount,
    btcAccount?.available?.total,
    btcAccount?.available?.quantity,
    btcAccount?.balance?.available,
    btcAccount?.account?.available,
  ]);
  if (direct !== undefined) {
    return { btc: direct, raw: btcAccount };
  }

  const listPayload: any = await nhPrivateRequest('GET', '/main/api/v2/accounting/accounts2', {
    query: { extendedResponse: false },
  });
  const list: any[] = listPayload?.currencies ?? listPayload?.balances ?? listPayload?.data ?? listPayload?.wallets ?? [];
  const btcEntry = Array.isArray(list)
    ? list.find((w: any) => String(w?.currency || w?.asset || '').toUpperCase() === 'BTC')
    : undefined;

  const fromList = firstFinite([
    btcEntry?.available,
    btcEntry?.availableAmount,
    btcEntry?.available?.total,
    btcEntry?.available?.quantity,
  ]);

  if (fromList === undefined) {
    throw new Error('unable to parse NiceHash BTC balance');
  }
  return { btc: fromList, raw: { btcAccount, listPayload } };
}

export async function nicehashBalanceUsd(): Promise<WalletStatus> {
  const overrideBtc = process.env.NICEHASH_BAL_OVERRIDE_BTC ? Number(process.env.NICEHASH_BAL_OVERRIDE_BTC) : undefined;
  if (overrideBtc && isFinite(overrideBtc)) {
    const usd = overrideBtc * (await btcUsd());
    return { usd, raw: { override: true, btc: overrideBtc } };
  }

  try {
    const { btc, raw } = await fetchNicehashBtcBalance();
    const usd = btc * (await btcUsd());
    return { usd, raw };
  } catch (err) {
    console.error('nicehash balance error', err);
    return { usd: Number.POSITIVE_INFINITY, raw: { error: (err as Error).message } };
  }
}
