import asyncio
import aiohttp
import os
import time
from typing import List, Set
from bs4 import BeautifulSoup
from src.utils.helpers import fetch, get_full_url, log_progress, log_summary
from src.scraper.record import Record
import logging


class RecordScraper:
    def __init__(self, session: aiohttp.ClientSession):
        self.session = session
        self.semaphore = asyncio.Semaphore(int(os.getenv("CONCURRENT_REQUESTS", 10)))

    async def process_results_page(self, url: str) -> List[str]:
        html = await fetch(
            self.session, url
        )  # this will also get the important jsessionid cookie
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
                async with aiohttp.ClientSession() as isolated_session:  # the website seems to send mixed up responses when using the same session (i.e. cookies)
                    start_time = time.perf_counter()
                    html = await fetch(isolated_session, record_url)
                    soup = BeautifulSoup(html, "lxml")
                    record_data = {
                        item_row.select_one(".tabularLabel")
                        .text.strip()
                        .lower()
                        .replace(":", ""): item_row.select_one(".tabularValue")
                        .text.strip()
                        for item_row in soup.select(".itemRow")
                    }
                    xid = record_url.split("xid=")[-1].split("&")[0]
                    xid_from_permalink = soup.select_one(
                        "#permalinkPopupTextarea"
                    ).text.split("xid=")[1]
                    # check if the xid from the permalink matches the xid from the URL
                    # mismatch happens sometimes when multiple requests are sent at the same
                    # time with the same session cookie. This shouldn't happen with the isolated_session in use
                    # (instead of the shared self.session)
                    if xid != xid_from_permalink:
                        logging.error(f"XID mismatch for {record_url}")
                        raise Exception(f"XID mismatch for {record_url}")
                    record_data["xid"] = xid
                    record_data["rejstříkové záznamy"] = [
                        {
                            "typ": index_block.select_one(
                                ".indexBlockLabel"
                            ).text.strip(),
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
        logging.info(f"Scraping {len(tasks)} records...")
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
