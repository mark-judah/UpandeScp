"""Pure conversion between a tank-mix absolute amount and its per-1000 L rate.

The frontend (``ApplicationPlan.tsx``) computes the ABSOLUTE amount for a tank
(``rate x water_volume / 1000``) and sends it; the backend stores it verbatim as
the Work Order ``required_qty`` (== transfer == per-plan BOM ``stock_qty`` ==
consumed). The per-1000 L rate is derived only for display and agronomic
rate-limit checks.
"""
from frappe.utils import flt


def absolute_to_rate(required_qty, water_volume) -> float:
    """Absolute tank amount -> per-1000 L rate.

    Read-path safety: a legacy row with no water volume returns the stored qty
    unchanged (factor 1). Write paths validate ``water_volume > 0`` (see
    ``drafts._validate_payload``), so that branch only guards display of
    pre-existing data.
    """
    wv = flt(water_volume)
    if wv <= 0:
        return flt(required_qty)
    return flt(required_qty) / (wv / 1000.0)
