"""Shared helpers for the dashboard aggregation endpoints.

These functions are pure where possible so they can be unit-tested without a
Frappe site; functions that hit the database take explicit dependencies.
"""

def resolve_greenhouse_scope(
    greenhouse: str,
    farm: str,
    farms_map: dict,
) -> list | None:
    """Match the Dashboard.tsx greenhouseScope rule:

    - explicit greenhouse wins → [greenhouse]
    - farm without greenhouse → farms_map[farm] (empty list if farm unknown)
    - both empty → None (i.e. no greenhouse filter)
    """
    if greenhouse:
        return [greenhouse]
    if farm:
        return list(farms_map.get(farm, []))
    return None
