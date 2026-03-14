# DHR — Discord Hashrate Rental Bot

## What’s working
- Discord bot with slash commands: /quote, /rent, /status, /cancel, /payment_status, /mark_paid (admin), /verify_payments (admin).
- Quotes: NiceHash price with fee/margin/buffer breakdown; BTC price fallback; pool validation and size/duration caps; payment instructions (USDC Base, USDC Solana, BTC); buffer baked in and shown.
- NiceHash quotes are required in this initial release; non-NiceHash fallback sources are not used by commands.
- Persistence: runtime-selectable DB backend (`sqlite` default, or `postgres` via env) for orders/payment state.
- Provider (initial release): hardcoded to `NiceHash` for quoting and fulfillment.
- Fulfillment: all new orders activate on NiceHash.
- Fulfillment safety: DB-backed state transition (`payment_required|pending -> fulfilling -> active`) prevents duplicate provider placements from concurrent activation attempts.
- Payments: each order gets a payment intent with unique amounts + reference; verifier loop confirms BTC, USDC on Base (ERC20 logs), and USDC on Solana (SPL token balance deltas).
- Auto-start after payment: confirmed payments can auto-activate orders (`AUTO_ACTIVATE_ON_PAYMENT=true`).
- Timed termination + notifications: active orders are auto-terminated on expiry and users are DM-notified on start/end.
- Pool management: NiceHash pool create/reuse helper (cached by host/port/user); allowlist + regex validation for pools.
- Comments added across core files for handoff (index.ts, pricing.ts, balances.ts, orders.ts, nh.ts, nhOrder.ts, braiins.ts, pool.ts).

## Current blockers / known issues
- Braiins spot API: current tokens/host return 404 on /spot/settings/orderbook; spot/bid not yet succeeding. Needs working Braiins API base/token with spot access.
- NiceHash fallback: buy/info sometimes misses USA; fallback now forces a matched market or the first market, but needs testing; NH auth can still hiccup (override exists for gating).
- USDC verification requires working RPC endpoints and correct receive addresses (for Solana, `PAYMENT_USDC_SOL` can be either the wallet address or the receiving USDC token account).
- Bitties Proxy should be smoke-tested against your live deployment (`/auth/login`, `POST /pools`, `DELETE /pools/{id}`) before production rollout.
- MiningRigRentals integration: not yet integrated; consider adding as provider/fallback.

## Commands (current)
- `/quote ph:<number> hours:<int>` — price with breakdown (NiceHash source).
- `/rent ph:<number> hours:<int> pool:<stratum url> worker:<btc-address>` — place order (NiceHash fulfillment).
- `/status id:<order-id>` — check status (DB-backed).
- `/cancel id:<order-id>` — cancel if not active.
- `/payment_status id:<order-id>` — see payment intent status + expected amounts/reference.
- `/mark_paid id:<order-id>` — admin only; activates on NiceHash.
- `/verify_payments` — admin only; run payment verification tick immediately.
- `/verify_payments_debug limit:<1-20?>` — admin only; diagnostic reasons for payment-match decisions.

## Setup
1) Install deps: `npm install`
2) Copy env: `cp .env.example .env` and fill values:
   - Discord: `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`
   - Database:
     - SQLite (default): `DB_BACKEND=sqlite`
     - Postgres: set `DB_BACKEND=postgres` and `DATABASE_URL` (optional TLS flags: `PGSSL=true` or `PGSSLMODE=require`)
   - NiceHash: `NICEHASH_API_KEY`, `NICEHASH_API_SECRET`, `NICEHASH_ORG_ID`; optional `NICEHASH_API_BASE`, `NICEHASH_BAL_OVERRIDE_BTC`, `NICEHASH_GATE_ENABLED`
   - Braiins: `BRAIINS_OWNER_TOKEN` or `BRAIINS_READONLY_TOKEN` (spot), optional `BRAIINS_BASE`
   - Payments: `PAYMENT_USDC_BASE`, `PAYMENT_USDC_SOL`, `PAYMENT_BTC_ONCHAIN`, `PAYMENT_VERIFY_INTERVAL_SEC`, `PAYMENT_BTC_SAT_TOLERANCE`, `PAYMENT_ACCEPT_UNCONFIRMED`, `PAYMENT_MAX_BACK_SKEW_SEC`, `REQUIRE_PAYMENT_CONFIRMATION_FOR_MARK_PAID`, `AUTO_ACTIVATE_ON_PAYMENT`
   - USDC Base verify: `BASE_RPC_URL`, `USDC_BASE_TOKEN`, `PAYMENT_BASE_SCAN_BLOCKS`, `PAYMENT_USDC_BASE_TOLERANCE_UNITS`
   - USDC Solana verify: `SOLANA_RPC_URL`, `USDC_SOL_MINT`, `PAYMENT_SOL_SCAN_LIMIT`, `PAYMENT_USDC_SOL_TOLERANCE_UNITS`
   - Bitties Proxy: `BITTIES_PROXY_ENABLED`, `BITTIES_PROXY_BASE`, `BITTIES_PROXY_TOKEN`, `BITTIES_PROXY_USERNAME`, `BITTIES_PROXY_PASSWORD`, `BITTIES_PROXY_AUTH_PATH`, `BITTIES_PROXY_POOLS_PATH`, `BITTIES_PROXY_WORKER_PASS`, `BITTIES_PROXY_THRESHOLD_BTC`, `BITTIES_PROXY_TOTAL_HASHRATE_TH`, `BITTIES_PROXY_WEIGHT_SCALE`, `BITTIES_PROXY_WEIGHT_PER_PH` (legacy fallback), `BITTIES_PROXY_MIN_WEIGHT`, `BITTIES_PROXY_MAX_WEIGHT`
   - Fulfillment retries: `FULFILLMENT_TERMINATION_RETRY_SEC`
   - Pricing: `PRICE_MARGIN_BPS`, `BETA_BUFFER_BPS`, `NICEHASH_FEE_BPS`, `BRAIINS_FEE_BPS`, `FLOOR_USD_PER_PH_DAY`, optional `INTERNAL_CAPACITY_USD_PER_PH_DAY`
   - Gates/Caps: `MIN_PH`, `MAX_PH`, `MIN_HOURS`, `MAX_HOURS`, `ADMIN_USER_IDS`, `ALLOWED_POOLS`
3) Run: `npm run dev` (dev) or `npm run build && npm start` (prod)

Production step-by-step guide: `docs/production-install.md`
Production go-live gate: `docs/production-go-live-checklist.md`
Detailed user manual: `docs/user-manual.md`

## Remaining TODO
- Fix Braiins spot ordering (working base/token) and Braiins quoting.
- Harden NH fallback and auth; remove overrides once stable.
- Add SLA tracking and under-delivery handling.
- Harden/monitor USDC verifier reliability (RPC outages, rate limits, and edge-case transfers) and optionally add LN.
- Decide whether to keep SQLite (single instance) or migrate to Postgres for multi-instance operation (see `docs/postgres-migration.md`).
