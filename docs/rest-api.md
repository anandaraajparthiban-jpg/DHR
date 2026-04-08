# DHR REST API Documentation

This is the detailed REST API guide for DHR.

## 1) Base URL and Version

Default:

```text
http://127.0.0.1:8080/api/v1
```

Public route:
- `GET /health`

All other routes require JWT bearer token.

## 2) Authentication Model

## 2.1 Login

`POST /auth/login`

Request body:

```json
{
  "username": "vendor1",
  "password": "YourStrongPassword"
}
```

Successful response:

```json
{
  "ok": true,
  "accessToken": "<jwt>",
  "tokenType": "Bearer",
  "expiresIn": 1800,
  "user": {
    "username": "vendor1",
    "subject": "vendor1",
    "roles": ["user"],
    "scopes": ["orders:read", "orders:write"],
    "isActive": true
  }
}
```

Use token:

```text
Authorization: Bearer <jwt>
```

## 2.2 JWT Config

Relevant env vars:
- `API_JWT_ALGORITHM=HS256|RS256`
- `API_JWT_SECRET` (HS256) or `API_JWT_PUBLIC_KEY` + `API_JWT_PRIVATE_KEY` (RS256)
- `API_JWT_ISSUER`
- `API_JWT_AUDIENCE`
- `API_JWT_ACCESS_TTL_SEC` (default `1800`)
- `API_JWT_REQUIRE_JTI`
- `API_JWT_CLOCK_TOLERANCE_SEC`

## 2.3 Admin Authorization

Admin routes are gated by role/scope:
- `API_ADMIN_ROLES`
- `API_ADMIN_SCOPES`

## 3) Quick Start cURL

```bash
export BASE_URL="http://127.0.0.1:8080/api/v1"
export USERNAME="vendor1"
export PASSWORD="YourStrongPassword"

LOGIN_RESPONSE=$(curl -s "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")

export TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.accessToken')
```

## 4) Customer Routes

## 4.1 `POST /quote`

Purpose:
- Quote price and show breakdown.

Request body:

```json
{
  "ph": 1,
  "hours": 12
}
```

Behavior:
- Uses NiceHash quote source.
- Mode behavior for quote context is automatic:
  - `business_fixed_speed` -> `business_fixed_duration` -> `standard`

Example:

```bash
curl -s "$BASE_URL/quote" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ph":1,"hours":12}'
```

## 4.2 `POST /rent`

Purpose:
- Create order + payment intent (payment-first flow).

Request body:

```json
{
  "ph": 1,
  "hours": 12,
  "pool": "stratum+tcp://yourpool:3333",
  "worker": "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
}
```

Example:

```bash
curl -s "$BASE_URL/rent" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ph": 1,
    "hours": 12,
    "pool": "stratum+tcp://yourpool:3333",
    "worker": "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
  }'
```

Notes:
- NH placement occurs after payment confirmation, not at request creation time.
- At fulfillment time, this route uses automatic fallback:
  - `business_fixed_speed` -> `business_fixed_duration` -> `standard`

## 4.3 `GET /orders/:id`

Purpose:
- Order status and summary fields.

Example:

```bash
curl -s "$BASE_URL/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN"
```

## 4.4 `GET /orders/:id/time_left`

Example:

```bash
curl -s "$BASE_URL/orders/$ORDER_ID/time_left" \
  -H "Authorization: Bearer $TOKEN"
```

## 4.5 `POST /orders/:id/cancel`

Example:

```bash
curl -s -X POST "$BASE_URL/orders/$ORDER_ID/cancel" \
  -H "Authorization: Bearer $TOKEN"
```

## 4.6 `GET /orders/:id/payment_status`

Example:

```bash
curl -s "$BASE_URL/orders/$ORDER_ID/payment_status" \
  -H "Authorization: Bearer $TOKEN"
```

## 5) Admin Routes

Use admin token for these routes.

```bash
export ADMIN_USERNAME="ops-admin"
export ADMIN_PASSWORD="AdminStrongPassword"

ADMIN_LOGIN_RESPONSE=$(curl -s "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}")

export ADMIN_TOKEN=$(echo "$ADMIN_LOGIN_RESPONSE" | jq -r '.accessToken')
```

## 5.1 `GET /auth/users`

```bash
curl -s "$BASE_URL/auth/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 5.2 `POST /auth/users`

```bash
curl -s -X POST "$BASE_URL/auth/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "vendor2",
    "password": "Vendor2StrongPass!",
    "subject": "vendor2",
    "roles": ["user"],
    "scopes": ["orders:read", "orders:write"],
    "isActive": true
  }'
```

## 5.3 `PATCH /auth/users/:username`

```bash
curl -s -X PATCH "$BASE_URL/auth/users/vendor2" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roles": ["admin"],
    "scopes": ["admin"],
    "password": "NewVendor2StrongPass!",
    "isActive": true
  }'
```

## 5.4 `POST /orders/:id/mark_paid`

```bash
curl -s -X POST "$BASE_URL/orders/$ORDER_ID/mark_paid" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 5.5 `POST /payments/verify`

```bash
curl -s -X POST "$BASE_URL/payments/verify" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 5.6 `POST /payments/verify_debug`

```bash
curl -s -X POST "$BASE_URL/payments/verify_debug" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":10}'
```

## 5.7 `GET /finance/summary`

```bash
curl -s "$BASE_URL/finance/summary" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 6) Order State Machine

Typical states:
- `payment_required`
- `pending`
- `fulfilling`
- `active`
- `complete`
- `canceled`

## 7) Error Shape

Typical format:

```json
{
  "ok": false,
  "error": "validation_error",
  "message": "Pool not allowed: ..."
}
```

Common `error` values:
- `unauthorized`
- `forbidden`
- `validation_error`
- `rate_limited`
- `not_found`
- `internal_error`

## 8) Notes About Discord-Only Features

Direct business request commands (`/rent-with-fixed-speed`, `/rent-with-fixed-duration`) are currently Discord command flows.

REST endpoints for those direct command payloads are not exposed yet.

## 9) Security and Ops Notes

- Put API behind HTTPS in production.
- Rotate JWT keys/secrets regularly.
- Prefer DB-managed API users over static env-only credentials.
- Keep admin scopes/roles minimal.
- Enable and monitor rate limits for login and general routes.
