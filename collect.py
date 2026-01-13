import os
import aiohttp
import asyncio
import logging

from src.scraper.nav_partition import fetch_record_ids_via_nav
from src.scraper.record_scraper import RecordScraper
from src.utils.helpers import get_full_url, read_urls_from_file, save_ids_to_file

RECORD_IDS_FILENAME = "output/available_record_ids.json"
logging.basicConfig(level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper()))


async def main_async():
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
        # Determine whether to load record IDs from file or fetch new ones
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

        # Scrape records using the scraper
        records = await scraper.scrape_records(record_ids, existing_ids)

        if records:
            logging.info(f"Scraped {len(records)} records.")
        else:
            logging.info("No records scraped.")


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
