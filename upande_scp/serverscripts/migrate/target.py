"""Talking to another Frappe site over its REST API.

Used to seed a training or testing site from this one. Reading is done locally
through bench (this database is authoritative); only writes go over the wire.

## Credentials

Read from a file outside the repository — `~/.scp_migrate_env` by default, or
wherever `SCP_MIGRATE_ENV` points:

    SCP_TARGET_URL=https://training.example
    SCP_API_KEY=xxxx
    SCP_API_SECRET=yyyy
    SCP_TARGET_HOST=          # optional; see below

They are never echoed, never written into the repo, and never placed on a command
line, where they would land in shell history and in `ps` output for every other
user on the box. `describe()` exists so a run can say which site it is talking to
without printing the token.

`SCP_TARGET_HOST` sets the `Host` header independently of the URL. Only needed to
reach a bench whose site name does not resolve in DNS — point the URL at
`http://127.0.0.1:8000` and the host at `thesite.local`. A real target with real
DNS never needs it.

Frappe issues **one key pair per User**, so regenerating it invalidates that key
everywhere. Prefer a throwaway user for the migration and disable it afterwards;
revoking a shared user's key breaks whatever else was using it.
"""

from __future__ import annotations

import json
import os
from urllib.parse import urlparse

import requests

DEFAULT_ENV_FILE = "~/.scp_migrate_env"
TIMEOUT = 60


class TargetError(RuntimeError):
	pass


def _load_env_file(path):
	"""Parse a simple KEY=value file. Missing file is not an error — the values
	may come from the real environment instead."""
	out = {}
	full = os.path.expanduser(path)
	if not os.path.isfile(full):
		return out
	mode = os.stat(full).st_mode & 0o777
	if mode & 0o077:
		# Readable by others. Say so once rather than silently accepting it.
		print(
			f"warning: {path} is mode {mode:o}; `chmod 600` it — "
			"the secret is readable by other users on this machine"
		)
	for line in open(full):
		line = line.strip()
		if not line or line.startswith("#") or "=" not in line:
			continue
		k, v = line.split("=", 1)
		out[k.strip()] = v.strip().strip("'\"")
	return out


class Target:
	"""A Frappe site we can read from and write to over REST."""

	def __init__(self, url=None, key=None, secret=None, env_file=None):
		env = _load_env_file(env_file or os.environ.get("SCP_MIGRATE_ENV", DEFAULT_ENV_FILE))

		def pick(name, given):
			return given or os.environ.get(name) or env.get(name)

		self.url = (pick("SCP_TARGET_URL", url) or "").rstrip("/")
		self._key = pick("SCP_API_KEY", key)
		self._secret = pick("SCP_API_SECRET", secret)
		self._host = pick("SCP_TARGET_HOST", None)

		missing = [
			n
			for n, v in (
				("SCP_TARGET_URL", self.url),
				("SCP_API_KEY", self._key),
				("SCP_API_SECRET", self._secret),
			)
			if not v
		]
		if missing:
			raise TargetError(
				f"missing {', '.join(missing)} — put them in {env_file or DEFAULT_ENV_FILE} "
				"or the environment"
			)

		self.session = requests.Session()
		headers = {
			"Authorization": f"token {self._key}:{self._secret}",
			"Accept": "application/json",
			"Content-Type": "application/json",
		}
		if self._host:
			# Frappe picks the site from the Host header, so this is what makes a
			# bench reachable at an IP serve the right site.
			headers["Host"] = self._host
		self.session.headers.update(headers)

	def describe(self):
		"""Which site, safe to print. Never includes the token."""
		host = self._host or urlparse(self.url).netloc or self.url
		return f"{host} (key {self._key[:4]}…)"

	# ---------------------------------------------------------------- requests

	def _request(self, method, path, **kw):
		try:
			r = self.session.request(method, f"{self.url}{path}", timeout=TIMEOUT, **kw)
		except requests.RequestException as e:
			raise TargetError(f"{method} {path}: {e}") from None
		return r

	def whoami(self):
		"""The user the key belongs to. Also the auth smoke test."""
		r = self._request("GET", "/api/method/frappe.auth.get_logged_user")
		if r.status_code == 401:
			raise TargetError("the key was rejected (401) — wrong key/secret, or the user is disabled")
		if r.status_code == 403:
			raise TargetError("authenticated, but forbidden (403) — the user lacks API access")
		if not r.ok:
			raise TargetError(f"auth check failed: HTTP {r.status_code} {r.text[:200]}")
		return r.json().get("message")

	def probe(self, doctype, filters=None):
		"""`(state, count)` for one doctype, where state is one of:

		    "ok"        — readable; count is the row count
		    "forbidden" — it exists, but this key's user cannot read it
		    "missing"   — no such doctype on the target
		    "error"     — something else; count is the message

		Keeping these apart matters. A 403 and a 404 look the same to a naive
		check, but "the app is not installed" and "the API user needs another
		role" are completely different problems with completely different fixes —
		and the second is the one you actually hit, because a fresh key usually
		lands on a user with fewer roles than the person who made it.
		"""
		params = {"doctype": doctype}
		if filters:
			import json as _json

			params["filters"] = _json.dumps(filters)
		r = self._request("GET", "/api/method/frappe.client.get_count", params=params)

		if r.ok:
			try:
				return "ok", int(r.json().get("message") or 0)
			except (ValueError, TypeError):
				return "error", "count was not a number"

		if r.status_code == 403:
			# Could be a permission problem OR a doctype that genuinely is not
			# there — Frappe answers 403 for both in some versions. Ask the
			# DocType registry to tell them apart.
			return ("forbidden", None) if self._doctype_in_registry(doctype) else ("missing", None)
		if r.status_code == 404:
			return "missing", None
		return "error", _explain(r)

	def _doctype_in_registry(self, doctype):
		"""Is there a DocType record by this name? Read through get_count, which
		needs only DocType read — something every authenticated user has."""
		import json as _json

		r = self._request(
			"GET",
			"/api/method/frappe.client.get_count",
			params={"doctype": "DocType", "filters": _json.dumps([["name", "=", doctype]])},
		)
		if not r.ok:
			return False
		try:
			return int(r.json().get("message") or 0) > 0
		except (ValueError, TypeError):
			return False

	def doctype_exists(self, doctype):
		return self.probe(doctype)[0] != "missing"

	def count(self, doctype, filters=None):
		"""Row count, or None when it is missing or not readable."""
		state, value = self.probe(doctype, filters)
		return value if state == "ok" else None

	def get_list(self, doctype, fields=None, filters=None, limit=0):
		import json as _json

		params = {
			"fields": _json.dumps(fields or ["name"]),
			"limit_page_length": limit,
		}
		if filters:
			params["filters"] = _json.dumps(filters)
		r = self._request("GET", f"/api/resource/{requests.utils.quote(doctype)}", params=params)
		if not r.ok:
			raise TargetError(f"listing {doctype}: HTTP {r.status_code} {r.text[:200]}")
		return r.json().get("data") or []

	def names(self, doctype):
		"""Every document name, as a set. Used to make the push idempotent."""
		return {r["name"] for r in self.get_list(doctype, ["name"])}

	def insert(self, doctype, payload):
		"""Create one document. Returns (ok, name_or_error).

		A payload that cannot be serialised is reported as this record's failure
		rather than raised: the encoder error for a single stray `date` once took
		down a run of 400 documents partway through.
		"""
		try:
			body = json.dumps(payload)
		except (TypeError, ValueError) as e:
			return False, f"payload could not be serialised: {e}"
		r = self._request(
			"POST",
			f"/api/resource/{requests.utils.quote(doctype)}",
			data=body,
		)
		if r.ok:
			return True, (r.json().get("data") or {}).get("name")
		return False, _explain(r)

	def submit(self, doctype, name):
		"""Submit an already-inserted document. Returns (ok, error_or_None).

		Calls the document's own `submit` through `run_doc_method`, which acts on
		the stored record by name. The tempting alternative — posting the whole doc
		to `frappe.client.submit` — builds a *new* in-memory document from the
		payload, so a name that already exists risks a second insert rather than a
		submit.

		A plain insert always lands as a draft: Frappe forces docstatus 0 on
		`insert()`, so `docstatus: 1` in the payload is silently ignored. Without
		this step every Animal, Herd and BOM arrives unsubmitted and drops out of
		anything filtering on submitted.
		"""
		r = self._request(
			"POST",
			"/api/method/run_doc_method",
			json={"dt": doctype, "dn": name, "method": "submit"},
		)
		if r.ok:
			return True, None
		return False, _explain(r)

	def cancel(self, doctype, name):
		"""Cancel a submitted document. Returns (ok, error_or_None)."""
		r = self._request(
			"POST",
			"/api/method/run_doc_method",
			json={"dt": doctype, "dn": name, "method": "cancel"},
		)
		return (True, None) if r.ok else (False, _explain(r))

	def delete(self, doctype, name):
		"""Delete a document. Returns (ok, error_or_None)."""
		r = self._request(
			"DELETE",
			f"/api/resource/{requests.utils.quote(doctype)}/{requests.utils.quote(name)}",
		)
		return (True, None) if r.ok else (False, _explain(r))

	def docstatus(self, doctype, name):
		"""Stored docstatus, or None if it cannot be read. Used to verify a submit
		rather than trusting the response."""
		rows = self.get_list(doctype, ["name", "docstatus"], [["name", "=", name]])
		return rows[0].get("docstatus") if rows else None


def _explain(response):
	"""Frappe's error bodies are JSON-in-JSON; dig out something readable."""
	import json as _json

	try:
		body = response.json()
	except ValueError:
		return f"HTTP {response.status_code} {response.text[:200]}"

	for key in ("_server_messages", "exception", "message"):
		val = body.get(key)
		if not val:
			continue
		if key == "_server_messages":
			try:
				msgs = [_json.loads(m).get("message", m) for m in _json.loads(val)]
				return f"HTTP {response.status_code}: " + "; ".join(str(m) for m in msgs)
			except (ValueError, TypeError, AttributeError):
				pass
		return f"HTTP {response.status_code}: {str(val)[:300]}"
	return f"HTTP {response.status_code} {str(body)[:200]}"
