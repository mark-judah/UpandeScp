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
| `band-as-row-like-unit-type.patch` | [#12](https://github.com/upandeltd/Upande-Core/issues/12) | Lets a coffee `Band` be validated as the row it is. Declares `ROW_LIKE_UNIT_TYPES = ("Row", "Band")` on `Bed` and uses it in `Bed.validate`, `Bed.assign_section`, `OrchardTree.validate` and `Triad.validate`, all of which tested `unit_type == "Row"` exactly — so a Band fell through to the bed-on-a-greenhouse path and was refused. |

Without this, `Field Unit Automation` creates beds and rows but not bands. It does
not fail loudly: the automation logs insert failures and reports "0 bands
created", which is why it is worth keeping the patch findable.

## Related, not patched here

[#13](https://github.com/upandeltd/Upande-Core/issues/13) — `Orchard Tree` carries
both `tree` (Int, mandatory, used by autoname) and `tree_number` (Data). No patch
is needed: SCP writes both. Recorded so the reason is not rediscovered.
