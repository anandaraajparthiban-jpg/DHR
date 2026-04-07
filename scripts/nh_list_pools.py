#!/usr/bin/env python3
"""
List NiceHash pools and print their pool IDs.

Usage:
  python3 scripts/nh_list_pools.py
  python3 scripts/nh_list_pools.py --json

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
from typing import Any, Dict, Optional
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest


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
    msg = "".join(parts).encode("utf-8")
    digest = hmac.new(api_secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
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
        "X-User-Agent": "nh-list-pools",
        "X-User-Lang": "en",
    }

    req = urlrequest.Request(
        url=url,
        data=(body_string.encode("utf-8") if body_string else None),
        headers=headers,
        method=method.upper(),
    )
    try:
        with urlrequest.urlopen(req, timeout=timeout) as response:
            status_code = response.getcode()
            raw = response.read().decode("utf-8", errors="replace")
    except urlerror.HTTPError as http_err:
        status_code = http_err.code
        raw = http_err.read().decode("utf-8", errors="replace")
    except urlerror.URLError as net_err:
        raise RuntimeError(f"Network error calling NiceHash: {net_err}") from net_err

    try:
        parsed: Any = json.loads(raw) if raw else {}
    except Exception:
        parsed = {"raw": raw}

    if status_code < 200 or status_code >= 300:
        raise RuntimeError(f"NiceHash {method.upper()} {path} failed HTTP {status_code}\nResponse: {raw}")
    return parsed if isinstance(parsed, dict) else {"data": parsed}


def extract_pools(payload: Dict[str, Any]) -> list[Dict[str, Any]]:
    if isinstance(payload.get("list"), list):
        return [p for p in payload["list"] if isinstance(p, dict)]
    if isinstance(payload.get("pools"), list):
        return [p for p in payload["pools"] if isinstance(p, dict)]
    if isinstance(payload.get("data"), list):
        return [p for p in payload["data"] if isinstance(p, dict)]
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description="List NiceHash pools and pool IDs.")
    parser.add_argument("--json", action="store_true", help="Print raw JSON")
    args = parser.parse_args()

    creds = require_creds()
    # We support both paths because different NH examples/docs have used both.
    last_err: Optional[str] = None
    payload: Optional[Dict[str, Any]] = None
    for path in ("/main/api/v2/pool", "/main/api/v2/pools"):
        try:
            payload = nh_request(creds, "GET", path)
            break
        except Exception as exc:
            last_err = str(exc)
    if payload is None:
        raise RuntimeError(last_err or "Unable to fetch pools")

    if args.json:
        print(json.dumps(payload, indent=2))
        return

    pools = extract_pools(payload)
    if not pools:
        print("No pools found in account.")
        return

    print(f"Found {len(pools)} pool(s):")
    for idx, pool in enumerate(pools, start=1):
        pool_id = str(pool.get("id") or "").strip() or "n/a"
        name = str(pool.get("name") or "").strip() or "n/a"
        algo = str(pool.get("algorithm") or "").strip() or "n/a"
        host = str(pool.get("stratumHostname") or pool.get("host") or "").strip()
        port = str(pool.get("stratumPort") or pool.get("port") or "").strip()
        user = str(pool.get("username") or "").strip() or "n/a"
        endpoint = f"{host}:{port}" if host and port else (host or "n/a")
        print(f"{idx}. pool-id={pool_id}  name={name}  algo={algo}")
        print(f"   endpoint={endpoint}  username={user}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
