# Discord Commands Reference

This document is the detailed Discord command guide for DHR.

## 1) Current Command Set

### Customer-facing
- `/quote`
- `/rent-with-fixed-speed`
- `/rent-with-fixed-duration`
- `/status`
- `/time_left`
- `/cancel`
- `/payment_status`

### Admin
- `/mark_paid`
- `/verify_payments`
- `/verify_payments_debug`
- `/nh_payload_preview`
- `/finance_summary`

### Legacy command visibility
- Legacy `/rent` command is **hidden by default**.
- Re-enable only if needed by setting:

```env
SHOW_LEGACY_RENT_COMMAND=true
```

## 2) Core Lifecycle (All Rent Commands)

All order commands are payment-first:

1. User submits command.
2. Bot validates inputs (pool allowlist, worker format, limits).
3. Bot creates internal order in `payment_required` state.
4. Bot creates payment intent with exact unique amounts and reference.
5. User pays exact amount.
6. On confirmation (`auto-activate` or `/mark_paid`), bot places NH order.
7. Order becomes `active` and later `complete` at expiry.

Important:
- NH order placement does **not** happen at command submit time.
- NH order placement happens only after payment confirmation/fulfillment trigger.

## 3) TH Unit Rules

For fixed commands, user speed inputs are in TH/s:
- `limit_th`
- `bottom_limit_th`

Internal conversion:
- `1 EH = 1,000,000 TH`
- `EH = TH / 1,000,000`

## 4) Command Details

## 4.1 `/quote`

Purpose:
- Price discovery only.

Input:
- `ph` (required)
- `hours` (required, max 72)

Behavior:
- NiceHash quote source.
- Displays pricing breakdown and estimated payment methods.
- Uses automatic NH fallback behavior for quote validation context:
  - `business_fixed_speed` -> `business_fixed_duration` -> `standard`

Example:

```text
/quote ph:2.5 hours:24
```

## 4.2 `/rent-with-fixed-speed`

Purpose:
- Collect payment for a direct fixed-speed business request.
- After payment, fulfillment attempts:
  - Business fixed speed first
  - Standard fallback second

Input:
- `amount` (BTC, required)
- `limit_th` (required)
- `pool` (required)
- `worker` (required)
- `bottom_limit_th` (optional)

Example:

```text
/rent-with-fixed-speed amount:0.0015 limit_th:2000 bottom_limit_th:1000 pool:stratum+tcp://mine.coean.xyz:3334 worker:bc1q...
```

Notes:
- `amount` is the NH order BTC amount target requested for fulfillment.
- Payment intent amount is calculated from current BTC/USD at request time.
- If business fixed speed fails at placement time, standard order fallback is attempted automatically.

## 4.3 `/rent-with-fixed-duration`

Purpose:
- Collect payment for a direct fixed-duration business request.
- After payment, fulfillment attempts:
  - Business duration variant(s) first
  - Standard fallback second

Input:
- `amount` (BTC, required)
- `hours` (required, max 72)
- `pool` (required)
- `worker` (required)
- `bottom_limit_th` (optional)
- `limit_th` (optional)
- `variant` (optional; default `auto`)

Supported `variant` values:
- `auto`
- `business_type_endts`
- `business_type_subtype_endts`
- `business_engine_duration`
- `business_engine_duration_endts`
- `business_engine_subtype_duration_endts`

Example:

```text
/rent-with-fixed-duration amount:0.0015 hours:24 bottom_limit_th:1000 limit_th:2000 variant:auto pool:stratum+tcp://mine.coean.xyz:3334 worker:bc1q...
```

Notes:
- `variant:auto` tries known duration payload variants sequentially.
- If all business duration variants fail, standard fallback is attempted.

## 4.4 `/status`

Shows:
- order status
- requested provider
- requested mode label
- active provider
- size/duration, pool/worker, expiry

Example:

```text
/status id:<order-id>
```

## 4.5 `/payment_status`

Shows:
- payment status (`pending`, `confirmed`, `expired`)
- payment reference
- exact expected amounts by chain
- confirmed tx id/method if available

Example:

```text
/payment_status id:<order-id>
```

## 4.6 `/cancel`

Cancels order if it is not active/fulfilling.

Example:

```text
/cancel id:<order-id>
```

## 4.7 `/time_left`

Shows remaining time for active order.

Example:

```text
/time_left id:<order-id>
```

## 5) Admin Commands

## 5.1 `/mark_paid`
- Manual fulfillment trigger for a specific order.
- Typically used for operational overrides.

## 5.2 `/verify_payments`
- Runs payment verification tick immediately.

## 5.3 `/verify_payments_debug`
- Diagnostics for why a payment matched or did not match.

## 5.4 `/nh_payload_preview`
- Admin payload preview tool.
- Does not place order.

## 5.5 `/finance_summary`
- Revenue vs spend summary.

## 6) Common Validation Errors

- `Pool not allowed`:
  - Pool URL failed allowlist/validation.
- `Worker must be a valid BTC mainnet address only`:
  - Worker is not accepted BTC format.
- `TH/s value must be > 0`:
  - `limit_th` or `bottom_limit_th` invalid.
- `Order rejected before creation ...`:
  - Minimums/constraints not satisfied at fulfillment stage.

## 7) Recommended Rollout/Testing

1. Start with `/quote` and `/nh_payload_preview`.
2. Use small-value `/rent-with-fixed-speed` and `/rent-with-fixed-duration` tests.
3. Confirm payment path via `/payment_status`.
4. Confirm activation via `/status` and later `/time_left`.
5. Keep `/verify_payments_debug` for support triage.
