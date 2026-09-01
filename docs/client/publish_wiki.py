#!/usr/bin/env python3
"""Publish a book of client documentation to a Frappe Wiki 3.0 space.

Wiki 3.0 does not store content in the legacy `Wiki Page` doctype. Content is a
nested-set tree of `Wiki Document` rows, versioned git-style by `Wiki Revision`,
and the ONLY supported way to write it is a Change Request:

    create_change_request  ->  apply_cr_operations  ->  submit  ->  approve  ->  merge

Writing `Wiki Document` rows directly leaves the revision hashes stale and
`main_revision` unmoved, so the pages exist in the table but never render. Hence
this script drives the CR flow instead.

IDEMPOTENT BY ROUTE. Every run opens a fresh CR, diffs the desired pages against
the tree that CR inherits from `main`, and emits `create_node` for routes that do
not exist yet and `update_content` for the ones that do. Re-running after editing
markdown updates the pages in place; it never duplicates them. The whole batch is
one transaction server-side, so a failure half way leaves nothing behind.

SOURCE FORMAT. One directory per book. `index.md` becomes the book's group node;
every other `*.md` becomes a page under it. Each file carries YAML front matter:

    ---
    title: Feeding
    route: livestock/using/feeding
    order: 7
    ---

`order` sets the sidebar position. Relative links between the files
(`](06-feeding.md)`) are rewritten to absolute wiki routes on the way up.

USAGE
    python3 publish_wiki.py --source <dir> --space-route livestock \
                            --space-name Livestock [--dry-run] [--no-merge]

Credentials come from ~/.scp_migrate_wiki_env (WIKI_URL / WIKI_API_KEY /
WIKI_API_SECRET). Nothing is ever printed that would disclose them.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ENV_FILE = os.path.expanduser("~/.scp_migrate_wiki_env")


# ---------------------------------------------------------------------------
# credentials + transport
# ---------------------------------------------------------------------------


def load_env(path: str = ENV_FILE) -> dict:
    """Read the shell-style env file. Tolerates `export`, quotes and a BOM."""
    if not os.path.exists(path):
        sys.exit(f"No credentials file at {path}")
    env = {}
    with open(path, encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):]
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    missing = [k for k in ("WIKI_URL", "WIKI_API_KEY", "WIKI_API_SECRET") if not env.get(k)]
    if missing:
        sys.exit(f"{path} is missing: {', '.join(missing)}")
    env["WIKI_URL"] = env["WIKI_URL"].rstrip("/")
    return env


class Site:
    def __init__(self, env: dict):
        self.url = env["WIKI_URL"]
        self.auth = f"token {env['WIKI_API_KEY']}:{env['WIKI_API_SECRET']}"

    def _request(self, path: str, payload=None, method="GET"):
        url = f"{self.url}{path}"
        data = None
        headers = {"Authorization": self.auth, "Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode(errors="replace")
            # Frappe puts the useful line in `exception`; the traceback is noise.
            try:
                parsed = json.loads(body)
                detail = parsed.get("exception") or parsed.get("message") or body
            except ValueError:
                detail = body
            sys.exit(f"\n{method} {path} failed ({exc.code}):\n  {str(detail)[:600]}")

    def call(self, method: str, **kwargs):
        """Invoke a whitelisted method, returning its `message`."""
        return self._request(f"/api/method/{method}", payload=kwargs, method="POST").get("message")

    def get_list(self, doctype: str, filters=None, fields=("name",)):
        qs = urllib.parse.urlencode(
            {
                "filters": json.dumps(filters or []),
                "fields": json.dumps(list(fields)),
                "limit_page_length": 0,
            }
        )
        dt = urllib.parse.quote(doctype)
        return self._request(f"/api/resource/{dt}?{qs}").get("data", [])

    def insert(self, doctype: str, doc: dict):
        dt = urllib.parse.quote(doctype)
        return self._request(f"/api/resource/{dt}", payload=doc, method="POST").get("data")


# ---------------------------------------------------------------------------
# source files
# ---------------------------------------------------------------------------

FRONT_MATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)


def parse_page(path: str) -> dict:
    """Split a markdown file into front matter and body."""
    raw = open(path, encoding="utf-8").read()
    match = FRONT_MATTER.match(raw)
    if not match:
        sys.exit(f"{path} has no front matter (need title and route)")
    meta = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        meta[key.strip()] = value.strip().strip('"').strip("'")
    for required in ("title", "route"):
        if not meta.get(required):
            sys.exit(f"{path} front matter is missing `{required}`")
    return {
        "file": os.path.basename(path),
        "title": meta["title"],
        "route": meta["route"].strip("/"),
        "order": int(meta.get("order") or 0),
        "content": raw[match.end():].lstrip("\n"),
    }


def collect(source: str) -> tuple[dict, list]:
    """Return (index page, chapter pages sorted by `order`)."""
    files = sorted(f for f in os.listdir(source) if f.endswith(".md"))
    if not files:
        sys.exit(f"No .md files in {source}")
    pages = [parse_page(os.path.join(source, f)) for f in files]
    index = next((p for p in pages if p["file"] == "index.md"), None)
    if not index:
        sys.exit(f"{source} has no index.md — it becomes the book's group node")
    chapters = sorted((p for p in pages if p is not index), key=lambda p: (p["order"], p["file"]))
    return index, chapters


def rewrite_links(pages: list) -> None:
    """Point relative file links at wiki routes.

    `](03-animals-and-herds.md#where-calves-go)` only resolves on disk. On the
    site the same link has to be an absolute route, so it is rewritten in place
    before anything is uploaded. Files the book does not contain are left alone
    rather than guessed at.
    """
    by_file = {p["file"]: p["route"] for p in pages}
    pattern = re.compile(r"\]\((?!https?://|/)([^)#\s]+\.md)(#[^)\s]*)?\)")

    def replace(match):
        target, anchor = match.group(1), match.group(2) or ""
        route = by_file.get(os.path.basename(target))
        return f"]({'/' + route if route else target}{anchor})"

    for page in pages:
        page["content"] = pattern.sub(replace, page["content"])


# ---------------------------------------------------------------------------
# the space
# ---------------------------------------------------------------------------


def ensure_space(site: Site, route: str, name: str, dry_run: bool) -> str:
    existing = site.get_list("Wiki Space", [["route", "=", route]], ["name", "space_name", "route"])
    if existing:
        print(f"  space   found   {existing[0]['space_name']!r} at /{route} ({existing[0]['name']})")
        return existing[0]["name"]
    if dry_run:
        print(f"  space   CREATE  {name!r} at /{route}")
        return "<new-space>"
    # `before_insert` builds the root group Wiki Document; `create_change_request`
    # seeds main_revision. Nothing else needs setting up by hand.
    doc = site.insert(
        "Wiki Space",
        {
            "doctype": "Wiki Space",
            "space_name": name,
            "route": route,
            "is_published": 1,
            "show_in_switcher": 1,
            "allow_contributions": 1,
        },
    )
    print(f"  space   CREATED {name!r} at /{route} ({doc['name']})")
    return doc["name"]


# ---------------------------------------------------------------------------
# the change request
# ---------------------------------------------------------------------------


def flatten(nodes: list, out: dict) -> dict:
    """Map route -> node across the whole CR tree."""
    for node in nodes or []:
        if node.get("route"):
            out[node["route"].strip("/")] = node
        flatten(node.get("children"), out)
    return out


def build_operations(index: dict, chapters: list, existing: dict, root_key: str) -> list:
    """Emit create/update operations for the book.

    The index becomes a group node; the chapters hang off it in `order`. A route
    already in the tree is updated in place — which is what makes a re-run safe.
    """
    operations = []
    group = existing.get(index["route"])
    if group:
        group_key = group["doc_key"]
        operations.append(
            {
                "type": "update_content",
                "doc_key": group_key,
                "title": index["title"],
                "content": index["content"],
            }
        )
    else:
        group_key = "tmp:book"
        operations.append(
            {
                "type": "create_node",
                "temp_key": group_key,
                "parent_key": root_key,
                "title": index["title"],
                "route": index["route"],
                "slug": index["route"].rsplit("/", 1)[-1],
                "is_group": 1,
                "is_published": 1,
                "content": index["content"],
                "order_index": index["order"],
            }
        )

    for position, page in enumerate(chapters):
        node = existing.get(page["route"])
        if node:
            operations.append(
                {
                    "type": "update_content",
                    "doc_key": node["doc_key"],
                    "title": page["title"],
                    "content": page["content"],
                }
            )
        else:
            operations.append(
                {
                    "type": "create_node",
                    "temp_key": f"tmp:{position}",
                    "parent_key": group_key,
                    "title": page["title"],
                    "route": page["route"],
                    "slug": page["route"].rsplit("/", 1)[-1],
                    "is_group": 0,
                    "is_published": 1,
                    "content": page["content"],
                    "order_index": position,
                }
            )
    return operations


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True, help="directory of the book's .md files")
    parser.add_argument("--space-route", required=True, help="wiki space route, e.g. livestock")
    parser.add_argument("--space-name", help="space display name (defaults to the route, capitalised)")
    parser.add_argument("--title", help="change request title")
    parser.add_argument("--dry-run", action="store_true", help="show the plan, write nothing")
    parser.add_argument("--no-merge", action="store_true", help="leave the CR in Draft for review")
    args = parser.parse_args()

    source = os.path.abspath(args.source)
    index, chapters = collect(source)
    rewrite_links([index, *chapters])

    print(f"\nBook     {index['title']!r}  ({len(chapters) + 1} pages from {source})")
    site = Site(load_env())
    user = site.call("frappe.auth.get_logged_user")
    print(f"Site     {site.url}  as {user}\n")

    space = ensure_space(site, args.space_route.strip("/"), args.space_name or args.space_route.title(), args.dry_run)

    if args.dry_run:
        print("\n  would publish:")
        print(f"    [group] {index['route']}")
        for page in chapters:
            print(f"            {page['route']}")
        print("\n  dry run — nothing written.\n")
        return

    title = args.title or f"Publish: {index['title']}"
    cr = site.call("wiki.frappe_wiki.doctype.wiki_change_request.wiki_change_request.create_change_request",
                   wiki_space=space, title=title)
    cr_name = cr["name"] if isinstance(cr, dict) else cr
    print(f"  cr      opened  {cr_name}  {title!r}")

    tree = site.call("wiki.frappe_wiki.doctype.wiki_change_request.wiki_change_request.get_cr_tree", name=cr_name)
    existing = flatten(tree.get("children"), {})
    root_key = tree.get("root_group")
    operations = build_operations(index, chapters, existing, root_key)

    created = sum(1 for o in operations if o["type"] == "create_node")
    updated = len(operations) - created
    print(f"  plan    {created} new, {updated} updated")

    result = site.call(
        "wiki.frappe_wiki.doctype.wiki_change_request.wiki_change_request.apply_cr_operations",
        name=cr_name,
        base_version=tree.get("operation_version"),
        operations=operations,
    )
    if isinstance(result, dict) and result.get("ok") is False:
        sys.exit(f"  apply   FAILED  {result.get('message') or result.get('error')}")
    print(f"  apply   ok      {len(operations)} operations")

    if args.no_merge:
        print(f"\n  left in Draft for review: {site.url}/{args.space_route}\n")
        return

    base = "wiki.frappe_wiki.doctype.wiki_change_request.wiki_change_request"
    site.call(f"{base}.submit_change_request", name=cr_name)
    site.call(f"{base}.approve_change_request", name=cr_name)
    site.call(f"{base}.merge_change_request", name=cr_name)
    print("  merged  ok")
    print(f"\n  live at {site.url}/{index['route']}\n")


if __name__ == "__main__":
    main()
