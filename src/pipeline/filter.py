import argparse
import json
from pathlib import Path

from src.pipeline.atomic_io import atomic_write_json


DEFAULT_RAW_RECORDS_DIR = Path("output/raw_records")
DEFAULT_FILTERED_DIR = Path("output/filtered")
DEFAULT_RECORDS_WITH_PLACES = Path("output/records_with_places.json")


def has_place_record(record: dict) -> bool:
    return any(
        "místo" in str(entry.get("typ", "")).lower()
        for entry in record.get("rejstříkové záznamy", [])
        if isinstance(entry, dict)
    )


def has_cp_in_index(record: dict) -> bool:
    return any(
        "čp." in str(entry.get("obsah", "")).lower()
        for entry in record.get("rejstříkové záznamy", [])
        if isinstance(entry, dict)
    )


def has_dilo_record(record: dict) -> bool:
    return any(
        str(entry.get("typ", "")).lower() == "dílo"
        for entry in record.get("rejstříkové záznamy", [])
        if isinstance(entry, dict)
    )


def load_raw_records(raw_records_dir: Path) -> list[dict]:
    records: list[dict] = []
    for path in sorted(raw_records_dir.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValueError(f"Invalid raw-record JSON in {path}: {exc}") from exc
        if not isinstance(payload, dict):
            raise ValueError(f"Raw record must be a JSON object: {path}")
        xid = payload.get("xid")
        if xid != path.stem:
            raise ValueError(
                f"Raw record XID does not match filename: {path} contains {xid!r}"
            )
        records.append(payload)
    return records


def categorize_records(records: list[dict]) -> tuple[list[dict], dict[str, list[dict]]]:
    records_with_places = [record for record in records if has_place_record(record)]
    filtered_records: dict[str, list[dict]] = {
        "records_with_cp": [],
        "records_with_cp_in_record_obsah": [],
        "records_without_cp": [],
        "records_without_dilo": [],
    }

    for record in records_with_places:
        obsah_lower = str(record.get("obsah", "")).lower()
        if has_cp_in_index(record):
            filtered_records["records_with_cp"].append(record)
        elif "čp." in obsah_lower:
            filtered_records["records_with_cp_in_record_obsah"].append(record)
        else:
            filtered_records["records_without_cp"].append(record)

    filtered_records["records_without_dilo"] = [
        record
        for record in filtered_records["records_without_cp"]
        if not has_dilo_record(record)
    ]
    return records_with_places, filtered_records


def write_json(path: Path, payload: object) -> None:
    atomic_write_json(path, payload)


def run_filter(
    raw_records_dir: Path = DEFAULT_RAW_RECORDS_DIR,
    filtered_dir: Path = DEFAULT_FILTERED_DIR,
    records_with_places_path: Path = DEFAULT_RECORDS_WITH_PLACES,
) -> dict[str, int]:
    if not raw_records_dir.exists():
        raise FileNotFoundError(f"Raw records directory not found: {raw_records_dir}")

    print(f"Loading scraped records from {raw_records_dir}...")
    records = load_raw_records(raw_records_dir)
    print(f"Loaded {len(records)} records.")

    records_with_places, filtered_records = categorize_records(records)
    write_json(records_with_places_path, records_with_places)
    print(f"Found {len(records_with_places)} records with places.")

    counts = {"records_with_places": len(records_with_places)}
    for key, value in filtered_records.items():
        counts[key] = len(value)
        write_json(filtered_dir / f"{key}.json", value)
        print(f"{key}: {len(value)}")

    print("Done.")
    return counts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter scraped records into geolocation input categories.",
    )
    parser.add_argument("--raw-dir", default=str(DEFAULT_RAW_RECORDS_DIR))
    parser.add_argument("--output-dir", default=str(DEFAULT_FILTERED_DIR))
    parser.add_argument(
        "--records-with-places",
        default=str(DEFAULT_RECORDS_WITH_PLACES),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run_filter(
        raw_records_dir=Path(args.raw_dir),
        filtered_dir=Path(args.output_dir),
        records_with_places_path=Path(args.records_with_places),
    )


if __name__ == "__main__":
    main()
