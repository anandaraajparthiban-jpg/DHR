# DHR User Manual

This manual explains how to use the Discord Hashrate Rental (DHR) bot as a customer and as an admin.

## 1. What the bot does

DHR lets a user:
- choose hashrate (`PH`)
- choose duration (`hours`)
- use provider (`nicehash`, hardcoded for this initial release)
- choose pool URL and worker name
- receive payment instructions
- start automatically after payment confirmation
- stop automatically at expiry

## 2. Roles

- Customer: can quote, create order, track own order, cancel own non-active order.
- Admin: can run payment verification and manual activation commands.

Admin access is controlled by `ADMIN_USER_IDS` in `.env`.

## 3. Customer Quick Start

1. Request a quote:
```text
/quote ph:1 hours:12
```

2. Create an order:
```text
/rent ph:1 hours:12 pool:stratum+tcp://pool.example.com:3333 worker:myworker
```

3. Pay exactly the shown amount to one of:
- USDC (Base)
- USDC (Solana)
- BTC on-chain

4. Track payment and order:
```text
/payment_status id:<order-id>
/status id:<order-id>
```

5. Wait for auto-start (if enabled) and auto-stop at expiry.

## 4. Command Reference (Customer)

## 4.1 `/quote`
Purpose: preview price before ordering.

Parameters:
- `ph` (number, required): requested PH
- `hours` (int, required): rental duration

Example:
```text
/quote ph:2.5 hours:24
```

## 4.2 `/rent`
Purpose: create an order and receive payment instructions.

Parameters:
- `ph` (number, required)
- `hours` (int, required)
- `pool` (required): pool URL
- `worker` (required): worker string

Example:
```text
/rent ph:1.5 hours:8 pool:stratum+tcp://pool.example.com:3333 worker:user001
```

Notes:
- Pool must pass allowlist/validation configured by operator.

## 4.3 `/status`
Purpose: order lifecycle and provider status.

Parameter:
- `id` (required): order ID

Shows:
- status
- requested provider
- active provider
- size/duration
- pool/worker
- expiry

## 4.4 `/payment_status`
Purpose: check payment intent details.

Parameter:
- `id` (required): order ID

Shows:
- payment status (`pending`, `confirmed`, or `expired`)
- payment reference
- expected amounts by chain
- expiry time
- confirmed transaction ID (if confirmed)

## 4.5 `/cancel`
Purpose: cancel an order that is not active.

Parameter:
- `id` (required): order ID

Behavior:
- active/fulfilling orders cannot be canceled

## 5. Command Reference (Admin)

## 5.1 `/verify_payments`
Purpose: run payment verification scan now.

Result includes:
- checked intents
- confirmed intents
- expired intents
- auto-activated orders count

## 5.2 `/verify_payments_debug`
Purpose: diagnostics for why pending intents matched or did not match.

Parameter:
- `limit` (optional, 1-20)

Use when a customer says payment is complete but order not activated.

## 5.3 `/mark_paid`
Purpose: manually trigger fulfillment for an order.

Parameter:
- `id` (required): order ID

Important:
- keep `REQUIRE_PAYMENT_CONFIRMATION_FOR_MARK_PAID=true` in production unless you intentionally allow manual overrides

## 6. Order Lifecycle States

- `payment_required`: order created, awaiting payment.
- `pending`: payment observed/confirmed, waiting fulfillment path.
- `fulfilling`: provider placement in progress.
- `active`: order is running.
- `complete`: order ended and termination succeeded.
- `canceled`: user/admin canceled before activation.

## 7. Payment Rules

- Pay exact displayed amount.
- Use current (not expired) payment intent.
- If payment is after intent expiry, create a new order/intent.
- Solana address must be the configured receiving USDC token account.

## 8. Provider Notes

## 8.1 NiceHash
- Requires valid NiceHash API credentials and sufficient balance.

## 8.2 Braiins / 8.3 Bitties Proxy
- Not used in initial release runtime path.

## 9. Common Errors and Fixes

## 9.1 `No quotes available`
Causes:
- all quote sources unavailable

Fix:
- configure provider credentials, or set `INTERNAL_CAPACITY_USD_PER_PH_DAY` as fallback

## 9.2 `Not authorized`
Cause:
- non-admin calling admin command, or non-owner accessing another user’s order

Fix:
- use admin account or order owner account

## 9.3 `Pool not allowed`
Cause:
- pool URL blocked by allowlist/validation

Fix:
- use approved pool URL or update `ALLOWED_POOLS`

## 9.4 Payment not detected
Checks:
- correct chain and address
- exact amount
- intent not expired
- verifier RPC endpoints healthy

Then run:
```text
/verify_payments_debug limit:10
```

## 10. Good Operating Practices

- Keep one test channel for admin smoke tests.
- Keep one low-value test order path before every release.
- Review logs daily for repeated provider or RPC errors.
- Keep `ALLOWED_POOLS` strict.
- Keep `ADMIN_USER_IDS` minimal.
