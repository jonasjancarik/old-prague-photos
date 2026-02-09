import os
import aiohttp
import asyncio
import logging
import json
from pathlib import Path

from src.scraper.nav_partition import fetch_record_ids_via_nav
from src.scraper.record_scraper import RecordScraper
from src.utils.helpers import get_full_url, read_urls_from_file, save_ids_to_file

RECORD_IDS_FILENAME = "output/available_record_ids.json"
FAILED_XIDS_FILENAME = "output/failed_xids.jsonl"
MISSING_DETAILS_XIDS_FILENAME = "output/missing_details_xids.json"
logging.basicConfig(level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper()))


def parse_failed_xids(path: Path) -> list[str]:
    if not path.exists():
        return []
    seen: set[str] = set()
    result: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw:
            continue
        xid = ""
        try:
            payload = json.loads(raw)
            xid = str(payload.get("xid", "")).strip()
        except json.JSONDecodeError:
            xid = raw
        if xid and xid not in seen:
            seen.add(xid)
            result.append(xid)
    return result


def parse_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalized_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item or "").strip() for item in value]


def record_missing_scan_details(record: dict[str, object]) -> bool:
    scan_count = parse_int(record.get("scan_count"), default=0)
    if scan_count <= 0:
        return True

    previews = normalized_list(record.get("scan_previews"))
    zoomify_paths = normalized_list(record.get("scan_zoomify_paths"))

    if len(previews) != scan_count or len(zoomify_paths) != scan_count:
        return True
    if any(not preview for preview in previews):
        return True
    if any(not path for path in zoomify_paths):
        return True
    return False


def parse_missing_details_xids(raw_records_dir: Path) -> list[str]:
    if not raw_records_dir.exists():
        return []

    missing: list[str] = []
    for path in sorted(raw_records_dir.glob("*.json")):
        xid = path.stem
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        if record_missing_scan_details(payload):
            missing.append(xid)
    return missing


def dedupe_keep_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


async def main_async():
    ids_only = os.getenv("FETCH_IDS_ONLY", "False").lower() in ["true", "1"]
    retry_failed = os.getenv("RETRY_FAILED_RECORDS", "False").lower() in ["true", "1"]
    retry_missing_details = os.getenv("RESCRAPE_MISSING_DETAILS", "False").lower() in [
        "true",
        "1",
    ]
    failed_xids_path = Path(FAILED_XIDS_FILENAME)
    missing_details_path = Path(MISSING_DETAILS_XIDS_FILENAME)
    existing_ids = set()
    # Check if we want to rescrape existing records
    if os.getenv("RESCRAPE_EXISTING_RECORDS", "False").lower() not in ["true", "1"]:
        if os.path.exists("output/raw_records"):
            existing_ids = set(
                filename.split(".")[0]
                for filename in os.listdir("output/raw_records")
                if filename.endswith(".json")
            )

    async with aiohttp.ClientSession() as session:
        scraper = RecordScraper(session)
        # Determine whether to load record IDs from file, failed list, missing-details list, or fetch new ones
        if retry_failed or retry_missing_details:
            record_ids: list[str] = []
            if retry_failed:
                failed_ids = parse_failed_xids(failed_xids_path)
                record_ids.extend(failed_ids)
                logging.info(
                    "Retry-failed enabled: loaded %s record IDs from %s.",
                    len(failed_ids),
                    failed_xids_path,
                )
            if retry_missing_details:
                missing_ids = parse_missing_details_xids(Path("output/raw_records"))
                record_ids.extend(missing_ids)
                missing_details_path.parent.mkdir(parents=True, exist_ok=True)
                missing_details_path.write_text(
                    json.dumps(missing_ids, ensure_ascii=True, indent=2) + "\n",
                    encoding="utf-8",
                )
                logging.info(
                    "Rescrape-missing-details enabled: found %s record IDs in %s.",
                    len(missing_ids),
                    missing_details_path,
                )
            record_ids = dedupe_keep_order(record_ids)
            logging.info("Selected %s unique record IDs.", len(record_ids))
        else:
            if os.path.exists(RECORD_IDS_FILENAME) and os.getenv(
                "GET_RECORD_IDS", "True"
            ).lower() not in ["true", "1"]:
                record_ids = read_urls_from_file(RECORD_IDS_FILENAME)
                logging.info(f"Loaded {len(record_ids)} record URLs from file.")
            else:
                initial_url = get_full_url(
                    "/permalink?xid=7BAF2038B67611DF820F00166F1163D4&fcDb=&onlyDigi=&modeView=MOSAIC&searchAsPhrase=&patternTxt="
                )
                use_nav_partition = os.getenv("USE_NAV_PARTITION", "True").lower() in [
                    "true",
                    "1",
                ]
                if use_nav_partition:
                    nav_label = os.getenv("NAV_PARTITION_LABEL", "Sbírka fotografií")
                    delay_s = float(os.getenv("ARCHIVE_REQUEST_DELAY_S", "1.5"))
                    max_rows = int(os.getenv("ARCHIVE_MAX_ROWS", "10000"))
                    record_ids = await fetch_record_ids_via_nav(
                        session,
                        initial_url,
                        label=nav_label,
                        max_rows=max_rows,
                        delay_s=delay_s,
                    )
                else:
                    record_ids = await scraper.process_results_page(initial_url)
                if not record_ids:
                    raise RuntimeError("No record IDs fetched from archive.")
                save_ids_to_file(record_ids, RECORD_IDS_FILENAME)
                logging.info(f"Saved {len(record_ids)} record URLs to file.")

        if ids_only:
            logging.info("FETCH_IDS_ONLY enabled; skipping record scrape.")
            return
        if not record_ids:
            logging.info("No record IDs to scrape.")
            return

        failed_xids_path.parent.mkdir(parents=True, exist_ok=True)
        failed_xids_path.write_text("", encoding="utf-8")

        # Scrape records using the scraper
        effective_existing_ids = (
            set() if (retry_failed or retry_missing_details) else existing_ids
        )
        records = await scraper.scrape_records(
            record_ids, effective_existing_ids, failed_ids_path=str(failed_xids_path)
        )

        if records:
            logging.info(f"Scraped {len(records)} records.")
        else:
            logging.info("No records scraped.")


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
