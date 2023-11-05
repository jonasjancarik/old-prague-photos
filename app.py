import os
import json
import aiohttp
import asyncio
from bs4 import BeautifulSoup
import logging
import time
from typing import Dict, Any, List, Set
from helpers import (
    get_full_url,
    fetch,
    log_progress,
    log_summary,
    save_ids_to_file,
    read_urls_from_file,
)

RECORD_IDS_FILENAME = "output/available_record_ids.json"
logging.basicConfig(level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper()))


class Record:
    def __init__(self, record_data: Dict[str, Any]):
        self.data = record_data
        self.xid = record_data.get("xid")

    def save(self) -> None:
        output_filename = f"output/records/{self.xid}.json"
        with open(output_filename, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False)
        logging.info(f"Record {self.xid} saved.")


class RecordScraper:
    def __init__(self, session: aiohttp.ClientSession):
        self.session = session
        self.semaphore = asyncio.Semaphore(int(os.getenv("CONCURRENT_REQUESTS", 10)))

    async def process_results_page(self, url: str) -> List[str]:
        html = await fetch(self.session, url)  # this will also get the important jsessionid cookie
        soup = BeautifulSoup(html, "lxml")
        source_page_value = soup.find("input", {"name": "_sourcePage"})["value"]
        fp_value = soup.find("input", {"name": "__fp"})["value"]
        second_url = get_full_url(f"/ViewControlImpl.action?_eventName=myPageRows")
        data = {
            "pageRows": 10000,
            "_sourcePage": source_page_value,
            "__fp": fp_value,
        }
        post_html = await fetch(self.session, second_url, method="POST", data=data)
        post_soup = BeautifulSoup(post_html, "lxml")
        record_links = post_soup.select(".mosaicLine .linkText")
        record_urls_ephemeral = [link["href"] for link in record_links]
        record_ids = [
            record_url_ephemeral.split("xid=")[1].split("&")[0]
            for record_url_ephemeral in record_urls_ephemeral
        ]
        return record_ids

    async def scrape_record(self, record_url: str) -> Record:
        try:
            async with self.semaphore:
                start_time = time.perf_counter()
                html = await fetch(self.session, record_url)
                soup = BeautifulSoup(html, "html.parser")
                record_data = {
                    item_row.select_one(".tabularLabel")
                    .text.strip()
                    .lower()
                    .replace(":", ""): item_row.select_one(".tabularValue")
                    .text.strip()
                    for item_row in soup.select(".itemRow")
                }
                xid = record_url.split("xid=")[-1].split("&")[0]
                record_data["xid"] = xid
                record_data["rejstříkové záznamy"] = [
                    {
                        "typ": index_block.select_one(".indexBlockLabel").text.strip(),
                        "obsah": index_block.select_one(
                            ".indexBlockPermalink"
                        ).text.strip(),
                    }
                    for index_block in soup.select(".indexBlockOne")
                ]
                record = Record(record_data)
                return record, time.perf_counter() - start_time
        except Exception as e:
            logging.error(f"Failed to fetch and process record from {record_url}: {e}")
            return None, time.perf_counter() - start_time

    async def scrape_records(
        self, record_ids: List[str], existing_ids: Set[str]
    ) -> List[Record]:
        start_time = time.perf_counter()
        tasks = [
            self.scrape_record(get_full_url(f"/permalink?xid={record_id}"))
            for record_id in record_ids
            if os.getenv("RESCRAPE_EXISTING_RECORDS", "False").lower() in ["true", "1"]
            or record_id not in existing_ids
        ]
        completed, errors, times = 0, 0, []
        records = []
        for task in asyncio.as_completed(tasks):
            record, time_taken = await task
            if record:
                record.save()  # Save immediately after scraping
                records.append(record)
                completed += 1
            else:
                errors += 1
            times.append(time_taken)
            log_progress(times, completed, errors, len(tasks), start_time)
        log_summary(times)
        return records


async def main_async():
    existing_ids = set()
    # Check if we want to rescrape existing records
    if not os.getenv("RESCRAPE_EXISTING_RECORDS", "False").lower() in ["true", "1"]:
        if os.path.exists("output/records"):
            existing_ids = set(
                filename.split(".")[0]
                for filename in os.listdir("output/records")
                if filename.endswith(".json")
            )

    async with aiohttp.ClientSession() as session:
        scraper = RecordScraper(session)
        # Determine whether to load record IDs from file or fetch new ones
        if os.path.exists(RECORD_IDS_FILENAME) and not os.getenv(
            "GET_RECORD_IDS", "True"
        ).lower() in ["true", "1"]:
            record_ids = read_urls_from_file(RECORD_IDS_FILENAME)
            logging.info(f"Loaded {len(record_ids)} record URLs from file.")
        else:
            initial_url = get_full_url('/permalink?xid=7BAF2038B67611DF820F00166F1163D4&fcDb=&onlyDigi=&modeView=MOSAIC&searchAsPhrase=&patternTxt=')
            record_ids = await scraper.process_results_page(initial_url)
            save_ids_to_file(record_ids, RECORD_IDS_FILENAME)
            logging.info(f"Saved {len(record_ids)} record URLs to file.")

        # Scrape records using the scraper
        records = await scraper.scrape_records(record_ids, existing_ids)

        if records:
            logging.info(f"Scraped {len(records)} records.")
        else:
            logging.warning("No records scraped.")


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
