"""Behavioural check for Task 6: the heatmaps grid ships only recent[0],
and the new heatmap_card_detail endpoint returns the full 3-date history
for one card, with recent[0] matching what the grid already showed.

`recent[]` was 99% of a 13.65 MB grid payload (zoneStages alone 9.9 MB),
but Heatmaps.tsx only renders `recent[0]` in the grid thumbnail; the
other two dates are read only inside the opened card. This checks the
split: the grid card carries len(recent) <= 1, and the detail endpoint
returns up to 3 dates whose first entry matches the grid's.

Not a FrappeTestCase (`bench run-tests` is broken on this bench; also
`test_dashboard_equivalence.py`, which an earlier task's brief assumed,
does not exist in this repo — task 1 deleted it as an abandoned,
broken-runner-dependent file). Run via:

    bench --site kaitet.local execute \\
        upande_scp.serverscripts.tests.check_card_detail.run
"""

from upande_scp.serverscripts.tests.equivalence import WINDOW


def run():
    _grid_ships_only_the_rendered_date()
    _card_detail_returns_the_full_three_dates()
    print("check_card_detail: 2 passed")


def _grid_ships_only_the_rendered_date():
    from upande_scp.serverscripts import dashboard_aggregates as DA

    out = DA.heatmaps_grid(crop="Rose", force=1, **WINDOW)
    cards = out["cards"]
    assert cards, "expected at least one card in the Rose window fixture"
    for card in cards:
        assert len(card["recent"]) <= 1, (
            f"grid card {card['greenhouse']}/{card['obsName']} carried "
            f"{len(card['recent'])} recent entries; expected <=1 "
            "(the modal fetches the rest)"
        )


def _card_detail_returns_the_full_three_dates():
    from upande_scp.serverscripts import dashboard_aggregates as DA
    from upande_scp.serverscripts.dashboard_aggregates import _heatmaps

    grid = DA.heatmaps_grid(crop="Rose", force=1, **WINDOW)
    card = grid["cards"][0]

    detail = _heatmaps.heatmap_card_detail(
        {
            "from_date": WINDOW["from_date"], "to_date": WINDOW["to_date"],
            "crop": "Rose",
            "greenhouse": card["greenhouse"], "obs_name": card["obsName"],
            "obs_kind": card["obsKind"],
        },
        force=True,
    )
    assert 1 <= len(detail["recent"]) <= 3, (
        f"expected 1-3 recent dates from detail, got {len(detail['recent'])}"
    )
    # recent[0] must match what the grid already showed, or the thumbnail
    # would jump when the modal opens.
    assert detail["recent"][0]["date"] == card["recent"][0]["date"], (
        f"detail recent[0] date {detail['recent'][0]['date']!r} != grid "
        f"recent[0] date {card['recent'][0]['date']!r}"
    )
