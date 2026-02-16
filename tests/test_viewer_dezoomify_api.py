import io
import os
import unittest
from unittest.mock import patch

import requests
from fastapi.testclient import TestClient
from PIL import Image

import viewer.app as viewer_app


def _jpeg_bytes(size: tuple[int, int] = (256, 256)) -> bytes:
    image = Image.new("RGB", size, (120, 80, 40))
    output = io.BytesIO()
    image.save(output, format="JPEG")
    image.close()
    return output.getvalue()


class _FakeTileResponse:
    def __init__(self, *, status_code: int = 200, content: bytes = b"") -> None:
        self.status_code = status_code
        self.content = content

    def raise_for_status(self) -> None:
        if self.status_code < 200 or self.status_code >= 300:
            raise requests.HTTPError(f"HTTP {self.status_code}")


class _FakeSession:
    def __init__(self, tile_bytes: bytes) -> None:
        self.headers: dict[str, str] = {}
        self.tile_bytes = tile_bytes
        self.requested_urls: list[str] = []
        self.closed = False

    def get(self, url: str, timeout: int = 20) -> _FakeTileResponse:
        self.requested_urls.append(url)
        return _FakeTileResponse(status_code=200, content=self.tile_bytes)

    def close(self) -> None:
        self.closed = True


class ViewerDezoomifyApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(viewer_app.app)

    def test_dezoomify_success_returns_jpeg_attachment(self) -> None:
        fake_session = _FakeSession(_jpeg_bytes())
        with patch.object(viewer_app.requests, "Session", return_value=fake_session):
            with patch.object(
                viewer_app.dezoomify, "resolve_zoomify", return_value="<html/>"
            ):
                with patch.object(
                    viewer_app.dezoomify,
                    "extract_zoomify_img_path",
                    return_value="https://tiles.example/base",
                ):
                    with patch.object(
                        viewer_app.dezoomify,
                        "fetch_image_properties",
                        return_value={"width": 512, "height": 256, "tile_size": 256},
                    ):
                        response = self.client.get(
                            "/api/dezoomify",
                            params={"xid": "ABC123", "scanIndex": 1},
                        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("content-type"), "image/jpeg")
        disposition = str(response.headers.get("content-disposition") or "")
        self.assertIn("attachment;", disposition)
        self.assertIn("ABC123_scan_2_full.jpg", disposition)
        self.assertGreater(len(response.content), 100)
        self.assertTrue(fake_session.closed)
        self.assertGreaterEqual(len(fake_session.requested_urls), 1)

    def test_dezoomify_rejects_invalid_xid(self) -> None:
        response = self.client.get("/api/dezoomify", params={"xid": "../bad"})
        self.assertEqual(response.status_code, 400)

    def test_dezoomify_rejects_invalid_scan_index(self) -> None:
        response = self.client.get(
            "/api/dezoomify", params={"xid": "ABC123", "scanIndex": -1}
        )
        self.assertEqual(response.status_code, 400)

    def test_dezoomify_rejects_oversized_images(self) -> None:
        fake_session = _FakeSession(_jpeg_bytes())
        with patch.dict(os.environ, {"FULLRES_MAX_PIXELS": "80000000"}, clear=False):
            with patch.object(viewer_app.requests, "Session", return_value=fake_session):
                with patch.object(
                    viewer_app.dezoomify, "resolve_zoomify", return_value="<html/>"
                ):
                    with patch.object(
                        viewer_app.dezoomify,
                        "extract_zoomify_img_path",
                        return_value="https://tiles.example/base",
                    ):
                        with patch.object(
                            viewer_app.dezoomify,
                            "fetch_image_properties",
                            return_value={
                                "width": 10000,
                                "height": 9000,
                                "tile_size": 256,
                            },
                        ):
                            response = self.client.get(
                                "/api/dezoomify",
                                params={"xid": "ABC123", "scanIndex": 0},
                            )

        self.assertEqual(response.status_code, 413)

    def test_dezoomify_returns_502_on_upstream_failure(self) -> None:
        fake_session = _FakeSession(_jpeg_bytes())
        with patch.object(viewer_app.requests, "Session", return_value=fake_session):
            with patch.object(
                viewer_app.dezoomify,
                "resolve_zoomify",
                side_effect=requests.RequestException("boom"),
            ):
                response = self.client.get(
                    "/api/dezoomify", params={"xid": "ABC123", "scanIndex": 0}
                )

        self.assertEqual(response.status_code, 502)


if __name__ == "__main__":
    unittest.main()
