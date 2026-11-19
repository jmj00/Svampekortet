"""Svampekortet data pipeline and probability model."""

from __future__ import annotations

try:
    # Trust the OS certificate store so HTTPS works on machines / networks that
    # do TLS inspection and re-sign certificates. No-op if truststore is absent.
    import truststore

    truststore.inject_into_ssl()
except ImportError:  # pragma: no cover
    pass
