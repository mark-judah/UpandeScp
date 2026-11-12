# SCP IT monitor (interim, until upande_mobile can be deployed)

## Why
`upande_mobile` (device register, crash/API events, issues, IT dashboard in upande_core) needs a
public repo / GitHub Pages and is not deployable on live kaitet. SCP carries its own, smaller copy
so the IT team can see every phone now. Field names and payload shapes follow upande_mobile
(`api/devices.register_install`, `api/monitor.ingest`, doctypes Mobile App Install / Mobile Event)
so a later move to upande_mobile is a copy, not a redesign.

## Role
`SCP IT` (new). Opens the IT monitor page and reads the SCP Mobile doctypes. System Manager and
SCP General Manager also see it. Created by a patch (idempotent), like the other SCP roles.

## Doctypes (module Upande Scp)
### SCP Mobile Device (autoname: field:install_id)
Mirror of Mobile App Install, plus SCP extras.
- install_id (Data, unique), user (Link User), employee (Link Employee, from user), farm (Link Farm),
  app_role (Data: scout/chemical/sprayer/store), status (Select: Current/Behind/Dormant/Unknown)
- platform, device_brand, device_model, device_name, os_version, is_physical_device (Check)
- app_version, runtime_version, update_id, channel, build_type,
  previous_app_version, version_changed_at
- first_seen, last_seen, last_login_at, launches (Int), ip_address
- battery_level (Float 0..1), battery_state (Data), low_power (Check),
  storage_free_bytes, storage_total_bytes (Long Int), memory_total_bytes (Long Int),
  network_type, connectivity (Data), clock_skew_seconds (Int)
- last_sync_at, last_sync_ok_at (Datetime), last_sync_error (Small Text)
- pending_total (Int), stuck_total (Int), oldest_pending_at (Datetime)
- queues (JSON: see payload), device_snapshot (JSON: last device_info), it_notes (Small Text)

### SCP Mobile Event (autoname hash; index on install_id, ts, kind, fingerprint)
Mirror of Mobile Event: event_id (unique per install), install_id, device (Link SCP Mobile Device),
user, kind (Select: crash/error/api_error/login/logout/sync/warning), level (Select: fatal/error/warning/info),
ts, received_at, message, error_name, stack (Long Text), fatal (Check), count (Int), screen,
app_version, runtime_version, update_id, req_method, req_url, req_status (Int), req_duration_ms (Int),
req_error, fingerprint (Data: sha1 of kind|error_name|first stack frame|req path), extra (JSON).

Retention: daily job deletes events older than 60 days (setting `it_event_retention_days`, default 60).

## Endpoints (all POST, logged-in user; never refuse over a bad field — clip, coerce, ignore)
`upande_scp.serverscripts.it_monitor.ingest.register_device(payload)`
payload (JSON object or string):
```
{ install_id, platform, device_brand, device_model, device_name, os_version, is_physical_device,
  app_version, runtime_version, update_id, channel, build_type,
  reason: "launch"|"foreground"|"login"|"heartbeat"|"sync",  login: bool, app_role, farm,
  device_info: { battery_level, battery_state, low_power, storage_free_bytes, storage_total_bytes,
                 memory_total_bytes, network_type, is_connected, is_internet_reachable,
                 locale, timezone },
  clock_skew_seconds,
  last_sync_at, last_sync_ok_at, last_sync_error,
  queues: { <name>: { pending, failed, held, refused, oldest_at } }
          names: scouting, pest_images, spray_sessions, sprayer_gps, traps, team_journal, other
}
```
Returns `{ install_id, status, latest_app_version, server_time }`.
`stuck` = failed + held + refused + items pending older than 30 minutes (computed server side from
queues; phone sends counts and oldest_at).

`upande_scp.serverscripts.it_monitor.ingest.report_events(install_id, events)`
events: list (max 200 per call) of
`{ event_id, kind, level, ts (ISO UTC), message, error_name, stack, fatal, screen, count,
   req_method, req_url, req_status, req_duration_ms, req_error, extra }`.
Dedupe on (install_id, event_id). Returns `{ accepted, duplicates }`.

## Dashboard API (GET, SCP IT / System Manager / SCP General Manager)
module `upande_scp.serverscripts.it_monitor.dashboard`
- `overview(days=7, farm=None)` → `{ devices: {total, active_24h, behind, dormant, low_battery, low_storage,
   with_stuck}, versions: [{app_version, runtime_version, devices}], latest_app_version,
   errors: {events, issues, crashes}, logins_today, stuck_by_queue: {name: count} }`
- `devices(farm=None, status=None, search=None, stuck_only=0, limit=500)` → rows of SCP Mobile Device
   (+ user full name, employee name, farm)
- `device(install_id)` → device row + last 200 events + queues + snapshot
- `issues(days=7, kind=None)` → grouped by fingerprint: `{fingerprint, kind, title, events, users, devices,
   first_seen, last_seen, last_version}`
- `logins(days=7, farm=None)` → from Activity Log (Login/Logout, status) joined to device login events
   (which device/app version), failed logins included
- `data_flow(days=7, farm=None)` → server-side per day: scouting entries per scout, pest photos,
   CSU scans, spray sessions by token status (Synced/Held/Partial/Refused), plus device-reported
   pending/stuck per queue

"Latest" app version = setting `it_latest_app_version` if set, else the highest app_version seen
in the last 14 days on the same runtime. Status: Behind if app_version < latest; Dormant if
last_seen older than 7 days; Unknown if no version.

## Phone (Scout RN, branch kaitet-sdk58)
`src/services/telemetry/` — collects with expo-device, expo-battery, expo-file-system
(getFreeDiskStorageAsync/getTotalDiskCapacityAsync), NetInfo, expo-updates (updateId, channel,
runtimeVersion), expo-application (version, build). Sends register_device on launch, foreground,
login, after each sync pass, and every 15 min while online. Events: global JS error handler,
axios interceptor for API failures (status >= 400 or network error, URL path only, no bodies or
tokens), login/logout, sync results. Events buffered on the phone (cap 500, oldest dropped) and
sent in batches when online. Never blocks the UI, never throws. Queue counts read from the
existing local DBs (submissionQueue, pestImageQueue, spraySessionDb, locationDb, traps, team journal).
Redact: no passwords, tokens, API keys, cookies; request bodies never sent.

## Web (SCP React app)
Page "IT monitor" (route `#/it`), own sidebar section shown to SCP IT / System Manager / SCP General
Manager. Tabs: Overview (tiles + versions chart + stuck by queue), Devices (table with battery,
storage, version vs latest, last seen, stuck, filter pills, PlacePicker farm filter), Device drawer
(snapshot, queues, event timeline), Errors (grouped issues → events), Logins, Data flow
(per-day charts per scout / queue). Follow existing design rules: FilterSelect pills, PageToolbar,
skeletons, no coloured left-border strips.

## Exact response shapes (as built by the backend; the phone and web code against these)
All dashboard endpoints are GET and return the value directly under `message` (Frappe's usual wrapper).
Datetimes are site-time `YYYY-MM-DD HH:MM:SS` strings; dates `YYYY-MM-DD`. Status is computed live on read.

- `devices(...)` -> list of rows: `install_id, user, user_full_name, employee, employee_name, farm, app_role,
  status, platform, device_brand, device_model, device_name, os_version, is_physical_device, app_version,
  runtime_version, update_id, channel, build_type, previous_app_version, version_changed_at, first_seen,
  last_seen, last_login_at, launches, ip_address, battery_level, battery_state, low_power, storage_free_bytes,
  storage_total_bytes, memory_total_bytes, network_type, connectivity, clock_skew_seconds, last_sync_at,
  last_sync_ok_at, last_sync_error, pending_total, stuck_total, oldest_pending_at, it_notes,
  queues: {name: {pending, failed, held, refused, oldest_at, stuck}},
  flags: ["low_battery"|"low_storage"|"offline"|"stuck", ...]`
- `device(install_id)` -> `{device: <row above>, events: [last 200, newest first: name, event_id, kind, level,
  ts, received_at, user, message, error_name, stack, fatal, count, screen, app_version, runtime_version,
  update_id, req_method, req_url, req_status, req_duration_ms, req_error, fingerprint, extra(object|null)],
  queues: {...}, snapshot: {battery_level, battery_state, low_power, storage_*, memory_total_bytes,
  network_type, is_connected, is_internet_reachable, locale, timezone}, latest_app_version}`
- `issues(days, kind)` -> list `{fingerprint, kind, level, title, events (sum of count), users, devices,
  first_seen, last_seen, last_version}`, newest first. `kind` filters to one of crash/error/api_error/warning;
  login/logout/sync events are never issues. To list one issue's events the web reads Frappe's list API on
  `SCP Mobile Event` filtered by `fingerprint` (SCP IT has read).
- `logins(days, farm)` -> `{days, summary: {success, failed, logouts}, rows: [{ts, user, user_full_name,
  operation: Login|Logout, status: Success|Failed, ip_address, subject, source: server|device, install_id,
  app_version, device_model, farm}]}`; device fields are null when no phone event matched within 5 minutes.
- `data_flow(days, farm)` -> `{from_date, to_date, daily: [{date, scouting_entries, scouts, pest_photos,
  csu_scans, spray_pending, spray_synced, spray_held, spray_partial, spray_refused}] (every day, zero-filled),
  scouting_by_scout: [{date, scout, scout_name, entries}], device_queues: {name: {pending, failed, held,
  refused, stuck, devices}}}`. Pest photos = Scouting Entry Photo rows by entry date; CSU scans = Work Order
  Chemical Scan rows by scanned_at; spray sessions = Spray Session Token by creation date (status "Held ..."
  variants fold into held).
- `register_device` stores `queues` as `{name: {pending, failed, held, refused, oldest_at, stuck}}`
  (stuck per queue computed server side; unknown queue names fold into `other`).
- Fingerprint deviation: an `api_error` fingerprint also keys on method + status, and an event with neither a
  stack frame nor a request path keys on its normalised message.
- `req_url` is stored as a path only (host and query string are dropped on the server).
- Dashboard roles: SCP IT, System Manager, SCP General Manager all see every farm (no farm scoping beyond the
  optional `farm` filter).
