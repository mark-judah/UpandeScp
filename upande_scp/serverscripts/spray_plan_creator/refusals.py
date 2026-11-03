"""Refused spray-session calls: readable to the app, visible in the Error Log.

Frappe does not log a ValidationError, so a spray the server refused (HTTP 417) left no
trace and the app could only say "waiting to reach site". ``log_refusals`` wraps the
spray-session endpoints so that a refusal

* reaches the app as plain text (ERPNext writes links and lists into its messages; the
  app shows the message as it is), and
* is written to the Error Log, titled "Spray session refused", with the work order, the
  user and the original message — at most once per work order + message per 10 minutes,
  so a phone retrying every few seconds does not flood it.
"""
from __future__ import annotations

import functools
import hashlib
import json

import frappe
from frappe.utils import strip_html_tags

TITLE = "Spray session refused"
WINDOW_SECONDS = 600


def plain_text(message) -> str:
    """HTML out, entities decoded, whitespace squashed, list items kept apart."""
    import html
    import re

    text = str(message or "")
    text = re.sub(r"(?i)</(li|p|div|tr)>|<br\s*/?>", "\n", text)
    text = html.unescape(strip_html_tags(text))
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def _plain_message_log() -> None:
    """Rewrite what frappe will send back (``_server_messages``) as plain text."""
    out = []
    for raw in frappe.local.message_log or []:
        try:
            entry = json.loads(raw) if isinstance(raw, str) else dict(raw)
        except Exception:
            out.append(raw)
            continue
        if isinstance(entry, dict) and entry.get("message"):
            entry["message"] = plain_text(entry["message"])
            out.append(json.dumps(entry) if isinstance(raw, str) else entry)
        else:
            out.append(raw)
    frappe.local.message_log = out


def _work_order_of(args, kwargs, work_order_arg: str) -> str | None:
    value = kwargs.get(work_order_arg)
    if value is None and args:
        value = args[0]
    if isinstance(value, str) and work_order_arg == "payload":
        try:
            value = json.loads(value)
        except Exception:
            return None
    if isinstance(value, dict):
        value = value.get("work_order")
    return value if isinstance(value, str) else None


def record_refusal(action: str, work_order: str | None, original: str) -> bool:
    """Write one Error Log row, unless the same refusal was logged in the last 10 min.
    Returns whether a row was written."""
    key = f"scp_spray_refusal:{work_order or '-'}:{hashlib.md5(plain_text(original).encode()).hexdigest()[:16]}"
    try:
        if frappe.cache.get_value(key):
            return False
        frappe.cache.set_value(key, 1, expires_in_sec=WINDOW_SECONDS)
    except Exception:
        pass  # no cache: log rather than lose the refusal
    try:
        frappe.log_error(
            title=TITLE,
            message=(
                f"Action: {action}\nWork Order: {work_order}\n"
                f"User: {frappe.session.user}\n\nMessage:\n{plain_text(original)}\n\n"
                f"Original:\n{original}"
            ),
            reference_doctype="Work Order" if work_order else None,
            reference_name=work_order,
        )
        return True
    except Exception:
        return False


def log_refusals(action: str, work_order_arg: str = "work_order"):
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except (frappe.ValidationError, frappe.PermissionError) as e:
                original = str(e) or (e.args[0] if e.args else "")
                plain = plain_text(original)
                if plain:
                    e.args = (plain,)
                _plain_message_log()
                wo = _work_order_of(args, kwargs, work_order_arg)
                # The request's rollback would take the log row with it, so the row is
                # written on its own after one (the call is being refused whole anyway).
                if not frappe.flags.in_test:
                    frappe.db.rollback()
                if record_refusal(action, wo, original) and not frappe.flags.in_test:
                    frappe.db.commit()
                raise

        return wrapper

    return deco
