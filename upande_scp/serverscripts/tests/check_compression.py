"""Post-deploy check: is response compression actually active?

    bench --site <site> execute upande_scp.serverscripts.tests.check_compression.run

Run this after every deploy to a new server. nginx's default ``gzip_types`` is
``text/html`` ONLY, so a host that ships ``gzip on;`` with the rest of the block
commented out — which is the Debian/Ubuntu default — sends every JSON API
response uncompressed while looking correctly configured.

Measured cost of getting this wrong on kaitet.local: a full ``/scp_app`` page
load is 61.2 MB uncompressed and 5.48 MB compressed. An 11.2x regression that
produces no error, no log line, and no failing test — only a slow site.

This check hits the running site over HTTP and asserts the response carries
``Content-Encoding: gzip``. It exits non-zero when it does not, so it can gate
a deployment pipeline.

See ``deploy/nginx/scp-compression.conf`` for the config this verifies.
"""

import json
import ssl
import urllib.error
import urllib.request

import frappe

# Must exceed nginx's gzip_min_length (1024) or the response is legitimately
# skipped and the check would report a false failure.
_MIN_BODY = 1024


def _site_url(base_url=None) -> str:
    """Resolve the URL to probe.

    ``frappe.utils.get_url()`` returns the site name (e.g. ``http://kaitet.local``),
    which is frequently not resolvable from the server itself. Pass ``base_url``
    explicitly on any host where that is true:

        bench --site <site> execute \\
            upande_scp.serverscripts.tests.check_compression.run \\
            --kwargs '{"base_url": "https://scp.example.com"}'
    """
    return (base_url or frappe.utils.get_url()).rstrip("/")


def _probe(path: str, base_url=None):
    """Return (status, content_encoding, length) for a GET with gzip offered.

    Returns status 0 when the host is unreachable — the caller reports that as
    "cannot verify" rather than as "compression is broken", because the two
    need very different responses from whoever is deploying.
    """
    url = f"{_site_url(base_url)}{path}"
    req = urllib.request.Request(
        url, headers={"Accept-Encoding": "gzip, deflate"}, method="GET"
    )
    # Deploy hosts routinely use self-signed or internal certs; this check is a
    # configuration probe, not a security boundary.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        # nosemgrep: URL is this site's own configured address
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            return resp.status, (resp.headers.get("Content-Encoding") or ""), len(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, (e.headers.get("Content-Encoding") or ""), 0
    except (urllib.error.URLError, OSError) as e:
        print(f"  could not reach {url}: {e}")
        return 0, "", 0


def _largest_asset() -> str | None:
    """A built JS bundle path, or None. Unauthenticated and comfortably >1 KB.

    This is the discriminating probe. Under nginx's DEFAULT config
    (``gzip_types text/html``) a JavaScript asset is served uncompressed, so
    seeing it gzipped proves the shipped gzip_types list is installed — and
    that list is a single shared directive, so application/json is covered by
    the same configuration.
    """
    import pathlib

    dist = pathlib.Path(frappe.get_site_path("..", "assets", "upande_scp", "dist"))
    try:
        js = sorted(dist.glob("*.js"), key=lambda p: p.stat().st_size, reverse=True)
    except OSError:
        return None
    for p in js:
        if p.stat().st_size > _MIN_BODY:
            return f"/assets/upande_scp/dist/{p.name}"
    return None


def run(base_url=None):
    """Assert response compression is active. Raises SystemExit if not.

    ``base_url`` overrides the probed host — required wherever the site name
    is not resolvable from the server itself.

    Exit codes: 0 pass, 1 compression is off, 2 could not verify.
    """
    asset = _largest_asset()
    if not asset:
        print(
            "CANNOT VERIFY: no built JS asset found under assets/upande_scp/dist. "
            "Run `bench build --app upande_scp` first."
        )
        raise SystemExit(2)

    status, enc, size = _probe(asset, base_url)
    if status == 0:
        print(
            "\nCANNOT VERIFY: the site was unreachable from this host. Re-run "
            "with an explicit URL, e.g.\n"
            "  bench --site <site> execute "
            "upande_scp.serverscripts.tests.check_compression.run \\\n"
            "    --kwargs '{\"base_url\": \"https://scp.example.com\"}'"
        )
        raise SystemExit(2)
    if status != 200:
        print(f"CANNOT VERIFY: {asset} returned HTTP {status}, expected 200.")
        raise SystemExit(2)

    compressed = "gzip" in enc or "br" in enc
    print(f"  {asset}")
    print(f"    HTTP {status}  Content-Encoding: {enc or 'NONE'}  body {size} B")

    # Secondary, informational: the JSON API. Usually 403 for an unauthenticated
    # probe, and a 403 body is under gzip_min_length, so it can neither pass nor
    # fail the check — it is reported, never asserted on.
    j_status, j_enc, j_size = _probe(
        "/api/method/upande_scp.serverscripts.scouting"
        ".observation_colors.get_observation_colors",
        base_url,
    )
    note = ""
    if j_status == 403 or j_size < _MIN_BODY:
        note = "  (too small / auth-gated to be conclusive — informational only)"
    print(f"  application/json probe: HTTP {j_status}  "
          f"Content-Encoding: {j_enc or 'NONE'}  body {j_size} B{note}")

    if not compressed:
        print(
            "\nCOMPRESSION CHECK FAILED\n"
            "  A JavaScript asset came back uncompressed, which means nginx is "
            "using its default `gzip_types text/html` — so every JSON API "
            "response is being sent raw too.\n"
            "  Fix: install deploy/nginx/scp-compression.conf into "
            "/etc/nginx/conf.d/, then `nginx -t && systemctl reload nginx`.\n"
            "  Measured impact of leaving this broken: a full /scp_app page load "
            "is 61.2 MB instead of 5.48 MB."
        )
        raise SystemExit(1)

    print("check_compression: passed")
