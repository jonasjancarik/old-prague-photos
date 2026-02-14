import json
import unittest
from argparse import Namespace
from pathlib import Path
from tempfile import TemporaryDirectory

import requests

from scripts.orphan_recovery import (
    PROBE_ACTIVE_FILE,
    PROBE_NOT_FOUND_FILE,
    PROBE_TRANSIENT_FILE,
    RequestPacer,
    classify_probe_response,
    probe_single_xid,
    run_finalize,
)


class _DummyResponse:
    def __init__(self, status_code: int, text: str) -> None:
        self.status_code = status_code
        self.text = text


class _FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class _FakeSession:
    def __init__(self, responses: list[object], now_fn) -> None:
        self.responses = responses
        self.now_fn = now_fn
        self.call_times: list[float] = []

    def get(self, _url: str, timeout: float) -> _DummyResponse:
        del timeout
        self.call_times.append(self.now_fn())
        if not self.responses:
            raise RuntimeError("No more fake responses")
        current = self.responses.pop(0)
        if isinstance(current, Exception):
            raise current
        return current


class OrphanRecoveryTests(unittest.TestCase):
    def test_classify_probe_response_phrase_and_active(self) -> None:
        self.assertEqual(classify_probe_response(200, "Záznam nenalezen"), "not_found")
        self.assertEqual(classify_probe_response(200, "<html>ok</html>"), "active")

    def test_classify_probe_response_status_not_found(self) -> None:
        self.assertEqual(classify_probe_response(404, ""), "not_found")
        self.assertEqual(classify_probe_response(410, ""), "not_found")

    def test_probe_single_xid_transient_after_timeout_and_5xx(self) -> None:
        clock = _FakeClock()
        session = _FakeSession(
            [
                requests.Timeout("timeout"),
                _DummyResponse(503, "service unavailable"),
                _DummyResponse(502, "bad gateway"),
            ],
            clock.time,
        )
        pacer = RequestPacer(min_interval=0, time_fn=clock.time, sleep_fn=clock.sleep)
        classification, attempts = probe_single_xid(
            "X1",
            archive_base_url="https://katalog.ahmp.cz/pragapublica",
            timeout=12,
            retries=2,
            retry_sleep=0,
            session=session,  # type: ignore[arg-type]
            pacer=pacer,
            sleep_fn=clock.sleep,
            time_fn=clock.time,
        )
        self.assertEqual(classification, "transient")
        self.assertEqual(len(attempts), 3)
        self.assertEqual(attempts[-1]["result"], "transient")

    def test_probe_single_xid_enforces_min_interval(self) -> None:
        clock = _FakeClock()
        session = _FakeSession(
            [
                _DummyResponse(503, "service unavailable"),
                _DummyResponse(200, "<html>ok</html>"),
            ],
            clock.time,
        )
        pacer = RequestPacer(min_interval=5, time_fn=clock.time, sleep_fn=clock.sleep)
        classification, attempts = probe_single_xid(
            "X2",
            archive_base_url="https://katalog.ahmp.cz/pragapublica",
            timeout=12,
            retries=1,
            retry_sleep=0,
            session=session,  # type: ignore[arg-type]
            pacer=pacer,
            sleep_fn=clock.sleep,
            time_fn=clock.time,
        )
        self.assertEqual(classification, "active")
        self.assertEqual(len(attempts), 2)
        self.assertGreaterEqual(session.call_times[1] - session.call_times[0], 5.0)

    def test_finalize_keeps_missing_raw_or_preview_in_orphans(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_dir = root / "run"
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / PROBE_ACTIVE_FILE).write_text(
                json.dumps(["A1", "A2"]),
                encoding="utf-8",
            )
            (run_dir / PROBE_NOT_FOUND_FILE).write_text(
                json.dumps([]),
                encoding="utf-8",
            )
            (run_dir / PROBE_TRANSIENT_FILE).write_text(
                json.dumps([]),
                encoding="utf-8",
            )

            photos = root / "photos.geojson"
            photos.write_text(
                json.dumps(
                    {
                        "type": "FeatureCollection",
                        "features": [
                            {
                                "type": "Feature",
                                "properties": {"id": "A1", "scan_previews": []},
                            },
                            {
                                "type": "Feature",
                                "properties": {"id": "A2", "scan_previews": []},
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )

            raw_dir = root / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            (raw_dir / "A1.json").write_text(
                json.dumps({"xid": "A1", "scan_previews": []}),
                encoding="utf-8",
            )

            output_orphans = root / "orphans.json"
            run_finalize(
                Namespace(
                    run_dir=str(run_dir),
                    photos=str(photos),
                    raw_dir=str(raw_dir),
                    downloads_root=str(root / "downloads"),
                    output_orphans=str(output_orphans),
                    active_file="",
                    not_found_file="",
                    transient_file="",
                )
            )

            orphans = json.loads(output_orphans.read_text(encoding="utf-8"))
            self.assertEqual(sorted(orphans), ["A1", "A2"])

    def test_finalize_unhides_active_with_raw_and_preview(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_dir = root / "run"
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / PROBE_ACTIVE_FILE).write_text(
                json.dumps(["B1"]),
                encoding="utf-8",
            )
            (run_dir / PROBE_NOT_FOUND_FILE).write_text(
                json.dumps([]),
                encoding="utf-8",
            )
            (run_dir / PROBE_TRANSIENT_FILE).write_text(
                json.dumps([]),
                encoding="utf-8",
            )

            photos = root / "photos.geojson"
            photos.write_text(
                json.dumps(
                    {
                        "type": "FeatureCollection",
                        "features": [
                            {
                                "type": "Feature",
                                "properties": {"id": "B1", "scan_previews": []},
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            raw_dir = root / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            (raw_dir / "B1.json").write_text(
                json.dumps({"xid": "B1", "scan_previews": ["https://example.test/p.jpg"]}),
                encoding="utf-8",
            )

            output_orphans = root / "orphans.json"
            run_finalize(
                Namespace(
                    run_dir=str(run_dir),
                    photos=str(photos),
                    raw_dir=str(raw_dir),
                    downloads_root=str(root / "downloads"),
                    output_orphans=str(output_orphans),
                    active_file="",
                    not_found_file="",
                    transient_file="",
                )
            )

            orphans = json.loads(output_orphans.read_text(encoding="utf-8"))
            self.assertEqual(orphans, [])

    def test_finalize_unhides_active_with_zoomify_only(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_dir = root / "run"
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / PROBE_ACTIVE_FILE).write_text(
                json.dumps(["C1"]),
                encoding="utf-8",
            )
            (run_dir / PROBE_NOT_FOUND_FILE).write_text(
                json.dumps([]),
                encoding="utf-8",
            )
            (run_dir / PROBE_TRANSIENT_FILE).write_text(
                json.dumps([]),
                encoding="utf-8",
            )

            photos = root / "photos.geojson"
            photos.write_text(
                json.dumps(
                    {
                        "type": "FeatureCollection",
                        "features": [
                            {
                                "type": "Feature",
                                "properties": {
                                    "id": "C1",
                                    "scan_previews": [],
                                    "scan_zoomify_paths": [
                                        "https://images.example.test/zoomify/path.jpg"
                                    ],
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            raw_dir = root / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            (raw_dir / "C1.json").write_text(
                json.dumps({"xid": "C1", "scan_previews": [], "scan_zoomify_paths": []}),
                encoding="utf-8",
            )

            output_orphans = root / "orphans.json"
            run_finalize(
                Namespace(
                    run_dir=str(run_dir),
                    photos=str(photos),
                    raw_dir=str(raw_dir),
                    downloads_root=str(root / "downloads"),
                    output_orphans=str(output_orphans),
                    active_file="",
                    not_found_file="",
                    transient_file="",
                )
            )

            orphans = json.loads(output_orphans.read_text(encoding="utf-8"))
            self.assertEqual(orphans, [])


if __name__ == "__main__":
    unittest.main()
