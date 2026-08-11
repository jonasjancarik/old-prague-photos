import pytest

from viewer.community_candidates import (
    build_duplicate_candidates,
    build_effective_groups,
    paginate,
    remap_version_clusters,
    StaleCandidateCursorError,
)


def _feature(index: int) -> dict:
    xid = f"X{index:03d}"
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [14.4, 50.1]},
        "properties": {"id": xid, "group_id": f"G{index:03d}", "signature": xid},
    }


def test_duplicate_coordinate_expansion_and_pages_are_bounded() -> None:
    groups = build_effective_groups(
        [_feature(index) for index in range(212)],
        set(),
        {"resolvedGroupByXid": {}, "groupCorrections": []},
    )
    candidates = build_duplicate_candidates(
        groups,
        [],
        {"groupRoots": {}, "mergeDecisions": []},
    )

    assert len(candidates) <= 212 * 8
    assert len(candidates) < (212 * 211) // 2
    page = paginate(candidates, "", 500, 7, "data-v1")
    assert len(page["items"]) == 50
    assert page["nextCursor"] == "vZGF0YS12MQ:r7:50"
    with pytest.raises(StaleCandidateCursorError):
        paginate(candidates, page["nextCursor"], 50, 7, "data-v2")


def test_similarity_pair_follows_xid_membership_override() -> None:
    left = _feature(1)
    right = _feature(2)
    review_state = {
        "resolvedGroupByXid": {"X001": "MOVED", "X002": "G002"},
        "groupRoots": {"G001": "G001", "G002": "G002", "MOVED": "MOVED"},
        "groupCorrections": [],
        "mergeDecisions": [],
    }
    groups = build_effective_groups([left, right], set(), review_state)
    candidates = build_duplicate_candidates(
        groups,
        [
            {
                "xid_a": "X001",
                "group_id_a": "G001",
                "xid_b": "X002",
                "group_id_b": "G002",
            }
        ],
        review_state,
    )
    assert len(candidates) == 1
    assert candidates[0]["key"] == "G002::MOVED"


def test_effective_group_preserves_raw_coordinates_with_correction() -> None:
    source = _feature(1)
    source["geometry"]["coordinates"] = [14.4, 50.1]
    groups = build_effective_groups(
        [source],
        set(),
        {
            "resolvedGroupByXid": {},
            "groupCorrections": [{"group_id": "G001", "lat": 51.0, "lon": 15.0}],
        },
    )

    candidate = groups[0]["items"][0]
    assert candidate["geometry"]["coordinates"] == [15.0, 51.0]
    assert candidate["properties"]["original_coordinates"] == [14.4, 50.1]


def test_effective_group_does_not_apply_pending_proposed_coordinates() -> None:
    source = _feature(1)
    source["geometry"]["coordinates"] = [14.4, 50.1]
    groups = build_effective_groups(
        [source],
        set(),
        {
            "resolvedGroupByXid": {},
            "groupCorrections": [
                {
                    "group_id": "G001",
                    "correction_state": "pending",
                    "lat": None,
                    "lon": None,
                    "proposed_lat": 51.0,
                    "proposed_lon": 15.0,
                    "proposed_has_coordinates": True,
                    "proposed_id": "proposal-1",
                    "anchor_id": "proposal-1",
                    "location_revision": '["G001","proposal-1"]',
                }
            ],
        },
    )

    candidate = groups[0]["items"][0]
    assert candidate["geometry"]["coordinates"] == [14.4, 50.1]
    assert "corrected" not in candidate["properties"]
    assert candidate["properties"]["proposed_id"] == "proposal-1"
    assert candidate["properties"]["proposed_lat"] == 51.0
    assert candidate["properties"]["proposed_lon"] == 15.0
    assert (
        candidate["properties"]["location_revision"]
        == '["G001","proposal-1"]'
    )


def test_pending_merge_pair_remains_available_for_another_reviewer() -> None:
    left = _feature(1)
    right = _feature(2)
    review_state = {
        "resolvedGroupByXid": {},
        "groupRoots": {},
        "groupCorrections": [],
        "mergeDecisions": [
            {
                "group_id_a": "G001",
                "group_id_b": "G002",
                "verdict": "pending",
                "same_votes": 1,
                "required_same_votes": 2,
            }
        ],
    }
    groups = build_effective_groups([left, right], set(), review_state)

    candidates = build_duplicate_candidates(groups, [], review_state)

    assert [candidate["key"] for candidate in candidates] == ["G001::G002"]


def test_version_clusters_follow_current_membership() -> None:
    source_a = _feature(1)
    source_b = _feature(2)
    target = _feature(3)
    review_state = {
        "resolvedGroupByXid": {
            "X001": "TARGET",
            "X002": "SOURCE",
            "X003": "TARGET",
        },
        "groupCorrections": [],
    }
    groups = build_effective_groups(
        [source_a, source_b, target],
        set(),
        review_state,
    )
    remapped = remap_version_clusters(
        [
            {
                "series_id": "SOURCE",
                "version_id": "v1",
                "xids": ["X001", "X002", "REMOVED"],
                "representative_xid": "X001",
                "max_distance": 3,
            },
            {
                "series_id": "TARGET",
                "version_id": "v1",
                "xids": ["X003"],
                "representative_xid": "X003",
                "max_distance": 0,
            },
        ],
        groups,
    )
    assert remapped["SOURCE"][0]["xids"] == ["X002"]
    assert sorted(
        xid for cluster in remapped["TARGET"] for xid in cluster["xids"]
    ) == ["X001", "X003"]
    assert [cluster["version_id"] for cluster in remapped["TARGET"]] == [
        "v1",
        "v2",
    ]
