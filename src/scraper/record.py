import json
import logging
import os
from typing import Dict, Any


class Record:
    def __init__(self, record_data: Dict[str, Any]):
        self.data = record_data
        self.xid = record_data.get("xid")

    def save(self) -> None:
        output_filename = f"output/raw_records/{self.xid}.json"
        # create the directory if it doesn't exist
        os.makedirs(os.path.dirname(output_filename), exist_ok=True)
        with open(output_filename, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False)
        logging.info(f"Record {self.xid} saved.")
