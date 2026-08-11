import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from src.scraper.nav_partition import (
    NAV_PROGRESS_SCHEMA_VERSION,
    _load_progress,
    _save_progress,
    _validate_partition_ids,
)


class NavPartitionProgressTests(unittest.TestCase):
    def test_reported_nonempty_partition_cannot_be_saved_as_complete_empty(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "despite reported total 4"):
            _validate_partition_ids("A", 4, [])

    def test_unknown_total_partition_cannot_be_saved_as_complete_empty(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "without explicit reported total 0"):
            _validate_partition_ids("A", None, [])

    def test_explicit_zero_total_allows_completed_empty_partition(self) -> None:
        self.assertEqual(_validate_partition_ids("A", 0, []), [])

    def test_round_trips_valid_progress(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "nav-progress.json"
            _save_progress(
                str(path),
                label="photos",
                seed_url="https://example.test/seed",
                ids_by_label={"A": ["X1", "X2"], "B": []},
                reported_totals_by_label={"A": 2, "B": 0},
                pending_labels=[],
                failed_labels=[],
            )

            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema_version"], NAV_PROGRESS_SCHEMA_VERSION)
            self.assertEqual(payload["reported_totals_by_label"], {"A": 2, "B": 0})
            self.assertEqual(
                _load_progress(
                    str(path),
                    label="photos",
                    seed_url="https://example.test/seed",
                ),
                {"A": ["X1", "X2"], "B": []},
            )

    def test_save_rejects_unconfirmed_empty_partition(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "nav-progress.json"

            with self.assertRaisesRegex(RuntimeError, "without explicit reported total 0"):
                _save_progress(
                    str(path),
                    label="photos",
                    seed_url="https://example.test/seed",
                    ids_by_label={"A": []},
                    reported_totals_by_label={},
                    pending_labels=[],
                    failed_labels=[],
                )

            self.assertFalse(path.exists())

    def test_legacy_empty_partition_is_retried_but_nonempty_work_is_resumed(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "nav-progress.json"
            path.write_text(
                json.dumps(
                    {
                        "label": "photos",
                        "seed_url": "https://example.test/seed",
                        "ids_by_label": {"A": ["X1"], "B": []},
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                _load_progress(
                    str(path),
                    label="photos",
                    seed_url="https://example.test/seed",
                ),
                {"A": ["X1"]},
            )

    def test_v2_empty_partition_without_reported_zero_is_retried(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "nav-progress.json"
            path.write_text(
                json.dumps(
                    {
                        "schema_version": NAV_PROGRESS_SCHEMA_VERSION,
                        "label": "photos",
                        "seed_url": "https://example.test/seed",
                        "ids_by_label": {"A": ["X1"], "B": []},
                        "reported_totals_by_label": {"A": 1},
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                _load_progress(
                    str(path),
                    label="photos",
                    seed_url="https://example.test/seed",
                ),
                {"A": ["X1"]},
            )

    def test_invalid_progress_fails_closed_instead_of_restarting(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "nav-progress.json"
            path.write_text("{torn", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Cannot safely resume"):
                _load_progress(
                    str(path),
                    label="photos",
                    seed_url="https://example.test/seed",
                )

    def test_mismatched_progress_fails_closed(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "nav-progress.json"
            path.write_text(
                json.dumps(
                    {
                        "label": "other",
                        "seed_url": "https://example.test/seed",
                        "ids_by_label": {"A": ["X1"]},
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "label mismatch"):
                _load_progress(
                    str(path),
                    label="photos",
                    seed_url="https://example.test/seed",
                )

    def test_missing_progress_identity_fails_closed(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "nav-progress.json"
            path.write_text(
                json.dumps(
                    {
                        "schema_version": NAV_PROGRESS_SCHEMA_VERSION,
                        "ids_by_label": {"A": ["X1"]},
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "label mismatch"):
                _load_progress(
                    str(path),
                    label="photos",
                    seed_url="https://example.test/seed",
                )

            path.write_text(
                json.dumps(
                    {
                        "schema_version": NAV_PROGRESS_SCHEMA_VERSION,
                        "label": "photos",
                        "ids_by_label": {"A": ["X1"]},
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "seed mismatch"):
                _load_progress(
                    str(path),
                    label="photos",
                    seed_url="https://example.test/seed",
                )


if __name__ == "__main__":
    unittest.main()
