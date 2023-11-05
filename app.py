import os
import json
import aiohttp
import asyncio
from bs4 import BeautifulSoup
from typing import List, Dict, Any
import logging
import time
import helpers
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper()))

RECORD_IDS_FILENAME = "output/available_record_ids.json"


async def process_results_page(session: aiohttp.ClientSession, url: str) -> List[str]:
    # Perform the initial GET request
    html = await helpers.fetch(session, url)
    soup = BeautifulSoup(html, "lxml")

    # Extract the required tokens
    source_page_value = soup.find("input", {"name": "_sourcePage"})["value"]
    fp_value = soup.find("input", {"name": "__fp"})["value"]

    # Prepare the second POST request URL
    jsessionid = session.cookie_jar.filter_cookies(url).get("JSESSIONID").value
    second_url = f"http://katalog.ahmp.cz/pragapublica/ViewControlImpl.action;jsessionid={jsessionid}?_eventName=myPageRows"

    # Prepare the data payload for the POST request
    data = {
        "pageRows": 10000,  # up to 10000 - won't show more than 10000 results, but it seems to be a bug on the website, there are more records apparently
        "_sourcePage": source_page_value,
        "__fp": fp_value,
    }

    # Perform the POST request
    post_html = await helpers.fetch(session, second_url, method="POST", data=data)
    post_soup = BeautifulSoup(post_html, "lxml")

    # Extract all the record URLs from the POST request's response

    record_links = post_soup.select(".mosaicLine .linkText")
    record_urls_ephemeral = [link["href"] for link in record_links]

    record_ids = [
        record_url_ephemeral.split("xid=")[1].split("&")[0]
        for record_url_ephemeral in record_urls_ephemeral
    ]

    return record_ids


def store_record(record: Dict[str, any]) -> None:
    t0 = time.perf_counter()
    output_filename = f"output/records/{record['xid']}.json"
    with open(output_filename, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False)
    logging.debug(f"{record['xid']} Saved in {time.perf_counter() - t0} s")


async def scrape_record(
    session: aiohttp.ClientSession, semaphore: asyncio.Semaphore, record_url: str
) -> Dict[str, any]:
    try:
        async with semaphore:
            html = await helpers.fetch(session, record_url)
            t0 = time.perf_counter()
            soup = BeautifulSoup(html, "html.parser")
            record = {
                item_row.select_one(".tabularLabel")
                .text.strip()
                .lower()
                .replace(":", ""): item_row.select_one(".tabularValue")
                .text.strip()
                for item_row in soup.select(".itemRow")
            }

            # Extract xid from the record URL and include it in the record data
            xid = record_url.split("xid=")[-1].split("&")[0]
            record["xid"] = xid

            record["rejstříkové záznamy"] = [
                {
                    "typ": index_block.select_one(".indexBlockLabel").text.strip(),
                    "obsah": index_block.select_one(
                        ".indexBlockPermalink"
                    ).text.strip(),
                }
                for index_block in soup.select(".indexBlockOne")
            ]
            logging.debug(f"{record['xid']} parsed in {time.perf_counter() - t0} s")
            store_record(record)
            return record
    except Exception as e:
        logging.error(f"Failed to fetch and process record from {record_url}: {e}")
        return None


async def scrape_records(
    session: aiohttp.ClientSession, record_ids: List[str], existing_ids: set
) -> List[Dict[str, Any]]:
    """
    Scrapes records from the given record IDs using the provided aiohttp session.
    If RESCRAPE_EXISTING_RECORDS is True, it will scrape all records regardless of whether they already exist.
    Otherwise, it will only scrape records that do not already exist in the provided existing_ids set.

    Args:
        session (aiohttp.ClientSession): The aiohttp session to use for making requests.
        record_ids (List[str]): The list of record IDs to scrape.
        existing_ids (set): The set of existing record IDs.

    Returns:
        List[Dict[str, Any]]: A list of scraped records.
    """
    records = []
    semaphore = asyncio.Semaphore(int(os.getenv("CONCURRENT_REQUESTS", 10)))
    start_time = time.perf_counter()
    tasks = [
        scrape_record(
            session,
            semaphore,
            helpers.get_full_url(f"/pragapublica/permalink?xid={record_id}"),
        )
        for record_id in record_ids
        if os.getenv("RESCRAPE_EXISTING_RECORDS", False) or record_id not in existing_ids
    ]

    completed, errors, times = 0, 0, []

    async for record, time_taken in helpers.gather_with_timing(tasks):
        if record:
            records.append(record)
            completed += 1
            logging.debug(
                f"{record['xid']} Request took: {time_taken:.6f} s (in wrapper)"
            )
        else:
            errors += 1
            logging.debug(f"Request failed: {time_taken:.6f} s (in wrapper)")

        times.append(time_taken)
        helpers.log_progress(times, completed, errors, len(tasks), start_time)

    helpers.log_summary(times)

    return records


async def main_async():
    existing_ids = set()
    if not os.getenv("RESCRAPE_EXISTING_RECORDS", False):
        # get list of all the files in the output/records directory
        existing_ids = set(
            [
                filename.split("/")[-1].split(".")[0]
                for filename in os.listdir("output/records")
            ]
        )

    async with aiohttp.ClientSession() as session:
        if os.path.exists(RECORD_IDS_FILENAME) and not os.getenv("GET_RECORD_IDS"):
            record_ids = helpers.read_urls_from_file(RECORD_IDS_FILENAME)
            logging.info(f"Loaded {len(record_ids)} record URLs from file.")
        else:
            print("Getting record IDs...")
            initial_url = "http://katalog.ahmp.cz/pragapublica/permalink?xid=7BAF2038B67611DF820F00166F1163D4&fcDb=&onlyDigi=&modeView=MOSAIC&searchAsPhrase=&patternTxt="
            record_ids = await process_results_page(session, initial_url)
            helpers.save_ids_to_file(record_ids, RECORD_IDS_FILENAME)
            logging.info(f"Saved {len(record_ids)} record URLs to file.")

        await scrape_records(session, record_ids, existing_ids)


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
