"""Link existing tank-mix Material Issues to their spray plan (Work Order).

Custom fields are normally declared on after_migrate, which runs after patches,
so declare them here first or a first migrate would find no column to fill.
"""
from upande_scp.serverscripts.spray_plan_creator.issue_link import backfill
from upande_scp.serverscripts.store.stock_entry_fields import ensure_scp_stock_entry_fields


def execute():
	ensure_scp_stock_entry_fields()
	summary = backfill()
	print(f"link_tank_mix_issues_to_plan: {summary}")
