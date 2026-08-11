import logging
from pathlib import Path
from typing import Dict, Any

from src.pipeline.atomic_io import atomic_write_json


class Record:
    def __init__(self, record_data: Dict[str, Any]):
        self.data = record_data
        self.xid = record_data.get("xid")

    def save(self, output_dir: str | Path = "output/raw_records") -> Path:
        output_filename = Path(output_dir) / f"{self.xid}.json"
        atomic_write_json(output_filename, self.data)
        logging.info(f"Record {self.xid} saved.")
        return output_filename
