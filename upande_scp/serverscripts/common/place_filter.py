"""Farm / greenhouse filters that take one name or several.

The multi-select place picker sends one name as a plain string (what every
caller sent before) and several as a JSON list. A comma-separated string is
read too. ``None``, ``""`` and the web app's "__all__" sentinel mean "no filter".
"""
from __future__ import annotations

import json

_ALL = {"", "__all__", "all"}


def parse_names(value) -> list[str]:
    """Normalise a filter value to a de-duplicated list of names (order kept)."""
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        raw = list(value)
    else:
        text = str(value).strip()
        if text.lower() in _ALL:
            return []
        raw = None
        if text.startswith("["):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    raw = parsed
            except ValueError:
                raw = None
        if raw is None:
            raw = text.split(",") if "," in text else [text]
    out: list[str] = []
    for n in raw:
        n = str(n).strip() if n is not None else ""
        if n and n.lower() != "__all__" and n not in out:
            out.append(n)
    return out


def matches(value, names: list[str]) -> bool:
    """True when ``names`` is empty (no filter) or ``value`` is one of them."""
    return not names or (value or "") in names
