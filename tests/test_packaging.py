from pathlib import Path
import tomllib


ROOT = Path(__file__).resolve().parents[1]


def test_wheel_includes_cli_runtime_helpers() -> None:
    config = tomllib.loads((ROOT / "pyproject.toml").read_text())
    force_includes = config["tool"]["hatch"]["build"]["targets"]["wheel"][
        "force-include"
    ]

    assert force_includes == {
        "viewer/build_geojson.py": "viewer/build_geojson.py",
        "viewer/static/data/photos.geojson": "viewer/static/data/photos.geojson",
        "scripts/write_pipeline_manifest.py": "scripts/write_pipeline_manifest.py",
    }
