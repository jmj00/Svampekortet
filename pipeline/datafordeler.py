"""Datafordeler OAuth: exchange an IT-system's Shared Secret for a bearer token.

Shared by every `pipeline.ingest.*` module that reads a Datafordeler WFS/WMS
service (GeoDanmark, Stednavne, ...). See `.env.example` for how to obtain
`DATAFORDELER_CLIENT_ID` / `DATAFORDELER_CLIENT_SECRET` -- a Shared Secret
authorises all of Datafordeler's open data, not just one service.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request

TOKEN_URL = "https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token"
USER_AGENT = "svampekortet/0.1 (+https://github.com/jmj00/Svampekortet)"


def get_token(client_id: str, client_secret: str) -> str:
    data = urllib.parse.urlencode(
        {"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret}
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
        return json.load(resp)["access_token"]
