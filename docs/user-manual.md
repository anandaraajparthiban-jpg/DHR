# DHR User Manual

This manual explains day-to-day usage of DHR for customers and admins.

For full Discord command details, see [docs/discord-commands.md](./discord-commands.md).

## 1) What DHR Does

DHR lets users:
- request hashrate quotes
- create payment-first order requests
- pay via USDC Base, USDC Solana, or BTC on-chain
- auto-activate orders after payment confirmation
- track status/time-left and cancel when eligible

Provider path in current runtime:
- NiceHash only

## 2) Roles

- Customer: quote, create order request, view own order/payment status, cancel own non-active order.
- Admin: all customer operations + manual fulfillment/payment verification/finance tools.

Admin access is controlled by `ADMIN_USER_IDS`.

## 3) Current Discord Customer Commands

- `/quote ph:<number> hours:<int>`
- `/rent-with-fixed-speed amount:<btc> limit_th:<th/s> pool:<url> worker:<btc_address> [bottom_limit_th:<th/s>]`
- `/rent-with-fixed-duration amount:<btc> hours:<int> pool:<url> worker:<btc_address> [bottom_limit_th:<th/s>] [limit_th:<th/s>] [variant:<...>]`
- `/status id:<order-id>`
- `/payment_status id:<order-id>`
- `/time_left id:<order-id>`
- `/cancel id:<order-id>`

Legacy command:
- `/rent` is hidden by default but code is preserved.
- Re-enable with:

```env
SHOW_LEGACY_RENT_COMMAND=true
```

## 4) Payment-First Lifecycle

All rent commands follow this flow:

1. Command validates input (pool/worker/speed/duration).
2. Internal order created in `payment_required` state.
3. Payment intent created with exact unique amount and reference.
4. User pays exact amount.
5. Payment verifier confirms transfer.
6. Fulfillment starts (`fulfilling`) and places provider order.
7. Order becomes `active`, then ends and transitions to `complete`.

## 5) NiceHash Placement Behavior

### Quote + legacy `/rent` API flow
- Automatic fallback:
  - `business_fixed_speed` -> `business_fixed_duration` -> `standard`

### `/rent-with-fixed-speed`
After payment, fulfillment attempts:
- `business_fixed_speed`
- fallback `standard` if needed

### `/rent-with-fixed-duration`
After payment, fulfillment attempts:
- duration payload variant(s) first (`variant:auto` tries known forms)
- fallback `standard` if needed

## 6) TH/s Input Rules

New direct commands use TH/s inputs:
- `limit_th`
- `bottom_limit_th`

Internal conversion:
- `1 EH = 1,000,000 TH`

## 7) Admin Operations

- `/mark_paid id:<order-id>`
- `/verify_payments`
- `/verify_payments_debug [limit:<1-20>]`
- `/nh_payload_preview ...`
- `/finance_summary`

Production recommendation:
- Keep `REQUIRE_PAYMENT_CONFIRMATION_FOR_MARK_PAID=true` unless intentional override is required.

## 8) Order States

- `payment_required`: waiting for payment
- `pending`: payment observed/confirmed, waiting fulfillment path
- `fulfilling`: provider placement in progress
- `active`: running
- `complete`: ended successfully
- `canceled`: canceled before activation

## 9) Common Errors

## `Pool not allowed`
- Pool URL failed allowlist/validation.

## `Worker must be a valid BTC mainnet address only`
- Worker string is not a valid BTC mainnet address format.

## `TH/s value must be > 0`
- Invalid speed value in `limit_th` / `bottom_limit_th`.

## `No valid quote available right now`
- Quote source currently unavailable or blocked by provider constraints.

## Payment not detected
Check:
- exact amount
- correct chain/address
- intent not expired
- RPC health

Then run:

```text
/verify_payments_debug limit:10
```

## 10) Good Operating Practices

- Keep a small-value test flow before each release.
- Keep pool allowlist strict (`ALLOWED_POOLS`).
- Keep admin list minimal (`ADMIN_USER_IDS`).
- Monitor repeated provider/RPC failures daily.
