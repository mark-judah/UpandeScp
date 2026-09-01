"""Live view of the Scouting Entry migration, for watching a 7-hour run.

Reads the JSON snapshot `serverscripts/migrate/migrate_scouting.py` writes. Nothing
here touches either site: the page is a reader, so opening it (or leaving it open on
a second screen all night) cannot slow the migration down or interfere with it.

A directory page with `__init__.py` rather than a flat `migration.html`, because a
flat www page renders a white screen on Frappe 16.
"""

import json
import os

import frappe

STATUS_FILE = "/tmp/scp_migration_status.json"

no_cache = 1


def get_context(context):
    context.no_cache = 1
    # Handed over as a JSON *string*: Jinja's `tojson` filter is not dependably
    # available in Frappe's sandboxed environment, and a first paint that works
    # without waiting for the first poll is worth the extra line.
    context.status_json = json.dumps(_read())
    return context


def _read():
    path = frappe.conf.get("scp_migration_status_file") or STATUS_FILE
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {"missing": True, "path": path}
    except Exception as e:
        # A half-written file should never be possible (the writer renames into
        # place) but a truncated read is not worth a traceback on a status page.
        return {"error": str(e), "path": path}


@frappe.whitelist()
def status():
    """Polled by the page every two seconds."""
    return _read()
