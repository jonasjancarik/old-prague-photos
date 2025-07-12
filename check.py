import json
import os
import pandas as pd
import logging
import re

# regional.municipality_part

directory = "output/geolocation/ok"

all_data = []
files_to_check = os.listdir(directory)
# [
#     os.path.join(directory, f) for f in os.listdir(directory) if f.endswith(".json")
# ]

# get records from output/filtered/records_with_cp.json
with open("output/filtered/records_with_cp.json", "r", encoding="utf-8") as file:
    records = json.load(file)

# get only the xid from each record
xids = [record["xid"] for record in records]

for file in files_to_check:
    if file.split("/")[-1].replace(".json", "") in xids:
        with open(os.path.join(directory, file), "r", encoding="utf-8") as f:
            file_data = json.load(f)
        # get geolocation.regionalStructure, which is a list of dicts, and get the one where type is "regional.municipality_part"
        regional_municipality_part = [
            item
            for item in file_data["geolocation"]["regionalStructure"]
            if item["type"] == "regional.municipality_part"
            and not item["name"].startswith("Praha ")
        ]

        # Find the rejistrikovy zaznam with the house number
        zaznam = next(
            (
                z
                for z in file_data.get("rejstříkové záznamy", [])
                if "čp." in z["obsah"].lower()
            ),
            None,
        )
        if not zaznam:
            logging.warning(f"No 'čp.' found in records for xid: {file_data['xid']}")
            continue

        string_to_geolocate = zaznam["obsah"].split(";")[0].strip()

        # Define the regex pattern with a capturing group for the desired part
        pattern = re.compile(r"dům čp\. \d+ \(Praha-([^)]+)\)")

        # Use search to find a match
        match = pattern.search(string_to_geolocate)

        # Check if a match was found and extract the group
        if match:
            extracted_part = match.group(1)
        else:
            # no extracted_part found
            print(f"No suitable string in {string_to_geolocate}")
            break

        # now check if the extracted neighbourhood name is in the regional_municipality_part list
        matched = False
        for item in regional_municipality_part:
            if item["name"] == extracted_part:
                matched = True
                break

        if not matched:
            print(string_to_geolocate)
            print(regional_municipality_part)
            print("NOT OK")

combined_data = pd.concat(all_data, ignore_index=True)
