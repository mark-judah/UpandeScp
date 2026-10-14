"""Add the Asset Check Sheet client-id Custom Field (owned by upande_asset).

Skipped when upande_asset is not installed; the Scout app's offline retries use
this field to find the sheet they already made. Safe to re-run. The same guard
also runs on every migrate (asset_checks.setup.after_migrate), so installing
upande_asset after SCP still gets the field.
"""
from upande_scp.serverscripts.asset_checks.setup import ensure_client_id_field


def execute() -> None:
    ensure_client_id_field()
