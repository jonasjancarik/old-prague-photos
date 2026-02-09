import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from collect import (
    dedupe_keep_order,
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


if __name__ == "__main__":
    unittest.main()
