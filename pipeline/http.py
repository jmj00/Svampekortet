"""Tiny standard-library JSON HTTP helper with polite throttling and retries.

Used by both the pipeline and the spikes. TLS trust comes from the OS store via
`truststore` (injected in `pipeline/__init__.py`).
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "svampekortet/0.1 (+https://github.com/jmj00/Svampekortet)"

# Cap outbound request rate. GBIF returns HTTP 429 for bursts; DMI has no
# published limit but politeness is cheap.
MIN_INTERVAL_S = 0.5
_last_call = 0.0


def _throttle() -> None:
    global _last_call
    wait = MIN_INTERVAL_S - (time.monotonic() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.monotonic()


def get_json(
    url: str,
    params: dict | None = None,
    *,
    retries: int = 4,
    timeout: int = 90,
) -> dict | list:
    """GET `url` with optional query `params`, decode JSON, retry with backoff.

    Returns whatever the endpoint sends (an object, or a bare array like DAWA).
    Raises RuntimeError on a 400/404 (no point retrying) or after exhausting retries.
    """
    if params:
        url = f"{url}?{urllib.parse.urlencode(params, doseq=True)}"

    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            _throttle()
            req = urllib.request.Request(
                url,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            last_err = err
            body = ""
            if isinstance(err, urllib.error.HTTPError):
                try:
                    body = err.read().decode("utf-8", "replace")[:400]
                except Exception:  # noqa: BLE001
                    body = ""
                if err.code in (400, 404):
                    raise RuntimeError(f"GET {url}\n  HTTP {err.code}: {body}") from err
            wait = 2**attempt
            print(f"  request failed ({err}); retry {attempt}/{retries} in {wait}s")
            if body:
                print(f"  body: {body}")
            time.sleep(wait)
    raise RuntimeError(f"GET {url} failed after {retries} attempts: {last_err}")
