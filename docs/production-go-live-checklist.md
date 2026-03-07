# DHR Production Go-Live Checklist

Use this as a release gate. Every item should be marked `PASS` before enabling real traffic.

## 0) Release Metadata
- Date:
- Release/commit:
- Environment (staging/prod):
- Operator:

## 1) Server + Runtime Checks

Run:
```bash
node -v
npm -v
git rev-parse --short HEAD
```

Pass criteria:
- Node is 20.x LTS
- npm is 10+
- commit matches intended release

## 2) App Build Checks

Run:
```bash
npm install
npm run build
```

Pass criteria:
- `npm install` succeeds with no dependency errors
- `npm run build` exits 0

## 3) Env and Secret Checks

Run:
```bash
test -f .env && echo "PASS: .env exists" || echo "FAIL: missing .env"
```

Manual verify in `.env`:
- Discord: `DISCORD_TOKEN`, `DISCORD_APP_ID`
- Admin access: `ADMIN_USER_IDS`
- Payment addresses: `PAYMENT_USDC_BASE`, `PAYMENT_USDC_SOL`, `PAYMENT_BTC_ONCHAIN`
- Backend:
  - SQLite: `DB_BACKEND=sqlite`
  - Postgres: `DB_BACKEND=postgres`, `DATABASE_URL`
- Provider secrets for providers you enable:
  - NiceHash keys
  - Braiins token
  - Bitties auth/token + base URL

Pass criteria:
- No required variable is blank for enabled features

## 4) Database Connectivity + Migration Checks

### If SQLite
Run:
```bash
mkdir -p data
ls -la data
```

Pass criteria:
- process user can read/write `data/`

### If Postgres
Run:
```bash
psql "$DATABASE_URL" -c "select now();"
psql "$DATABASE_URL" -c "\\dt"
```

Pass criteria:
- DB connection succeeds
- tables exist after app startup (`orders`, `payment_intents`, `payment_matches`)

## 5) Start and Health Checks

Run once in foreground:
```bash
npm start
```

Pass criteria (logs):
- `Database backend: sqlite` or `Database backend: postgres`
- `Slash commands registered`
- `Logged in as ...`
- no startup exceptions

Stop and run under PM2:
```bash
pm2 start dist/index.js --name dhr-bot
pm2 save
pm2 status
pm2 logs dhr-bot --lines 100
```

Pass criteria:
- process is `online`
- no crash loop

## 6) Discord Command Smoke Tests

From Discord:
1. `/quote ph:1 hours:1 provider:bitties_proxy`
2. `/rent ph:1 hours:1 provider:bitties_proxy pool:stratum+tcp://... worker:testworker`
3. `/payment_status id:<order-id>`
4. `/verify_payments_debug limit:5` (admin)

Pass criteria:
- responses are returned
- no "Unknown command"
- no command-time exceptions in logs

## 7) Payment Verification Gate

Run:
1. Create test order with small amount.
2. Pay exact amount to configured test address.
3. Trigger scan:
```text
/verify_payments
```

Pass criteria:
- intent transitions `pending -> confirmed`
- order transitions to `active` (if auto-activate enabled)
- no duplicate confirmation for same tx

## 8) Provider Fulfillment Gates

## 8.1 Bitties Proxy
- Submit a Bitties order.
- Confirm pool created in Bitties API/admin.
- Wait expiry or force cancel path.

Pass criteria:
- create succeeds
- terminate succeeds
- order becomes `complete`
- user receives start/end DM

## 8.2 NiceHash
- Submit NiceHash order and verify order ID saved.

Pass criteria:
- NH placement succeeds
- cancellation at expiry succeeds

## 8.3 Braiins (if enabled)
- Submit Braiins order with valid token.

Pass criteria:
- bid/order placement succeeds
- no persistent 404/auth errors

## 9) Safety Controls

Verify in `.env`:
- `REQUIRE_PAYMENT_CONFIRMATION_FOR_MARK_PAID=true` (recommended)
- `AUTO_ACTIVATE_ON_PAYMENT` set as intended
- `ALLOWED_POOLS` restricted to approved pools
- `MIN_PH`, `MAX_PH`, `MIN_HOURS`, `MAX_HOURS` set

Pass criteria:
- unsafe defaults are not left open in production

## 10) Monitoring + Alerting Checks

Run:
```bash
pm2 logs dhr-bot --lines 200 | rg -i "error|failed|exception"
```

Pass criteria:
- no recurring critical errors
- retry loops (if any) are bounded and recover

## 11) Backup and Rollback Readiness

Pre-verify:
- previous stable commit known
- rollback command documented

Rollback commands:
```bash
git checkout <last-stable-commit>
npm install
npm run build
pm2 restart dhr-bot
```

Pass criteria:
- rollback tested at least once in staging

## 12) Final Launch Decision

Go-live only if all sections above are `PASS`.

Sign-off:
- Engineering:
- Operations:
- Product/Owner:

