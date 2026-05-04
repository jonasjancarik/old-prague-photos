import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image, ImageDraw

import build_similarity
from src.utils.similarity_core import (
    HashResult,
    ScanInput,
    dhash,
    edge_hash,
    load_hash_cache,
    visual_hash,
)
from src.utils.similarity_hashing import mounted_photo_crop
from src.utils.similarity_images import (
    build_zoomify_candidates,
    build_zoomify_tile_urls,
    compute_hash_for_scan,
    select_stitch_level,
)


class BuildSimilarityTests(unittest.TestCase):
    def test_select_stitch_level_prefers_highest_within_target(self) -> None:
        tiers = [
            (256, 185),
            (512, 370),
            (1024, 740),
            (2048, 1480),
        ]
        selected = select_stitch_level(
            tiers,
            tile_size=256,
            stitch_target_long_side=1024,
            stitch_max_tiles=16,
        )
        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected.level, 2)
        self.assertEqual(selected.long_side, 1024)

    def test_select_stitch_level_uses_closest_above_when_none_within(self) -> None:
        tiers = [
            (256, 185),
            (512, 370),
            (1024, 740),
        ]
        selected = select_stitch_level(
            tiers,
            tile_size=256,
            stitch_target_long_side=100,
            stitch_max_tiles=16,
        )
        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected.level, 0)
        self.assertEqual(selected.long_side, 256)

    def test_build_zoomify_tile_urls(self) -> None:
        urls = build_zoomify_tile_urls(
            "https://r2.example/tiles/X1/scan_0",
            tiers=[(512, 370)],
            tile_size=256,
            level=0,
        )
        self.assertEqual(len(urls), 4)
        self.assertEqual(
            urls[0][2],
            "https://r2.example/tiles/X1/scan_0/TileGroup0/0-0-0.jpg",
        )
        self.assertEqual(
            urls[-1][2],
            "https://r2.example/tiles/X1/scan_0/TileGroup0/0-1-1.jpg",
        )

    def test_build_zoomify_candidates_orders_r2_then_feature(self) -> None:
        candidates = build_zoomify_candidates(
            xid="X1",
            scan_index=2,
            r2_tiles_base="https://r2.example/tiles",
            feature_zoomify_path="https://images.example/zoomify/x1_scan2",
        )
        self.assertEqual(
            candidates,
            [
                ("r2_zoomify", "https://r2.example/tiles/X1/scan_2"),
                ("feature_zoomify", "https://images.example/zoomify/x1_scan2"),
            ],
        )

    def test_compute_hash_for_scan_prefers_r2_then_feature_then_archive(self) -> None:
        scan = ScanInput(
            scan_index=0,
            preview_url="https://preview.example/p.jpg",
            feature_zoomify_path="https://feature.example/zoomify",
        )
        success = HashResult(
            hash_value=123,
            image_source="r2_zoomify",
            render_mode="stitched_level_2",
            image_width=1024,
            image_height=740,
        )

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            with patch(
                "src.utils.similarity_images.load_local_stitched_hash",
                return_value=None,
            ), patch(
                "src.utils.similarity_images.compute_zoomify_hash",
                return_value=success,
            ) as compute_zoomify_hash_mock, patch(
                "src.utils.similarity_images.fetch_zoomify_meta",
            ) as fetch_zoomify_meta_mock:
                result = compute_hash_for_scan(
                    session=object(),  # not used by mocked functions
                    xid="X1",
                    scan=scan,
                    archive_base_url="https://archive.example",
                    r2_tiles_base="https://r2.example/tiles",
                    hash_size=8,
                    stitch_target_long_side=1024,
                    stitch_max_tiles=16,
                    download_root=root,
                    stitched_root=root / "stitched",
                    no_download_cache=False,
                )
        self.assertEqual(result, success)
        self.assertEqual(compute_zoomify_hash_mock.call_count, 1)
        first_call = compute_zoomify_hash_mock.call_args_list[0].kwargs
        self.assertEqual(
            first_call["zoomify_img_path"],
            "https://r2.example/tiles/X1/scan_0",
        )
        fetch_zoomify_meta_mock.assert_not_called()

    def test_compute_hash_for_scan_uses_feature_when_r2_fails(self) -> None:
        scan = ScanInput(
            scan_index=1,
            preview_url="",
            feature_zoomify_path="https://feature.example/zoomify/x1",
        )
        success = HashResult(
            hash_value=456,
            image_source="feature_zoomify",
            render_mode="stitched_level_1",
            image_width=512,
            image_height=370,
        )

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            with patch(
                "src.utils.similarity_images.load_local_stitched_hash",
                return_value=None,
            ), patch(
                "src.utils.similarity_images.compute_zoomify_hash",
                side_effect=[RuntimeError("r2 down"), success],
            ) as compute_zoomify_hash_mock, patch(
                "src.utils.similarity_images.fetch_zoomify_meta",
            ) as fetch_zoomify_meta_mock:
                result = compute_hash_for_scan(
                    session=object(),
                    xid="X1",
                    scan=scan,
                    archive_base_url="https://archive.example",
                    r2_tiles_base="https://r2.example/tiles",
                    hash_size=8,
                    stitch_target_long_side=1024,
                    stitch_max_tiles=16,
                    download_root=root,
                    stitched_root=root / "stitched",
                    no_download_cache=False,
                )
        self.assertEqual(result, success)
        self.assertEqual(compute_zoomify_hash_mock.call_count, 2)
        first_call = compute_zoomify_hash_mock.call_args_list[0].kwargs
        second_call = compute_zoomify_hash_mock.call_args_list[1].kwargs
        self.assertEqual(
            first_call["zoomify_img_path"],
            "https://r2.example/tiles/X1/scan_1",
        )
        self.assertEqual(
            second_call["zoomify_img_path"],
            "https://feature.example/zoomify/x1",
        )
        fetch_zoomify_meta_mock.assert_not_called()

    def test_compute_hash_for_scan_uses_archive_when_r2_and_feature_fail(self) -> None:
        scan = ScanInput(
            scan_index=0,
            preview_url="",
            feature_zoomify_path="https://feature.example/zoomify/x1",
        )
        success = HashResult(
            hash_value=789,
            image_source="archive_zoomify",
            render_mode="single_tile_level0",
            image_width=256,
            image_height=185,
        )

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            with patch(
                "src.utils.similarity_images.load_local_stitched_hash",
                return_value=None,
            ), patch(
                "src.utils.similarity_images.compute_zoomify_hash",
                side_effect=[RuntimeError("r2 down"), RuntimeError("feature down"), success],
            ) as compute_zoomify_hash_mock, patch(
                "src.utils.similarity_images.fetch_zoomify_meta",
                return_value=("https://archive.example/zoomify/X1", 2048, 1200, 256),
            ) as fetch_zoomify_meta_mock:
                result = compute_hash_for_scan(
                    session=object(),
                    xid="X1",
                    scan=scan,
                    archive_base_url="https://archive.example",
                    r2_tiles_base="https://r2.example/tiles",
                    hash_size=8,
                    stitch_target_long_side=1024,
                    stitch_max_tiles=16,
                    download_root=root,
                    stitched_root=root / "stitched",
                    no_download_cache=False,
                )
        self.assertEqual(result, success)
        self.assertEqual(compute_zoomify_hash_mock.call_count, 3)
        third_call = compute_zoomify_hash_mock.call_args_list[2].kwargs
        self.assertEqual(
            third_call["zoomify_img_path"],
            "https://archive.example/zoomify/X1",
        )
        fetch_zoomify_meta_mock.assert_called_once()

    def test_load_hash_cache_requires_hash_profile(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hashes.jsonl"
            path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "xid": "X1",
                                "group_id": "G1",
                                "hash": "00ff",
                                "algo": "dhash",
                                "hash_size": 8,
                                "scan_index": 0,
                                "hash_profile": "profile-v2",
                            }
                        ),
                        json.dumps(
                            {
                                "xid": "X2",
                                "group_id": "G2",
                                "hash": "00aa",
                                "algo": "dhash",
                                "hash_size": 8,
                                "scan_index": 0,
                                "hash_profile": "other-profile",
                            }
                        ),
                        json.dumps(
                            {
                                "xid": "X3",
                                "group_id": "G3",
                                "hash": "00bb",
                                "algo": "dhash",
                                "hash_size": 8,
                                "scan_index": 0,
                            }
                        ),
                    ]
                ),
                encoding="utf-8",
            )
            cache = load_hash_cache(
                path,
                force=False,
                hash_size=8,
                hash_profile="profile-v2",
            )
        self.assertEqual(sorted(cache.keys()), [("X1", 0)])

    def test_load_hash_cache_respects_expected_algo(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hashes.jsonl"
            path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "xid": "X1",
                                "group_id": "G1",
                                "hash": "00ff",
                                "algo": "dhash",
                                "hash_size": 8,
                                "scan_index": 0,
                                "hash_profile": "profile-v3",
                            }
                        ),
                        json.dumps(
                            {
                                "xid": "X2",
                                "group_id": "G2",
                                "hash": "00aa",
                                "algo": "dhash-edge-mountcrop",
                                "hash_size": 8,
                                "scan_index": 0,
                                "hash_profile": "profile-v3",
                            }
                        ),
                    ]
                ),
                encoding="utf-8",
            )
            cache = load_hash_cache(
                path,
                force=False,
                hash_size=8,
                hash_profile="profile-v3",
                expected_algo="dhash-edge-mountcrop",
            )
        self.assertEqual(sorted(cache.keys()), [("X2", 0)])

    def test_visual_hash_combines_dhash_and_edge_hash(self) -> None:
        image = Image.new("RGB", (64, 64), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((6, 6, 58, 58), outline="black", width=4)
        draw.line((16, 48, 48, 16), fill="black", width=3)

        hash_size = 8
        component_bits = hash_size * hash_size
        mask = (1 << component_bits) - 1
        value = visual_hash(image, hash_size)

        self.assertEqual(value >> component_bits, dhash(image, hash_size))
        self.assertEqual(value & mask, edge_hash(image, hash_size))

    def test_mounted_photo_crop_detects_inset_photo(self) -> None:
        image = Image.new("RGB", (400, 300), (224, 204, 160))
        draw = ImageDraw.Draw(image)
        draw.rectangle((120, 80, 280, 190), fill=(120, 125, 110))
        draw.line((130, 165, 270, 95), fill=(40, 40, 40), width=3)
        draw.text((155, 212), "caption", fill=(80, 70, 50))

        cropped, applied = mounted_photo_crop(image)

        self.assertTrue(applied)
        self.assertLess(cropped.size[0], image.size[0] * 0.7)
        self.assertLess(cropped.size[1], image.size[1] * 0.7)

    def test_mounted_photo_crop_leaves_full_frame_image(self) -> None:
        image = Image.new("RGB", (300, 220), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 299, 219), outline="black", width=6)
        draw.rectangle((8, 8, 292, 212), fill=(120, 120, 120))
        draw.line((10, 190, 290, 20), fill=(30, 30, 30), width=4)
        draw.line((20, 20, 270, 205), fill=(210, 210, 210), width=3)

        cropped, applied = mounted_photo_crop(image)

        self.assertFalse(applied)
        self.assertEqual(cropped.size, image.size)

    def test_resolve_distances(self) -> None:
        self.assertEqual(build_similarity.resolve_distances(None, None, None), (18, 32))
        self.assertEqual(build_similarity.resolve_distances(7, None, None), (7, 7))
        self.assertEqual(build_similarity.resolve_distances(7, 5, None), (5, 7))
        self.assertEqual(build_similarity.resolve_distances(7, 5, 6), (5, 6))


if __name__ == "__main__":
    unittest.main()
