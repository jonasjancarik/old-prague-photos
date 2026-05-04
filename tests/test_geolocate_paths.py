import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from src.pipeline.geolocate import (
    geolocate_record,
    get_processed_ids,
    process_records,
)


class GeolocatePathTests(unittest.TestCase):
    def test_get_processed_ids_uses_custom_directories(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            ok_dir = root / "run" / "geolocation" / "ok"
            failed_dir = root / "run" / "geolocation" / "failed"
            ok_dir.mkdir(parents=True)
            (ok_dir / "A1.json").write_text("{}", encoding="utf-8")
            (failed_dir / "records_with_cp").mkdir(parents=True)
            (failed_dir / "records_with_cp" / "B2.json").write_text(
                "{}",
                encoding="utf-8",
            )

            self.assertEqual(
                get_processed_ids(
                    False,
                    output_ok_dir=ok_dir,
                    failed_base_dir=failed_dir,
                ),
                {"A1", "B2"},
            )

    def test_geolocate_record_writes_to_custom_ok_dir(self) -> None:
        with TemporaryDirectory() as tmpdir:
            ok_dir = Path(tmpdir) / "run" / "geolocation" / "ok"
            record = {"xid": "A1"}
            item = {
                "name": "Test 12/1",
                "position": {"lon": 14.0, "lat": 50.0},
            }

            with patch(
                "src.pipeline.geolocate.search_mapy_items",
                return_value=([item], "geocode"),
            ):
                ok = geolocate_record(
                    record,
                    ["Test čp. 12"],
                    api_key="key",
                    request_delay_s=0,
                    timeout_s=1,
                    retries=1,
                    allow_fallback=False,
                    output_ok_dir=ok_dir,
                )

            self.assertTrue(ok)
            payload = json.loads((ok_dir / "A1.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["geolocation"]["query"], "Test čp. 12")

    def test_process_records_writes_failures_to_custom_failed_dir(self) -> None:
        with TemporaryDirectory() as tmpdir:
            failed_dir = Path(tmpdir) / "run" / "geolocation" / "failed"
            stats = process_records(
                [{"xid": "A1"}],
                query_extractor=lambda record: [],
                category="records_with_cp",
                processed_ids=set(),
                limit=None,
                api_key="key",
                request_delay_s=0,
                timeout_s=1,
                retries=1,
                allow_fallback=False,
                failed_base_dir=failed_dir,
            )

            self.assertEqual(stats["failed"], 1)
            self.assertTrue((failed_dir / "records_with_cp" / "A1.json").exists())


if __name__ == "__main__":
    unittest.main()
