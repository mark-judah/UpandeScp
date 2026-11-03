"""Site-timezone helpers for client timestamps.

Trimmed from kaitet's ``common/timezone.py``: only what the offline spray sync needs
(``erp_timezone``, ``to_site_naive``). The timezone report / lock endpoints are not
ported to this site.
"""
from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import frappe

FALLBACK = "UTC"


def _single_value(doctype: str, field: str):
	try:
		return frappe.db.get_single_value(doctype, field)
	except Exception:
		return None


def erp_timezone() -> str:
	"""The site timezone, the only one that governs stored timestamps."""
	return str(_single_value("System Settings", "time_zone") or FALLBACK)


def is_valid(name: str | None) -> bool:
	if not name:
		return False
	try:
		ZoneInfo(str(name))
		return True
	except (ZoneInfoNotFoundError, ValueError, TypeError):
		return False


def to_site_naive(value):
	"""A client timestamp as a naive datetime in the ERP's timezone.

	Handsets stamp with ``Date.toISOString()`` (UTC, with a ``Z``). ``get_datetime``
	returns an aware datetime for that, while everything stored here is naive site-local;
	mixing them raises on comparison and MariaDB refuses the string (1292). This converts
	(rather than strips) the offset so the recorded instant stays correct. Naive input is
	already site time and is returned untouched; unparseable input returns None.
	"""
	if not value:
		return None
	try:
		moment = frappe.utils.get_datetime(value)
	except Exception:
		return None
	if moment is None or getattr(moment, "tzinfo", None) is None:
		return moment
	name = erp_timezone()
	if not is_valid(name):
		name = FALLBACK
	return moment.astimezone(ZoneInfo(name)).replace(tzinfo=None)


def offset_minutes(name: str | None) -> int | None:
	"""Current UTC offset of a timezone, in minutes (None when unreadable)."""
	from datetime import datetime

	if not is_valid(name):
		return None
	delta = datetime.now(ZoneInfo(str(name))).utcoffset()
	return int(delta.total_seconds() // 60) if delta else 0
