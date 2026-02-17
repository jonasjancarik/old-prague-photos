import asyncio
import os
import time
import html as html_lib
import logging
import re
import json
from typing import Any, List, Set
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup

from src.scraper.record import Record
from src.utils.helpers import get_full_url, log_progress, log_summary


SCAN_COUNT_PATTERN = re.compile(r"(\d+)\s+obrázk", re.IGNORECASE)
ZOOMIFY_URL_PATTERN = re.compile(r"Zoomify\.action[^\"']+", re.IGNORECASE)
ZOOMIFY_PATH_PATTERN = re.compile(r'zoomifyImgPath\s*=\s*"([^"]+)"', re.IGNORECASE)
DEFAULT_REQUEST_HEADERS = {
    "User-Agent": "python-requests/2.32.3",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def extract_scan_count(page_html: str) -> int | None:
    match = SCAN_COUNT_PATTERN.search(page_html)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def extract_zoomify_url(page_html: str, base_url: str) -> str | None:
    match = ZOOMIFY_URL_PATTERN.search(page_html)
    if not match:
        return None
    return urljoin(base_url, html_lib.unescape(match.group(0)))


def extract_zoomify_img_path(page_html: str) -> str | None:
    match = ZOOMIFY_PATH_PATTERN.search(page_html)
    return match.group(1) if match else None


def with_scan_index(url: str, scan_index: int) -> str:
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    query["scanIndex"] = [str(scan_index)]
    new_query = urlencode(query, doseq=True)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))


def with_scan_number(url: str, scan_number: int) -> str:
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    query["scan"] = [str(scan_number)]
    new_query = urlencode(query, doseq=True)
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, new_query, f"scan{scan_number}")
    )


def build_preview_url(zoomify_img_path: str) -> str:
    base = zoomify_img_path.replace("/zoomify/", "/image/").rstrip("/")
    return f"{base}/nahled_maly.jpg"


def extract_xid_from_url(url: str) -> str:
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    xid = query.get("xid", [""])[0]
    return str(xid or "").strip()


class RecordScraper:
    def __init__(self, session: Any | None = None):
        self.session = session
        self.semaphore = asyncio.Semaphore(int(os.getenv("CONCURRENT_REQUESTS", 1)))
        self.record_delay_s = float(os.getenv("ARCHIVE_RECORD_DELAY_S", "0"))
        self.request_timeout_s = float(os.getenv("ARCHIVE_REQUEST_TIMEOUT_S", "30"))
        self.request_max_retries = int(os.getenv("ARCHIVE_REQUEST_RETRIES", "10"))
        self.request_retry_base_s = float(
            os.getenv("ARCHIVE_REQUEST_RETRY_BASE_S", "0.5")
        )
        self._request_headers = dict(DEFAULT_REQUEST_HEADERS)
        self._request_lock = asyncio.Lock()
        self._last_request_ts = 0.0
        self._shared_http = self._new_http_session()

    def _new_http_session(self) -> requests.Session:
        session = requests.Session()
        session.headers.update(self._request_headers)
        return session

    def _request_with_retries(
        self,
        url: str,
        *,
        method: str = "GET",
        data: dict[str, object] | None = None,
        session: requests.Session | None = None,
    ) -> str:
        active_session = session or self._shared_http
        delay_s = self.request_retry_base_s
        last_error: Exception | None = None
        for attempt in range(1, self.request_max_retries + 1):
            try:
                response = active_session.request(
                    method=method,
                    url=url,
                    data=data,
                    timeout=self.request_timeout_s,
                    allow_redirects=True,
                )
                response.raise_for_status()
                return response.text
            except requests.RequestException as exc:
                last_error = exc
                status = getattr(getattr(exc, "response", None), "status_code", None)
                logging.error(
                    "Request to %s failed on attempt %s/%s (status=%s): %s",
                    url,
                    attempt,
                    self.request_max_retries,
                    status,
                    exc,
                )
                if attempt >= self.request_max_retries:
                    break
                time.sleep(delay_s)
                delay_s = min(delay_s * 2, 60.0)
        raise RuntimeError(f"Failed to fetch {url}: {last_error}")

    async def _throttled_fetch(
        self,
        url: str,
        *,
        method: str = "GET",
        data: dict[str, object] | None = None,
        session: requests.Session | None = None,
    ) -> str:
        if self.record_delay_s > 0:
            async with self._request_lock:
                elapsed = time.perf_counter() - self._last_request_ts
                wait_s = self.record_delay_s - elapsed
                if wait_s > 0:
                    await asyncio.sleep(wait_s)
                self._last_request_ts = time.perf_counter()
        return await asyncio.to_thread(
            self._request_with_retries,
            url,
            method=method,
            data=data,
            session=session,
        )

    async def process_results_page(self, url: str) -> List[str]:
        with self._new_http_session() as http_session:
            html = await self._throttled_fetch(url, session=http_session)
            soup = BeautifulSoup(html, "lxml")
            source_page_value = soup.find("input", {"name": "_sourcePage"})["value"]
            fp_value = soup.find("input", {"name": "__fp"})["value"]
            second_url = get_full_url(f"/ViewControlImpl.action?_eventName=myPageRows")
            data = {
                "pageRows": 10000,
                "_sourcePage": source_page_value,
                "__fp": fp_value,
            }
            post_html = await self._throttled_fetch(
                second_url,
                method="POST",
                data=data,
                session=http_session,
            )
            post_soup = BeautifulSoup(post_html, "lxml")
            record_links = post_soup.select(".mosaicLine .linkText")
            record_urls_ephemeral = [link["href"] for link in record_links]
            record_ids = [
                record_url_ephemeral.split("xid=")[1].split("&")[0]
                for record_url_ephemeral in record_urls_ephemeral
            ]
            return record_ids

    async def scrape_record(self, record_url: str):
        start_time = time.perf_counter()
        xid = extract_xid_from_url(record_url)
        try:
            async with self.semaphore:
                with self._new_http_session() as isolated_session:
                    html = await self._throttled_fetch(
                        record_url,
                        session=isolated_session,
                    )
                    soup = BeautifulSoup(html, "lxml")
                    record_data = {
                        item_row.select_one(".tabularLabel")
                        .text.strip()
                        .lower()
                        .replace(":", ""): item_row.select_one(".tabularValue")
                        .text.strip()
                        for item_row in soup.select(".itemRow")
                    }
                    permalink_node = soup.select_one("#permalinkPopupTextarea")
                    if not permalink_node:
                        raise Exception(f"Permalink not found for {record_url}")
                    xid_from_permalink = extract_xid_from_url(permalink_node.text.strip())
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
                    scan_count = extract_scan_count(html)
                    scan_count_from_page = scan_count is not None
                    if scan_count is None:
                        scan_count = 1
                    scan_indices = list(range(scan_count)) if scan_count > 0 else []
                    scan_previews = []
                    scan_zoomify_paths = []
                    zoomify_url = extract_zoomify_url(html, record_url)
                    if zoomify_url:
                        zoomify_xid = extract_xid_from_url(zoomify_url)
                        if (
                            zoomify_xid
                            and xid
                            and zoomify_xid.lower() != xid.lower()
                        ):
                            logging.warning(
                                "Ignoring mismatched Zoomify xid for %s: %s",
                                xid,
                                zoomify_xid,
                            )
                            zoomify_url = None

                    if not zoomify_url and not scan_count_from_page:
                        scan_count = 0
                        scan_indices = []
                    if scan_indices:
                        for scan_index in scan_indices:
                            zoomify_img_path = ""
                            preview_url = ""
                            try:
                                scan_number = scan_index + 1
                                scan_url = with_scan_number(record_url, scan_number)
                                scan_html = (
                                    html
                                    if scan_index == 0
                                    else await self._throttled_fetch(
                                        scan_url,
                                        session=isolated_session,
                                    )
                                )
                                zoomify_img_path = extract_zoomify_img_path(scan_html) or ""
                                if not zoomify_img_path and zoomify_url:
                                    zoomify_scan_url = with_scan_index(
                                        zoomify_url, scan_index
                                    )
                                    zoomify_html = await self._throttled_fetch(
                                        zoomify_scan_url,
                                        session=isolated_session,
                                    )
                                    zoomify_img_path = (
                                        extract_zoomify_img_path(zoomify_html) or ""
                                    )
                                if zoomify_img_path:
                                    preview_url = build_preview_url(zoomify_img_path)
                            except Exception as exc:
                                logging.warning(
                                    f"Failed to resolve scan {scan_index} for {xid}: {exc}"
                                )
                            scan_zoomify_paths.append(zoomify_img_path)
                            scan_previews.append(preview_url)

                    record_data["scan_count"] = scan_count
                    record_data["scan_indices"] = scan_indices
                    record_data["scan_previews"] = scan_previews
                    record_data["scan_zoomify_paths"] = scan_zoomify_paths
                    record_data["has_scans"] = scan_count > 1

                    record = Record(record_data)
                    return record, time.perf_counter() - start_time, None
        except Exception as e:
            logging.error(f"Failed to fetch and process record from {record_url}: {e}")
            failure = {
                "xid": xid,
                "record_url": record_url,
                "error": str(e),
            }
            return None, time.perf_counter() - start_time, failure

    async def scrape_records(
        self,
        record_ids: List[str],
        existing_ids: Set[str],
        failed_ids_path: str | None = None,
    ) -> List[Record]:
        start_time = time.perf_counter()
        urls_to_scrape = [
            get_full_url(f"/permalink?xid={record_id}")
            for record_id in record_ids
            if os.getenv("RESCRAPE_EXISTING_RECORDS", "False").lower() in ["true", "1"]
            or record_id not in existing_ids
        ]
        total = len(record_ids)
        skipped = total - len(urls_to_scrape)
        if skipped:
            logging.info(
                "Scraping %s records (total %s, skipping %s existing)",
                len(urls_to_scrape),
                total,
                skipped,
            )
        else:
            logging.info("Scraping %s records (total %s)", len(urls_to_scrape), total)
        completed, errors, times = 0, 0, []
        records = []
        failed_file = None
        if failed_ids_path:
            failed_path = Path(failed_ids_path)
            failed_path.parent.mkdir(parents=True, exist_ok=True)
            failed_file = failed_path.open("a", encoding="utf-8")
        try:
            for url in urls_to_scrape:
                record, time_taken, failure = await self.scrape_record(url)
                if record:
                    record.save()  # Save immediately after scraping
                    records.append(record)
                    completed += 1
                else:
                    errors += 1
                    if failed_file and failure:
                        failed_file.write(json.dumps(failure, ensure_ascii=True) + "\n")
                times.append(time_taken)
                log_progress(times, completed, errors, len(urls_to_scrape), start_time)
        finally:
            if failed_file:
                failed_file.close()
        log_summary(times)
        return records
