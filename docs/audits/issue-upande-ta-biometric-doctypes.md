# Add Biometric Data, Employee Request, and Stock Entry custom fields for the upande_scp store-keeper flow

## Goal

Biometric and employee-assignment DocTypes for the SCP store-keeper transfer flow
should live in `upande_ta`, so that installing `upande_scp` requires only
`upande_ta`, `upande_core`, ERPNext, and Frappe. `upande_ta` already owns the
biometric device/log stack; this issue adds the two child DocTypes and the Stock
Entry custom fields SCP writes during transfer authorization.

## Already present - no change

`Biometric Logs` already exists in `upande_ta` with the fields SCP reads
(`employee`, `employee_name`, `biometric_id`, `time`, plus `log_type`). SCP reads
it read-only for live finger-scan verification. No change needed.

## Add: Employee Request - child table (istable = 1)

Used as the `custom_employee_data` child on Stock Entry (employee assignment for a
transfer). Fields SCP uses:
- `employee` (Link -> Employee)
- `employee_name` (Data)

## Add: Biometric Data - child table (istable = 1)

Used as the `custom_biometric_data` child on Stock Entry (written on
biometric-authorized submit). Fields SCP uses:
- `employee` (Link -> Employee)
- `employee_name` (Data)
- `biometric_id` (Data)

## Add: Stock Entry custom fields (ship as fixtures)

These bind the two child DocTypes into the Stock Entry transfer flow:
- `Stock Entry.custom_employee_data` (Table -> Employee Request)
- `Stock Entry.custom_biometric_data` (Table -> Biometric Data)
- `Stock Entry.custom_biometric_verified` (Check) - read by SCP after biometric submit

## Context

`upande_scp` will add `upande_ta` to its required apps. The store-keeper transfer
flow (`serverscripts/store_keeper_api.py`) reads and writes the above:
- `custom_employee_data` set/append and read (transfer assignment)
- `custom_biometric_data` append on `submit_with_biometric`
- `Biometric Logs` read for the latest live scan

## Acceptance criteria

- `upande_ta` provides `Employee Request` and `Biometric Data` with the fields above.
- `upande_ta` ships the three Stock Entry custom fields as fixtures.
- A clean install of `upande_ta` + `upande_core` + `upande_scp`, with only ERPNext
  and Frappe otherwise, runs the store-keeper transfer and biometric-submit flows
  end to end.
