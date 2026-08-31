#!/usr/bin/env python3
"""Shopify seam — STUB (spec §13). Tier 4 replaces this with the real UTM fuzzy-join.

correlate.py calls fetch() and branches on `enabled`; v1 always gets False, so no
revenue / product-category attribution is attempted and the brief makes no revenue claim.
"""

from __future__ import annotations


def fetch(since: str, until: str) -> dict:
    return {"enabled": False, "since": since, "until": until, "orders": []}
