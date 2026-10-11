"""Gallery page photo feed (spec 2026-10-11 GP2).

Every ``Scouting Entry Photo`` in scope for a date range, newest first, a page
at a time — the pop-up's photo list (``_gallery._photos``) without its single
observation, plus farm / greenhouse / kind / name / scout filters. Scoping is
the pop-up's own: ``resolve_greenhouse_scope`` → ``_gallery._user_scope``
(the user's crop-scoped greenhouses; a named house or farm outside them is a
PermissionError) → ``parent_filter_conditions``.

A photo row's ``subject`` is a bare name; its kind is read from the crop's pest
and disease lists (the masters when there is no crop), anything else — General,
an unidentified pest — is ``other``.

Uncached, like the pop-up's photos: the table is small and a scout's new photo
should show at once. The files are private; the browser fetches them with its
own session.
"""

import frappe

from upande_scp.serverscripts.dashboard_aggregates import _gallery
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.dashboard_aggregates._common import (
    coerce_date,
    parent_filter_conditions,
    resolve_greenhouse_scope,
)
from upande_scp.serverscripts.scouting import scouting_metrics

PHOTOS_PER_PAGE = _gallery.PHOTOS_PER_PAGE
MAX_PAGE = _gallery.MAX_PAGE

_PHOTOS = """
SELECT ph.image, ph.caption, ph.captured_on, se.scouts_name, {wh}, se.date_of_capture,
       se.name, ph.subject, se.time_of_capture
FROM `tabScouting Entry Photo` ph
JOIN `tabScouting Entry` se ON se.name = ph.parent
WHERE ph.parenttype = 'Scouting Entry' AND {where}{extra}
ORDER BY COALESCE(ph.captured_on, se.date_of_capture) DESC, ph.name DESC
LIMIT %(limit)s OFFSET %(offset)s
"""

_FACETS = """
SELECT IFNULL(ph.subject, ''), se.scouts_name, COUNT(*)
FROM `tabScouting Entry Photo` ph
JOIN `tabScouting Entry` se ON se.name = ph.parent
WHERE ph.parenttype = 'Scouting Entry' AND {where}
GROUP BY IFNULL(ph.subject, ''), se.scouts_name
"""


def photo_feed(args: dict, force: bool = False) -> dict:
    kind = (args.get("kind") or "").strip().lower()
    if kind and kind not in ("pest", "disease", "other"):
        frappe.throw(f"Unknown observation kind: {kind}.", frappe.ValidationError)
    name = (args.get("name") or "").strip()
    scout = (args.get("scout") or "").strip()
    try:
        page = min(MAX_PAGE, max(0, int(args.get("page") or 0)))
    except (TypeError, ValueError):
        page = 0

    crop = (args.get("crop") or "").strip()
    greenhouse = (args.get("greenhouse") or "").strip()
    farm = (args.get("farm") or "").strip()
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(greenhouse, farm, farms_map)
    scope = _gallery._user_scope(scope, crop, greenhouse, farm)

    where, params = parent_filter_conditions(
        coerce_date(args.get("from_date")), coerce_date(args.get("to_date")), crop, scope,
    )
    kinds = _Kinds(crop)

    extra, xparams = [], {}
    if name:
        # D4: a pest/disease not linked to the crop reads as "other" here, so
        # asking for it under its kind returns nothing.
        if kind and kinds.of(name) != kind:
            where = "1=0"
        extra.append("ph.subject = %(subject)s")
        xparams["subject"] = name
    elif kind in ("pest", "disease"):
        names = kinds.names(kind)
        if not names:
            where = "1=0"
        else:
            extra.append("ph.subject IN %(subjects)s")
            xparams["subjects"] = tuple(names)
    elif kind == "other":
        known = kinds.names("pest") + kinds.names("disease")
        if known:
            extra.append("(IFNULL(ph.subject, '') = '' OR ph.subject NOT IN %(known)s)")
            xparams["known"] = tuple(known)
    if scout:
        extra.append("se.scouts_name = %(scout)s")
        xparams["scout"] = scout

    photos, has_more = _photos(where, {**params, **xparams}, extra, page, kinds)
    out = {"photos": photos, "page": page, "hasMore": has_more, "pageSize": PHOTOS_PER_PAGE}
    if page == 0:
        out["facets"] = _facets(where, params, kinds)
    return out


class _Kinds:
    """Subject → pest / disease / other, for one crop (or the masters)."""

    def __init__(self, crop: str):
        if crop:
            self._pests = _gallery._crop_list("pest", crop)
            self._diseases = _gallery._crop_list("disease", crop)
        else:
            self._pests = frappe.get_all("Pest", pluck="name", limit_page_length=0)
            self._diseases = frappe.get_all("Plant Disease", pluck="name", limit_page_length=0)
        self._p, self._d = set(self._pests), set(self._diseases)

    def of(self, subject: str) -> str:
        if subject in self._p:
            return "pest"
        if subject in self._d:
            return "disease"
        return "other"

    def names(self, kind: str) -> list:
        return list(self._pests if kind == "pest" else self._diseases)


def _photos(where: str, params: dict, extra: list, page: int, kinds: _Kinds) -> tuple:
    if where == "1=0":
        return [], False
    rows = frappe.db.sql(
        _PHOTOS.format(wh=R._WH, where=where, extra="".join(f" AND {c}" for c in extra)),
        {**params, "limit": PHOTOS_PER_PAGE + 1, "offset": page * PHOTOS_PER_PAGE},
    )
    has_more = len(rows) > PHOTOS_PER_PAGE
    rows = rows[:PHOTOS_PER_PAGE]
    people = scout_people({r[3] for r in rows if r[3]})
    out = []
    for r in rows:
        person = people.get(r[3]) or {}
        subject = r[7] or ""
        out.append({
            "image": r[0] or "",
            "caption": r[1] or "",
            "capturedOn": str(r[2] or _day_time(r[5], r[8])),
            "scout": r[3] or "",
            "scoutName": person.get("name") or r[3] or "",
            "scoutImage": person.get("image") or "",
            "house": r[4] or "",
            "date": coerce_date(r[5]),
            "entry": r[6],
            "subject": subject,
            "kind": kinds.of(subject),
        })
    return out, has_more


def _day_time(day, time) -> str:
    d = coerce_date(day)
    if not d:
        return ""
    t = hms(time)
    return f"{d} {t}" if t else d


def hms(time) -> str:
    """A TIME column (a timedelta from MariaDB, or a string) as HH:MM:SS."""
    if time is None or time == "":
        return ""
    if hasattr(time, "total_seconds"):
        s = int(time.total_seconds())
        return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"
    return str(time).split(".")[0]


def _facets(where: str, params: dict, kinds: _Kinds) -> dict:
    if where == "1=0":
        return {"subjects": [], "scouts": []}
    subjects: dict = {}
    scouts: dict = {}
    for subject, scout, n in frappe.db.sql(_FACETS.format(where=where), params):
        subjects[subject] = subjects.get(subject, 0) + int(n)
        if scout:
            scouts[scout] = scouts.get(scout, 0) + int(n)
    people = scout_people(set(scouts))
    return {
        "subjects": sorted(
            ({"name": s, "kind": kinds.of(s), "count": n} for s, n in subjects.items() if s),
            key=lambda x: (x["kind"], x["name"]),
        ),
        "scouts": sorted(
            ({"scout": s, "scoutName": (people.get(s) or {}).get("name") or s,
              "image": (people.get(s) or {}).get("image") or "", "count": n}
             for s, n in scouts.items()),
            key=lambda x: x["scoutName"],
        ),
    }


def scout_people(ids) -> dict:
    """{employee: {"name", "image"}} — Employee name and photo."""
    ids = [i for i in ids if i]
    if not ids:
        return {}
    return {
        r.name: {"name": r.employee_name or r.name, "image": r.image or ""}
        for r in frappe.get_all("Employee", filters={"name": ["in", ids]},
                                fields=["name", "employee_name", "image"], limit_page_length=0)
    }
