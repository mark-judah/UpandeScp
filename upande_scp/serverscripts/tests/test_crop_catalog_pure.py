"""crop_catalog's pure parts — runs under plain pytest, no site."""

from unittest.mock import patch

import pytest

from upande_scp.serverscripts.common import crop_catalog as CC

IDX = CC.build_index(
    ["Rose", "Avocado", "Coffee"],
    [
        {"crop_scouted": "Rose", "pest": "Thrips"},
        {"crop_scouted": "Avocado", "pest": "Fruit fly (Ceratitis)"},
        {"crop_scouted": "Rose", "pest": ""},
    ],
    [{"crop_scouted": "Avocado", "disease": "Avocado Scab"}],
    # Ordered by (idx, parent) as _load() orders them: Rose lists Chepsito first.
    [
        {"parent": "Rose", "farm": "Chepsito"},
        {"parent": "Avocado", "farm": "Lokitela"},
        {"parent": "Coffee", "farm": "Chepsito"},
    ],
    [
        {"name": "Chepsito GH 01 - KR", "custom_farm": "Chepsito"},
        {"name": "AIRSTRIP BLK 1 - KL", "custom_farm": "Lokitela"},
        {"name": "Orphan", "custom_farm": "Nowhere"},
    ],
)


def test_index_lists_are_sorted_and_blank_rows_dropped():
    assert IDX["pests"] == {"Rose": ["Thrips"], "Avocado": ["Fruit fly (Ceratitis)"]}
    assert IDX["diseases"] == {"Avocado": ["Avocado Scab"]}
    assert IDX["crops"] == ["Avocado", "Coffee", "Rose"]


def test_a_farm_belongs_to_the_first_crop_that_lists_it():
    assert IDX["farm_crop"]["Chepsito"] == "Rose"
    # Membership is still recorded for every crop that lists the farm.
    assert IDX["farms"]["Coffee"] == ["Chepsito"]


def test_a_greenhouse_counts_under_one_crop_only():
    """D5 must be single-valued, or a crop-less entry counts under two crops."""
    assert IDX["houses"]["Rose"] == ["Chepsito GH 01 - KR"]
    assert "Coffee" not in IDX["houses"]
    assert IDX["houses"]["Avocado"] == ["AIRSTRIP BLK 1 - KL"]


def test_entry_crop_condition_shape():
    assert CC.entry_crop_condition("se") == (
        "(se.crop_scouted = %(crop)s OR (IFNULL(se.crop_scouted, '') = '' "
        "AND COALESCE(NULLIF(se.greenhouse, ''), se.block) IN %(crop_whs)s))"
    )


def test_obs_crop_condition():
    assert CC.obs_crop_condition("pest", "p.pest") == "p.pest IN %(crop_pests)s"
    assert CC.obs_crop_condition("disease", "d.disease") == "d.disease IN %(crop_diseases)s"
    with pytest.raises(KeyError):
        CC.obs_crop_condition("trap", "t.pest")


def test_canonical_is_case_insensitive():
    with patch.object(CC, "catalog", return_value=IDX):
        assert CC.canonical("rose") == "Rose"
        assert CC.canonical(" ROSE ") == "Rose"
        assert CC.canonical("Mango") == ""
        assert CC.canonical("") == ""
        assert CC.canonical(None) == ""


def test_lookups_accept_route_slugs():
    with patch.object(CC, "catalog", return_value=IDX):
        assert CC.pests_for_crop("rose") == ["Thrips"]
        assert CC.targets_for_crop("avocado") == ["Avocado Scab", "Fruit fly (Ceratitis)"]
        assert CC.greenhouses_for_crop("rose") == ["Chepsito GH 01 - KR"]
        assert CC.crop_for_farm("Chepsito") == "Rose"
        assert CC.crop_for_farm("Nowhere") is None
        assert CC.crop_for_farm("") is None


def test_a_crop_with_nothing_linked_matches_nothing():
    with patch.object(CC, "catalog", return_value=IDX):
        p = CC.crop_sql_params("rose")
        assert p["crop"] == "Rose"
        assert p["crop_pests"] == ("Thrips",)
        assert p["crop_diseases"] == (CC.NO_MATCH,)
        p = CC.crop_sql_params("Mango")
        assert p["crop"] == CC.NO_MATCH
        assert p["crop_whs"] == (CC.NO_MATCH,)
        assert p["crop_pests"] == (CC.NO_MATCH,)
        assert p["crop_diseases"] == (CC.NO_MATCH,)


def test_entry_condition_falls_back_to_block_for_avocado_entries():
    assert "COALESCE(NULLIF(se.greenhouse, ''), se.block)" in CC.entry_crop_condition("se")
    assert "COALESCE(NULLIF(x.greenhouse, ''), x.block)" in CC.entry_crop_condition("x")
