import argparse
import json
import re
from datetime import datetime
from pathlib import Path

import pandas as pd

from src.pipeline.atomic_io import atomic_write_text
from src.pipeline.place_normalization import normalize_archive_metadata


DEFAULT_GEOLOCATION_OK_DIR = Path("output/geolocation/ok")
DEFAULT_RAW_RECORDS_DIR = Path("output/raw_records")
DEFAULT_OUTPUT_FILE = Path("output/old_prague_photos.csv")
DATE_PLACEHOLDER_START = "1800-01-01"
DATE_PLACEHOLDER_END = "2000-12-31"

YEAR_RE = re.compile(r"\d{4}")
YEAR_ONLY_RE = re.compile(r"\d{4}$")
YEAR_RANGE_RE = re.compile(r"\d{4}-\d{4}$")
SPECIFIC_DATE_RE = re.compile(r"\d{1,2}\.\d{1,2}\.\d{4}$")
BEFORE_YEAR_RE = re.compile(r"před \d{4}")
AFTER_YEAR_RE = re.compile(r"po \d{4}")
YEAR_QUESTION_RE = re.compile(r"\d{4} \(\?\)$")
KOL_YEAR_RE = re.compile(r"kol\.\d{4}")

MINIMAL_COLUMNS = [
    "druh",
    "obsah",
    "datace",
    "zobrazeno",
    "xid",
    "signatura",
    "start_date",
    "end_date",
    "date_precision",
    "date_imprecise",
    "geolocation_position_lon",
    "geolocation_position_lat",
    "geolocation_type",
    "geolocation_endpoint",
    "autor",
    "archive_place_terms",
    "places",
    "authors",
    "poznámka",
    "scan_count",
    "scan_previews",
    "scan_zoomify_paths",
]


def parse_date(date_str):
    def date_result(start_date=None, end_date=None, precision="unknown"):
        return {
            "start_date": start_date,
            "end_date": end_date,
            "date_precision": precision,
            "date_imprecise": (
                start_date == DATE_PLACEHOLDER_START
                or end_date == DATE_PLACEHOLDER_END
            ),
        }

    if not date_str:
        return date_result()
    date_str = str(date_str).strip()

    months_cz = {
        "leden": 1,
        "únor": 2,
        "březen": 3,
        "duben": 4,
        "květen": 5,
        "červen": 6,
        "červenec": 7,
        "srpen": 8,
        "září": 9,
        "říjen": 10,
        "listopad": 11,
        "prosinec": 12,
    }

    if YEAR_ONLY_RE.match(date_str):
        return date_result(
            start_date=f"{date_str}-01-01",
            end_date=f"{date_str}-12-31",
            precision="year",
        )

    if YEAR_RANGE_RE.match(date_str):
        start_year, end_year = date_str.split("-")
        return date_result(
            start_date=f"{start_year}-01-01",
            end_date=f"{end_year}-12-31",
            precision="year_range",
        )

    if any(month in date_str for month in months_cz):
        for month, num in months_cz.items():
            if month not in date_str:
                continue
            year_match = YEAR_RE.search(date_str)
            if not year_match:
                return date_result()
            year = year_match.group()
            last_day = {
                1: 31,
                2: 29
                if int(year) % 4 == 0
                and (int(year) % 100 != 0 or int(year) % 400 == 0)
                else 28,
                3: 31,
                4: 30,
                5: 31,
                6: 30,
                7: 31,
                8: 31,
                9: 30,
                10: 31,
                11: 30,
                12: 31,
            }[num]
            return date_result(
                start_date=f"{year}-{num:02d}-01",
                end_date=f"{year}-{num:02d}-{last_day}",
                precision="month",
            )

    if "jaro" in date_str:
        year_match = YEAR_RE.search(date_str)
        if not year_match:
            return date_result()
        year = year_match.group()
        return date_result(
            start_date=f"{year}-03-21",
            end_date=f"{year}-06-20",
            precision="season",
        )

    if BEFORE_YEAR_RE.match(date_str):
        year = int(YEAR_RE.search(date_str).group())
        return date_result(
            start_date=DATE_PLACEHOLDER_START,
            end_date=f"{year - 1}-12-31",
            precision="before_year",
        )

    if AFTER_YEAR_RE.match(date_str):
        year = int(YEAR_RE.search(date_str).group())
        return date_result(
            start_date=f"{year + 1}-01-01",
            end_date=DATE_PLACEHOLDER_END,
            precision="after_year",
        )

    if SPECIFIC_DATE_RE.match(date_str):
        try:
            parsed = datetime.strptime(date_str, "%d.%m.%Y").strftime("%Y-%m-%d")
        except ValueError:
            return date_result()
        return date_result(start_date=parsed, end_date=parsed, precision="day")

    if YEAR_QUESTION_RE.match(date_str):
        year = YEAR_RE.search(date_str).group()
        return date_result(
            start_date=f"{year}-01-01",
            end_date=f"{year}-12-31",
            precision="year_uncertain",
        )

    if KOL_YEAR_RE.match(date_str):
        year = YEAR_RE.search(date_str).group()
        return date_result(
            start_date=f"{year}-01-01",
            end_date=f"{year}-12-31",
            precision="year_approx",
        )

    return date_result()


def normalize_json_array(value):
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return "[]"
    if isinstance(value, list):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            return stripped
    return json.dumps([value], ensure_ascii=False)


def _load_json_object(path: Path, *, label: str) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"Invalid {label} JSON in {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{label.capitalize()} must be a JSON object: {path}")
    xid = payload.get("xid")
    if xid != path.stem:
        raise ValueError(
            f"{label.capitalize()} XID does not match filename: "
            f"{path} contains {xid!r}"
        )
    return payload


def load_geolocated_records(
    directory: Path,
    raw_records_dir: Path | None = None,
) -> pd.DataFrame:
    frames = []
    for path in sorted(directory.glob("*.json")):
        geolocated = _load_json_object(path, label="geolocation record")
        payload = dict(geolocated)
        archive_source = geolocated if raw_records_dir is None else None
        if raw_records_dir is not None:
            raw_path = raw_records_dir / path.name
            if raw_path.exists():
                raw_record = _load_json_object(raw_path, label="raw record")
                archive_source = raw_record
                if "geolocation" not in geolocated:
                    raise ValueError(f"Missing geolocation result in {path}")
                payload = {
                    **geolocated,
                    **raw_record,
                    "geolocation": geolocated["geolocation"],
                }
        payload.update(normalize_archive_metadata(archive_source))
        date = parse_date(payload.get("datace"))
        payload["start_date"] = date["start_date"]
        payload["end_date"] = date["end_date"]
        payload["date_precision"] = date["date_precision"]
        payload["date_imprecise"] = date["date_imprecise"]
        frames.append(pd.json_normalize(payload, sep="_"))

    if not frames:
        raise ValueError(f"No geolocated records found in {directory}")
    return pd.concat(frames, ignore_index=True)


def prepare_export_frame(combined_data: pd.DataFrame, minimal: bool) -> pd.DataFrame:
    combined_data = combined_data.copy()
    for column, default in {
        "scan_count": 0,
        "scan_previews": None,
        "archive_place_terms": None,
        "places": None,
        "authors": None,
        "scan_zoomify_paths": None,
    }.items():
        if column not in combined_data.columns:
            combined_data[column] = default

    combined_data["scan_previews"] = combined_data["scan_previews"].apply(
        normalize_json_array
    )
    combined_data["scan_zoomify_paths"] = combined_data["scan_zoomify_paths"].apply(
        normalize_json_array
    )

    for column in ("archive_place_terms", "places", "authors"):
        combined_data[column] = combined_data[column].apply(normalize_json_array)

    if "typ záznamu" in combined_data.columns:
        type_counts = (
            combined_data["typ záznamu"].fillna("(missing)").value_counts().to_dict()
        )
        before_count = len(combined_data)
        combined_data = combined_data[combined_data["typ záznamu"] == "Archiválie"].copy()
        removed = before_count - len(combined_data)
        print(
            "Filtered non-archival records:",
            f"removed={removed}",
            f"types={type_counts}",
        )
    else:
        print("Warning: typ záznamu missing; no filter applied.")

    if not minimal:
        return combined_data

    for column in MINIMAL_COLUMNS:
        if column not in combined_data.columns:
            combined_data[column] = ""
    return combined_data[MINIMAL_COLUMNS]


def export_records(
    geolocation_ok_dir: Path = DEFAULT_GEOLOCATION_OK_DIR,
    output_file: Path = DEFAULT_OUTPUT_FILE,
    minimal: bool = True,
    raw_records_dir: Path | None = None,
) -> int:
    if not geolocation_ok_dir.exists():
        raise FileNotFoundError(f"Geolocation directory not found: {geolocation_ok_dir}")
    combined_data = load_geolocated_records(
        geolocation_ok_dir,
        raw_records_dir=raw_records_dir,
    )
    export_frame = prepare_export_frame(combined_data, minimal=minimal)
    atomic_write_text(output_file, export_frame.to_csv(index=False))
    print(f"Saved {len(export_frame)} records to {output_file}")
    return len(export_frame)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export geolocated records to CSV.")
    parser.add_argument("--input-dir", default=str(DEFAULT_GEOLOCATION_OK_DIR))
    parser.add_argument(
        "--raw-dir",
        default=str(DEFAULT_RAW_RECORDS_DIR),
        help="Current raw metadata to join with preserved geolocation results",
    )
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_FILE))
    parser.add_argument("--minimal", dest="minimal", action="store_true", default=True)
    parser.add_argument("--full", dest="minimal", action="store_false")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    export_records(
        geolocation_ok_dir=Path(args.input_dir),
        output_file=Path(args.output),
        minimal=args.minimal,
        raw_records_dir=Path(args.raw_dir),
    )


if __name__ == "__main__":
    main()
