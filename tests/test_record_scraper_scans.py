import unittest
from unittest.mock import patch

from src.scraper.record_scraper import RecordScraper


MAIN_HTML = """
<html>
  <body>
    <div class="itemRow">
      <span class="tabularLabel">Název:</span>
      <span class="tabularValue">Test</span>
    </div>
    <textarea id="permalinkPopupTextarea">https://katalog.ahmp.cz/pragapublica/permalink?xid=A1</textarea>
    <div>2 obrázky</div>
    <a href="Zoomify.action;jsessionid=ABC123?xid=A1&amp;scanIndex=0">open</a>
    <script>var zoomifyImgPath = "https://images.ahmp.cz/mrimage/ahmp_watermark/zoomify/cz/archives/scan1.jpg";</script>
  </body>
</html>
"""

SCAN2_HTML = """
<html>
  <body>
    <script>var zoomifyImgPath = "https://images.ahmp.cz/mrimage/ahmp_watermark/zoomify/cz/archives/scan2.jpg";</script>
  </body>
</html>
"""

MAIN_HTML_MISMATCH_ZOOMIFY_XID = """
<html>
  <body>
    <div class="itemRow">
      <span class="tabularLabel">Název:</span>
      <span class="tabularValue">Test</span>
    </div>
    <textarea id="permalinkPopupTextarea">https://katalog.ahmp.cz/pragapublica/permalink?xid=A1</textarea>
    <div>2 obrázky</div>
    <a href="Zoomify.action;jsessionid=ABC123?xid=B2&amp;scanIndex=0">open</a>
    <script>var zoomifyImgPath = "https://images.ahmp.cz/mrimage/ahmp_watermark/zoomify/cz/archives/scan1.jpg";</script>
  </body>
</html>
"""

SCAN2_EMPTY_HTML = """
<html>
  <body></body>
</html>
"""


class RecordScraperScanResolutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_scrape_record_reads_per_scan_permalink(self) -> None:
        requested_urls: list[str] = []

        def fake_request(url, method="GET", data=None, session=None):  # type: ignore[no-untyped-def]
            requested_urls.append(url)
            if "permalink?xid=A1&scan=2" in url:
                return SCAN2_HTML
            if "permalink?xid=A1" in url and "scan=" not in url:
                return MAIN_HTML
            raise AssertionError(f"Unexpected fetch URL: {url}")

        scraper = RecordScraper(None)
        with patch.object(scraper, "_request_with_retries", side_effect=fake_request):
            record, _, failure = await scraper.scrape_record(
                "https://katalog.ahmp.cz/pragapublica/permalink?xid=A1"
            )

        self.assertIsNone(failure)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(
            record.data["scan_zoomify_paths"],
            [
                "https://images.ahmp.cz/mrimage/ahmp_watermark/zoomify/cz/archives/scan1.jpg",
                "https://images.ahmp.cz/mrimage/ahmp_watermark/zoomify/cz/archives/scan2.jpg",
            ],
        )
        self.assertEqual(
            record.data["scan_previews"],
            [
                "https://images.ahmp.cz/mrimage/ahmp_watermark/image/cz/archives/scan1.jpg/nahled_maly.jpg",
                "https://images.ahmp.cz/mrimage/ahmp_watermark/image/cz/archives/scan2.jpg/nahled_maly.jpg",
            ],
        )
        self.assertTrue(
            any("permalink?xid=A1&scan=2" in url for url in requested_urls),
            f"Missing scan=2 permalink fetch in {requested_urls}",
        )
        self.assertFalse(
            any("Zoomify.action" in url for url in requested_urls),
            f"Legacy Zoomify fallback was unexpectedly used: {requested_urls}",
        )

    async def test_scrape_record_ignores_mismatched_zoomify_xid(self) -> None:
        requested_urls: list[str] = []

        def fake_request(url, method="GET", data=None, session=None):  # type: ignore[no-untyped-def]
            requested_urls.append(url)
            if "permalink?xid=A1&scan=2" in url:
                return SCAN2_EMPTY_HTML
            if "permalink?xid=A1" in url and "scan=" not in url:
                return MAIN_HTML_MISMATCH_ZOOMIFY_XID
            raise AssertionError(f"Unexpected fetch URL: {url}")

        scraper = RecordScraper(None)
        with patch.object(scraper, "_request_with_retries", side_effect=fake_request):
            record, _, failure = await scraper.scrape_record(
                "https://katalog.ahmp.cz/pragapublica/permalink?xid=A1"
            )

        self.assertIsNone(failure)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(
            record.data["scan_zoomify_paths"],
            [
                "https://images.ahmp.cz/mrimage/ahmp_watermark/zoomify/cz/archives/scan1.jpg",
                "",
            ],
        )
        self.assertFalse(
            any("Zoomify.action" in url for url in requested_urls),
            f"Mismatched zoomify xid should not be fetched: {requested_urls}",
        )


if __name__ == "__main__":
    unittest.main()
