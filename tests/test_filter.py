import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from src.pipeline.filter import categorize_records, load_raw_records


def record(xid: str, *, place: bool, obsah: str = "", entries: list[dict] | None = None):
    index_entries = []
    if place:
        index_entries.append({"typ": "Místo", "obsah": "Praha"})
    index_entries.extend(entries or [])
    return {
        "xid": xid,
        "obsah": obsah,
        "rejstříkové záznamy": index_entries,
    }


class FilterRecordsTests(unittest.TestCase):
    def test_corrupt_raw_record_fails_instead_of_disappearing(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "BROKEN.json"
            path.write_text('{"xid":', encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Invalid raw-record JSON"):
                load_raw_records(Path(tmpdir))

    def test_adjacent_records_without_places_are_both_excluded(self) -> None:
        records = [
            record("NO_PLACE_1", place=False),
            record("NO_PLACE_2", place=False),
            record("WITH_PLACE", place=True, entries=[{"typ": "Dílo", "obsah": "čp. 12"}]),
        ]

        records_with_places, filtered = categorize_records(records)

        self.assertEqual([item["xid"] for item in records_with_places], ["WITH_PLACE"])
        self.assertEqual(
            [item["xid"] for item in filtered["records_with_cp"]],
            ["WITH_PLACE"],
        )

    def test_categorizes_cp_in_obsah_and_without_dilo(self) -> None:
        records = [
            record("INDEX_CP", place=True, entries=[{"typ": "Dílo", "obsah": "čp. 7"}]),
            record("OBSAH_CP", place=True, obsah="Dům čp. 8"),
            record("NO_CP_NO_DILO", place=True),
            record("NO_CP_WITH_DILO", place=True, entries=[{"typ": "Dílo", "obsah": "Most"}]),
        ]

        _, filtered = categorize_records(records)

        self.assertEqual([item["xid"] for item in filtered["records_with_cp"]], ["INDEX_CP"])
        self.assertEqual(
            [item["xid"] for item in filtered["records_with_cp_in_record_obsah"]],
            ["OBSAH_CP"],
        )
        self.assertEqual(
            [item["xid"] for item in filtered["records_without_cp"]],
            ["NO_CP_NO_DILO", "NO_CP_WITH_DILO"],
        )
        self.assertEqual(
            [item["xid"] for item in filtered["records_without_dilo"]],
            ["NO_CP_NO_DILO"],
        )


if __name__ == "__main__":
    unittest.main()
