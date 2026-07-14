import csv
import json
from pathlib import Path

from viewer.build_geojson import build_geojson


FIELDNAMES = [
    "xid",
    "obsah",
    "autor",
    "datace",
    "geolocation_position_lat",
    "geolocation_position_lon",
]


def write_rows(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


def read_groups(path: Path) -> dict[str, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {
        feature["properties"]["id"]: feature["properties"]["group_id"]
        for feature in payload["features"]
    }


def row(xid: str, description: str) -> dict[str, str]:
    return {
        "xid": xid,
        "obsah": description,
        "autor": "Autor",
        "datace": "1900",
        "geolocation_position_lat": "50.08",
        "geolocation_position_lon": "14.42",
    }


def test_group_id_survives_metadata_changes(tmp_path: Path) -> None:
    source = tmp_path / "photos.csv"
    output = tmp_path / "photos.geojson"
    write_rows(source, [row("X1", "Old description")])
    build_geojson(source, output)
    original_group = read_groups(output)["X1"]

    write_rows(source, [row("X1", "Corrected description")])
    build_geojson(source, output)

    assert read_groups(output)["X1"] == original_group


def test_new_member_reuses_existing_series_id(tmp_path: Path) -> None:
    source = tmp_path / "photos.csv"
    output = tmp_path / "photos.geojson"
    write_rows(source, [row("X1", "Shared description")])
    build_geojson(source, output)
    original_group = read_groups(output)["X1"]

    write_rows(
        source,
        [row("X1", "Shared description"), row("X2", "Shared description")],
    )
    build_geojson(source, output)

    assert read_groups(output) == {"X1": original_group, "X2": original_group}


def test_fresh_destination_preserves_published_series_assignment(tmp_path: Path) -> None:
    source = tmp_path / "photos.csv"
    published = tmp_path / "published.geojson"
    fresh_output = tmp_path / "run" / "photos.geojson"
    write_rows(source, [row("X1", "Original description")])
    build_geojson(source, published)
    original_group = read_groups(published)["X1"]

    write_rows(source, [row("X1", "Changed description")])
    build_geojson(source, fresh_output, existing_groups_path=published)

    assert read_groups(fresh_output)["X1"] == original_group
