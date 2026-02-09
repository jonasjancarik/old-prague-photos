import unittest

from src.scraper.record_scraper import (
    build_preview_url,
    extract_xid_from_url,
    extract_scan_count,
    extract_zoomify_img_path,
    extract_zoomify_url,
)


class RecordScraperRegexTests(unittest.TestCase):
    def test_extract_scan_count(self) -> None:
        html = "<div>3 obrázky</div>"
        self.assertEqual(extract_scan_count(html), 3)

    def test_extract_zoomify_url(self) -> None:
        html = '<a href="Zoomify.action;jsessionid=ABC123?showOne=&amp;_sourcePage=xyz">open</a>'
        base = "https://katalog.ahmp.cz/pragapublica/permalink?xid=ABC"
        url = extract_zoomify_url(html, base)
        self.assertIsNotNone(url)
        assert url is not None
        self.assertIn("Zoomify.action;jsessionid=ABC123?showOne=&_sourcePage=xyz", url)

    def test_extract_zoomify_img_path(self) -> None:
        html = '<script>var zoomifyImgPath = "https://images.ahmp.cz/zoomify/abc";</script>'
        self.assertEqual(
            extract_zoomify_img_path(html),
            "https://images.ahmp.cz/zoomify/abc",
        )

    def test_build_preview_url(self) -> None:
        zoomify_path = "https://images.ahmp.cz/mrimage/ahmp_watermark/zoomify/cz/archives/foo"
        self.assertEqual(
            build_preview_url(zoomify_path),
            "https://images.ahmp.cz/mrimage/ahmp_watermark/image/cz/archives/foo/nahled_maly.jpg",
        )

    def test_extract_xid_from_url(self) -> None:
        url = "https://katalog.ahmp.cz/pragapublica/permalink?xid=A1186FFAB67611DF820F00166F1163D4&scan=1"
        self.assertEqual(
            extract_xid_from_url(url),
            "A1186FFAB67611DF820F00166F1163D4",
        )


if __name__ == "__main__":
    unittest.main()
