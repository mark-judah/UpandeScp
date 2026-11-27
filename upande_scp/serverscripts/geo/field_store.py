"""A durable copy of the field-geometry payloads (block index, per-block lattices), on disk.

Redis is the hot copy, but Redis is a cache: ``bench clear-cache``, a restart with ``save ""``
or LRU eviction empties it, and rebuilding Mutara's ~400k triangles from the Triad table is
tens of seconds of Python (the lattice) plus a full-table GROUP BY (the index). The payloads
only change when the geometry does, and each is keyed by the data version
(``field_geo._version``), so a copy written once stays valid until the next regenerate: a cold
Redis then costs a few small file reads instead of a rebuild.

Files live in ``sites/<site>/private/scp_geo_cache/<kind>-<version>-<hash of key>.json``,
written atomically (temp file + rename) so concurrent workers never read a half-written one.
Old versions are pruned by ``prune`` (called from the warm job).
"""

import hashlib
import json
import os
import re
import time

import frappe

DIR_NAME = "scp_geo_cache"
PRUNE_AFTER_SEC = 24 * 3600  # files of another version older than this are removed
_SAFE = re.compile(r"[^A-Za-z0-9_.]")


def store_dir() -> str:
	return frappe.get_site_path("private", DIR_NAME)


def _path(kind: str, version: str, key: str) -> str:
	h = hashlib.sha1((key or "").encode()).hexdigest()[:20]
	return os.path.join(store_dir(), f"{_SAFE.sub('_', kind)}-{_SAFE.sub('_', version or '')}-{h}.json")


def get(kind: str, version: str, key: str):
	"""The stored value, or None when there is none (or it cannot be read)."""
	if not version:
		return None
	try:
		with open(_path(kind, version, key), encoding="utf-8") as f:
			return json.load(f)
	except (OSError, ValueError):
		return None


def put(kind: str, version: str, key: str, value) -> None:
	"""Store ``value`` (JSON-able). Best effort: a read-only disk only loses the durable copy."""
	if not version:
		return
	path = _path(kind, version, key)
	tmp = f"{path}.{os.getpid()}.{time.monotonic_ns()}.tmp"
	try:
		os.makedirs(os.path.dirname(path), exist_ok=True)
		with open(tmp, "w", encoding="utf-8") as f:
			json.dump(value, f, separators=(",", ":"))
		os.replace(tmp, path)
	except OSError:
		try:
			os.remove(tmp)
		except OSError:
			pass


def prune(keep_versions, older_than_sec: int = PRUNE_AFTER_SEC) -> int:
	"""Remove files whose version is not in ``keep_versions`` and that are older than
	``older_than_sec`` (another worker may still be serving a just-replaced version)."""
	keep = {v for v in keep_versions if v}
	d = store_dir()
	try:
		names = os.listdir(d)
	except OSError:
		return 0
	now, n = time.time(), 0
	for name in names:
		parts = name.split("-")
		path = os.path.join(d, name)
		try:
			if len(parts) >= 3 and parts[1] in keep and not name.endswith(".tmp"):
				continue
			if now - os.path.getmtime(path) < older_than_sec:
				continue
			os.remove(path)
			n += 1
		except OSError:
			pass
	return n
