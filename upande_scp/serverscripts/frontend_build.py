"""Build the React frontend on every deploy.

The compiled SPA lives in ``upande_scp/public/dist/`` (hashed ``scp-<hash>.js``
plus ``.vite/manifest.json``), which ``www/scp_app/index.py`` reads to emit the
``<script>`` tag. That directory is **gitignored**, so ``git pull`` never ships
it, and Frappe's ``bench build`` only runs the *frappe* repo's esbuild bundler —
it does **not** run this app's Vite build. Without an explicit trigger the live
site keeps serving whatever ``dist`` was last built by hand, so freshly merged
pages (e.g. Approvals) never appear even though the source is deployed.

Hooking the Vite build into ``before_migrate`` fixes that: every deploy runs
``bench migrate``, so the bundle is rebuilt from the deployed source each time,
independent of Frappe version or who runs the deploy. On the standard bench
layout ``sites/assets/upande_scp`` is a symlink to this app's ``public/`` dir,
so the rebuilt ``dist`` is served immediately with no copy step.

Escape hatch: set ``UPANDE_SCP_SKIP_FRONTEND_BUILD=1`` to skip the build (useful
for fast local ``bench migrate`` runs where the dev server / a manual build
already owns ``dist``).
"""

import os
import shutil
import subprocess

import frappe


def _frontend_dir():
	# frappe.get_app_path → .../apps/upande_scp/upande_scp ; the Vite project
	# sits one level up at .../apps/upande_scp/frontend.
	app_root = os.path.dirname(frappe.get_app_path("upande_scp"))
	return os.path.join(app_root, "frontend")


def before_migrate():
	"""Hook target — rebuild the SPA so each deploy serves the latest UI."""
	if os.environ.get("UPANDE_SCP_SKIP_FRONTEND_BUILD"):
		print("upande_scp: UPANDE_SCP_SKIP_FRONTEND_BUILD set — skipping frontend build.")
		return

	frontend_dir = _frontend_dir()
	if not os.path.isdir(frontend_dir):
		print(f"upande_scp: no frontend dir at {frontend_dir} — skipping frontend build.")
		return

	npm = shutil.which("npm")
	if not npm:
		# Don't abort migrate just because this host has no Node toolchain
		# (e.g. a worker container). The site keeps serving the existing
		# bundle; the operator must build on a host that has npm.
		print(
			"upande_scp: npm not found on PATH — skipping frontend build. "
			"The site will keep serving the existing dist bundle."
		)
		return

	if not os.path.isdir(os.path.join(frontend_dir, "node_modules")):
		print("upande_scp: installing frontend deps (npm install)…")
		subprocess.run([npm, "install"], cwd=frontend_dir, check=True)

	print("upande_scp: building React frontend (npm run build)…")
	# check=True: a broken build must fail the deploy loudly rather than
	# silently leave the old bundle in place — that stale-bundle state is
	# exactly the bug this hook exists to prevent.
	subprocess.run([npm, "run", "build"], cwd=frontend_dir, check=True)
	print("upande_scp: frontend build complete → public/dist refreshed.")
