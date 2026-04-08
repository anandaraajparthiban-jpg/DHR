# NiceHash Business and Fallback Mode Guide

This document explains all NiceHash placement behavior currently used by DHR.

## 1) Placement Paths in DHR

## 1.1 Auto path (quote + API `/rent` + legacy Discord `/rent`)

Automatic fallback chain:
- `business_fixed_speed`
- `business_fixed_duration`
- `standard`

## 1.2 Direct fixed-speed command path

Discord command:
- `/rent-with-fixed-speed`

After payment confirmation:
- try business fixed speed first
- fallback to standard if business placement fails

## 1.3 Direct fixed-duration command path

Discord command:
- `/rent-with-fixed-duration`

After payment confirmation:
- try business duration payload variant(s)
- fallback to standard if business duration placement fails

## 2) Command Visibility and Control

Legacy `/rent` command visibility:

```env
SHOW_LEGACY_RENT_COMMAND=false
```

Set `true` to show legacy `/rent` in Discord again.

## 3) Business Endpoints and Payload Families

## 3.1 Standard endpoint
- `POST /main/api/v2/hashpower/order`
- `type: "STANDARD"`
- fields include: `price`, `limit`, `amount`

## 3.2 Business fixed speed endpoint
- `POST /main/api/v2/hashpower/business/order`
- typically uses `subType: "BUSINESS_FIXED_SPEED"`
- fields include: `amount`, `limit`, optional `bottomLimit`

## 3.3 Business fixed duration endpoint
- `POST /main/api/v2/hashpower/business/order`
- DHR supports multiple duration payload variants because NH contract behavior can differ by account/runtime.
- `variant:auto` cycles through known forms.

## 4) TH/s vs EH/s

Direct Discord commands accept TH/s:
- `limit_th`
- `bottom_limit_th`

Internal conversion:
- `1 EH = 1,000,000 TH`

## 5) Payment-First Behavior

For all order commands in current Discord flow:
- command creates payment intent first
- NH placement happens only after payment confirmation (`auto-activate` or `/mark_paid`)

This avoids spending before payment is secured.

## 6) Environment Variables

```env
# Legacy /rent slash command visibility
SHOW_LEGACY_RENT_COMMAND=false

# Optional for auto business flow
NICEHASH_BUSINESS_BOTTOM_LIMIT_EH=
NICEHASH_BUSINESS_DURATION_MIN_END_SEC=900

# Optional internal metadata default used by fixed-speed request creation
NH_DIRECT_SPEED_ORDER_HOURS=24
```

Notes:
- `NICEHASH_BUSINESS_DURATION_MIN_END_SEC` default is `900` (15 minutes).
- Duration business candidate may be skipped if request is below this minimum window.

## 7) Dry-Run and Payload Preview

CLI dry run:

```bash
npm run nh:dry-run -- --ph 25 --hours 30 --pool stratum+tcp://pool.example.com:3333 --worker bc1q...
```

Resolve real NH poolId in preview:

```bash
npm run nh:dry-run -- --ph 25 --hours 30 --pool stratum+tcp://pool.example.com:3333 --worker bc1q... --resolve-pool-id
```

Discord admin preview:

```text
/nh_payload_preview ph:<num> hours:<num> pool:<url> worker:<btc_address> resolve_pool_id:<true|false>
```

## 8) Troubleshooting

## `Malformed request` on business endpoint
- Verify payload family/variant.
- For duration, test `variant:auto` first.

## `MISSING_DURATION`
- Indicates business duration payload shape mismatch for selected variant.
- Use `variant:auto` or switch to known-good variant for your account.

## `Unable to allocate hashrate for this package` (code 5191)
- Capacity unavailable for current parameters.
- Retry later, reduce requested package, or allow fallback to standard.

## `order can't be fulfilled ... less than 1 day`
- Business package constraints reject current amount/speed combination.
- Increase amount or reduce speed limit.

## 9) Recommended Operational Flow

1. Validate payload with `/nh_payload_preview`.
2. Run small-value payment-first test on direct command.
3. Confirm post-payment activation and end-time behavior.
4. Keep fallback enabled unless a strict mode is required.
