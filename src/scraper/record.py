import json
import logging
from pathlib import Path
from typing import Dict, Any


class Record:
    def __init__(self, record_data: Dict[str, Any]):
        self.data = record_data
        self.xid = record_data.get("xid")

    def save(self, output_dir: str | Path = "output/raw_records") -> Path:
        output_filename = Path(output_dir) / f"{self.xid}.json"
        output_filename.parent.mkdir(parents=True, exist_ok=True)
        with output_filename.open("w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False)
        logging.info(f"Record {self.xid} saved.")
        return output_filename
