"""Give SCP's people accounts and roles on another site.

    bench --site kaitet.local execute upande_scp.serverscripts.migrate.port_users.plan
    bench --site kaitet.local execute upande_scp.serverscripts.migrate.port_users.run

Two separable steps, in this order:

1. **create** the users who are missing there, carrying *no roles at all*;
2. **grant** only the four SCP roles, mapped from the live source roles here.

Keeping them apart matters. A user copied wholesale drags along whatever else it
holds on this site — Accounts, Stock, HR — and a training site should not inherit
that. So accounts are created bare and then given exactly what SCP needs.

## Which roles, and why not the obvious ones

`Has Role` on this site cannot be trusted as evidence a role exists: 20 role names
have assignments pointing at Role documents that were deleted, `Spray Plan Approver`
among them — 24 users "hold" it and it grants nothing, because the namespacing
rename removed the Role and left the child rows behind.

So the source roles below are only ones with a live Role record, and the approver
is taken from the **prefixed** name for exactly that reason:

    Scout                     -> SCP Scout
    Spray Supervisor          -> SCP Spray Supervisor
    Spray Plan Creator        -> SCP Spray Plan Creator
    SCP Spray Plan Approver   -> SCP Spray Plan Approver

The legacy names are absent from the target, which is correct — it is a clean
install that never had the pre-namespacing duplicates. Porting them would import a
problem it does not have.
"""

from __future__ import annotations

import frappe

from upande_scp.serverscripts.migrate.target import Target

# source role here -> role to grant there. Sources are verified live Role records.
ROLE_MAP = {
	"Scout": "SCP Scout",
	"Spray Supervisor": "SCP Spray Supervisor",
	"Spray Plan Creator": "SCP Spray Plan Creator",
	"SCP Spray Plan Approver": "SCP Spray Plan Approver",
}

# Never created. The Upande team do not belong on a client training site.
EXCLUDE_DOMAINS = ("upande.com",)

# Excluded by default; pass `include_suspect=True` to override.
#
# The test accounts are here because a training site should not start life with
# them in it. The other two are decisions the office made when shown the list:
#
# * `pkatule@loikitelaorchards.com` — `loikitela`, a typo. The same person already
#   has `pkatule@lokitelaorchards.com` on the target, and both accounts here hold
#   only `Scout`, so dropping the misspelt one loses nothing: the correct address
#   picks up `SCP Scout` in the grant pass. 41 users use the right spelling, 1 the
#   wrong one.
# * `nduryaphilip66@gmail.com` — a personal address holding Spray Plan Creator.
#
# The two shared security accounts are deliberately NOT excluded — they scout.
SUSPECT = (
	"test@test.com",
	"test1@dev.com",
	"pkatule@loikitelaorchards.com",
	"nduryaphilip66@gmail.com",
)

# Fields worth carrying. Deliberately excludes `roles` — see the docstring.
USER_FIELDS = (
	"email",
	"first_name",
	"last_name",
	"full_name",
	"username",
	"user_type",
	"enabled",
	"gender",
	"mobile_no",
	"phone",
	"language",
	"time_zone",
)


def _source_users():
	"""{user: {roles wanted there}} for enabled users holding a live source role."""
	rows = frappe.db.sql(
		"""
		SELECT hr.parent AS user, hr.role
		FROM `tabHas Role` hr
		JOIN tabUser u ON u.name = hr.parent
		JOIN tabRole r ON r.name = hr.role
		WHERE hr.parenttype = 'User' AND u.enabled = 1 AND hr.role IN %(roles)s
		""",
		{"roles": tuple(ROLE_MAP)},
		as_dict=True,
	)
	out = {}
	for row in rows:
		out.setdefault(row.user, set()).add(ROLE_MAP[row.role])
	return out


def _excluded(email, include_suspect=False):
	if any(email.endswith("@" + d) for d in EXCLUDE_DOMAINS):
		return "team account"
	if not include_suspect and email in SUSPECT:
		return "test account"
	return None


def plan(env_file=None, include_suspect=False):
	"""What would be created and granted. Makes no writes."""
	site = Target(env_file=env_file)
	wanted = _source_users()
	there = site.names("User")
	target_roles = site.names("Role")

	print(f"target: {site.describe()}   (read-only)\n")

	missing_roles = [r for r in set(ROLE_MAP.values()) if r not in target_roles]
	if missing_roles:
		print(f"!! these roles do not exist on the target: {missing_roles}\n")

	to_create, skipped = [], []
	for email in sorted(wanted):
		if email in there:
			continue
		why = _excluded(email, include_suspect)
		(skipped if why else to_create).append((email, why))

	print(f"{len(wanted)} enabled SCP users here; {len(set(wanted) & there)} already on target\n")
	print(f"CREATE ({len(to_create)}):")
	for email, _ in to_create:
		print(f"  + {email:<42} {sorted(wanted[email])}")
	print(f"\nSKIP ({len(skipped)}):")
	for email, why in skipped:
		print(f"  - {email:<42} {why}")

	# Role grants cover everyone who will exist there, not just the new ones.
	print("\nROLE GRANTS (all SCP users present after creation):")
	will_exist = (set(wanted) & there) | {e for e, _ in to_create}
	for role in sorted(set(ROLE_MAP.values())):
		n = sum(1 for u in will_exist if role in wanted[u])
		print(f"  {role:<26} {n:>4} users")
	return {"create": [e for e, _ in to_create], "skip": skipped, "grant": len(will_exist)}
