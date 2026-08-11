import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from src.scraper.record import Record
from src.scraper.record_scraper import RecordScraper


class RecordStoragePathTests(unittest.IsolatedAsyncioTestCase):
    def test_record_save_uses_custom_output_dir(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "raw"
            path = Record({"xid": "A1", "obsah": "test"}).save(output_dir)

            self.assertEqual(path, output_dir / "A1.json")
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["xid"], "A1")

    async def test_scrape_records_saves_to_custom_output_dir(self) -> None:
        async def fake_scrape_record(url: str):  # type: ignore[no-untyped-def]
            return Record({"xid": "A1", "url": url}), 0.1, None

        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "run" / "collect" / "raw_records"
            scraper = RecordScraper(None)
            with patch.object(
                scraper,
                "scrape_record",
                side_effect=fake_scrape_record,
            ):
                records = await scraper.scrape_records(
                    ["A1"],
                    set(),
                    raw_records_dir=output_dir,
                )

            self.assertEqual(len(records), 1)
            self.assertTrue((output_dir / "A1.json").exists())

    async def test_success_appends_resolution_only_for_an_unresolved_xid(self) -> None:
        async def fake_scrape_record(url: str):  # type: ignore[no-untyped-def]
            return Record({"xid": "A1", "url": url}), 0.1, None

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            ledger_path = root / "failed_xids.jsonl"
            ledger_path.write_text(
                '{"xid":"A1","error":"previous failure"}\n',
                encoding="utf-8",
            )
            scraper = RecordScraper(None)
            with patch.object(
                scraper,
                "scrape_record",
                side_effect=fake_scrape_record,
            ):
                await scraper.scrape_records(
                    ["A1"],
                    set(),
                    failed_ids_path=str(ledger_path),
                    raw_records_dir=root / "raw",
                )

            events = [
                json.loads(line)
                for line in ledger_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(events[-1]["xid"], "A1")
            self.assertTrue(events[-1]["resolved"])
            self.assertTrue(events[-1]["event_id"])
            self.assertTrue((root / "raw" / "A1.json").exists())

    async def test_success_without_an_unresolved_failure_does_not_append(self) -> None:
        async def fake_scrape_record(url: str):  # type: ignore[no-untyped-def]
            return Record({"xid": "A1", "url": url}), 0.1, None

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            ledger_path = root / "failed_xids.jsonl"
            ledger_path.write_text(
                '{"xid":"B2","error":"unrelated"}\n',
                encoding="utf-8",
            )
            scraper = RecordScraper(None)
            with patch.object(scraper, "scrape_record", side_effect=fake_scrape_record):
                await scraper.scrape_records(
                    ["A1"],
                    set(),
                    failed_ids_path=str(ledger_path),
                    raw_records_dir=root / "raw",
                )

            self.assertEqual(
                ledger_path.read_text(encoding="utf-8"),
                '{"xid":"B2","error":"unrelated"}\n',
            )


if __name__ == "__main__":
    unittest.main()
