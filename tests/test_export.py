import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd

from src.pipeline.export import export_records, parse_date


class ExportTests(unittest.TestCase):
    def test_parse_date_marks_open_ended_ranges_imprecise(self) -> None:
        before = parse_date("před 1900")
        after = parse_date("po 1910")

        self.assertEqual(before["start_date"], "1800-01-01")
        self.assertTrue(before["date_imprecise"])
        self.assertEqual(after["end_date"], "2000-12-31")
        self.assertTrue(after["date_imprecise"])

    def test_export_records_filters_non_archival_and_honors_full_mode(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            geo_dir = root / "ok"
            geo_dir.mkdir(parents=True)
            output_minimal = root / "minimal.csv"
            output_full = root / "full.csv"

            archival = {
                "xid": "A1",
                "typ záznamu": "Archiválie",
                "druh": "fotografie",
                "obsah": "Praha",
                "datace": "1900",
                "zobrazeno": "1",
                "signatura": "SIG",
                "autor": "Autor",
                "poznámka": "Pozn",
                "scan_count": 1,
                "scan_previews": ["p"],
                "scan_zoomify_paths": ["z"],
                "extra_field": "kept only in full",
                "geolocation": {
                    "position": {"lon": 14.0, "lat": 50.0},
                    "type": "regional.address",
                    "endpoint": "geocode",
                },
            }
            non_archival = dict(archival, xid="B1", **{"typ záznamu": "Pomůcka"})
            (geo_dir / "A1.json").write_text(json.dumps(archival), encoding="utf-8")
            (geo_dir / "B1.json").write_text(json.dumps(non_archival), encoding="utf-8")

            minimal_count = export_records(geo_dir, output_minimal, minimal=True)
            full_count = export_records(geo_dir, output_full, minimal=False)

            minimal = pd.read_csv(output_minimal)
            full = pd.read_csv(output_full)

        self.assertEqual(minimal_count, 1)
        self.assertEqual(full_count, 1)
        self.assertEqual(minimal["xid"].tolist(), ["A1"])
        self.assertNotIn("extra_field", minimal.columns)
        self.assertIn("extra_field", full.columns)


if __name__ == "__main__":
    unittest.main()
