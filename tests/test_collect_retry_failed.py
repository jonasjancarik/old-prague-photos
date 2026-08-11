import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from src.pipeline.collect import (
    dedupe_keep_order,
    main_async,
    parse_failed_xids,
    parse_missing_details_xids,
    record_missing_scan_details,
)


class CollectRetryFailedTests(unittest.TestCase):
    def test_parse_failed_xids_dedupes_and_supports_jsonl(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "failed_xids.jsonl"
            path.write_text(
                "\n".join(
                    [
                        '{"xid":"A1","record_url":"u1","error":"e1"}',
                        '{"xid":"B2","record_url":"u2","error":"e2"}',
                        '{"xid":"A1","record_url":"u3","error":"e3"}',
                        "C3",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            self.assertEqual(parse_failed_xids(path), ["A1", "B2", "C3"])

    def test_parse_failed_xids_missing_file(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "missing.jsonl"
            self.assertEqual(parse_failed_xids(path), [])

    def test_parse_failed_xids_uses_latest_failure_or_resolution_event(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "failed_xids.jsonl"
            path.write_text(
                "\n".join(
                    [
                        '{"xid":"A1","error":"first"}',
                        '{"xid":"A1","resolved":true}',
                        '{"xid":"B2","error":"still failed"}',
                        '{"xid":"C3","resolved":true}',
                        '{"xid":"C3","error":"failed again"}',
                    ]
                ),
                encoding="utf-8",
            )

            self.assertEqual(parse_failed_xids(path), ["B2", "C3"])

    def test_record_missing_scan_details(self) -> None:
        self.assertFalse(
            record_missing_scan_details(
                {
                    "scan_count": 1,
                    "scan_previews": ["https://example/a.jpg"],
                    "scan_zoomify_paths": ["https://example/zoomify/a"],
                }
            )
        )
        self.assertTrue(
            record_missing_scan_details(
                {
                    "scan_count": 2,
                    "scan_previews": ["https://example/a.jpg", ""],
                    "scan_zoomify_paths": [
                        "https://example/zoomify/a",
                        "https://example/zoomify/b",
                    ],
                }
            )
        )
        self.assertTrue(
            record_missing_scan_details(
                {"scan_count": 0, "scan_previews": [], "scan_zoomify_paths": []}
            )
        )

    def test_parse_missing_details_xids(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "ok.json").write_text(
                '{"xid":"OK","scan_count":1,"scan_previews":["p"],"scan_zoomify_paths":["z"]}',
                encoding="utf-8",
            )
            (root / "missing.json").write_text(
                '{"xid":"MISS","scan_count":2,"scan_previews":["p",""],"scan_zoomify_paths":["z","z2"]}',
                encoding="utf-8",
            )
            (root / "unknown.json").write_text(
                '{"xid":"UNK","scan_count":0,"scan_previews":[],"scan_zoomify_paths":[]}',
                encoding="utf-8",
            )
            self.assertEqual(parse_missing_details_xids(root), ["missing", "unknown"])

    def test_dedupe_keep_order(self) -> None:
        self.assertEqual(dedupe_keep_order(["A", "B", "A", "", "C"]), ["A", "B", "C"])


class CollectPathTests(unittest.IsolatedAsyncioTestCase):
    async def test_retry_does_not_treat_a_newer_raw_mtime_as_resolution(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            raw_dir = root / "raw_records"
            raw_dir.mkdir()
            failed_path = root / "failed_xids.jsonl"
            failed_path.write_text(
                '{"xid":"A1","error":"earlier attempt"}\n',
                encoding="utf-8",
            )
            (raw_dir / "A1.json").write_text('{"xid":"A1"}', encoding="utf-8")

            with patch.dict(
                "os.environ",
                {
                    "RETRY_FAILED_RECORDS": "True",
                    "RESCRAPE_MISSING_DETAILS": "False",
                    "FETCH_IDS_ONLY": "False",
                    "GET_RECORD_IDS": "False",
                    "RESCRAPE_EXISTING_RECORDS": "True",
                },
            ), patch(
                "src.pipeline.collect.RecordScraper.scrape_records",
                new_callable=AsyncMock,
            ) as scrape_records:
                await main_async(
                    record_ids_path=root / "available_record_ids.json",
                    failed_xids_path=failed_path,
                    missing_details_path=root / "missing_details_xids.json",
                    raw_records_dir=raw_dir,
                )

            scrape_records.assert_awaited_once()
            self.assertEqual(scrape_records.await_args.args[0], ["A1"])
            self.assertEqual(parse_failed_xids(failed_path), ["A1"])

    async def test_retry_keeps_existing_failure_history(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            failed_path = root / "failed_xids.jsonl"
            previous = '{"xid":"A1","error":"earlier attempt"}\n'
            failed_path.write_text(previous, encoding="utf-8")

            with patch.dict(
                "os.environ",
                {
                    "RETRY_FAILED_RECORDS": "True",
                    "RESCRAPE_MISSING_DETAILS": "False",
                    "FETCH_IDS_ONLY": "False",
                    "GET_RECORD_IDS": "False",
                    "RESCRAPE_EXISTING_RECORDS": "True",
                },
            ), patch(
                "src.pipeline.collect.RecordScraper.scrape_records",
                new_callable=AsyncMock,
                return_value=[],
            ):
                await main_async(
                    record_ids_path=root / "available_record_ids.json",
                    failed_xids_path=failed_path,
                    missing_details_path=root / "missing_details_xids.json",
                    raw_records_dir=root / "raw_records",
                )

            self.assertEqual(failed_path.read_text(encoding="utf-8"), previous)

    async def test_retry_missing_details_uses_custom_raw_records_dir(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            raw_records_dir = root / "run" / "collect" / "raw_records"
            raw_records_dir.mkdir(parents=True)
            (raw_records_dir / "A1.json").write_text(
                '{"xid":"A1","scan_count":2,"scan_previews":["p",""],"scan_zoomify_paths":["z","z2"]}',
                encoding="utf-8",
            )
            missing_details_path = root / "run" / "collect" / "missing_details_xids.json"

            with patch.dict(
                "os.environ",
                {
                    "RESCRAPE_MISSING_DETAILS": "True",
                    "RETRY_FAILED_RECORDS": "False",
                    "FETCH_IDS_ONLY": "True",
                    "GET_RECORD_IDS": "False",
                    "RESCRAPE_EXISTING_RECORDS": "True",
                },
            ):
                await main_async(
                    record_ids_path=root / "run" / "collect" / "available_record_ids.json",
                    failed_xids_path=root / "run" / "collect" / "failed_xids.jsonl",
                    missing_details_path=missing_details_path,
                    raw_records_dir=raw_records_dir,
                )

            self.assertEqual(
                missing_details_path.read_text(encoding="utf-8"),
                '[\n  "A1"\n]\n',
            )


if __name__ == "__main__":
    unittest.main()
