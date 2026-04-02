import 'dotenv/config';
import { quoteHashrate } from '../pricing.js';
import { previewNhOrderPlacement } from '../nhOrder.js';

interface ParsedArgs {
  ph: number;
  hours: number;
  pool: string;
  worker: string;
  usdPerPhDay?: number;
  resolvePoolId: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run nh:dry-run -- --ph <number> --hours <number> --pool <stratum_url> --worker <btc_address> [--usd-per-ph-day <number>] [--resolve-pool-id]',
    '',
    'Examples:',
    '  npm run nh:dry-run -- --ph 25 --hours 30 --pool stratum+tcp://pool.example.com:3333 --worker bc1q... --resolve-pool-id',
    '  npm run nh:dry-run -- --ph 5 --hours 6 --pool stratum+tcp://pool.example.com:3333 --worker bc1q... --usd-per-ph-day 120.5',
  ].join('\n');
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: Partial<ParsedArgs> = { resolvePoolId: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resolve-pool-id') {
      out.resolvePoolId = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${a}`);
    }
    if (a === '--ph') out.ph = Number(next);
    else if (a === '--hours') out.hours = Number(next);
    else if (a === '--pool') out.pool = next;
    else if (a === '--worker') out.worker = next;
    else if (a === '--usd-per-ph-day') out.usdPerPhDay = Number(next);
    else throw new Error(`Unknown argument: ${a}`);
    i += 1;
  }

  if (!isFinite(out.ph ?? NaN) || (out.ph ?? 0) <= 0) throw new Error('Argument --ph must be > 0.');
  if (!isFinite(out.hours ?? NaN) || (out.hours ?? 0) <= 0) throw new Error('Argument --hours must be > 0.');
  if (!out.pool) throw new Error('Argument --pool is required.');
  if (!out.worker) throw new Error('Argument --worker is required.');
  if (out.usdPerPhDay !== undefined && (!isFinite(out.usdPerPhDay) || out.usdPerPhDay <= 0)) {
    throw new Error('Argument --usd-per-ph-day must be > 0 when provided.');
  }

  return out as ParsedArgs;
}

async function resolveUsdPerPhDay(args: ParsedArgs): Promise<{ usdPerPhDay: number; source: string }> {
  if (args.usdPerPhDay !== undefined) return { usdPerPhDay: args.usdPerPhDay, source: 'arg' };
  const quote = await quoteHashrate({
    ph: args.ph,
    hours: args.hours,
    pool: args.pool,
    worker: args.worker,
    preferredSource: 'nicehash',
  });
  if (quote.source !== 'nicehash' || !isFinite(quote.baseUsdPerPhDay) || quote.baseUsdPerPhDay <= 0) {
    throw new Error('Unable to derive NiceHash base USD/PH-day quote. Provide --usd-per-ph-day explicitly.');
  }
  return { usdPerPhDay: quote.baseUsdPerPhDay, source: 'quote_base' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const usd = await resolveUsdPerPhDay(args);
  const plan = await previewNhOrderPlacement(
    {
      ph: args.ph,
      hours: args.hours,
      poolUrl: args.pool,
      worker: args.worker,
      usdPerPhDay: usd.usdPerPhDay,
    },
    {
      resolvePoolId: args.resolvePoolId,
      poolIdPlaceholder: '<resolved_at_order_time>',
    }
  );

  const output = {
    input: {
      ph: args.ph,
      hours: args.hours,
      pool: args.pool,
      worker: args.worker,
      usdPerPhDay: usd.usdPerPhDay,
      usdPerPhDaySource: usd.source,
      resolvePoolId: args.resolvePoolId,
    },
    plan,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`nh:dry-run failed: ${message}`);
  console.error(usage());
  process.exit(1);
});
