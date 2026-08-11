import errno
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from src.pipeline.atomic_io import _fsync_directory, atomic_write_text


class AtomicIoTests(unittest.TestCase):
    def test_failed_replace_preserves_previous_file_and_removes_temporary(self) -> None:
        with TemporaryDirectory() as tmpdir:
            destination = Path(tmpdir) / "state.json"
            destination.write_text("previous", encoding="utf-8")

            with patch(
                "src.pipeline.atomic_io.os.replace",
                side_effect=OSError("simulated interruption"),
            ):
                with self.assertRaisesRegex(OSError, "simulated interruption"):
                    atomic_write_text(destination, "replacement")

            self.assertEqual(destination.read_text(encoding="utf-8"), "previous")
            self.assertEqual(list(destination.parent.glob(".state.json.tmp-*")), [])

    def test_successful_write_replaces_file(self) -> None:
        with TemporaryDirectory() as tmpdir:
            destination = Path(tmpdir) / "state.json"
            destination.write_text("previous", encoding="utf-8")

            atomic_write_text(destination, "replacement")

            self.assertEqual(destination.read_text(encoding="utf-8"), "replacement")
            self.assertTrue(os.path.isfile(destination))

    def test_successful_replace_fsyncs_parent_directory(self) -> None:
        with TemporaryDirectory() as tmpdir:
            destination = Path(tmpdir) / "state.json"

            with patch("src.pipeline.atomic_io._fsync_directory") as fsync_directory:
                atomic_write_text(destination, "replacement")

            fsync_directory.assert_called_once_with(destination.parent)

    def test_directory_fsync_tolerates_unsupported_platform(self) -> None:
        with TemporaryDirectory() as tmpdir, patch(
            "src.pipeline.atomic_io.os.open",
            side_effect=OSError(errno.EINVAL, "directory fsync unsupported"),
        ):
            _fsync_directory(Path(tmpdir))


if __name__ == "__main__":
    unittest.main()
