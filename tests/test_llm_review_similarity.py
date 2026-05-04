import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

from scripts import llm_review_similarity


class LlmReviewSimilarityTests(unittest.TestCase):
    def test_select_pairs_spreads_across_input(self) -> None:
        pairs = [
            {
                "group_id_a": f"a{i}",
                "group_id_b": f"b{i}",
                "distance": i,
            }
            for i in range(5)
        ]

        selected = llm_review_similarity.select_pairs(pairs, 3, "spread", 42)

        self.assertEqual([item["distance"] for item in selected], [0, 2, 4])

    def test_load_completed_only_skips_ok_records(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "reviews.jsonl"
            path.write_text(
                "\n".join(
                    [
                        json.dumps({"status": "ok", "pair_id": "a:b"}),
                        json.dumps({"status": "error", "pair_id": "c:d"}),
                    ]
                ),
                encoding="utf-8",
            )

            completed = llm_review_similarity.load_completed(path)

        self.assertEqual(completed, {"a:b"})

    def test_extract_output_text_from_response_output(self) -> None:
        response = {
            "output": [
                {
                    "content": [
                        {
                            "type": "output_text",
                            "text": '{"verdict":"different","confidence":0.9,"reason":"x"}',
                        }
                    ]
                }
            ]
        }

        text = llm_review_similarity.extract_output_text(response)

        self.assertIn('"different"', text)

    def test_parse_model_json_validates_verdict(self) -> None:
        parsed = llm_review_similarity.parse_model_json(
            '{"verdict":"same_shot","confidence":0.91,"reason":"structures align"}'
        )

        self.assertEqual(parsed["verdict"], "same_shot")
        self.assertEqual(parsed["confidence"], 0.91)

    def test_prepare_image_returns_data_url(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "image.jpg"
            Image.new("RGB", (200, 100), "white").save(path)

            prepared = llm_review_similarity.prepare_image(path, 80, 85, False)

        self.assertTrue(prepared.data_url.startswith("data:image/jpeg;base64,"))
        self.assertEqual(prepared.prepared_width, 80)
        self.assertEqual(prepared.prepared_height, 40)

    def test_write_data_url_image_round_trips(self) -> None:
        with TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "source.jpg"
            target = Path(tmpdir) / "target.jpg"
            Image.new("RGB", (24, 12), "white").save(source)
            prepared = llm_review_similarity.prepare_image(source, 0, 85, False)

            llm_review_similarity.write_data_url_image(prepared.data_url, target)

            with Image.open(target) as image:
                self.assertEqual(image.size, (24, 12))

    def test_parse_codex_tokens_used(self) -> None:
        self.assertEqual(
            llm_review_similarity.parse_codex_tokens_used("tokens used\n18\u00a0673\n2026-05"),
            18673,
        )

    def test_materialize_candidates_filters_by_review(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            input_path = root / "candidates.json"
            reviews_path = root / "reviews.jsonl"
            output_path = root / "final.json"
            pairs = [
                {
                    "group_id_a": "a1",
                    "group_id_b": "b1",
                    "xid_a": "x1",
                    "xid_b": "y1",
                    "distance": 3,
                },
                {
                    "group_id_a": "a2",
                    "group_id_b": "b2",
                    "xid_a": "x2",
                    "xid_b": "y2",
                    "distance": 4,
                },
                {
                    "group_id_a": "a3",
                    "group_id_b": "b3",
                    "xid_a": "x3",
                    "xid_b": "y3",
                    "distance": 5,
                },
            ]
            input_path.write_text(
                json.dumps({"pair_distance": 18, "pairs": pairs}),
                encoding="utf-8",
            )
            reviews_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "status": "ok",
                                "pair_id": "a1:b1",
                                "verdict": "same_shot",
                                "confidence": 0.91,
                                "reason": "match",
                                "model": "m",
                                "backend": "codex",
                            }
                        ),
                        json.dumps(
                            {
                                "status": "ok",
                                "pair_id": "a2:b2",
                                "verdict": "different",
                                "confidence": 0.98,
                                "reason": "no",
                                "model": "m",
                                "backend": "codex",
                            }
                        ),
                        json.dumps(
                            {
                                "status": "ok",
                                "pair_id": "a3:b3",
                                "verdict": "same_shot",
                                "confidence": 0.4,
                                "reason": "weak",
                                "model": "m",
                                "backend": "codex",
                            }
                        ),
                    ]
                ),
                encoding="utf-8",
            )

            payload = llm_review_similarity.materialize_candidates(
                input_path,
                reviews_path,
                output_path,
                {"same_shot"},
                0.85,
                False,
            )

        self.assertEqual(len(payload["pairs"]), 1)
        self.assertEqual(payload["pairs"][0]["llm_verdict"], "same_shot")
        self.assertEqual(payload["llm_review"]["source_pair_count"], 3)
        self.assertEqual(payload["llm_review"]["accepted_pair_count"], 1)
        self.assertEqual(payload["llm_review"]["rejected_pair_count"], 2)

    def test_materialize_requires_complete_reviews_by_default(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            input_path = root / "candidates.json"
            reviews_path = root / "reviews.jsonl"
            output_path = root / "final.json"
            input_path.write_text(
                json.dumps(
                    {
                        "pairs": [
                            {
                                "group_id_a": "a1",
                                "group_id_b": "b1",
                                "xid_a": "x1",
                                "xid_b": "y1",
                                "distance": 3,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            reviews_path.write_text("", encoding="utf-8")

            with self.assertRaises(ValueError):
                llm_review_similarity.materialize_candidates(
                    input_path,
                    reviews_path,
                    output_path,
                    {"same_shot"},
                    0.85,
                    False,
                )


if __name__ == "__main__":
    unittest.main()
