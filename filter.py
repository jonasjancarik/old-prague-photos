import json
import os

# load records from file
records = []

with open("output/records_with_places.json", "r", encoding="utf-8") as file:
    records = json.load(file)

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
