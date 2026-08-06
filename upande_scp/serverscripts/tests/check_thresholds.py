"""Equivalence check for the ``load_thresholds`` N+1 fix.

``load_thresholds`` used to issue one SQL round trip per Pest Filter /
Disease Filter row to fetch that row's stage children (21 round trips for
crop "Rose": 12 Pest Filter + 6 Disease Filter rows, plus the two parent
queries). It now issues exactly two LEFT JOIN queries total. This check
embeds a straightforward, obviously-correct per-row reference
implementation (mirroring the old code) and asserts the live
``load_thresholds`` returns byte-for-byte identical maps for every crop in
the system.

Not a FrappeTestCase (`bench run-tests` is broken on this bench); run via:

    bench --site kaitet.local execute \\
        upande_scp.serverscripts.tests.check_thresholds.run

Read-only: only SELECTs against tabPest Filter / tabPests Stages /
tabDisease Filter / tabDisease Stages / tabCrop Scouted.
"""

import frappe

from upande_scp.serverscripts.dashboard_aggregates._common import (
    _zero_band,
    load_thresholds,
)


def _reference_thresholds(crop: str) -> dict:
    """Naive one-query-per-parent-row implementation -- the pre-fix
    behaviour, kept here (not in production code) purely as an oracle."""
    crop = (crop or "").strip()
    if not crop:
        return {}
    if not frappe.db.exists("Crop Scouted", crop):
        return {}

    out: dict = {}

    pest_rows = frappe.db.sql(
        """
        SELECT pf.name AS row_name, pf.pest, pf.low_threshold,
               pf.moderate_threshold, pf.high_threshold
        FROM `tabPest Filter` pf
        WHERE pf.crop_scouted = %(crop)s
        """,
        {"crop": crop},
        as_dict=True,
    )
    for pf in pest_rows:
        if not _zero_band(pf["low_threshold"], pf["moderate_threshold"], pf["high_threshold"]):
            out[("pest", pf["pest"], "")] = {
                "low":  float(pf["low_threshold"] or 0),
                "mod":  float(pf["moderate_threshold"] or 0),
                "high": float(pf["high_threshold"] or 0),
            }
        stage_rows = frappe.db.sql(
            """
            SELECT stage, low_threshold, moderate_threshold, high_threshold
            FROM `tabPests Stages`
            WHERE parent = %(row)s AND parenttype = 'Pest Filter'
            """,
            {"row": pf["row_name"]},
            as_dict=True,
        )
        for sr in stage_rows:
            if _zero_band(sr["low_threshold"], sr["moderate_threshold"], sr["high_threshold"]):
                continue
            out[("pest", pf["pest"], (sr["stage"] or "").strip())] = {
                "low":  float(sr["low_threshold"] or 0),
                "mod":  float(sr["moderate_threshold"] or 0),
                "high": float(sr["high_threshold"] or 0),
            }

    dis_rows = frappe.db.sql(
        """
        SELECT df.name AS row_name, df.disease, df.low_threshold,
               df.moderate_threshold, df.high_threshold
        FROM `tabDisease Filter` df
        WHERE df.crop_scouted = %(crop)s
        """,
        {"crop": crop},
        as_dict=True,
    )
    for df in dis_rows:
        if not _zero_band(df["low_threshold"], df["moderate_threshold"], df["high_threshold"]):
            out[("disease", df["disease"], "")] = {
                "low":  float(df["low_threshold"] or 0),
                "mod":  float(df["moderate_threshold"] or 0),
                "high": float(df["high_threshold"] or 0),
            }
        stage_rows = frappe.db.sql(
            """
            SELECT stage, low_threshold, moderate_threshold, high_threshold
            FROM `tabDisease Stages`
            WHERE parent = %(row)s AND parenttype = 'Disease Filter'
            """,
            {"row": df["row_name"]},
            as_dict=True,
        )
        for sr in stage_rows:
            if _zero_band(sr["low_threshold"], sr["moderate_threshold"], sr["high_threshold"]):
                continue
            out[("disease", df["disease"], (sr["stage"] or "").strip())] = {
                "low":  float(sr["low_threshold"] or 0),
                "mod":  float(sr["moderate_threshold"] or 0),
                "high": float(sr["high_threshold"] or 0),
            }

    return out


def run():
    crops = [c["name"] for c in frappe.get_all("Crop Scouted")]
    assert crops, "no Crop Scouted docs found -- nothing to check"

    checked = 0
    for crop in crops:
        # Bypass load_thresholds' per-request memo so every crop is actually
        # recomputed from the database, not served from a stale cache entry.
        cache = getattr(frappe.local, "_scp_threshold_cache", None)
        if cache is not None:
            cache.pop(crop, None)

        got = load_thresholds(crop)
        want = _reference_thresholds(crop)

        assert got == want, (
            f"load_thresholds('{crop}') diverged from the reference implementation:\n"
            f"  got keys not in want:  {set(got) - set(want)}\n"
            f"  want keys not in got:  {set(want) - set(got)}\n"
            f"  mismatched values: "
            f"{ {k: (got.get(k), want.get(k)) for k in set(got) & set(want) if got.get(k) != want.get(k)} }"
        )
        checked += 1

    print(f"check_thresholds: {checked} crops, load_thresholds == reference for all -- PASS")
