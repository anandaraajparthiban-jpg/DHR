# DHR Production Install Guide

## 1. Prerequisites
- OS: Linux server (Ubuntu 22.04+ recommended)
- Node.js: 20.x LTS
- npm: 10+
- Git
- Optional (recommended): Postgres 14+

Check:
```bash
node -v
npm -v
git --version
```

## 2. Get the code
```bash
git clone <your-repo-url> dhr
cd dhr
git checkout feat/address-core-gaps
```

## 3. Install dependencies
```bash
npm install
```

## 4. Configure environment
```bash
cp .env.example .env
```

Edit `.env` and set at minimum:
- Discord: `DISCORD_TOKEN`, `DISCORD_APP_ID`
- Admins: `ADMIN_USER_IDS`
- Payments: `PAYMENT_USDC_BASE`, `PAYMENT_USDC_SOL`, `PAYMENT_BTC_ONCHAIN`
- Providers you will use:
  - NiceHash: `NICEHASH_API_KEY`, `NICEHASH_API_SECRET`, `NICEHASH_ORG_ID` (optional `NICEHASH_API_BASE`)
  - Braiins: `BRAIINS_OWNER_TOKEN` or `BRAIINS_READONLY_TOKEN`
- NiceHash order thresholds:
  - Market/order minimum amount: `0.001 BTC`
  - Configured minimum start amount: `NICEHASH_MIN_START_AMOUNT_BTC` (default `0.0011 BTC`)

## 5. Choose database backend

### Option A: SQLite (single instance only)
Set:
```env
DB_BACKEND=sqlite
```

### Option B: Postgres (recommended for production)
Set:
```env
DB_BACKEND=postgres
DATABASE_URL=postgres://user:password@host:5432/dbname
```

If your Postgres requires TLS:
```env
PGSSLMODE=require
```
or
```env
PGSSL=true
```

## 6. Build
```bash
npm run build
```

## 7. Start once (smoke test)
```bash
npm start
```

Expected startup log includes:
- `Database backend: sqlite` or `Database backend: postgres`
- `Logged in as ...`

Stop after smoke test (`Ctrl+C`).

## 8. Run as a service (PM2)
Install PM2:
```bash
npm i -g pm2
```

Start:
```bash
pm2 start dist/index.js --name dhr-bot
pm2 save
pm2 startup
```

Useful commands:
```bash
pm2 logs dhr-bot
pm2 status
pm2 restart dhr-bot
```

## 9. Post-deploy verification checklist
- Bot appears online in Discord.
- Slash commands are registered.
- `/quote` works.
- `/rent` works and returns payment instructions.
- `/verify_payments_debug` returns scan results.
- Paid test order auto-activates and later auto-terminates.
- User receives start/end DM notifications.

## 10. Hardening before real traffic
- Set `REQUIRE_PAYMENT_CONFIRMATION_FOR_MARK_PAID=true`.
- Keep `AUTO_ACTIVATE_ON_PAYMENT=true` only after payment verifier is validated in your environment.
- Restrict `ALLOWED_POOLS` to approved pools only.
- Set sensible `MIN_PH`, `MAX_PH`, `MIN_HOURS`, `MAX_HOURS`.
- Monitor logs for RPC and provider API failures.

## 11. Upgrade procedure
```bash
git pull
npm install
npm run build
pm2 restart dhr-bot
```

## 12. Rollback procedure
```bash
git checkout <previous-working-commit>
npm install
npm run build
pm2 restart dhr-bot
```
