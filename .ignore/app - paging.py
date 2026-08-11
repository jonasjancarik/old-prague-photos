import os
import json
import aiohttp
import asyncio
from bs4 import BeautifulSoup
from typing import List, Dict, Optional, Tuple
import logging
import time
from datetime import timedelta

logging.basicConfig(level=logging.INFO)

MAX_PAGES = 9999999999
GET_RECORD_URLS = True
RESCRAPE_EXISTING_RECORDS = True
BASE_URL = "http://katalog.ahmp.cz"
CONCURRENT_REQUESTS = 30
RECORD_URLS_FILENAME = "record_urls.json"
OUTPUT_FILENAME = "output/records.json"


def get_full_url(path: str) -> str:
    return f"{BASE_URL}{path}"


async def fetch(session: aiohttp.ClientSession, url: str) -> str:
    async with session.get(url) as response:
        response.raise_for_status()
        return await response.text()


async def process_results_page(
    session: aiohttp.ClientSession, url: str
) -> Tuple[List[str], Optional[str]]:
    html = await fetch(session, url)
    soup = BeautifulSoup(html, "html.parser")

    record_links = soup.select(".mosaicLine .linkText")
    record_urls_ephemeral = [link["href"] for link in record_links]

    record_urls = [
        get_full_url(
            "/pragapublica/permalink?xid="
            + record_url_ephemeral.split("xid=")[1].split("&")[0]
        )
        for record_url_ephemeral in record_urls_ephemeral
    ]

    try:
        next_page_path = soup.select("#paginatiorBlock .pageIco a")[2]["href"]
        next_page_url = get_full_url(next_page_path)
    except IndexError:
        next_page_url = None

    return record_urls, next_page_url


async def scrape_record(
    session: aiohttp.ClientSession, semaphore: asyncio.Semaphore, record_url: str
) -> Dict[str, any]:
    async with semaphore:
        html = await fetch(session, record_url)
        soup = BeautifulSoup(html, "html.parser")
        record = {
            item_row.select_one(".tabularLabel")
            .text.strip(): item_row.select_one(".tabularValue")
            .text.strip()
            for item_row in soup.select(".itemRow")
        }

        # Extract xid from the record URL and include it in the record data
        xid = record_url.split("xid=")[-1].split("&")[0]
        record["xid"] = xid

        record["Rejstříkové záznamy"] = [
            {
                "typ": index_block.select_one(".indexBlockLabel").text.strip(),
                "obsah": index_block.select_one(".indexBlockPermalink").text.strip(),
            }
            for index_block in soup.select(".indexBlockOne")
        ]

        return record


async def scrape_records(
    session: aiohttp.ClientSession, record_urls: List[str], existing_xids: set
) -> List[Dict[str, any]]:
    records = []
    semaphore = asyncio.Semaphore(CONCURRENT_REQUESTS)
    start_time = time.time()

    tasks = []
    for url in record_urls:
        xid = url.split("xid=")[-1].split("&")[0]
        if RESCRAPE_EXISTING_RECORDS or xid not in existing_xids:
            tasks.append(scrape_record(session, semaphore, url))

    completed = 0
    for future in asyncio.as_completed(tasks):
        record = await future
        records.append(record)
        completed += 1
        elapsed_time = time.time() - start_time
        avg_time_per_record = elapsed_time / completed
        remaining_time = avg_time_per_record * (len(record_urls) - completed)
        eta = timedelta(seconds=int(remaining_time))
        logging.info(f"Scraped {completed}/{len(record_urls)} records. ETA: {eta}")
    return records


def save_urls_to_file(urls: List[str], filename: str) -> None:
    with open(filename, "w") as file:
        json.dump(urls, file)


def read_urls_from_file(filename: str) -> List[str]:
    with open(filename, "r") as file:
        return json.load(file)


def save_records_to_file(records: List[Dict[str, any]], filename: str) -> None:
    os.makedirs(os.path.dirname(filename), exist_ok=True)
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)


async def main_async():
    existing_xids = set()
    if os.path.exists(OUTPUT_FILENAME) and not RESCRAPE_EXISTING_RECORDS:
        with open(OUTPUT_FILENAME, "r", encoding="utf-8") as f:
            existing_records = json.load(f)
            existing_xids = {record.get("xid") for record in existing_records}

    async with aiohttp.ClientSession() as session:
        if os.path.exists(RECORD_URLS_FILENAME) and not GET_RECORD_URLS:
            record_urls = read_urls_from_file(RECORD_URLS_FILENAME)
            logging.info(f"Loaded {len(record_urls)} record URLs from file.")
        else:
            record_urls = []
            next_page_url = get_full_url(
                "/pragapublica/permalink?xid=7BAF2038B67611DF820F00166F1163D4&fc3D4&fcDb=&onlyDigi=&modeView=MOSAIC&searchAsPhrase=&patternTxt="
            )
            page_counter = 0
            while next_page_url and page_counter < MAX_PAGES:
                new_record_urls, next_page_url = await process_results_page(
                    session, next_page_url
                )
                record_urls.extend(new_record_urls)
                page_counter += 1
                logging.info(f"Processed {page_counter} pages")
            save_urls_to_file(record_urls, RECORD_URLS_FILENAME)
            logging.info(f"Saved {len(record_urls)} record URLs to file.")

        records = await scrape_records(session, record_urls, existing_xids)
        save_records_to_file(records, OUTPUT_FILENAME)


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
