import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from download_archive_images import (
    build_preview_url,
    load_items,
    load_resolved_previews_cache,
    parse_scan_count,
    with_scan_index,
)


class DownloadArchiveImagesTests(unittest.TestCase):
    def test_load_items_falls_back_to_raw_record_previews(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            input_path = root / "photos.geojson"
            raw_dir = root / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)

            input_path.write_text(
                json.dumps(
                    {
                        "type": "FeatureCollection",
                        "features": [
                            {
                                "type": "Feature",
                                "properties": {
                                    "id": "X1",
                                    "scan_previews": [],
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (raw_dir / "X1.json").write_text(
                json.dumps(
                    {
                        "xid": "X1",
                        "scan_previews": ["https://example.test/p1.jpg"],
                    }
                ),
                encoding="utf-8",
            )

            items = load_items(input_path, limit=0, raw_records_dir=raw_dir)
            self.assertEqual(len(items), 1)
            self.assertEqual(
                items[0]["scan_previews"],
                ["https://example.test/p1.jpg"],
            )

    def test_load_resolved_previews_cache_ignores_invalid_and_empty(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "resolved.jsonl"
            path.write_text(
                "\n".join(
                    [
                        '{"xid":"A1","scan_previews":["https://example.test/a.jpg"]}',
                        '{"xid":"A2","scan_previews":[""]}',
                        '{"xid":"A3","scan_previews":[]}',
                        "invalid-json",
                    ]
                ),
                encoding="utf-8",
            )
            cache = load_resolved_previews_cache(path)
            self.assertEqual(
                cache,
                {"A1": ["https://example.test/a.jpg"]},
            )

    def test_parse_scan_count(self) -> None:
        self.assertEqual(parse_scan_count("<div>12 obrázků</div>"), 12)
        self.assertIsNone(parse_scan_count("<div>bez obrázků</div>"))

    def test_with_scan_index_overwrites_existing_query(self) -> None:
        url = (
            "https://katalog.ahmp.cz/pragapublica/Zoomify.action"
            "?xid=A1&scanIndex=0&foo=bar"
        )
        updated = with_scan_index(url, 3)
        self.assertIn("scanIndex=3", updated)
        self.assertIn("foo=bar", updated)

    def test_build_preview_url(self) -> None:
        zoomify = (
            "https://images.ahmp.cz/mrimage/ahmp_watermark/zoomify/"
            "cz/archives/CZ-321100010/NAD-157/dao/images/0017/abc.jpg"
        )
        self.assertEqual(
            build_preview_url(zoomify),
            "https://images.ahmp.cz/mrimage/ahmp_watermark/image/"
            "cz/archives/CZ-321100010/NAD-157/dao/images/0017/abc.jpg/nahled_maly.jpg",
        )


if __name__ == "__main__":
    unittest.main()
