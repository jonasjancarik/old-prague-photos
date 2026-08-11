from pathlib import Path


HEADERS_PATH = Path(__file__).parents[1] / "viewer" / "static" / "_headers"
VIEWER_ROOT = Path(__file__).parents[1] / "viewer"


def test_pages_headers_protect_the_viewer_without_blocking_required_services() -> None:
    headers = HEADERS_PATH.read_text(encoding="utf-8")

    for directive in (
        "default-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "https://challenges.cloudflare.com",
        "https://images.ahmp.cz",
        "https://api.mapy.cz",
        "https://tile.openstreetmap.org",
        "https://katalog.ahmp.cz",
        "https://*.r2.dev",
        "https://*.r2.cloudflarestorage.com",
        "X-Content-Type-Options: nosniff",
        "X-Frame-Options: DENY",
    ):
        assert directive in headers

    assert "https://unpkg.com" not in headers


def test_viewer_libraries_are_bundled_without_runtime_unpkg_dependencies() -> None:
    source_paths = [
        *sorted((VIEWER_ROOT / "react").glob("*.html")),
        *sorted((VIEWER_ROOT / "react" / "src" / "entries").glob("*.jsx")),
        *sorted((VIEWER_ROOT / "static").glob("*.html")),
        *sorted((VIEWER_ROOT / "static").glob("*.js")),
    ]
    for path in source_paths:
        assert "unpkg.com" not in path.read_text(encoding="utf-8"), path

    controls = VIEWER_ROOT / "react" / "public" / "vendor" / "openseadragon" / "images"
    for filename in ("zoomin_rest.png", "zoomout_rest.png", "home_rest.png"):
        assert (controls / filename).is_file()
