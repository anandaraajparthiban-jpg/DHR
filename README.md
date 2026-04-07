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
- Optional REST API with JWT auth mirrors bot flows for third-party integrations.
- API auth users can be stored in DB and managed live (no `.env` edits needed for role changes).
- Pool management: NiceHash pool create/reuse helper (cached by host/port/user); allowlist + regex validation for pools.
- Comments added across core files for handoff (index.ts, pricing.ts, balances.ts, orders.ts, nh.ts, nhOrder.ts, braiins.ts, pool.ts).

## Current blockers / known issues
- Braiins spot API: current tokens/host return 404 on /spot/settings/orderbook; spot/bid not yet succeeding. Needs working Braiins API base/token with spot access.
- NiceHash fallback: buy/info sometimes misses USA; fallback now forces a matched market or the first market, but needs testing; NH auth can still hiccup (override exists for gating).
- USDC verification requires working RPC endpoints and correct receive addresses (for Solana, `PAYMENT_USDC_SOL` can be either the wallet address or the receiving USDC token account).
- MiningRigRentals integration: not yet integrated; consider adding as provider/fallback.

## Commands (current)
- `/quote ph:<number> hours:<int>` — price with breakdown (NiceHash source).
- `/rent ph:<number> hours:<int> pool:<stratum url> worker:<btc-address>` — place order (NiceHash fulfillment).
- `/status id:<order-id>` — check status (DB-backed).
- `/time_left id:<order-id>` — active order remaining time.
- `/cancel id:<order-id>` — cancel if not active.
- `/payment_status id:<order-id>` — see payment intent status + expected amounts/reference.
- `/mark_paid id:<order-id>` — admin only; activates on NiceHash.
- `/verify_payments` — admin only; run payment verification tick immediately.
- `/verify_payments_debug limit:<1-20?>` — admin only; diagnostic reasons for payment-match decisions.
- `/finance_summary` — admin only; revenue vs NiceHash spend.

## REST API (JWT secured)
Enable with:
- `REST_API_ENABLED=true`
- `API_JWT_ALGORITHM=HS256|RS256`
- `API_JWT_ISSUER`, `API_JWT_AUDIENCE`
- HS256: `API_JWT_SECRET` (>= 32 chars)
- RS256: `API_JWT_PUBLIC_KEY` + `API_JWT_PRIVATE_KEY` (PEM; `\n` escapes supported)
- Token lifetime: `API_JWT_ACCESS_TTL_SEC` (default `1800` = 30 min)
- Credentials: set `API_AUTH_CREDENTIALS_JSON` (recommended) or `API_AUTH_USERNAME` + `API_AUTH_PASSWORD_HASH`

Security controls:
- login issues JWT with 30-minute default validity
- Bearer JWT required on all routes except `GET /health` and `POST /auth/login`
- token must include `sub` and `exp` (`jti` required by default)
- issuer/audience enforced
- admin routes require role/scope (`API_ADMIN_ROLES`, `API_ADMIN_SCOPES`)
- per-user/IP API rate limiting (`API_RATE_LIMIT_PER_MIN`)
- login attempt rate limiting (`API_AUTH_LOGIN_RATE_LIMIT_PER_MIN`)
- API users are read from DB at login; env credentials are optional bootstrap seeds

Generate bcrypt password hash:
```bash
node --input-type=module -e "import bcrypt from 'bcryptjs'; bcrypt.hash('YourStrongPassword', 12).then(console.log)"
```

Single-user auth example:
```env
API_AUTH_USERNAME=vendor1
API_AUTH_PASSWORD_HASH=$2b$12$...
API_AUTH_SUBJECT=vendor1
API_AUTH_ROLES=user
API_AUTH_SCOPES=orders:read orders:write
```

Multi-user auth example (`API_AUTH_CREDENTIALS_JSON`):
```json
[{"username":"vendor1","passwordHash":"$2b$12$...","subject":"vendor1","roles":["user"],"scopes":["orders:read","orders:write"]},{"username":"ops-admin","passwordHash":"$2b$12$...","subject":"ops-admin","roles":["admin"],"scopes":["admin"]}]
```

Base path default: `/api/v1`

Routes:
- `GET /health`
- `POST /auth/login` (username/password -> JWT)
- `GET /auth/users` (admin, list API users)
- `POST /auth/users` (admin, create API user)
- `PATCH /auth/users/:username` (admin, update API user password/roles/scopes/active flag)
- `POST /quote`
- `POST /rent`
- `GET /orders/:id`
- `GET /orders/:id/time_left`
- `POST /orders/:id/cancel`
- `GET /orders/:id/payment_status`
- `POST /orders/:id/mark_paid` (admin)
- `POST /payments/verify` (admin)
- `POST /payments/verify_debug` (admin)
- `GET /finance/summary` (admin)

## Setup
1) Install deps: `npm install`
2) Copy env: `cp .env.example .env` and fill values:
   - Discord: `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`
   - REST API (optional): `REST_API_ENABLED`, `REST_API_HOST`, `REST_API_PORT`, `REST_API_BASE_PATH`
   - JWT auth for REST API: `API_JWT_ALGORITHM`, `API_JWT_SECRET` or (`API_JWT_PUBLIC_KEY` + `API_JWT_PRIVATE_KEY`), `API_JWT_ISSUER`, `API_JWT_AUDIENCE`, `API_JWT_ACCESS_TTL_SEC`, `API_JWT_REQUIRE_JTI`, `API_JWT_CLOCK_TOLERANCE_SEC`, `API_ADMIN_ROLES`, `API_ADMIN_SCOPES`, `API_RATE_LIMIT_PER_MIN`
   - REST login bootstrap credentials (optional): `API_AUTH_CREDENTIALS_JSON` or `API_AUTH_USERNAME` + `API_AUTH_PASSWORD_HASH`; optional `API_AUTH_LOGIN_RATE_LIMIT_PER_MIN`
   - Database:
     - SQLite (default): `DB_BACKEND=sqlite`
     - Postgres: set `DB_BACKEND=postgres` and `DATABASE_URL` (optional TLS flags: `PGSSL=true` or `PGSSLMODE=require`)
   - NiceHash: `NICEHASH_API_KEY`, `NICEHASH_API_SECRET`, `NICEHASH_ORG_ID`; optional `NICEHASH_API_BASE`, `NICEHASH_BAL_OVERRIDE_BTC`, `NICEHASH_GATE_ENABLED`; fallback flow is automatic (`business_fixed_speed` -> `business_fixed_duration` -> `standard`), optional `NICEHASH_BUSINESS_BOTTOM_LIMIT_EH` for business modes, optional `NICEHASH_BUSINESS_DURATION_MIN_END_SEC` (minimum duration end window, default `900`)
   - Braiins: `BRAIINS_OWNER_TOKEN` or `BRAIINS_READONLY_TOKEN` (spot), optional `BRAIINS_BASE`
   - Payments: `PAYMENT_USDC_BASE` (Base recipient wallet, `0x...`), `PAYMENT_USDC_SOL` (Solana wallet or USDC token account), `PAYMENT_BTC_ONCHAIN`, `PAYMENT_VERIFY_INTERVAL_SEC`, `PAYMENT_BTC_SAT_TOLERANCE`, `PAYMENT_ACCEPT_UNCONFIRMED`, `PAYMENT_MAX_BACK_SKEW_SEC`, `REQUIRE_PAYMENT_CONFIRMATION_FOR_MARK_PAID`, `AUTO_ACTIVATE_ON_PAYMENT`
   - USDC Base verify: `BASE_RPC_URL`, `USDC_BASE_TOKEN` (Base USDC token contract, not your wallet), `PAYMENT_BASE_SCAN_BLOCKS`, `PAYMENT_BASE_MAX_SCAN_BLOCKS`, `PAYMENT_USDC_BASE_TOLERANCE_UNITS`
   - USDC Solana verify: `SOLANA_RPC_URL`, `USDC_SOL_MINT`, `PAYMENT_SOL_SCAN_LIMIT`, `PAYMENT_SOL_PAGE_SIZE`, `SOLANA_MAX_TX_VERSION`, `PAYMENT_USDC_SOL_TOLERANCE_UNITS`
   - NiceHash minimums: market minimum order amount is `0.001 BTC`; configured minimum start amount is `NICEHASH_MIN_START_AMOUNT_BTC` (default `0.0011 BTC`)
   - Fulfillment retries: `FULFILLMENT_TERMINATION_RETRY_SEC`
   - Pricing: `PRICE_MARGIN_BPS`, `BETA_BUFFER_BPS`, `NICEHASH_FEE_BPS`, `BRAIINS_FEE_BPS`, `FLOOR_USD_PER_PH_DAY`, optional `INTERNAL_CAPACITY_USD_PER_PH_DAY`
   - Gates/Caps: `MIN_PH`, `MAX_PH`, `MIN_HOURS`, `MAX_HOURS`, `ADMIN_USER_IDS`, `ALLOWED_POOLS`
3) Run: `npm run dev` (dev) or `npm run build && npm start` (prod)

NiceHash dry-run payload preview (no order placement):
- `npm run nh:dry-run -- --ph 25 --hours 30 --pool stratum+tcp://pool.example.com:3333 --worker bc1q...`
- Add `--resolve-pool-id` if you want the script to create/resolve an actual NiceHash `poolId` instead of using a placeholder.

Production step-by-step guide: `docs/production-install.md`
Production go-live gate: `docs/production-go-live-checklist.md`
Detailed user manual: `docs/user-manual.md`
REST API guide (cURL): `docs/rest-api.md`
NiceHash business mode guide: `docs/nicehash-business-mode.md`

## Remaining TODO
- Fix Braiins spot ordering (working base/token) and Braiins quoting.
- Harden NH fallback and auth; remove overrides once stable.
- Add SLA tracking and under-delivery handling.
- Harden/monitor USDC verifier reliability (RPC outages, rate limits, and edge-case transfers) and optionally add LN.
- Decide whether to keep SQLite (single instance) or migrate to Postgres for multi-instance operation (see `docs/postgres-migration.md`).
