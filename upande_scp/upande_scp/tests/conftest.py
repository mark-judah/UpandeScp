"""Test-suite configuration for the Spray Plan A1 backend.

Reserved for shared session-level fixtures. Tests currently inherit from
``frappe.tests.utils.FrappeTestCase`` which handles per-test transaction
rollback; if a future test file needs additional setup (custom warehouses,
sample BOMs, etc.) factor it out here rather than copy-pasting into each
test module.
"""
