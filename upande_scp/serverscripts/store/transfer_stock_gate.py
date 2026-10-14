"""Will the approved transfers waiting in a store fit in what the store holds?

Pure arithmetic, no frappe: the endpoint feeds it the pending transfer rows and
the real stock, it says which transfers cannot go out and why, BEFORE anyone
scans a thumb for them.

Rules
-----
* Only the SELECTED transfers hold stock, in the store keeper's click order.
  Unselected ones are judged "as if added next" and consume nothing.
* A transfer is judged whole. If any row is short the transfer is blocked and
  consumes NOTHING. ``queue_order`` (plan date, creation, name) is only the order
  select-all adds transfers in.
* A row naming a batch (``batch_no``) draws from that batch, and from the item
  total. A row with only a ``planned_batch`` takes what the batch holds, up to
  its need, and the rest comes from the item pool - which is what the submit-time
  FEFO fill does with a plan's preferred batch.
* An unbatched row of a batch-tracked item draws from the item pool: whatever
  batches hold, less everything already earmarked. The item total must also
  never be exceeded, for every row.

Rows: ``{transfer, planned_date, created, item_code, warehouse, qty,
batch_no, planned_batch}``. Stock: ``item_stock[(item, wh)]`` and
``batch_stock[(item, wh, batch)]``. ``batch_tracked`` is an optional set of item
codes known to be batch-tracked (otherwise inferred from batch_stock).
"""

from __future__ import annotations

EPS = 1e-6


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _order(rows) -> list:
    """Transfers in queue order, each with its rows (original row order kept)."""
    by: dict = {}
    for i, r in enumerate(rows):
        t = by.setdefault(r["transfer"], {"transfer": r["transfer"], "rows": [],
                                           "key": (str(r.get("planned_date") or ""),
                                                   str(r.get("created") or ""), r["transfer"])})
        t["rows"].append(r)
    return sorted(by.values(), key=lambda t: t["key"])


def queue_order(rows) -> list:
    """Transfer names in queue order (plan date, creation, name): the order
    select-all adds them in."""
    return [t["transfer"] for t in _order(rows)]


class _State:
    def __init__(self, item_stock, batch_stock, batch_tracked):
        self.item = {k: _f(v) for k, v in (item_stock or {}).items()}
        self.batch = {k: _f(v) for k, v in (batch_stock or {}).items()}
        self.tracked = set(batch_tracked or ()) | {k[0] for k in self.batch}
        self.pool: dict = {}
        for (item, wh, _b), q in self.batch.items():
            self.pool[(item, wh)] = self.pool.get((item, wh), 0.0) + q
        self.consumers: dict = {}  # key -> selected transfers that took stock there

    def copy(self):
        c = _State.__new__(_State)
        c.item, c.batch, c.pool = dict(self.item), dict(self.batch), dict(self.pool)
        c.tracked = self.tracked
        c.consumers = {k: list(v) for k, v in self.consumers.items()}
        return c


def _judge(name, trows, st: "_State"):
    """Judge one transfer against ``st``. Returns (shorts, trial_state); the
    caller adopts trial_state only if it wants the transfer to consume."""
    t = st.copy()
    shorts: list = []
    for r in trows:
        item, wh, need = r["item_code"], r["warehouse"], _f(r.get("qty"))
        if not wh or need <= EPS:
            continue
        ik = (item, wh)
        tracked = item in t.tracked
        hard = (r.get("batch_no") or "").strip()
        soft = (r.get("planned_batch") or "").strip() if not hard else ""

        def avail_pool():
            a = t.item.get(ik, 0.0)
            return min(a, t.pool.get(ik, 0.0)) if tracked else a

        if hard:
            bk = (item, wh, hard)
            have = min(t.batch.get(bk, 0.0), avail_pool())
            if need > have + EPS:
                binding_batch = t.batch.get(bk, 0.0) <= avail_pool()
                shorts.append(_short(item, hard, wh, need, have,
                                     st.consumers.get(bk if binding_batch else ik, [])))
                continue
            t.batch[bk] = t.batch.get(bk, 0.0) - need
            keys = [bk, ik]
        else:
            from_batch = 0.0
            if soft:
                bk = (item, wh, soft)
                from_batch = min(need, max(t.batch.get(bk, 0.0), 0.0), max(avail_pool(), 0.0))
            have_rest = avail_pool() - from_batch
            if need - from_batch > have_rest + EPS:
                shorts.append(_short(item, None, wh, need, from_batch + max(have_rest, 0.0),
                                     st.consumers.get(ik, [])))
                continue
            keys = [ik]
            if from_batch > 0:
                t.batch[bk] = t.batch.get(bk, 0.0) - from_batch
                keys.append(bk)
        t.item[ik] = t.item.get(ik, 0.0) - need
        t.pool[ik] = t.pool.get(ik, 0.0) - need
        for k in keys:
            lst = t.consumers.setdefault(k, [])
            if name not in lst:
                lst.append(name)
    return shorts, t


def evaluate(rows, item_stock, batch_stock, batch_tracked=None, selected=None) -> dict:
    """``{transfer: {"ok": bool, "shorts": [...]}}`` for every transfer in ``rows``.

    Only the SELECTED transfers hold stock, in the order given (the store
    keeper's click order): each is judged whole against what the earlier ones
    left, and a short one is blocked and consumes nothing. Every other transfer
    is judged as if it were added next, after the selected ones, and does not
    consume from the other unselected ones. With nothing selected each is judged
    alone against real stock.

    A row naming a batch (``batch_no``) draws from that batch and the item
    total. A row with only ``planned_batch`` takes what that batch holds, the
    rest from the item pool (as the submit-time FEFO fill does). An unbatched row
    of a batch-tracked item draws from the pool of all its batches, never
    exceeding the item total.
    """
    by: dict = {}
    for r in rows:
        by.setdefault(r["transfer"], []).append(r)
    st = _State(item_stock, batch_stock, batch_tracked)
    out: dict = {}
    seen = set()
    for name in selected or []:
        if name not in by or name in seen:
            continue
        seen.add(name)
        shorts, trial = _judge(name, by[name], st)
        if shorts:
            out[name] = {"ok": False, "shorts": shorts}
        else:
            st = trial
            out[name] = {"ok": True, "shorts": []}
    for name in by:
        if name in seen:
            continue
        shorts, _ = _judge(name, by[name], st)
        out[name] = {"ok": not shorts, "shorts": shorts}
    return out


def _short(item, batch, wh, need, have, blockers) -> dict:
    have = max(have, 0.0)
    return {
        "item_code": item,
        "batch_no": batch,
        "warehouse": wh,
        "needed": round(need, 6),
        "available_when_its_turn": round(have, 6),
        "short_by": round(need - have, 6),
        "blocking_transfers": list(blockers),
    }


def _num(v) -> str:
    v = round(float(v), 3)
    return str(int(v)) if v == int(v) else f"{v:g}"


def short_message(shorts) -> str:
    """The sentence the store keeper reads when a transfer is refused."""
    parts = []
    for s in shorts:
        label = s["item_code"] + (f" batch {s['batch_no']}" if s.get("batch_no") else "")
        part = (f"{label} in {s['warehouse']}: needs {_num(s['needed'])}, "
                f"{_num(s['available_when_its_turn'])} left")
        if s.get("blocking_transfers"):
            part += " after " + ", ".join(s["blocking_transfers"])
        parts.append(part)
    return "Cannot be submitted — not enough stock: " + "; ".join(parts)
