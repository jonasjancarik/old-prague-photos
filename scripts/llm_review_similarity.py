#!/usr/bin/env python3
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import random
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import requests
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.utils.similarity_hashing import mounted_photo_crop  # noqa: E402


OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-5.4-mini"
DEFAULT_INPUT = "viewer/static/data/similarity_candidates.json"
DEFAULT_STITCHED_ROOT = "output/similarity/stitched"
DEFAULT_OUTPUT = "output/similarity/llm_pair_reviews.jsonl"
DEFAULT_FINAL_OUTPUT = "viewer/static/data/similarity_candidates.json"
DEFAULT_ACCEPT_VERDICTS = ["same_shot"]
DEFAULT_MIN_CONFIDENCE = 0.85

REVIEW_INSTRUCTIONS = """You are reviewing two archival photo scans for duplicate detection.

Decide whether the two images show the same underlying photograph, not merely
the same place or subject.

Ignore:
- black scan borders
- beige mounting cards or frames
- captions/text under the photo
- watermarks, archive stamps, dust, scratches
- tone, contrast, exposure, sepia vs black-and-white
- small crop or scale differences

Focus on the actual photographed content: object positions, building geometry,
skyline, streets, people, vehicles, shadows, perspective, and framing.

Do not infer hidden or cropped-away content. Judge only visible content. If the
dominant visible scene category differs, for example a river/log yard versus a
ruin wall, the verdict must be different. If same_shot, the reason must name
distinctive visible structures that appear in both images.

Definitions:
- same_shot: same original photograph or scan, possibly cropped, resized,
  retouched, contrast-adjusted, or mounted differently.
- same_scene_variant: same place/subject, but a different exposure, angle,
  moment, crop from another camera position, or visibly different composition.
- different: different subject/place, or only broadly similar layout/tones.
- uncertain: not enough visual evidence.

Be conservative. Use same_shot only when distinctive visual structure aligns.
If the images only share a similar panorama, riverbank, street, building type,
border, mount, or tonal pattern, use same_scene_variant or different."""

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "verdict": {
            "type": "string",
            "enum": ["same_shot", "same_scene_variant", "different", "uncertain"],
        },
        "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
        },
        "reason": {
            "type": "string",
            "maxLength": 160,
        },
    },
    "required": ["verdict", "confidence", "reason"],
}


@dataclass(frozen=True)
class PreparedImage:
    path: Path
    data_url: str
    original_width: int
    original_height: int
    prepared_width: int
    prepared_height: int
    crop_applied: bool
    bytes_sent: int


def load_env(path: Path) -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(path)


def load_candidates(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    pairs = payload.get("pairs", [])
    if not isinstance(pairs, list):
        raise ValueError(f"{path} does not contain a pairs array")
    return pairs


def load_candidate_payload(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    pairs = payload.get("pairs", [])
    if not isinstance(pairs, list):
        raise ValueError(f"{path} does not contain a pairs array")
    return payload


def pair_id(pair: dict[str, Any]) -> str:
    group_a = str(pair["group_id_a"])
    group_b = str(pair["group_id_b"])
    return f"{group_a}:{group_b}"


def select_pairs(
    pairs: list[dict[str, Any]],
    limit: int,
    sample: str,
    seed: int,
) -> list[dict[str, Any]]:
    if limit <= 0 or limit >= len(pairs):
        return pairs
    if sample == "first":
        return pairs[:limit]
    if sample == "random":
        rng = random.Random(seed)
        selected = rng.sample(pairs, limit)
        return sorted(selected, key=lambda item: (int(item["distance"]), pair_id(item)))

    step = (len(pairs) - 1) / (limit - 1) if limit > 1 else 0
    return [pairs[round(index * step)] for index in range(limit)]


def load_completed(path: Path) -> set[str]:
    if not path.exists():
        return set()
    completed: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if item.get("status") == "ok" and item.get("pair_id"):
            completed.add(str(item["pair_id"]))
    return completed


def load_review_records(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    records: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if item.get("status") != "ok" or not item.get("pair_id"):
            continue
        records[str(item["pair_id"])] = item
    return records


def accepted_verdicts(raw_verdicts: list[str] | None) -> set[str]:
    verdicts = raw_verdicts or DEFAULT_ACCEPT_VERDICTS
    allowed = {"same_shot", "same_scene_variant", "different", "uncertain"}
    result = {str(item).strip() for item in verdicts if str(item).strip()}
    unknown = result - allowed
    if unknown:
        raise ValueError(f"Unknown accepted verdict(s): {', '.join(sorted(unknown))}")
    return result


def review_is_accepted(
    review: dict[str, Any],
    verdicts: set[str],
    min_confidence: float,
) -> bool:
    try:
        confidence = float(review.get("confidence"))
    except (TypeError, ValueError):
        return False
    return str(review.get("verdict")) in verdicts and confidence >= min_confidence


def find_stitched_image(stitched_root: Path, xid: str) -> Path:
    scan_zero = stitched_root / xid / "scan_0.jpg"
    if scan_zero.exists():
        return scan_zero
    image_dir = stitched_root / xid
    matches = sorted(image_dir.glob("scan_*.jpg")) if image_dir.exists() else []
    if matches:
        return matches[0]
    raise FileNotFoundError(f"No stitched image found for {xid}")


def resize_to_max_side(image: Image.Image, max_side: int) -> Image.Image:
    if max_side <= 0:
        return image
    width, height = image.size
    if max(width, height) <= max_side:
        return image
    scale = max_side / max(width, height)
    new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(new_size, Image.Resampling.LANCZOS)


def prepare_image(
    path: Path,
    max_side: int,
    jpeg_quality: int,
    crop_mounted: bool,
) -> PreparedImage:
    with Image.open(path) as image:
        rgb = ImageOps.exif_transpose(image).convert("RGB")
    original_width, original_height = rgb.size
    crop_applied = False
    if crop_mounted:
        rgb, crop_applied = mounted_photo_crop(rgb)
    rgb = resize_to_max_side(rgb, max_side)
    buffer = BytesIO()
    rgb.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True)
    payload = buffer.getvalue()
    encoded = base64.b64encode(payload).decode("ascii")
    return PreparedImage(
        path=path,
        data_url=f"data:image/jpeg;base64,{encoded}",
        original_width=original_width,
        original_height=original_height,
        prepared_width=rgb.width,
        prepared_height=rgb.height,
        crop_applied=crop_applied,
        bytes_sent=len(payload),
    )


def image_payload(image: PreparedImage, detail: str) -> dict[str, str]:
    return {
        "type": "input_image",
        "image_url": image.data_url,
        "detail": detail,
    }


def build_request_payload(
    model: str,
    pair: dict[str, Any],
    image_a: PreparedImage,
    image_b: PreparedImage,
    detail: str,
    max_output_tokens: int,
) -> dict[str, Any]:
    text = (
        "Compare image A and image B. Are they the same underlying photograph?\n"
        f"Perceptual hash distance: {pair.get('distance')}\n"
        "Return only JSON matching the schema."
    )
    return {
        "model": model,
        "instructions": REVIEW_INSTRUCTIONS,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": text},
                    image_payload(image_a, detail),
                    image_payload(image_b, detail),
                ],
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "photo_duplicate_verdict",
                "strict": True,
                "schema": RESPONSE_SCHEMA,
            }
        },
        "store": False,
        "max_output_tokens": max_output_tokens,
    }


def extract_output_text(response: dict[str, Any]) -> str:
    direct = response.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct

    chunks: list[str] = []
    for item in response.get("output", []):
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []):
            if not isinstance(content, dict):
                continue
            text = content.get("text")
            if isinstance(text, str):
                chunks.append(text)
    return "\n".join(chunks).strip()


def parse_model_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    payload = json.loads(cleaned.strip())
    verdict = payload.get("verdict")
    if verdict not in {"same_shot", "same_scene_variant", "different", "uncertain"}:
        raise ValueError(f"Unexpected verdict: {verdict}")
    confidence = float(payload.get("confidence"))
    if confidence < 0 or confidence > 1:
        raise ValueError(f"Unexpected confidence: {confidence}")
    payload["confidence"] = confidence
    payload["reason"] = str(payload.get("reason") or "").strip()
    return payload


def call_openai(
    session: requests.Session,
    api_key: str,
    payload: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    response = session.post(
        OPENAI_RESPONSES_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=timeout,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"OpenAI API error {response.status_code}: {response.text[:1200]}")
    return response.json()


def review_pair_openai(
    session: requests.Session,
    api_key: str,
    pair: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    xid_a = str(pair["xid_a"])
    xid_b = str(pair["xid_b"])
    image_a = prepare_image(
        find_stitched_image(args.stitched_root, xid_a),
        args.max_side,
        args.jpeg_quality,
        not args.no_crop,
    )
    image_b = prepare_image(
        find_stitched_image(args.stitched_root, xid_b),
        args.max_side,
        args.jpeg_quality,
        not args.no_crop,
    )
    request_payload = build_request_payload(
        args.model,
        pair,
        image_a,
        image_b,
        args.detail,
        args.max_output_tokens,
    )
    response = call_openai(session, api_key, request_payload, args.timeout)
    verdict = parse_model_json(extract_output_text(response))
    return {
        "status": "ok",
        "pair_id": pair_id(pair),
        "group_id_a": pair["group_id_a"],
        "group_id_b": pair["group_id_b"],
        "xid_a": xid_a,
        "xid_b": xid_b,
        "distance": pair["distance"],
        "backend": "openai",
        "model": args.model,
        "detail": args.detail,
        "verdict": verdict["verdict"],
        "confidence": verdict["confidence"],
        "reason": verdict["reason"],
        "response_id": response.get("id"),
        "usage": response.get("usage", {}),
        "images": {
            "a": image_metadata(image_a),
            "b": image_metadata(image_b),
        },
    }


def review_pair_codex(pair: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    xid_a = str(pair["xid_a"])
    xid_b = str(pair["xid_b"])
    image_a = prepare_image(
        find_stitched_image(args.stitched_root, xid_a),
        args.max_side,
        args.jpeg_quality,
        not args.no_crop,
    )
    image_b = prepare_image(
        find_stitched_image(args.stitched_root, xid_b),
        args.max_side,
        args.jpeg_quality,
        not args.no_crop,
    )
    with TemporaryDirectory() as tmpdir:
        tmp_root = Path(tmpdir)
        image_a_path = tmp_root / "image_a.jpg"
        image_b_path = tmp_root / "image_b.jpg"
        schema_path = tmp_root / "schema.json"
        result_path = tmp_root / "result.json"
        write_data_url_image(image_a.data_url, image_a_path)
        write_data_url_image(image_b.data_url, image_b_path)
        schema_path.write_text(
            json.dumps(RESPONSE_SCHEMA, ensure_ascii=True),
            encoding="utf-8",
        )
        prompt = (
            f"{REVIEW_INSTRUCTIONS}\n\n"
            "Compare the two attached archival photo scans. Are they the same "
            "underlying photograph? Return only JSON matching the schema."
        )
        command = [
            args.codex_bin,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox",
            "read-only",
            "-m",
            args.model,
            "-c",
            f"model_reasoning_effort={args.codex_reasoning_effort}",
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(result_path),
            "--image",
            str(image_a_path),
            "--image",
            str(image_b_path),
            "-",
        ]
        completed = subprocess.run(
            command,
            input=prompt,
            text=True,
            capture_output=True,
            timeout=args.timeout,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"codex exec failed with {completed.returncode}: "
                f"{completed.stderr[-1200:] or completed.stdout[-1200:]}"
            )
        output_text = (
            result_path.read_text(encoding="utf-8").strip()
            if result_path.exists()
            else completed.stdout.strip()
        )
        verdict = parse_model_json(output_text)
        return {
            "status": "ok",
            "pair_id": pair_id(pair),
            "group_id_a": pair["group_id_a"],
            "group_id_b": pair["group_id_b"],
            "xid_a": xid_a,
            "xid_b": xid_b,
            "distance": pair["distance"],
            "backend": "codex",
            "model": args.model,
            "detail": None,
            "verdict": verdict["verdict"],
            "confidence": verdict["confidence"],
            "reason": verdict["reason"],
            "codex_tokens_used": parse_codex_tokens_used(completed.stderr),
            "images": {
                "a": image_metadata(image_a),
                "b": image_metadata(image_b),
            },
        }


def write_data_url_image(data_url: str, path: Path) -> None:
    _, encoded = data_url.split(",", 1)
    path.write_bytes(base64.b64decode(encoded))


def parse_codex_tokens_used(stderr: str) -> int | None:
    match = re.search(r"tokens used\s*\n?\s*([0-9][0-9,\u00a0 ]*)", stderr, re.IGNORECASE)
    if not match:
        return None
    digits = re.sub(r"\D", "", match.group(1))
    return int(digits) if digits else None


def image_metadata(image: PreparedImage) -> dict[str, Any]:
    return {
        "path": str(image.path),
        "original_width": image.original_width,
        "original_height": image.original_height,
        "prepared_width": image.prepared_width,
        "prepared_height": image.prepared_height,
        "crop_applied": image.crop_applied,
        "bytes_sent": image.bytes_sent,
    }


def write_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True) + "\n")
        handle.flush()


def pair_with_review(pair: dict[str, Any], review: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(pair)
    enriched["llm_verdict"] = review.get("verdict")
    enriched["llm_confidence"] = review.get("confidence")
    enriched["llm_reason"] = review.get("reason")
    enriched["llm_model"] = review.get("model")
    enriched["llm_backend"] = review.get("backend") or "openai"
    return enriched


def materialize_candidates(
    input_path: Path,
    reviews_path: Path,
    output_path: Path,
    verdicts: set[str],
    min_confidence: float,
    allow_partial: bool,
) -> dict[str, Any]:
    source_payload = load_candidate_payload(input_path)
    pairs = source_payload["pairs"]
    reviews = load_review_records(reviews_path)
    missing = [pair for pair in pairs if pair_id(pair) not in reviews]
    if missing and not allow_partial:
        raise ValueError(
            f"{len(missing)} candidate pair(s) have no successful LLM review. "
            "Pass --allow-partial for a smoke/test materialization."
        )

    accepted_pairs: list[dict[str, Any]] = []
    rejected_count = 0
    reviewed_count = 0
    for pair in pairs:
        review = reviews.get(pair_id(pair))
        if not review:
            continue
        reviewed_count += 1
        if review_is_accepted(review, verdicts, min_confidence):
            accepted_pairs.append(pair_with_review(pair, review))
        else:
            rejected_count += 1

    output_payload = dict(source_payload)
    output_payload["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    output_payload["pairs"] = sorted(
        accepted_pairs,
        key=lambda item: (item["distance"], item["group_id_a"], item["group_id_b"]),
    )
    output_payload["llm_review"] = {
        "source_candidates": str(input_path),
        "reviews": str(reviews_path),
        "source_pair_count": len(pairs),
        "reviewed_pair_count": reviewed_count,
        "accepted_pair_count": len(accepted_pairs),
        "rejected_pair_count": rejected_count,
        "missing_review_count": len(missing),
        "accepted_verdicts": sorted(verdicts),
        "min_confidence": min_confidence,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(output_payload, ensure_ascii=True, indent=2),
        encoding="utf-8",
    )
    return output_payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Use a vision model to adjudicate and materialize similarity candidates.",
    )
    parser.add_argument(
        "--mode",
        choices=["review", "materialize"],
        default="review",
        help="Run model reviews or write a final candidate dataset from reviews.",
    )
    parser.add_argument("--input", default=DEFAULT_INPUT)
    parser.add_argument("--stitched-root", default=DEFAULT_STITCHED_ROOT)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--final-output", default=DEFAULT_FINAL_OUTPUT)
    parser.add_argument("--env-file", default=".env")
    parser.add_argument(
        "--backend",
        choices=["openai", "codex"],
        default="openai",
        help="Use direct OpenAI Responses API or shell out to codex exec.",
    )
    parser.add_argument("--model", default=None)
    parser.add_argument("--detail", choices=["low", "high", "auto"], default="high")
    parser.add_argument("--codex-bin", default="codex")
    parser.add_argument("--codex-reasoning-effort", default="low")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--sample",
        choices=["first", "spread", "random"],
        default="spread",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-side", type=int, default=1024)
    parser.add_argument("--jpeg-quality", type=int, default=88)
    parser.add_argument("--max-output-tokens", type=int, default=220)
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--sleep", type=float, default=0.0)
    parser.add_argument(
        "--jobs",
        type=int,
        default=1,
        help="Number of pair reviews to run concurrently.",
    )
    parser.add_argument(
        "--accept-verdict",
        action="append",
        default=None,
        help=(
            "LLM verdict to include in materialized output. "
            "Repeatable; default: same_shot."
        ),
    )
    parser.add_argument("--min-confidence", type=float, default=DEFAULT_MIN_CONFIDENCE)
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="Allow materializing even when some input pairs have no successful review.",
    )
    parser.add_argument(
        "--allow-in-place",
        action="store_true",
        help="Allow materializing to the same path used as --input.",
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--no-crop",
        action="store_true",
        help="Send full stitched scans instead of applying mounted-photo crop.",
    )
    args = parser.parse_args()
    args.input = Path(args.input)
    args.stitched_root = Path(args.stitched_root)
    args.output = Path(args.output)
    args.final_output = Path(args.final_output)
    args.env_file = Path(args.env_file)
    return args


def review_one_pair(
    pair: dict[str, Any],
    args: argparse.Namespace,
    api_key: str | None,
) -> dict[str, Any]:
    if args.backend == "openai":
        with requests.Session() as session:
            return review_pair_openai(session, str(api_key), pair, args)
    return review_pair_codex(pair, args)


def error_record_for_pair(
    pair: dict[str, Any],
    args: argparse.Namespace,
    exc: Exception,
) -> dict[str, Any]:
    return {
        "status": "error",
        "pair_id": pair_id(pair),
        "group_id_a": pair.get("group_id_a"),
        "group_id_b": pair.get("group_id_b"),
        "xid_a": pair.get("xid_a"),
        "xid_b": pair.get("xid_b"),
        "distance": pair.get("distance"),
        "backend": args.backend,
        "model": args.model,
        "detail": args.detail,
        "error": str(exc),
    }


def print_review_progress(
    index: int,
    total: int,
    pair: dict[str, Any],
    record: dict[str, Any],
    elapsed: float,
) -> None:
    if record.get("status") == "ok":
        print(
            f"{index}/{total} d={pair['distance']} "
            f"{record['verdict']} conf={record['confidence']:.2f} "
            f"{elapsed:.1f}s"
        )
    else:
        print(f"{index}/{total} d={pair.get('distance')} ERROR {record.get('error')}")


def run_reviews(
    pending: list[dict[str, Any]],
    args: argparse.Namespace,
    api_key: str | None,
) -> None:
    total = len(pending)
    if total == 0:
        return
    jobs = max(1, args.jobs)
    if jobs == 1:
        for index, pair in enumerate(pending, start=1):
            started = time.time()
            try:
                record = review_one_pair(pair, args, api_key)
            except Exception as exc:
                record = error_record_for_pair(pair, args, exc)
            write_jsonl(args.output, record)
            print_review_progress(index, total, pair, record, time.time() - started)
            if args.sleep:
                time.sleep(args.sleep)
        return

    with ThreadPoolExecutor(max_workers=jobs) as executor:
        future_to_pair = {}
        for pair in pending:
            future_to_pair[executor.submit(review_one_pair, pair, args, api_key)] = (
                pair,
                time.time(),
            )
            if args.sleep:
                time.sleep(args.sleep)
        for index, future in enumerate(as_completed(future_to_pair), start=1):
            pair, started = future_to_pair[future]
            try:
                record = future.result()
            except Exception as exc:
                record = error_record_for_pair(pair, args, exc)
            write_jsonl(args.output, record)
            print_review_progress(index, total, pair, record, time.time() - started)


def main() -> None:
    args = parse_args()
    load_env(args.env_file)
    args.model = (
        args.model
        or os.getenv("OPENAI_VISION_MODEL")
        or os.getenv("OPENAI_MODEL")
        or DEFAULT_MODEL
    )
    api_key = os.getenv("OPENAI_API_KEY")
    if args.mode == "review" and args.backend == "openai" and not api_key and not args.dry_run:
        raise SystemExit("OPENAI_API_KEY is not set")

    if args.mode == "materialize":
        if (
            args.input.resolve() == args.final_output.resolve()
            and not args.allow_in_place
        ):
            raise SystemExit(
                "Refusing to materialize in place. Use a stable raw candidate source, "
                "for example --input output/similarity/hash_candidates.json, or pass "
                "--allow-in-place explicitly."
            )
        payload = materialize_candidates(
            args.input,
            args.output,
            args.final_output,
            accepted_verdicts(args.accept_verdict),
            args.min_confidence,
            args.allow_partial,
        )
        review_info = payload["llm_review"]
        print(
            f"Wrote {review_info['accepted_pair_count']} accepted pairs "
            f"from {review_info['reviewed_pair_count']} reviewed pairs to {args.final_output}"
        )
        if review_info["missing_review_count"]:
            print(f"Missing reviews: {review_info['missing_review_count']}")
        return

    pairs = select_pairs(load_candidates(args.input), args.limit, args.sample, args.seed)
    completed = set() if args.force else load_completed(args.output)
    pending = [item for item in pairs if pair_id(item) not in completed]
    print(
        f"Loaded {len(pairs)} selected pairs; "
        f"{len(completed)} already reviewed; {len(pending)} pending."
    )
    print(
        f"Backend={args.backend} model={args.model} detail={args.detail} "
        f"output={args.output}"
    )

    if args.dry_run:
        for item in pending:
            print(
                json.dumps(
                    {
                        "pair_id": pair_id(item),
                        "distance": item["distance"],
                        "xid_a": item["xid_a"],
                        "xid_b": item["xid_b"],
                    },
                    ensure_ascii=True,
                )
            )
        return

    run_reviews(pending, args, str(api_key) if api_key else None)


if __name__ == "__main__":
    main()
