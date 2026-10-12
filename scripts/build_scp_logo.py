"""Generate the SCP mark's two SVGs from one description.

    python3 scripts/build_scp_logo.py

* ``public/images/scp_logo.svg`` — the desk tile. Drawn at rest it IS the
  original ``upande_logo.png`` (white disc, the Upande arrow at the same place
  and size on a 689 canvas), so the tile is the same size as before. The scene
  is in the file but hidden; ``public/js/scp_logo_motion.js`` inlines the file
  and plays it on hover, reading the keyframes from the ``<metadata>`` below.
* ``public/images/scp_logo_loader.svg`` — the splash loader: the same scene as a
  pure-CSS loop (the splash shows it through ``<img>``, where scripts never run).

THE SCENE (SCP's own, not the Webstore's): the arrow steps aside to the top
right, a rose grows from the bottom of the disc — stem, leaves, bloom — and the
scouting round plays: a scout's magnifier finds a pest on a leaf, a ring marks
it, spray falls and the pest is gone, the magnifier moves on. On the desk the
first part eases in on hover, the round loops while the pointer stays, and on
leave it all eases back out to the plain mark. The loader runs in → round → out.

Keyframes are written once (``ENTER`` and ``LOOP``) and emitted both as CSS for
the loader and as JSON for the desk script.
"""

from __future__ import annotations

import json
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

ROSE = """<g class="rose">
    <path class="stem" d="M330 720 C318 620 342 500 330 380" fill="none" stroke="#4f7a3a"
          stroke-width="34" stroke-linecap="round" pathLength="1" stroke-dasharray="1"/>
    <path class="leaf-l" d="M328 560 C250 566 158 520 132 444 C214 424 306 476 328 560 Z" fill="#6a9a4c"/>
    <path class="leaf-r" d="M334 470 C410 470 492 424 512 352 C432 340 352 392 334 470 Z" fill="#5a8a42"/>
    <g class="bloom">
      <circle cx="330" cy="285" r="108" fill="#c43b52"/>
      <path d="M240 256 C262 186 398 186 420 256 C384 226 276 226 240 256 Z" fill="#a8293f"/>
      <path d="M268 306 C274 246 386 246 392 306 C366 280 294 280 268 306 Z" fill="#e0647a"/>
      <path d="M258 346 C292 378 368 378 402 346 C368 362 292 362 258 346 Z" fill="#a8293f"/>
      <circle cx="330" cy="292" r="22" fill="#8e1f33"/>
    </g>
  </g>"""

# The round: a pest on the left leaf, the ring that marks it, spray, the magnifier.
# Drawn bold: the tile is 54px, where one pixel is ~13 units of this canvas.
SCOUT = """<g class="scout">
    <g class="pest">
      <ellipse cx="222" cy="478" rx="34" ry="24" fill="#1f2a14"/>
      <circle cx="186" cy="472" r="15" fill="#1f2a14"/>
      <path d="M206 498 l-14 20 M226 502 l-2 24 M246 496 l12 20 M204 458 l-14 -16 M242 458 l12 -16"
            stroke="#1f2a14" stroke-width="8" stroke-linecap="round"/>
    </g>
    <circle class="ring" cx="218" cy="480" r="82" fill="none" stroke="#c43b52" stroke-width="28"/>
    <g class="spray">
      <circle cx="166" cy="330" r="26" fill="#2f86c4"/>
      <circle cx="240" cy="296" r="22" fill="#2f86c4"/>
      <circle cx="292" cy="352" r="22" fill="#2f86c4"/>
      <circle cx="132" cy="398" r="20" fill="#2f86c4"/>
      <circle cx="226" cy="392" r="20" fill="#2f86c4"/>
    </g>
    <g class="lens">
      <circle cx="0" cy="0" r="84" fill="#ffffff" fill-opacity=".3" stroke="#45433f" stroke-width="26"/>
      <path d="M62 62 L140 140" stroke="#45433f" stroke-width="36" stroke-linecap="round"/>
    </g>
  </g>"""


def body(rest_hidden: bool) -> str:
    hide = ' opacity="0"' if rest_hidden else ""
    return f"""  <clipPath id="scp-disc"><circle cx="344.5" cy="344.5" r="336"/></clipPath>
  <!-- the white disc of upande_logo.png, with its thin dark rim -->
  <circle cx="344.5" cy="344.5" r="340" fill="#ffffff" stroke="#1c1b19" stroke-opacity=".3" stroke-width="7"/>
  <g clip-path="url(#scp-disc)">
  <g class="scene"{hide}>
  {ROSE}
  {SCOUT}
  </g>
  {ARROW}
  </g>
"""


# ── motion ─────────────────────────────────────────────────────────────────
# Each entry: selector, transform-origin (view-box px), keyframes [offset, props].
# ENTER runs 0 → 1 on hover (and back on leave). LOOP is the scouting round.

ARROW_HOME = "translate(0px, 0px) scale(1)"
ARROW_ASIDE = "translate(186px, -190px) scale(.3)"

ENTER = [
    (".arrow", "348.5px 347px", [
        (0, {"transform": ARROW_HOME}),
        (0.55, {"transform": ARROW_ASIDE}),
        (1, {"transform": ARROW_ASIDE}),
    ]),
    (".scene", None, [
        (0, {"opacity": 0}),
        (0.12, {"opacity": 1}),
        (1, {"opacity": 1}),
    ]),
    (".stem", None, [
        (0, {"strokeDashoffset": 1}),
        (0.15, {"strokeDashoffset": 1}),
        (0.6, {"strokeDashoffset": 0}),
        (1, {"strokeDashoffset": 0}),
    ]),
    (".leaf-l", "328px 560px", [
        (0, {"transform": "scale(0)"}),
        (0.4, {"transform": "scale(0)"}),
        (0.7, {"transform": "scale(1)"}),
        (1, {"transform": "scale(1)"}),
    ]),
    (".leaf-r", "334px 470px", [
        (0, {"transform": "scale(0)"}),
        (0.48, {"transform": "scale(0)"}),
        (0.78, {"transform": "scale(1)"}),
        (1, {"transform": "scale(1)"}),
    ]),
    (".bloom", "330px 360px", [
        (0, {"transform": "scale(0)"}),
        (0.58, {"transform": "scale(0)"}),
        (0.92, {"transform": "scale(1.06)"}),
        (1, {"transform": "scale(1)"}),
    ]),
    (".scout", None, [
        (0, {"opacity": 0}),
        (0.8, {"opacity": 0}),
        (1, {"opacity": 1}),
    ]),
]

LENS_AWAY = "translate(560px, 600px)"
LENS_ON_PEST = "translate(218px, 480px)"

LOOP = [
    (".lens", None, [
        (0, {"transform": LENS_AWAY}),
        (0.28, {"transform": LENS_ON_PEST}),
        (0.62, {"transform": LENS_ON_PEST}),
        (0.9, {"transform": LENS_AWAY}),
        (1, {"transform": LENS_AWAY}),
    ]),
    (".ring", "218px 480px", [
        (0, {"transform": "scale(.5)", "opacity": 0}),
        (0.3, {"transform": "scale(.5)", "opacity": 0}),
        (0.34, {"transform": "scale(.7)", "opacity": 1}),
        (0.48, {"transform": "scale(1.25)", "opacity": 0}),
        (1, {"transform": "scale(1.25)", "opacity": 0}),
    ]),
    (".spray", None, [
        (0, {"transform": "translate(0px, -70px)", "opacity": 0}),
        (0.44, {"transform": "translate(0px, -70px)", "opacity": 0}),
        (0.5, {"transform": "translate(0px, -40px)", "opacity": 1}),
        (0.66, {"transform": "translate(0px, 90px)", "opacity": 0}),
        (1, {"transform": "translate(0px, 90px)", "opacity": 0}),
    ]),
    (".pest", None, [
        (0, {"opacity": 1}),
        (0.58, {"opacity": 1}),
        (0.68, {"opacity": 0}),
        (0.92, {"opacity": 0}),
        (1, {"opacity": 1}),
    ]),
]

ENTER_MS = 1100
LOOP_MS = 2800
EASE = "cubic-bezier(.3,.7,.2,1)"


# ── emit ───────────────────────────────────────────────────────────────────


def _css_props(props: dict) -> str:
    out = []
    for k, v in props.items():
        name = {"strokeDashoffset": "stroke-dashoffset"}.get(k, k)
        out.append(f"{name}: {v}")
    return "; ".join(out)


def _origin_rules(tracks) -> list[str]:
    rules = []
    for sel, origin, _ in tracks:
        if origin:
            rules.append(f"    {sel} {{ transform-box: view-box; transform-origin: {origin}; }}")
    return rules


def loader_css() -> str:
    """One cycle: enter (0–18%), the round (18–82%), back out (82–100%)."""
    cycle_ms = 4600
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
            {"sel": sel, "origin": origin, "frames": [dict(offset=o, **p) for o, p in frames]}
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
