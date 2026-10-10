"""One icon set (item 9b): the desk sprite and the Livestock notice icons are
generated from upande_scp/shared/icons. Pure — runs under plain pytest, no site."""

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from upande_scp import hooks

APP = Path(hooks.__file__).resolve().parent  # .../upande_scp/upande_scp
REPO = APP.parent
SHARED = APP / "shared" / "icons"
MANIFEST = json.loads((SHARED / "manifest.json").read_text())
LIVESTOCK_ICONS = REPO.parent / "upande_livestock" / "upande_livestock" / "public" / "icons"


def _asset_to_file(url):
	# "/assets/upande_scp/icons/x.svg" is served from upande_scp/public/icons/x.svg
	m = re.fullmatch(r"/assets/upande_scp/(.+)", url)
	assert m, f"{url} is not an upande_scp asset path"
	return APP / "public" / m.group(1)


def test_hook_points_at_the_generated_sprite():
	paths = hooks.app_include_icons
	assert isinstance(paths, list) and paths
	for url in paths:
		assert _asset_to_file(url).is_file(), url


def test_sprite_has_a_symbol_for_every_manifest_icon():
	sprite = _asset_to_file(hooks.app_include_icons[0]).read_text()
	ids = set(re.findall(r'<symbol id="([^"]+)"', sprite))
	want = {f"icon-scp-{i['category']}-{i['key']}" for i in MANIFEST["icons"].values()}
	assert want == ids


def test_stage_category_holds_the_ten_marker_shapes_and_the_default():
	stage = {i["key"] for i in MANIFEST["icons"].values() if i["category"] == "stage"}
	assert stage == {
		"circle", "triangle", "pentagon", "diamond", "cross",
		"plus", "square", "hexagon", "star", "chevron",
	}
	assert MANIFEST["defaultStageKey"] == "circle"


@pytest.mark.skipif(not LIVESTOCK_ICONS.is_dir(), reason="upande_livestock not beside upande_scp")
def test_livestock_notice_files_match_their_sources():
	sources = sorted((SHARED / "notice").glob("*.svg"))
	assert len(sources) == 8
	for src in sources:
		out = (LIVESTOCK_ICONS / src.name).read_text()
		body = re.sub(r"^<!--.*?-->\n", "", out, count=1, flags=re.S)
		assert body.strip() == src.read_text().strip(), src.name


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_generator_check_passes_on_committed_outputs():
	r = subprocess.run(
		["node", str(REPO / "scripts" / "build_icons.mjs"), "--check"],
		capture_output=True, text=True,
	)
	assert r.returncode == 0, r.stdout + r.stderr
