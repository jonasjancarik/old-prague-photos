from dotenv import load_dotenv
import os
import backoff
import aiohttp
import time
import backoff
from fake_useragent import UserAgent
import logging
from datetime import timedelta
import json
import asyncio
from typing import List

# Load the environment variables at module load time.
load_dotenv()

# Set up the logging configuration.
logging.basicConfig(level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper()))

# Fake User-Agent setup.
ua = UserAgent()
user_agent = ua.random


def get_full_url(path: str) -> str:
    return f'{os.getenv("BASE_URL", "http://katalog.ahmp.cz/pragapublica")}{path}'


@backoff.on_exception(backoff.expo, aiohttp.ClientError, max_tries=10)
async def fetch(
    session: aiohttp.ClientSession, url: str, method="GET", data=None
) -> str:
    try:
        t0 = time.perf_counter()
        async with session.request(
            method, url, data=data, headers={"User-Agent": user_agent}
        ) as response:
            response.raise_for_status()
            logging.debug(
                f'{url.split("=")[-1]} Request took: {time.perf_counter() - t0} s'
            )
            response_text = await response.text()
            logging.debug(
                f'{url.split("=")[-1]} Request took: {time.perf_counter() - t0} s (incl. text())'
            )
            return response_text
    except aiohttp.ClientResponseError as e:
        logging.error(f"Request to {url} failed with status {e.status}: {e.message}")
        raise  # Reraising the exception will trigger the backoff
    except aiohttp.ClientError as e:
        logging.error(f"Client error occurred: {e}")
        raise  # Reraising the exception will trigger the backoff


def calculate_median(times):
    times.sort()
    mid_index = len(times) // 2
    if len(times) % 2 == 0:
        return (times[mid_index - 1] + times[mid_index]) / 2
    else:
        return times[mid_index]


def log_progress(times, completed, errors, task_count, start_time):
    elapsed_time = time.perf_counter() - start_time
    percentage = (completed + errors) / task_count * 100
    eta = timedelta(
        seconds=int(elapsed_time / max(completed, 1) * (task_count - completed))
    )
    avg_time = sum(times) / len(times)
    median_time = calculate_median(times)
    logging.info(
        f"OK: {completed}, Failed: {errors}, Total: {task_count}, {percentage:.2f}%. ETA: {eta} | "
        f"avg {avg_time:.4f} s | med {median_time:.4f} s | {(completed + errors) / elapsed_time:.2f} req/s"
    )


def log_summary(times):
    try:
        avg_time = sum(times) / len(times)
        median_time = calculate_median(times)
        logging.info(f"Average time per record: {avg_time:.6f} s")
        logging.info(f"Median time per record: {median_time:.6f} s")
    except ZeroDivisionError:
        pass


def save_ids_to_file(urls: List[str], filename: str) -> None:
    with open(filename, "w") as file:
        json.dump(urls, file)


def read_urls_from_file(filename: str) -> List[str]:
    with open(filename, "r") as file:
        return json.load(file)
