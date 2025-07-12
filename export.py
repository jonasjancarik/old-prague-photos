import pandas as pd
import os
import json
import re
import time
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

EXPORT_MINIMAL_FILE = True

# Pre-compile regular expressions for efficiency
year_regex = re.compile(r"\d{4}")
year_only_regex = re.compile(r"\d{4}$")
year_range_regex = re.compile(r"\d{4}-\d{4}$")
specific_date_regex = re.compile(r"\d{1,2}\.\d{1,2}\.\d{4}$")
before_year_regex = re.compile(r"před \d{4}")
after_year_regex = re.compile(r"po \d{4}")
year_question_regex = re.compile(r"\d{4} \(\?\)$")
kol_year_regex = re.compile(r"kol\.\d{4}")

# Global counter and lock for thread-safe progress tracking
total_files_count = 0
processed_files_count = 0
start_time = time.time()
lock = Lock()


def parse_date(date_str):
    # Czech month mapping
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

    # Year only
    if year_only_regex.match(date_str):
        return {"start_date": f"{date_str}-01-01", "end_date": f"{date_str}-12-31"}

    # Year range
    elif year_range_regex.match(date_str):
        start_year, end_year = date_str.split("-")
        return {"start_date": f"{start_year}-01-01", "end_date": f"{end_year}-12-31"}

    # Czech month
    elif any(month in date_str for month in months_cz):
        for month, num in months_cz.items():
            if month in date_str:
                year = year_regex.search(date_str).group()
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
                return {
                    "start_date": f"{year}-{num:02d}-01",
                    "end_date": f"{year}-{num:02d}-{last_day}",
                }

    # Spring
    elif "jaro" in date_str:
        year = year_regex.search(date_str).group()
        return {"start_date": f"{year}-03-21", "end_date": f"{year}-06-20"}

    # only spring seems to be mentioned in the data

    # # Summer
    # elif "léto" in date_str:
    #     year = year_regex.search(date_str).group()
    #     return {"start_date": f"{year}-06-21", "end_date": f"{year}-09-20"}

    # # Autumn
    # elif "podzim" in date_str:
    #     year = year_regex.search(date_str).group()
    #     return {"start_date": f"{year}-09-21", "end_date": f"{year}-12-20"}

    # # Winter
    # elif "zima" in date_str:
    #     year = year_regex.search(date_str).group()
    #     return {"start_date": f"{year}-12-21", "end_date": f"{year}-03-20"}

    # Before year
    elif before_year_regex.match(date_str):
        year = int(year_regex.search(date_str).group())
        return {"start_date": "1800-01-01", "end_date": f"{year - 1}-12-31"}

    # After year
    elif after_year_regex.match(date_str):
        year = int(year_regex.search(date_str).group())
        return {"start_date": f"{year + 1}-01-01", "end_date": "2000-12-31"}

    # Specific date
    elif specific_date_regex.match(date_str):
        return {
            "start_date": datetime.strptime(date_str, "%d.%m.%Y").strftime("%Y-%m-%d"),
            "end_date": datetime.strptime(date_str, "%d.%m.%Y").strftime("%Y-%m-%d"),
        }

    # Year with question mark
    elif year_question_regex.match(date_str):
        year = year_regex.search(date_str).group()
        return {"start_date": f"{year}-01-01", "end_date": f"{year}-12-31"}

    # Kol. year
    elif kol_year_regex.match(date_str):
        year = year_regex.search(date_str).group()
        return {"start_date": f"{year}-01-01", "end_date": f"{year}-12-31"}

    else:
        return {"start_date": None, "end_date": None}


def process_file(filepath):
    global total_files_count, processed_files_count, start_time

    try:
        with open(filepath, "r", encoding="utf-8") as file:
            file_data = json.load(file)

            # Parse date
            if "datace" in file_data:
                date = parse_date(file_data["datace"])
                file_data["start_date"] = date["start_date"]
                file_data["end_date"] = date["end_date"]
            else:
                file_data["start_date"] = None
                file_data["end_date"] = None

            # Flatten JSON data
            return pd.json_normalize(file_data, sep="_")
    except Exception as e:
        print(f"Error processing {filepath}: {e}")
        return pd.DataFrame()

    finally:
        # Safely update the counter
        with lock:
            processed_files_count += 1
            # calculate and print progress
            if (
                processed_files_count % 10 == 0
                or processed_files_count == total_files_count
            ):
                files_per_second = processed_files_count / (time.time() - start_time)
                eta = (total_files_count - processed_files_count) / files_per_second

                print(
                    f"\rProcessed {processed_files_count}/{total_files_count} files ({files_per_second:.2f} files/s, ETA: {eta:.0f}s)",
                    end="",
                )


def load_and_flatten_json(directory):
    global total_files_count

    all_data = []
    files = [
        os.path.join(directory, f) for f in os.listdir(directory) if f.endswith(".json")
    ]
    total_files_count = len(files)
    with ThreadPoolExecutor(
        max_workers=1
    ) as executor:  # todo: multi-threading not efficient here, revert to a single-threaded solution
        results = executor.map(process_file, files)
        all_data = [result for result in results if not result.empty]

    combined_data = pd.concat(all_data, ignore_index=True)
    return combined_data


combined_data = load_and_flatten_json("output/geolocation/ok")

if EXPORT_MINIMAL_FILE:
    # keep only druh,obsah,datace,zobrazeno,xid,start_date,end_date,geolocation_position_lon,geolocation_position_lat,geolocation_type,geolocation_endpoint,autor,poznámka columns
    columns_to_keep = [
        "druh",
        "obsah",
        "datace",
        "zobrazeno",
        "xid",
        "start_date",
        "end_date",
        "geolocation_position_lon",
        "geolocation_position_lat",
        "geolocation_type",
        "geolocation_endpoint",
        "autor",
        "poznámka",
    ]
    combined_data = combined_data[columns_to_keep]

print("\nSaving to csv...")
combined_data.to_csv("output/old_prague_photos.csv", index=False)
