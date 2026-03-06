# DHR — Discord Hashrate Rental Bot

## What’s working
- Discord bot with slash commands: /quote, /rent, /status, /cancel, /payment_status, /mark_paid (admin), /verify_payments (admin).
- Quotes: price from NiceHash + Braiins with fee/margin/buffer breakdown; BTC price fallback; pool validation and size/duration caps; payment instructions (USDC Base, USDC Solana, BTC); buffer baked in and shown.
- Persistence: SQLite orders with NH metadata + expiry; status/cancel/mark_paid guarded.
- Balance gates: Braiins (on-chain address via mempool) and NiceHash (wrapper balance with override option); gate can skip NH if desired.
- Fulfillment: /mark_paid tries Braiins spot bid first, then falls back to NiceHash order creation; stores NH metadata; expiry cancel timers restore on restart.
- Fulfillment safety: DB-backed state transition (`payment_required|pending -> fulfilling -> active`) prevents duplicate provider placements from concurrent admin clicks.
- Payments: each order gets a payment intent with unique amounts + reference; verifier loop confirms BTC on-chain exact-amount matches and marks orders `pending` for admin activation.
- Pool management: NiceHash pool create/reuse helper (cached by host/port/user); allowlist + regex validation for pools.
- Comments added across core files for handoff (index.ts, pricing.ts, balances.ts, orders.ts, nh.ts, nhOrder.ts, braiins.ts, pool.ts).

## Current blockers / known issues
- Braiins spot API: current tokens/host return 404 on /spot/settings/orderbook; spot/bid not yet succeeding. Needs working Braiins API base/token with spot access.
- NiceHash fallback: buy/info sometimes misses USA; fallback now forces a matched market or the first market, but needs testing; NH auth can still hiccup (override exists for gating).
- USDC auto-verification is scaffolded only (Base/Solana scanners are placeholders until indexer/API integration is wired).
- MiningRigRentals integration: not yet integrated; consider adding as provider/fallback.

## Commands (current)
- `/quote ph:<number> hours:<int>` — price with breakdown (base/fee/margin/buffer).
- `/rent ph:<number> hours:<int> pool:<stratum url> worker:<name>` — place order, gate on balances, lock quote, return payment instructions.
- `/status id:<order-id>` — check status (DB-backed).
- `/cancel id:<order-id>` — cancel if not active.
- `/payment_status id:<order-id>` — see payment intent status + expected amounts/reference.
- `/mark_paid id:<order-id>` — admin only; Braiins order first, NH fallback.
- `/verify_payments` — admin only; run payment verification tick immediately.

## Setup
1) Install deps: `npm install`
2) Copy env: `cp .env.example .env` and fill values:
   - Discord: `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`
   - NiceHash: `NICEHASH_API_KEY`, `NICEHASH_API_SECRET`, `NICEHASH_ORG_ID`; optional `NICEHASH_BAL_OVERRIDE_BTC`, `NICEHASH_GATE_ENABLED`
   - Braiins: `BRAIINS_OWNER_TOKEN` or `BRAIINS_READONLY_TOKEN` (spot), optional `BRAIINS_BASE`
   - Payments: `PAYMENT_USDC_BASE`, `PAYMENT_USDC_SOL`, `PAYMENT_BTC_ONCHAIN`, `PAYMENT_VERIFY_INTERVAL_SEC`, `PAYMENT_BTC_SAT_TOLERANCE`, `PAYMENT_ACCEPT_UNCONFIRMED`, `PAYMENT_MAX_BACK_SKEW_SEC`, `REQUIRE_PAYMENT_CONFIRMATION_FOR_MARK_PAID`
   - Pricing: `PRICE_MARGIN_BPS`, `BETA_BUFFER_BPS`, `NICEHASH_FEE_BPS`, `BRAIINS_FEE_BPS`, `FLOOR_USD_PER_PH_DAY`
   - Gates/Caps: `MIN_PH`, `MAX_PH`, `MIN_HOURS`, `MAX_HOURS`, `ADMIN_USER_IDS`, `ALLOWED_POOLS`
3) Run: `npm run dev` (dev) or `npm run build && npm start` (prod)

## Remaining TODO
- Fix Braiins spot ordering (working base/token) and Braiins quoting.
- Harden NH fallback and auth; remove overrides once stable.
- Add SLA tracking and under-delivery handling.
- Wire real USDC verifiers (Base/Solana) and optional LN.
- Decide whether to keep SQLite (single instance) or migrate to Postgres for multi-instance operation (see `docs/postgres-migration.md`).
