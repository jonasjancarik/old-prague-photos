import json
import os
import time

records = []

PROCESS_RAW_RECORDS = True  # dev option, set to False if the records have already been processed once to save time and you're making changes to the filtering. For 10k records it takes around a minute or two to process them.

if PROCESS_RAW_RECORDS:
    # load all the records from the output/records directory - those are all JSON files
    print(
        "Loading scraped records from output/records and filtering out those without a place..."
    )

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
            "místo" in rejstrik["typ"].lower()
            for rejstrik in record["rejstříkové záznamy"]
        ):
            records.pop(i)
        elapsed_time = time.time() - start_time
        eta = elapsed_time / (i + 1) * (records_all_count - i - 1)
        print(
            f"{i+1}/{records_all_count} | Elapsed time: {elapsed_time:.2f}s | ETA: {eta:.2f}s",
            end="\r",
        )

    # save the records to a new file
    with open("output/records_with_places.json", "w", encoding="utf-8") as file:
        json.dump(records, file, ensure_ascii=False)

else:
    # load the records from the output/records_with_places.json file

    with open("output/records_with_places.json", "r", encoding="utf-8") as file:
        records = json.load(file)

print(f"\nFound {len(records)} records with places.")

# loop through all the records and find those that contain "č. p." or "č.p." in the "rejstříkové záznamy"."obsah" key and count them
filtered_records = {
    "records_with_cp": [],
    "records_with_cp_in_record_obsah": [],
    "records_without_cp": [],
    "records_without_dilo": [],
}

for record in records:
    zaznamy = record.get("rejstříkové záznamy", [])
    obsah_lower = record.get("obsah", "").lower()

    if any("čp." in zaznam["obsah"].lower() for zaznam in zaznamy):
        filtered_records["records_with_cp"].append(record)
    elif "čp." in obsah_lower:
        filtered_records["records_with_cp_in_record_obsah"].append(record)
    else:
        filtered_records["records_without_cp"].append(record)

for record in filtered_records["records_without_cp"]:
    item_started = False
    dilo_found = False
    for zaznam in record.get("rejstříkové záznamy", []):
        if zaznam["typ"].lower() == "dílo":
            # if not item_started:
            #     print('---')
            # print(zaznam["obsah"])
            dilo_found = True
    if not dilo_found:
        filtered_records["records_without_dilo"].append(record)

# print lengths of the lists and dump to files
for key, value in filtered_records.items():
    print(f"{key}: {len(value)}")

    if not os.path.exists("output/filtered"):
        os.mkdir("output/filtered")
    with open(f"output/filtered/{key}.json", "w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False)

print("Done.")
