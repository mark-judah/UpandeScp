# Local patches to `upande_core`

Changes this app needs in `upande_core` that we cannot merge ourselves — we have
read-only access to
[upandeltd/Upande-Core](https://github.com/upandeltd/Upande-Core), so they are
raised as issues and applied locally in the meantime.

They live here because a `git pull` or `git checkout` in the core app would
silently discard them, and the symptom would be confusing: coffee bands quietly
refused, with the failure only in the Error Log.

## Applying

```bash
cd ../upande_core
git apply ../upande_scp/docs/upande_core_patches/<name>.patch
```

Check first — if core has merged the change, the patch will fail to apply and
that is the signal to delete it from here.

## Open patches

| Patch | Issue | What it does |
| --- | --- | --- |
| `farm-type-not-in-list-view.patch` | _to raise_ | Drops `in_list_view` from `Farm.farm_type`. Frappe forbids `in_list_view` on a `Table MultiSelect` and validates the **whole** doctype whenever a Custom Field is added to it, so this single flag makes `Farm` un-extendable by any app: `'In List View' not allowed for type Table MultiSelect in row 4`. |
| `band-as-row-like-unit-type.patch` | [#12](https://github.com/upandeltd/Upande-Core/issues/12) | Lets a coffee `Band` be validated as the row it is. Declares `ROW_LIKE_UNIT_TYPES = ("Row", "Band")` on `Bed` and uses it in `Bed.validate`, `Bed.assign_section`, `OrchardTree.validate` and `Triad.validate`, all of which tested `unit_type == "Row"` exactly — so a Band fell through to the bed-on-a-greenhouse path and was refused. |

Without this, `Field Unit Automation` creates beds and rows but not bands. It does
not fail loudly: the automation logs insert failures and reports "0 bands
created", which is why it is worth keeping the patch findable.

## Related, not patched here

[#13](https://github.com/upandeltd/Upande-Core/issues/13) — `Orchard Tree` carries
both `tree` (Int, mandatory, used by autoname) and `tree_number` (Data). No patch
is needed: SCP writes both. Recorded so the reason is not rediscovered.

## `farm-type-not-in-list-view` — why SCP does not simply wait for the fix

Without it, `upande_scp` cannot create **any** custom field on `Farm`. That is
how `Farm.spray_plan_approvers` came to be missing on a fresh install: the
approver roster had its child doctype and nowhere to put rows, so the GM could
not roster an approver at all.

Because that failure is silent and load-bearing, SCP does not rely on the patch
being applied. `serverscripts/common/custom_fields.py` clears the invalid flag
itself on `after_migrate` before adding its fields
(`_repair_invalid_list_view_flags`), writing the `DocField` row directly —
saving the DocType is the thing that is broken. The patch is still the right
fix: it stops `bench migrate` re-imposing the flag from core's JSON on every
run.
