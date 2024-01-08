import pandas as pd
import os
import json
import re
from datetime import datetime


def parse_date(date_str):
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

    # Match different date formats
    if re.match(r"\d{4}$", date_str):  # Year only
        return {"start_date": f"{date_str}-01-01", "end_date": f"{date_str}-12-31"}
    elif re.match(r"\d{4}-\d{4}$", date_str):  # Year range
        start_year, end_year = date_str.split("-")
        return {"start_date": f"{start_year}-01-01", "end_date": f"{end_year}-12-31"}
    elif any(month in date_str for month in months_cz):  # Czech month
        for month, num in months_cz.items():
            if month in date_str:
                year = re.search(r"\d{4}", date_str).group()
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
    elif "léto" in date_str:  # Summer
        year = re.search(r"\d{4}", date_str).group()
        return {"start_date": f"{year}-06-21", "end_date": f"{year}-09-20"}
    elif re.match(r"před \d{4}", date_str):  # Before year
        year = int(re.search(r"\d{4}", date_str).group())
        return {"start_date": "1800-01-01", "end_date": f"{year - 1}-12-31"}
    elif re.match(r"po \d{4}", date_str):  # After year
        year = int(re.search(r"\d{4}", date_str).group())
        return {"start_date": f"{year + 1}-01-01", "end_date": "2000-12-31"}
    elif re.match(r"\d{1,2}\.\d{1,2}\.\d{4}$", date_str):  # Specific date
        return {
            "start_date": datetime.strptime(date_str, "%d.%m.%Y").strftime("%Y-%m-%d"),
            "end_date": datetime.strptime(date_str, "%d.%m.%Y").strftime("%Y-%m-%d"),
        }
    elif re.match(r"\d{4} \(\?\)$", date_str):  # Year with question mark
        year = re.search(r"\d{4}", date_str).group()
        return {"start_date": f"{year}-01-01", "end_date": f"{year}-12-31"}
    elif re.match(r"kol\.\d{4}", date_str):  # kol. year
        year = re.search(r"\d{4}", date_str).group()
        return {"start_date": f"{year}-01-01", "end_date": f"{year}-12-31"}
    else:
        return {"start_date": None, "end_date": None}


def load_and_flatten_json(directory):
    all_data = []
    files = os.listdir(directory)
    for counter, filename in enumerate(files, start=1):
        if filename.endswith(".json"):
            with open(os.path.join(directory, filename), "r", encoding="utf-8") as file:
                print(f"\rProcessing file {counter}/{len(files)}", end="")
                file_data = json.load(file)

                # Parse date
                if "datace" in file_data:
                    date = parse_date(file_data["datace"])
                    file_data["start_date"] = date["start_date"]
                    file_data["end_date"] = date["end_date"]
                else:
                    file_data["start_date"] = None
                    file_data["end_date"] = None

                # Flatten the JSON data including nested structures
                flattened_data = pd.json_normalize(file_data, sep="_")
                all_data.append(flattened_data)

    combined_data = pd.concat(all_data, ignore_index=True)
    return combined_data


directory = "output/geolocation/ok"
combined_data = load_and_flatten_json(directory)
combined_data.to_csv("output/old_prague_photos.csv", index=False)
