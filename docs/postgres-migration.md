# Postgres Migration Notes

SQLite is still a good default for a single bot process.
Move to Postgres when you need one or more of:

- multiple bot replicas
- managed backups / point-in-time recovery
- stronger concurrency guarantees across processes
- centralized analytics/reporting queries

## Suggested rollout

1. Add Postgres alongside SQLite and dual-write `orders` + `payment_intents`.
2. Backfill historical rows.
3. Read from Postgres in staging.
4. Cut production reads to Postgres.
5. Remove SQLite writes after a stabilization window.

## Core schema (Postgres)

```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  ph DOUBLE PRECISION NOT NULL,
  hours INTEGER NOT NULL,
  pool TEXT NOT NULL,
  worker TEXT NOT NULL,
  "user" TEXT NOT NULL,
  status TEXT NOT NULL,
  "totalUsd" DOUBLE PRECISION NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "nhOrderId" TEXT,
  "nhMarket" TEXT,
  "nhPrice" DOUBLE PRECISION,
  "nhLimit" DOUBLE PRECISION,
  "nhAmount" DOUBLE PRECISION,
  "expiresAt" BIGINT
);

CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL,
  status TEXT NOT NULL,
  reference TEXT NOT NULL,
  "usdAmount" DOUBLE PRECISION NOT NULL,
  "usdcBaseAmount" DOUBLE PRECISION NOT NULL,
  "usdcSolAmount" DOUBLE PRECISION NOT NULL,
  "btcAmount" DOUBLE PRECISION,
  "confirmedMethod" TEXT,
  "confirmedTxId" TEXT,
  "createdAt" BIGINT NOT NULL,
  "expiresAt" BIGINT NOT NULL,
  "confirmedAt" BIGINT,
  notes TEXT
);

CREATE INDEX idx_payment_intents_status_expires ON payment_intents(status, "expiresAt");
```
