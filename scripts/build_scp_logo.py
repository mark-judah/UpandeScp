"""Generate the SCP mark's two SVGs from one description.

    python3 scripts/build_scp_logo.py

* ``public/images/scp_logo.svg`` — the desk tile. Drawn at rest it IS the
  original ``upande_logo.png`` (white disc, the Upande arrow at the same place
  and size on a 689 canvas), so the tile is the same size as before. The scene
  is in the file but hidden; ``public/js/scp_logo_motion.js`` inlines the file
  and plays it on hover, reading the keyframes from the ``<metadata>`` below.
* ``public/images/scp_logo_loader.svg`` — the splash loader: the same scene as a
  pure-CSS loop (the splash shows it through ``<img>``, where scripts never run).

THE SCENE (SCP's own, not the Webstore's): the arrow shrinks into the centre
of the disc and a leaf unfurls across the disc — one leaf, not a flower, because SCP
covers roses, avocado and coffee and the leaf is where scouts read both. It
carries disease lesions (brown with a yellow halo) and a pest. The scouting
round: a magnifier checks the lesions (an amber ring marks disease), then the
pest (a red ring), spray falls on the pest and it is gone, the lens moves on.
On the desk the leaf eases in on hover, the round loops while the pointer
stays, and on leave it all eases back out to the plain mark. The loader runs
in → round → out.

Keyframes are written once (``ENTER`` and ``LOOP``) and emitted both as CSS for
the loader and as JSON for the desk script.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "upande_scp" / "public" / "images"

# ── artwork (689 × 689, the PNG's own canvas) ───────────────────────────────

# The Upande arrow, from upande_mark.svg, placed where upande_logo.png has it
# (ink at x 169–528, y 165–529).
ARROW = """<g class="arrow">
    <g transform="translate(169 165)">
      <path fill="#625d59" d="M0 0 H272 V85 H0 Z"/>
      <path fill="#45433f" d="M272 0 H359 V364 H272 Z"/>
      <path fill="#1a1917" d="M246 85 H272 V161 L246 187 Z"/>
      <path fill="#45433f" d="M198 85 H246 V187 L69 364 H0 V283 Z"/>
    </g>
  </g>"""

# One leaf, not a flower: SCP covers roses, avocado and coffee, and a leaf is
# where scouts read both pests and disease. Drawn pointing up in its own
# coordinates (base at 0,250, tip at 0,-300), then laid on the disc tilted
# toward the top left so the arrow has the top right.
LEAF_AT = (330.0, 400.0)
LEAF_TILT = -36.0


def _on_leaf(x: float, y: float) -> tuple[float, float]:
    """A point in the leaf's own coordinates → the disc's."""
    t = math.radians(LEAF_TILT)
    return (
        round(LEAF_AT[0] + x * math.cos(t) - y * math.sin(t), 1),
        round(LEAF_AT[1] + x * math.sin(t) + y * math.cos(t), 1),
    )


PEST_LOCAL = (-58.0, 40.0)
SPOT_LOCAL = (62.0, -120.0)
PEST = _on_leaf(*PEST_LOCAL)
SPOT = _on_leaf(*SPOT_LOCAL)

INK = "#2b2a27"
LEAF_GREEN = "#5f7a52"
LESION = "#4a3526"
ACCENT = "#b4533c"  # the one accent: it marks what the scout has found
MIST = "#4f7a96"

px, py = PEST_LOCAL
sx, sy = SPOT_LOCAL

# A solid leaf silhouette (slightly asymmetric, drawn tip) with the veins cut
# out as negative space; lesions as small solid marks; the pest a solid insect
# (head, thorax, abdomen, six legs, antennae) with no face.
LEAF = f"""<g transform="translate({LEAF_AT[0]:g} {LEAF_AT[1]:g}) rotate({LEAF_TILT:g})">
    <g class="leaf">
      <path fill="{LEAF_GREEN}" d="M-7 236 C-6 270 -4 300 -9 334 L9 334 C5 300 6 270 7 236 Z"/>
      <path fill="{LEAF_GREEN}" d="M0 258 C-172 190 -205 -70 -8 -304 C196 -96 178 182 0 258 Z"/>
      <g fill="none" stroke="#ffffff" stroke-linecap="round">
        <path stroke-width="10" d="M0 244 C3 100 -3 -100 -6 -262"/>
        <g stroke-width="6">
          <path d="M1 170 Q-52 140 -108 92 M1 170 Q54 140 112 96"/>
          <path d="M0 80 Q-56 52 -126 -16 M0 80 Q58 50 128 -14"/>
          <path d="M-2 -20 Q-52 -50 -110 -122 M-2 -20 Q52 -52 106 -118"/>
          <path d="M-4 -120 Q-34 -150 -66 -204 M-4 -120 Q32 -148 62 -200"/>
        </g>
      </g>
    <g class="spots" fill="{LESION}">
      <ellipse cx="{sx:g}" cy="{sy:g}" rx="34" ry="29" transform="rotate(-20 {sx:g} {sy:g})"/>
      <ellipse cx="{sx + 54:g}" cy="{sy + 68:g}" rx="25" ry="21" transform="rotate(30 {sx + 54:g} {sy + 68:g})"/>
      <circle cx="{sx - 26:g}" cy="{sy + 62:g}" r="17"/>
      <circle cx="{sx + 34:g}" cy="{sy - 34:g}" r="12"/>
      <circle cx="{sx + 92:g}" cy="{sy + 18:g}" r="10"/>
    </g>
    <g class="pest" fill="{INK}">
      <ellipse cx="{px + 12:g}" cy="{py + 2:g}" rx="38" ry="28"/>
      <ellipse cx="{px - 22:g}" cy="{py:g}" rx="16" ry="15"/>
      <circle cx="{px - 40:g}" cy="{py - 2:g}" r="11"/>
      <path d="M{px + 44:g} {py - 12:g} l22 -8 l-2 10 Z M{px + 44:g} {py + 16:g} l22 8 l-2 -10 Z"/>
      <path fill="none" stroke="{INK}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"
            d="M{px - 24:g} {py + 10:g} l-12 24 l-8 8 M{px - 6:g} {py + 22:g} l-4 28 l-2 8 M{px + 14:g} {py + 26:g} l10 24 l4 6
               M{px - 24:g} {py - 10:g} l-12 -24 l-8 -8 M{px - 6:g} {py - 20:g} l-4 -28 l-2 -8 M{px + 14:g} {py - 24:g} l10 -24 l4 -6
               M{px - 46:g} {py - 10:g} l-18 -22 M{px - 46:g} {py + 4:g} l-20 -8"/>
    </g>
    </g>
  </g>"""

# The round's marks and tools, in disc coordinates.
SCOUT = f"""<g class="scout">
    <circle class="ring-spot" cx="{SPOT[0]:g}" cy="{SPOT[1]:g}" r="122" fill="none" stroke="{ACCENT}" stroke-width="18"/>
    <circle class="ring-pest" cx="{PEST[0]:g}" cy="{PEST[1]:g}" r="122" fill="none" stroke="{ACCENT}" stroke-width="18"/>
    <g class="spray" fill="{MIST}">
      <circle cx="{PEST[0] - 78:g}" cy="{PEST[1] - 150:g}" r="14"/>
      <circle cx="{PEST[0] - 30:g}" cy="{PEST[1] - 168:g}" r="16"/>
      <circle cx="{PEST[0] + 28:g}" cy="{PEST[1] - 160:g}" r="14"/>
      <circle cx="{PEST[0] + 76:g}" cy="{PEST[1] - 140:g}" r="15"/>
      <circle cx="{PEST[0] - 52:g}" cy="{PEST[1] - 100:g}" r="13"/>
      <circle cx="{PEST[0] + 0:g}" cy="{PEST[1] - 112:g}" r="14"/>
      <circle cx="{PEST[0] + 52:g}" cy="{PEST[1] - 96:g}" r="13"/>
      <circle cx="{PEST[0] - 22:g}" cy="{PEST[1] - 64:g}" r="12"/>
      <circle cx="{PEST[0] + 26:g}" cy="{PEST[1] - 58:g}" r="12"/>
    </g>
    <g class="lens" fill="{INK}">
      <path fill-rule="evenodd" d="M-88 0 a88 88 0 1 0 176 0 a88 88 0 1 0 -176 0 Z M-70 0 a70 70 0 1 1 140 0 a70 70 0 1 1 -140 0 Z"/>
      <path d="M52 66 L72 46 L148 122 Q158 132 148 142 Q138 152 128 142 Z"/>
    </g>
  </g>"""


def body(rest_hidden: bool) -> str:
    hide = ' opacity="0"' if rest_hidden else ""
    return f"""  <clipPath id="scp-disc"><circle cx="344.5" cy="344.5" r="336"/></clipPath>
  <!-- the white disc of upande_logo.png, with its thin dark rim -->
  <circle cx="344.5" cy="344.5" r="340" fill="#ffffff" stroke="#1c1b19" stroke-opacity=".3" stroke-width="7"/>
  <g clip-path="url(#scp-disc)">
  <g class="scene"{hide}>
  {LEAF}
  {SCOUT}
  </g>
  {ARROW}
  </g>
"""


# ── motion ─────────────────────────────────────────────────────────────────
# Each entry: selector, transform-origin (view-box px), keyframes [offset, props].
# ENTER runs 0 → 1 on hover (and back on leave). LOOP is the scouting round.

ARROW_HOME = "translate(0px, 0px) scale(1)"
ARROW_GONE = "translate(0px, 0px) scale(0)"

ENTER = [
    # The arrow shrinks into the centre of the disc and fades, so the scene has the whole
    # disc; on leave it grows back out of the centre.
    (".arrow", "348.5px 347px", [
        (0, {"transform": ARROW_HOME, "opacity": 1}),
        (0.45, {"transform": ARROW_GONE, "opacity": 0}),
        (1, {"transform": ARROW_GONE, "opacity": 0}),
    ]),
    (".scene", None, [
        (0, {"opacity": 0}),
        (0.12, {"opacity": 1}),
        (1, {"opacity": 1}),
    ]),
    # the leaf unfurls from its stalk (its own box: base at the bottom); the
    # lesions and the pest are on it, so they grow and shrink with it
    (".leaf", "fill-box|50% 100%", [
        (0, {"transform": "scale(0)"}),
        (0.15, {"transform": "scale(0)"}),
        (0.8, {"transform": "scale(1)"}),
        (1, {"transform": "scale(1)"}),
    ]),
    (".spots", None, [
        (0, {"opacity": 0}),
        (0.62, {"opacity": 0}),
        (0.85, {"opacity": 1}),
        (1, {"opacity": 1}),
    ]),
    (".scout", None, [
        (0, {"opacity": 0}),
        (0.82, {"opacity": 0}),
        (1, {"opacity": 1}),
    ]),
]

LENS_AWAY = "translate(30px, 680px)"
LENS_ON_SPOT = f"translate({SPOT[0]:g}px, {SPOT[1]:g}px)"
LENS_ON_PEST = f"translate({PEST[0]:g}px, {PEST[1]:g}px)"


def _ring(at, lo, hi):
    return [
        (0, {"transform": "scale(.8)", "opacity": 0}),
        (lo, {"transform": "scale(.8)", "opacity": 0}),
        (lo + 0.03, {"transform": "scale(.9)", "opacity": 1}),
        (hi, {"transform": "scale(1.1)", "opacity": 0}),
        (1, {"transform": "scale(1.1)", "opacity": 0}),
    ]


# The round: the lens checks the lesions (amber ring: disease), then the pest
# (red ring), the spray falls on the pest and it is gone, the lens moves off.
LOOP = [
    (".lens", None, [
        (0, {"transform": LENS_AWAY}),
        (0.18, {"transform": LENS_ON_SPOT}),
        (0.32, {"transform": LENS_ON_SPOT}),
        (0.46, {"transform": LENS_ON_PEST}),
        (0.66, {"transform": LENS_ON_PEST}),
        (0.88, {"transform": LENS_AWAY}),
        (1, {"transform": LENS_AWAY}),
    ]),
    (".ring-spot", f"view-box|{SPOT[0]:g}px {SPOT[1]:g}px", _ring(SPOT, 0.2, 0.34)),
    (".ring-pest", f"view-box|{PEST[0]:g}px {PEST[1]:g}px", _ring(PEST, 0.48, 0.62)),
    (".spray", None, [
        (0, {"transform": "translate(0px, -70px)", "opacity": 0}),
        (0.6, {"transform": "translate(0px, -70px)", "opacity": 0}),
        (0.65, {"transform": "translate(0px, -40px)", "opacity": 1}),
        (0.8, {"transform": "translate(0px, 90px)", "opacity": 0}),
        (1, {"transform": "translate(0px, 90px)", "opacity": 0}),
    ]),
    (".pest", None, [
        (0, {"opacity": 1}),
        (0.74, {"opacity": 1}),
        (0.82, {"opacity": 0}),
        (0.94, {"opacity": 0}),
        (1, {"opacity": 1}),
    ]),
]

ENTER_MS = 1650
LOOP_MS = 3900  # slowed ~1.4x: calm, not busy
EASE = "cubic-bezier(.4,0,.2,1)"


# ── emit ───────────────────────────────────────────────────────────────────


def _css_props(props: dict) -> str:
    out = []
    for k, v in props.items():
        name = {"strokeDashoffset": "stroke-dashoffset"}.get(k, k)
        out.append(f"{name}: {v}")
    return "; ".join(out)


def _origin(origin: str) -> tuple[str, str]:
    """"fill-box|50% 100%" → (box, origin); a bare origin is in view-box px."""
    box, _, at = origin.rpartition("|")
    return (box or "view-box", at)


def _origin_rules(tracks) -> list[str]:
    rules = []
    for sel, origin, _ in tracks:
        if origin:
            box, at = _origin(origin)
            rules.append(f"    {sel} {{ transform-box: {box}; transform-origin: {at}; }}")
    return rules


def loader_css() -> str:
    """One cycle: enter (0–18%), the round (18–82%), back out (82–100%)."""
    # One full pass (arrow in, the scene, arrow back out) in the 4 s the splash is held for.
    cycle_ms = 4000
    a, b = 18.0, 82.0
    lines = ["  <style>"]
    lines += _origin_rules(ENTER + LOOP)
    keyframes = []
    for i, (sel, _o, frames) in enumerate(ENTER):
        name = f"scp-in-{i}"
        steps = {}
        for off, props in frames:
            steps[round(off * a, 2)] = props
            steps[round(100 - off * (100 - b), 2)] = props
        keyframes.append((sel, name, sorted(steps.items())))
    for i, (sel, _o, frames) in enumerate(LOOP):
        name = f"scp-round-{i}"
        first = frames[0][1]
        steps = {0.0: first}
        for off, props in frames:
            steps[round(a + off * (b - a), 2)] = props
        steps[100.0] = first
        keyframes.append((sel, name, sorted(steps.items())))
    for sel, name, _ in keyframes:
        lines.append(f"    {sel} {{ animation: {name} {cycle_ms}ms {EASE} infinite both; }}")
    for _sel, name, steps in keyframes:
        lines.append(f"    @keyframes {name} {{")
        for pct, props in steps:
            lines.append(f"      {pct:g}% {{ {_css_props(props)}; }}")
        lines.append("    }")
    lines.append("    @media (prefers-reduced-motion: reduce) {")
    lines.append("      .arrow, .scene, .scene * { animation: none !important; }")
    lines.append("      .scene { opacity: 0; }")
    lines.append("    }")
    lines.append("  </style>")
    return "\n".join(lines)


def motion_json() -> str:
    def tracks(t):
        return [
            {
                "sel": sel,
                "box": _origin(origin)[0] if origin else None,
                "origin": _origin(origin)[1] if origin else None,
                "frames": [dict(offset=o, **p) for o, p in frames],
            }
            for sel, origin, frames in t
        ]

    return json.dumps(
        {"enterMs": ENTER_MS, "loopMs": LOOP_MS, "ease": EASE, "enter": tracks(ENTER), "loop": tracks(LOOP)},
        separators=(",", ":"),
    )


HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 689 689" width="689" height="689" role="img" aria-label="{label}">'


def main():
    desk = "\n".join([
        HEAD.format(label="SCP"),
        "  <!-- Generated by scripts/build_scp_logo.py — edit there. At rest this is",
        "       upande_logo.png; scp_logo_motion.js plays the scene on hover. -->",
        f'  <metadata id="scp-motion">{motion_json()}</metadata>',
        body(rest_hidden=True) + "</svg>",
        "",
    ])
    (ROOT / "scp_logo.svg").write_text(desk)

    loader = "\n".join([
        HEAD.format(label="Upande SCP"),
        "  <!-- Generated by scripts/build_scp_logo.py — edit there. The splash loader:",
        "       the SCP scene on a loop (in, the scouting round, out). Pure CSS. -->",
        loader_css(),
        body(rest_hidden=False) + "</svg>",
        "",
    ])
    (ROOT / "scp_logo_loader.svg").write_text(loader)
    print("wrote", ROOT / "scp_logo.svg", "and", ROOT / "scp_logo_loader.svg")


if __name__ == "__main__":
    main()
