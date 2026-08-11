import time
from tinydb import TinyDB, Query
import json

db = TinyDB(
    "output/db.json",
    sort_keys=True,
    indent=4,
    separators=(",", ": "),
    encoding="utf-8",
    ensure_ascii=False,
)

Record = Query()

records = db.all()
records_count = len(records)

print(f"Found {len(records)} records in the database.")

counter = 0

start_time = time.time()

for index, record in enumerate(records):
    # dump the record to a json file in the output/records directory - the name of the file will be the value from the xid field
    with open(f"output/records/{record['xid']}.json", "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False)
        counter += 1
        percentage = round((counter / records_count) * 100, 2)
        elapsed_time = time.time() - start_time
        eta = round((elapsed_time / counter) * (records_count - counter), 2)
        print(
            f"\rSaved {counter}/{records_count} ({percentage}%) to disk. ETA: {eta}s",
            end="",
        )
