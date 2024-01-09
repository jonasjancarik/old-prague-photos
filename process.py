import json
import os
import time

records = []

# load all the records from the output/records directory - those are all JSON files

file_list = os.listdir("output/records")

start_time = time.time()

for i, filename in enumerate(file_list):
    if filename.endswith(".json"):
        with open(f"output/records/{filename}", "r", encoding="utf-8") as file:
            records.append(json.load(file))
    percentage = (i + 1) / len(file_list) * 100
    elapsed_time = time.time() - start_time
    eta = elapsed_time / (i + 1) * (len(file_list) - i - 1)
    print(
        f"{percentage:.2f}% ({i+1}/{len(file_list)}) | {elapsed_time:.2f}s | ETA: {eta:.2f}s",
        end="\r",
    )

records_all_count = len(records)

print(f"\nLoaded {records_all_count} records.")

# drop all the records that don't have at least one key named "rejstříkové záznamy"."místo"
start_time = time.time()

for i, record in enumerate(records):
    if not any(
        "místo" in rejstrik["typ"].lower() for rejstrik in record["rejstříkové záznamy"]
    ):
        records.pop(i)
    elapsed_time = time.time() - start_time
    eta = elapsed_time / (i + 1) * (records_all_count - i - 1)
    print(
        f"{i+1}/{records_all_count} | Elapsed time: {elapsed_time:.2f}s | ETA: {eta:.2f}s",
        end="\r",
    )

print(f"\nFound {records} records with places.")

# save the records to a new file
with open("output/records_with_places.json", "w", encoding="utf-8") as file:
    json.dump(records, file, ensure_ascii=False)
