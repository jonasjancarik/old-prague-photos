from __future__ import annotations

from pathlib import Path

from src.pipeline import export as export_module
from src.pipeline import filter as filter_module
from src.pipeline.paths import PipelinePaths
from src.pipeline.run_manifest import append_stage_event, write_run_manifest
from viewer.build_geojson import build_geojson


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PUBLISHED_GROUPS_PATH = PROJECT_ROOT / "viewer/static/data/photos.geojson"


def derive_snapshot(
    run_dir: str | Path,
    *,
    minimal_export: bool = True,
    write_manifest: bool = True,
    existing_groups_path: str | Path | None = PUBLISHED_GROUPS_PATH,
) -> dict[str, int | str]:
    paths = PipelinePaths.from_run_dir(run_dir)
    paths.assert_snapshot_inputs()
    paths.create()

    filter_counts = filter_module.run_filter(
        raw_records_dir=paths.raw_records_dir,
        filtered_dir=paths.filter_dir,
        records_with_places_path=paths.records_with_places_path,
    )
    export_count = export_module.export_records(
        geolocation_ok_dir=paths.geolocation_ok_dir,
        output_file=paths.photos_csv_path,
        minimal=minimal_export,
    )
    geojson_count = build_geojson(
        input_path=paths.photos_csv_path,
        output_path=paths.photos_geojson_path,
        existing_groups_path=(
            Path(existing_groups_path) if existing_groups_path is not None else None
        ),
    )

    if write_manifest:
        append_stage_event(
            paths,
            "derive",
            details={
                "minimal_export": minimal_export,
                "records_with_places": filter_counts["records_with_places"],
                "exported_records": export_count,
                "geojson_features": geojson_count,
            },
        )
        write_run_manifest(paths)

    return {
        "records_with_places": filter_counts["records_with_places"],
        "exported_records": export_count,
        "geojson_features": geojson_count,
        "manifest": str(paths.manifest_path) if write_manifest else "",
    }
