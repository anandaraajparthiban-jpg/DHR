#!/usr/bin/env python3
"""
Standalone test for NiceHash Business Fixed Duration order creation.

This script can try multiple payload variants because NiceHash has changed
business-duration payload requirements over time.

Usage example (auto variant probing):
  python3 scripts/nh_test_business_duration.py \
    --pool stratum+tcp://mine.coean.xyz:3334 \
    --worker <btc_address> \
    --amount 0.0015 \
    --hours 24 \
    --bottom-limit-th 1000 \
    --market EU \
    --variant auto \
    --cancel-after-create

Usage example (explicit pool-id):
  python3 scripts/nh_test_business_duration.py \
    --pool-id 054614e2-c3e5-409d-8428-71c50b1341c4 \
    --amount 0.0015 \
    --hours 24 \
    --bottom-limit 0.001 \
    --market EU \
    --variant auto \
    --cancel-after-create

Credentials are loaded from env (or .env):
  NICEHASH_API_KEY, NICEHASH_API_SECRET, NICEHASH_ORG_ID
Optional:
  NICEHASH_API_BASE (default: https://api2.nicehash.com)
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

TH_PER_EH = 1_000_000.0


def load_dotenv(path: str = ".env") -> None:
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip().strip('"').strip("'")
            os.environ[key] = value


@dataclass
class NhCreds:
    api_key: str
    api_secret: str
    org_id: str
    api_base: str


def require_creds() -> NhCreds:
    load_dotenv()
    api_key = os.getenv("NICEHASH_API_KEY", "").strip()
    api_secret = os.getenv("NICEHASH_API_SECRET", "").strip()
    org_id = os.getenv("NICEHASH_ORG_ID", "").strip()
    api_base = os.getenv("NICEHASH_API_BASE", "https://api2.nicehash.com").strip().rstrip("/")
    if not api_key or not api_secret or not org_id:
        raise SystemExit("Missing credentials. Set NICEHASH_API_KEY, NICEHASH_API_SECRET, NICEHASH_ORG_ID.")
    return NhCreds(api_key=api_key, api_secret=api_secret, org_id=org_id, api_base=api_base)


def build_signature(
    *,
    api_key: str,
    api_secret: str,
    org_id: str,
    method: str,
    path: str,
    query_string: str,
    body_string: str,
    timestamp_ms: str,
    nonce: str,
) -> str:
    parts = [
        api_key,
        "\x00",
        timestamp_ms,
        "\x00",
        nonce,
        "\x00",
        "\x00",
        org_id,
        "\x00",
        "\x00",
        method.upper(),
        "\x00",
        path,
        "\x00",
        query_string,
    ]
    if body_string:
        parts.extend(["\x00", body_string])
    message = "".join(parts).encode("utf-8")
    digest = hmac.new(api_secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return f"{api_key}:{digest}"


def nh_request(
    creds: NhCreds,
    method: str,
    path: str,
    *,
    query: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: int = 30,
) -> Dict[str, Any]:
    query = query or {}
    query_string = "&".join(
        f"{urlparse.quote(str(k), safe='')}={urlparse.quote(str(v), safe='')}"
        for k, v in query.items()
        if v is not None
    )
    body_string = json.dumps(body, separators=(",", ":"), ensure_ascii=False) if body is not None else ""
    timestamp_ms = str(int(time.time() * 1000))
    nonce = secrets.token_hex(16)
    signature = build_signature(
        api_key=creds.api_key,
        api_secret=creds.api_secret,
        org_id=creds.org_id,
        method=method,
        path=path,
        query_string=query_string,
        body_string=body_string,
        timestamp_ms=timestamp_ms,
        nonce=nonce,
    )

    url = f"{creds.api_base}{path}"
    if query_string:
        url = f"{url}?{query_string}"

    headers = {
        "Content-Type": "application/json",
        "X-Time": timestamp_ms,
        "X-Nonce": nonce,
        "X-Organization-Id": creds.org_id,
        "X-Request-Id": nonce,
        "X-Auth": signature,
        "X-User-Agent": "nh-business-duration-test",
        "X-User-Lang": "en",
    }

    payload_bytes = body_string.encode("utf-8") if body_string else None
    req = urlrequest.Request(url=url, data=payload_bytes, headers=headers, method=method.upper())
    try:
        with urlrequest.urlopen(req, timeout=timeout) as response:
            status_code = response.getcode()
            raw = response.read().decode("utf-8", errors="replace")
    except urlerror.HTTPError as http_err:
        status_code = http_err.code
        raw = http_err.read().decode("utf-8", errors="replace")
    except urlerror.URLError as net_err:
        raise RuntimeError(f"Network error calling NiceHash: {net_err}") from net_err

    parsed: Any
    try:
        parsed = json.loads(raw) if raw else {}
    except Exception:
        parsed = {"raw": raw}

    if status_code < 200 or status_code >= 300:
        raise RuntimeError(
            f"NiceHash {method.upper()} {path} failed HTTP {status_code}\n"
            f"Request body: {body_string}\n"
            f"Response: {raw}"
        )
    return parsed if isinstance(parsed, dict) else {"data": parsed}


def parse_pool_url(pool_url: str) -> Tuple[str, int]:
    raw = pool_url.strip()
    if not raw:
        raise RuntimeError("Pool URL is empty")
    if "://" not in raw:
        raw = f"stratum+tcp://{raw}"
    normalized = raw.replace("stratum+tcp://", "http://").replace("stratum+ssl://", "https://")
    parsed = urlparse.urlparse(normalized)
    host = parsed.hostname
    port = parsed.port
    if not host or not port:
        raise RuntimeError(f"Invalid pool URL: {pool_url}")
    return host, int(port)


def ensure_pool_id(
    creds: NhCreds,
    *,
    pool_id: Optional[str],
    pool_url: Optional[str],
    worker: Optional[str],
    algorithm: str,
    pool_password: str,
    pool_name: Optional[str],
) -> str:
    if pool_id and pool_id.strip():
        return pool_id.strip()
    if not pool_url or not worker:
        raise RuntimeError("Provide either --pool-id OR both --pool and --worker")

    host, port = parse_pool_url(pool_url)
    name = pool_name.strip() if pool_name and pool_name.strip() else f"auto-{worker[:12]}-{host}"
    payload = {
        "name": name,
        "algorithm": algorithm.upper(),
        "stratumHostname": host,
        "stratumPort": port,
        "username": worker,
        "password": pool_password,
    }
    try:
        created = nh_request(creds, "POST", "/main/api/v2/pool", body=payload)
    except Exception as first_err:
        try:
            created = nh_request(creds, "POST", "/main/api/v2/pool/", body=payload)
        except Exception:
            raise RuntimeError(f"Pool create failed via API. {first_err}") from first_err
    resolved_id = str(created.get("id") or created.get("poolId") or "").strip()
    if not resolved_id:
        raise RuntimeError(f"Pool create succeeded but no id returned. Response: {json.dumps(created)}")
    print(f"Resolved pool-id by creating pool: {resolved_id} (host={host} port={port} user={worker})")
    return resolved_id


def th_to_eh(th_value: float) -> float:
    if th_value <= 0:
        raise RuntimeError(f"TH/s value must be > 0, got {th_value}")
    return th_value / TH_PER_EH


def first_algo_entry(algos_payload: Dict[str, Any], algorithm: str) -> Dict[str, Any]:
    entries = algos_payload.get("miningAlgorithms") or algos_payload.get("algorithms") or []
    for entry in entries:
        code = str(entry.get("algorithm") or entry.get("algo") or entry.get("code") or "").upper()
        if code == algorithm.upper():
            return entry
    raise RuntimeError(f"Algorithm {algorithm} not found in /main/api/v2/mining/algorithms")


def parse_float(value: Any, fallback: float) -> float:
    try:
        out = float(value)
        return out if out == out else fallback
    except Exception:
        return fallback


def normalize_factor(value: Any) -> Optional[str]:
    if value is None:
        return None
    txt = str(value).strip()
    return txt or None


def base_payload_fields(
    algorithm_entry: Dict[str, Any],
    *,
    market: str,
    algorithm: str,
    amount: float,
    pool_id: str,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "market": market.upper(),
        "algorithm": algorithm.upper(),
        "amount": amount,
        "poolId": pool_id,
        "displayMarketFactor": str(algorithm_entry.get("displayMarketFactor") or "EH"),
        "displayPriceFactor": str(algorithm_entry.get("displayPriceFactor") or "EH"),
    }
    market_factor = normalize_factor(algorithm_entry.get("marketFactor"))
    price_factor = normalize_factor(algorithm_entry.get("priceFactor"))
    if market_factor:
        payload["marketFactor"] = market_factor
    if price_factor:
        payload["priceFactor"] = price_factor
    return payload


def compute_end_ts(hours: float) -> str:
    end_dt = datetime.now(timezone.utc) + timedelta(hours=hours)
    return end_dt.isoformat().replace("+00:00", "Z")


def build_variant_payload(
    variant: str,
    *,
    common: Dict[str, Any],
    hours: float,
    duration_sec: int,
    bottom_limit: float,
    limit: Optional[float],
) -> Dict[str, Any]:
    payload = dict(common)
    end_ts = compute_end_ts(hours)

    if variant == "business_type_endts":
        payload.update(
            {
                "type": "BUSINESS",
                "endTs": end_ts,
                "bottomLimit": bottom_limit,
            }
        )
        if limit is not None:
            payload["limit"] = limit
        return payload

    if variant == "business_type_subtype_endts":
        payload.update(
            {
                "type": "BUSINESS",
                "subType": "BUSINESS_FIXED_DURATION",
                "endTs": end_ts,
                "bottomLimit": bottom_limit,
            }
        )
        if limit is not None:
            payload["limit"] = limit
        return payload

    if variant == "business_engine_duration":
        payload.update(
            {
                "type": "BUSINESS_ENGINE",
                "duration": duration_sec,
                "bottomLimit": bottom_limit,
            }
        )
        if limit is not None:
            payload["limit"] = limit
        return payload

    if variant == "business_engine_duration_endts":
        payload.update(
            {
                "type": "BUSINESS_ENGINE",
                "duration": duration_sec,
                "endTs": end_ts,
                "bottomLimit": bottom_limit,
            }
        )
        if limit is not None:
            payload["limit"] = limit
        return payload

    if variant == "business_engine_subtype_duration_endts":
        payload.update(
            {
                "type": "BUSINESS_ENGINE",
                "subType": "BUSINESS_FIXED_DURATION",
                "duration": duration_sec,
                "endTs": end_ts,
                "bottomLimit": bottom_limit,
            }
        )
        if limit is not None:
            payload["limit"] = limit
        return payload

    raise RuntimeError(f"Unknown variant: {variant}")


def cancel_order(creds: NhCreds, order_id: str) -> Dict[str, Any]:
    return nh_request(creds, "DELETE", f"/main/api/v2/hashpower/order/{order_id}")


def variant_order(selected: str) -> List[str]:
    if selected != "auto":
        return [selected]
    return [
        "business_type_endts",
        "business_type_subtype_endts",
        "business_engine_duration",
        "business_engine_duration_endts",
        "business_engine_subtype_duration_endts",
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="Test NiceHash Business Fixed Duration order creation.")
    parser.add_argument("--market", default="EU", help="Market, e.g. EU or USA (default: EU)")
    parser.add_argument("--algorithm", default="SHA256ASICBOOST", help="Algorithm code (default: SHA256ASICBOOST)")
    parser.add_argument("--pool-id", help="Existing NiceHash poolId")
    parser.add_argument("--pool", help="Pool URL, e.g. stratum+tcp://mine.coean.xyz:3334")
    parser.add_argument("--worker", help="Worker/username (e.g. BTC address)")
    parser.add_argument("--pool-password", default="x", help="Pool password for pool creation (default: x)")
    parser.add_argument("--pool-name", help="Optional NiceHash pool name when creating pool")
    parser.add_argument("--amount", type=float, required=True, help="Order amount in BTC")
    parser.add_argument("--hours", type=float, required=True, help="Target duration in hours")
    parser.add_argument("--bottom-limit", type=float, default=None, help="Bottom speed in EH (default: algo minSpeedLimit)")
    parser.add_argument("--bottom-limit-th", type=float, default=None, help="Bottom speed in TH/s (converted to EH)")
    parser.add_argument("--limit", type=float, default=None, help="Optional speed cap in EH")
    parser.add_argument("--limit-th", type=float, default=None, help="Optional speed cap in TH/s (converted to EH)")
    parser.add_argument(
        "--variant",
        default="auto",
        choices=[
            "auto",
            "business_type_endts",
            "business_type_subtype_endts",
            "business_engine_duration",
            "business_engine_duration_endts",
            "business_engine_subtype_duration_endts",
        ],
        help="Payload variant to test (default: auto tries all known forms)",
    )
    parser.add_argument("--cancel-after-create", action="store_true", help="Cancel order immediately after successful create")
    args = parser.parse_args()

    if args.hours <= 0:
        raise RuntimeError("--hours must be > 0")
    if args.bottom_limit is not None and args.bottom_limit_th is not None:
        raise RuntimeError("Provide only one of --bottom-limit or --bottom-limit-th")
    if args.limit is not None and args.limit_th is not None:
        raise RuntimeError("Provide only one of --limit or --limit-th")

    creds = require_creds()

    print("[1/5] Fetching algorithm constraints...")
    algos = nh_request(creds, "GET", "/main/api/v2/mining/algorithms")
    algo_entry = first_algo_entry(algos, args.algorithm)

    min_speed = parse_float(algo_entry.get("minSpeedLimit"), 0.0)
    max_speed = parse_float(algo_entry.get("maxSpeedLimit"), float("inf"))
    min_amount = parse_float(algo_entry.get("minimalOrderAmount"), 0.0)

    bottom_limit_input: Optional[float]
    if args.bottom_limit_th is not None:
        bottom_limit_input = th_to_eh(float(args.bottom_limit_th))
    else:
        bottom_limit_input = args.bottom_limit
    limit_input: Optional[float]
    if args.limit_th is not None:
        limit_input = th_to_eh(float(args.limit_th))
    else:
        limit_input = args.limit

    if min_amount > 0 and args.amount < min_amount:
        raise RuntimeError(f"amount {args.amount} is below minimalOrderAmount {min_amount}")

    bottom_limit = bottom_limit_input if bottom_limit_input is not None else min_speed
    if bottom_limit <= 0:
        raise RuntimeError("bottomLimit could not be derived. Pass --bottom-limit explicitly.")
    if min_speed > 0 and bottom_limit < min_speed:
        raise RuntimeError(f"bottomLimit {bottom_limit} is below minSpeedLimit {min_speed}")

    if limit_input is not None:
        if limit_input <= 0:
            raise RuntimeError("--limit must be > 0")
        if max_speed > 0 and max_speed != float("inf") and limit_input > max_speed:
            raise RuntimeError(f"limit {limit_input} exceeds maxSpeedLimit {max_speed}")
        if bottom_limit > limit_input:
            raise RuntimeError(f"bottomLimit {bottom_limit} cannot exceed limit {limit_input}")

    print("[2/5] Resolving pool-id...")
    resolved_pool_id = ensure_pool_id(
        creds,
        pool_id=args.pool_id,
        pool_url=args.pool,
        worker=args.worker,
        algorithm=args.algorithm,
        pool_password=args.pool_password,
        pool_name=args.pool_name,
    )

    duration_sec = int(round(args.hours * 3600))
    common = base_payload_fields(
        algo_entry,
        market=args.market,
        algorithm=args.algorithm,
        amount=args.amount,
        pool_id=resolved_pool_id,
    )

    print("[3/5] Common fields:")
    print(json.dumps(common, indent=2))
    if args.bottom_limit_th is not None:
        print(f"Converted --bottom-limit-th {args.bottom_limit_th} TH/s -> {bottom_limit:.12f} EH")
    if args.limit_th is not None and limit_input is not None:
        print(f"Converted --limit-th {args.limit_th} TH/s -> {limit_input:.12f} EH")
    print("[4/5] Attempting duration payload variant(s)...")

    attempts: List[Tuple[str, str]] = []
    for variant in variant_order(args.variant):
        payload = build_variant_payload(
            variant,
            common=common,
            hours=args.hours,
            duration_sec=duration_sec,
            bottom_limit=bottom_limit,
            limit=limit_input,
        )

        print(f"\n--- Variant: {variant} ---")
        print(json.dumps(payload, indent=2))

        try:
            created = nh_request(creds, "POST", "/main/api/v2/hashpower/business/order", body=payload)
            print("Create success:")
            print(json.dumps(created, indent=2))

            order_id = str(created.get("id") or created.get("orderId") or "").strip()
            if args.cancel_after_create and order_id:
                print(f"Cancelling order {order_id} ...")
                cancelled = cancel_order(creds, order_id)
                print("Cancel response:")
                print(json.dumps(cancelled, indent=2))
            print(f"\nSUCCESS with variant: {variant}")
            return
        except Exception as exc:
            msg = str(exc)
            attempts.append((variant, msg))
            print(f"Variant {variant} failed:\n{msg}")

    print("\n[5/5] All attempted duration variants failed.")
    for variant, err in attempts:
        print(f"- {variant}: {err.splitlines()[0]}")
    raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
