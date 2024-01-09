import os
import aiohttp
import asyncio
import logging
from src.scraper.record_scraper import RecordScraper
from src.utils.helpers import (
    get_full_url,
    save_ids_to_file,
    read_urls_from_file,
)

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
            record_ids = await scraper.process_results_page(initial_url)
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
