"""Shared warehouse-name classification for the spray-plan flow.

One source of truth for "is this a chemical store / fertilizer store / CSU?"
so the store-keeper dashboard (stock.py) and the Spray Plan Settings
warehouse resolver agree. Names vary by site: the chemical store is
"Chemical Store - <farm>" on some sites and "Chemical Main Store - <farm>"
on mona, so match "chemical" ... "store" anywhere rather than a literal
prefix. CSUs ("Main CSU - MFK") carry no "store" token.
"""
from __future__ import annotations

import re

CHEMICAL_STORE_RE = re.compile(r"\bchemical\b.*\bstore\b", re.IGNORECASE)
FERTILIZER_STORE_RE = re.compile(r"\bfertilizer\b.*\bstore\b", re.IGNORECASE)
CSU_RE = re.compile(r"\bcsu\b", re.IGNORECASE)


def is_chemical_store(name: str | None) -> bool:
    return bool(CHEMICAL_STORE_RE.search(name or ""))


def is_fertilizer_store(name: str | None) -> bool:
    return bool(FERTILIZER_STORE_RE.search(name or ""))


def is_csu(name: str | None) -> bool:
    return bool(CSU_RE.search(name or ""))
