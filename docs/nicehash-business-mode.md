# NiceHash Business Mode Guide

This guide explains NiceHash order behavior in DHR.

Default runtime flow is automatic:
- `business_fixed_speed`
- `business_fixed_duration`
- `standard` orderbook fallback

It also shows how to preview payloads before placing live orders.

## 1) Mode Overview

## `standard`
- Endpoint: `POST /main/api/v2/hashpower/order`
- Bot sets `type: "STANDARD"` and includes `price`, `limit`, `amount`.
- Best for default marketplace behavior.

## `business_fixed_speed`
- Endpoint: `POST /main/api/v2/hashpower/business/order`
- Bot sets `subType: "BUSINESS_FIXED_SPEED"`.
- Includes `amount`, `limit`, optional `bottomLimit`.
- Good when you want business order flow without fixed end timestamp logic.

## `business_fixed_duration`
- Endpoint: `POST /main/api/v2/hashpower/business/order`
- Bot computes `endTs` from requested `hours`.
- Bot sends `type: "BUSINESS"` and no subtype override.
- Includes `amount`, `endTs`, and `bottomLimit` (env override or minimum speed).

## 2) Environment Variables

Set in `.env`:

```env
NICEHASH_ORDER_MODE=auto
```

Business options:

```env
# For business_fixed_speed and business_fixed_duration
NICEHASH_BUSINESS_BOTTOM_LIMIT_EH=

# For business_fixed_duration
NICEHASH_BUSINESS_DURATION_MIN_END_SEC=900
```

Notes:
- `NICEHASH_BUSINESS_DURATION_MIN_END_SEC` default is `900` (15 minutes).
- If `NICEHASH_BUSINESS_BOTTOM_LIMIT_EH` is not set in duration mode, bot uses algorithm min speed (or internal computed speed if algorithm minimum is unavailable).

## 3) Recommended Dry-Run Before Live Orders

Preview payload without placing an order:

```bash
npm run nh:dry-run -- --ph 25 --hours 30 --pool stratum+tcp://pool.example.com:3333 --worker bc1q...
```

Resolve real NiceHash `poolId` during preview (creates/resolves pool):

```bash
npm run nh:dry-run -- --ph 25 --hours 30 --pool stratum+tcp://pool.example.com:3333 --worker bc1q... --resolve-pool-id
```

Provide explicit base rate instead of fetching quote:

```bash
npm run nh:dry-run -- --ph 5 --hours 12 --pool stratum+tcp://pool.example.com:3333 --worker bc1q... --usd-per-ph-day 120
```

## 4) Discord Admin Payload Preview

Admin command:

```text
/nh_payload_preview ph:<num> hours:<num> pool:<url> worker:<btc_address> resolve_pool_id:<true|false>
```

- Returns request payload candidate as JSON.
- Does not place an order.
- Useful for confirming mode, subtype, factors, `endTs`, and `bottomLimit`.

## 4.1) User-Facing Input

Users provide only:

```text
/quote ph:<num> hours:<num>
/rent ph:<num> hours:<num> pool:<url> worker:<btc_address>
```

Runtime order flow is automatic (`business_fixed_speed` -> `business_fixed_duration` -> `standard`).

## 5) Fallback Sequence Example

Preview:

```bash
npm run nh:dry-run -- --ph 25 --hours 24 --pool stratum+tcp://pool.example.com:3333 --worker bc1q...
```

Expected candidate sequence:
- First request: `/main/api/v2/hashpower/business/order` with `subType: "BUSINESS_FIXED_SPEED"`.
- Second request: `/main/api/v2/hashpower/business/order` with `type: "BUSINESS"` and `endTs`.
- Third request: `/main/api/v2/hashpower/order` with `type: "STANDARD"` (orderbook fallback).

Live placement behavior:
- Bot tries candidates in this fixed order: speed -> duration -> standard.
- It proceeds to the next candidate only when the previous candidate is rejected.
- After successful create, bot reads order details from NiceHash and normalizes persisted metadata with server values.

## 6) Operational Notes

- Startup log shows auto fallback mode.
- For very short requests, duration candidate can be skipped if below `NICEHASH_BUSINESS_DURATION_MIN_END_SEC`; fallback still continues.
- Order metadata persisted in DB now includes:
  - `nhOrderType`
  - `nhSubType`
  - `nhBottomLimit`
  - `nhEndTs`

## 7) Troubleshooting

## `Preview failed: Requested NiceHash order too small`
- Increase `ph` or `hours`, or adjust quote input.
- Ensure amount passes NiceHash minimums and configured `NICEHASH_MIN_START_AMOUNT_BTC`.

## `Business duration order end window ... below minimum ...`
- Increase `hours` or lower `NICEHASH_BUSINESS_DURATION_MIN_END_SEC` intentionally.

## Create succeeds but stored subtype/end differ
- Bot trusts NiceHash post-create read response and stores returned values.
- Check logs for `post-create verification mismatch` warnings.
