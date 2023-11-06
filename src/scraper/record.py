import json
import logging
from typing import Dict, Any


class Record:
    def __init__(self, record_data: Dict[str, Any]):
        self.data = record_data
        self.xid = record_data.get("xid")

    def save(self) -> None:
        output_filename = f"output/records/{self.xid}.json"
        with open(output_filename, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False)
        logging.info(f"Record {self.xid} saved.")
