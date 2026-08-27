"""Job-specific Role Profiles for the livestock roles, on the target site.

    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.livestock_profiles.plan
    bench --site kaitet.local execute \
        upande_scp.serverscripts.migrate.livestock_profiles.run

## Why not extend the two that exist

The target already has `Dairy Operator` and `Dairy Approver`, and both are
livestock-related — so the instinct is to add the new roles to them. That does not
work, because **a Role Profile grants the same set to everyone holding it** and the
two users on `Dairy Approver` do different jobs: `dickson@` manages, `yammah@`
breeds and vets. Adding Breeder and Vet there would hand `dickson@` both, which is
exactly the sprawl this work removed.

They are also not purely livestock — both carry `Employee Self Service`, and
`Dairy Approver` carries `Expense Approver` and `Leave Approver`. Reshaping them
would reach into HR.

So the existing two are left alone for their approval and HR content, and one
profile is added per job. A person can hold a job profile and still sit in
`Dairy Approver` for the approving they do.

## Naming

`Dairy ` follows the target's own convention (`Dairy Operator`, `Dairy Approver`,
`Agronomy Supervisor`), even though the roles inside are named `Livestock `. The
profile is what an administrator picks from a list next to `Coffee Clerk` and
`Accounts Clerk`; matching that list matters more than matching the role names.

## These are inert until the app ships

The roles exist on the target but carry no permissions yet — those live in the
app's DocType JSON and arrive with a deploy. Creating the profiles now is still
worth doing: they are ready, and they start working the moment the permissions
land, with no second pass.
"""

from __future__ import annotations

from upande_scp.serverscripts.migrate.target import Target

# Every staff profile on this site carries Employee Self Service; a livestock
# worker still needs their own leave and payslips.
BASE = "Employee Self Service"

PROFILES = {
	"Dairy Vet": ["Livestock Vet"],
	"Dairy Breeder": ["Livestock Breeder"],
	"Dairy Attendant": ["Livestock Attendant"],
	"Dairy Milker": ["Livestock Milker"],
	"Dairy Stores": ["Livestock Stores"],
	"Dairy Manager": ["Livestock Manager"],
}

# Left alone deliberately — see the module docstring.
UNTOUCHED = ("Dairy Operator", "Dairy Approver")


def _rows(roles):
	return [{"role": r} for r in [BASE] + list(roles)]


def plan(env_file=None):
	site = Target(env_file=env_file)
	existing = site.names("Role Profile")
	roles = site.names("Role")
	print(f"target: {site.describe()}   (read-only)\n")
	for name, wanted in PROFILES.items():
		missing = [r for r in [BASE] + wanted if r not in roles]
		state = "exists" if name in existing else "to create"
		note = f"  !! missing roles: {missing}" if missing else ""
		print(f"  {name:<18} {state:<10} roles={[BASE] + wanted}{note}")
	print(f"\nleft untouched: {', '.join(UNTOUCHED)}")
	return {"create": [n for n in PROFILES if n not in existing]}


def run(env_file=None):
	site = Target(env_file=env_file)
	existing = site.names("Role Profile")
	made = skipped = failed = 0
	print(f"target: {site.describe()}   (WRITING)\n")
	for name, wanted in PROFILES.items():
		if name in existing:
			skipped += 1
			print(f"  {name:<18} already there")
			continue
		ok, result = site.insert(
			"Role Profile", {"role_profile": name, "roles": _rows(wanted)}
		)
		if ok:
			made += 1
			print(f"  {name:<18} created")
		else:
			failed += 1
			print(f"  {name:<18} FAILED: {str(result)[:140]}")
	print(f"\n{made} created, {skipped} already present, {failed} failed")
	return {"created": made, "skipped": skipped, "failed": failed}
