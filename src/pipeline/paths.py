from __future__ import annotations

import json
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from src.pipeline.atomic_io import atomic_write_json, atomic_write_text


@dataclass(frozen=True)
class PipelinePaths:
    root: Path

    @classmethod
    def from_run_dir(cls, run_dir: str | Path) -> "PipelinePaths":
        return cls(Path(run_dir))

    @property
    def config_path(self) -> Path:
        return self.root / "config.json"

    @property
    def manifest_path(self) -> Path:
        return self.root / "manifest.json"

    @property
    def stage_log_path(self) -> Path:
        return self.root / "stage_log.jsonl"

    @property
    def collect_dir(self) -> Path:
        return self.root / "collect"

    @property
    def available_record_ids_path(self) -> Path:
        return self.collect_dir / "available_record_ids.json"

    @property
    def raw_records_dir(self) -> Path:
        return self.collect_dir / "raw_records"

    @property
    def failed_xids_path(self) -> Path:
        return self.collect_dir / "failed_xids.jsonl"

    @property
    def missing_details_xids_path(self) -> Path:
        return self.collect_dir / "missing_details_xids.json"

    @property
    def nav_partition_progress_path(self) -> Path:
        return self.collect_dir / "nav_partition_progress.json"

    @property
    def filter_dir(self) -> Path:
        return self.root / "filter"

    @property
    def records_with_places_path(self) -> Path:
        return self.filter_dir / "records_with_places.json"

    @property
    def geolocation_dir(self) -> Path:
        return self.root / "geolocation"

    @property
    def geolocation_ok_dir(self) -> Path:
        return self.geolocation_dir / "ok"

    @property
    def geolocation_failed_dir(self) -> Path:
        return self.geolocation_dir / "failed"

    @property
    def llm_dir(self) -> Path:
        return self.geolocation_dir / "llm"

    @property
    def llm_batches_path(self) -> Path:
        return self.llm_dir / "batches.json"

    @property
    def llm_prompts_path(self) -> Path:
        return self.llm_dir / "prompts.json"

    @property
    def llm_batch_results_dir(self) -> Path:
        return self.llm_dir / "batch_results"

    @property
    def llm_batch_requests_dir(self) -> Path:
        return self.llm_dir / "batch_requests"

    @property
    def llm_failed_dir(self) -> Path:
        return self.geolocation_failed_dir / "records_without_cp_llm"

    @property
    def export_dir(self) -> Path:
        return self.root / "export"

    @property
    def photos_csv_path(self) -> Path:
        return self.export_dir / "old_prague_photos.csv"

    @property
    def viewer_data_dir(self) -> Path:
        return self.root / "viewer-data"

    @property
    def photos_geojson_path(self) -> Path:
        return self.viewer_data_dir / "photos.geojson"

    @property
    def similarity_candidates_path(self) -> Path:
        return self.viewer_data_dir / "similarity_candidates.json"

    @property
    def series_version_clusters_path(self) -> Path:
        return self.viewer_data_dir / "series_version_clusters.json"

    def required_snapshot_inputs(self) -> list[Path]:
        return [self.raw_records_dir, self.geolocation_ok_dir]

    def directories(self) -> list[Path]:
        return [
            self.collect_dir,
            self.raw_records_dir,
            self.filter_dir,
            self.geolocation_ok_dir,
            self.geolocation_failed_dir,
            self.llm_dir,
            self.llm_batch_results_dir,
            self.llm_batch_requests_dir,
            self.export_dir,
            self.viewer_data_dir,
        ]

    def manifest_artifacts(self) -> list[str]:
        return [
            self._relative(self.stage_log_path),
            self._relative(self.available_record_ids_path),
            self._relative(self.failed_xids_path),
            self._relative(self.missing_details_xids_path),
            self._relative(self.nav_partition_progress_path),
            self._relative(self.llm_batches_path),
            self._relative(self.llm_prompts_path),
            self._relative(self.photos_csv_path),
            self._relative(self.photos_geojson_path),
            self._relative(self.similarity_candidates_path),
            self._relative(self.series_version_clusters_path),
        ]

    def manifest_count_dirs(self) -> list[str]:
        return [
            self._relative(self.raw_records_dir),
            self._relative(self.geolocation_ok_dir),
            self._relative(self.geolocation_failed_dir),
            self._relative(self.llm_batch_results_dir),
            self._relative(self.llm_batch_requests_dir),
        ]

    def create(self, config: dict[str, Any] | None = None) -> None:
        for directory in self.directories():
            directory.mkdir(parents=True, exist_ok=True)
        if config is not None:
            atomic_write_json(
                self.config_path,
                config,
                indent=2,
                trailing_newline=True,
            )

    def assert_snapshot_inputs(self) -> None:
        missing = [path for path in self.required_snapshot_inputs() if not path.exists()]
        if missing:
            joined = ", ".join(str(path) for path in missing)
            raise FileNotFoundError(f"Missing run snapshot input(s): {joined}")

    def copy_current_output_snapshot(self, output_dir: Path = Path("output")) -> None:
        if self.root.exists() and any(self.root.iterdir()):
            raise FileExistsError(
                f"Refusing to overwrite nonempty run directory: {self.root}"
            )
        copy_specs = [
            (output_dir / "available_record_ids.json", self.available_record_ids_path),
            (output_dir / "failed_xids.jsonl", self.failed_xids_path),
            (output_dir / "missing_details_xids.json", self.missing_details_xids_path),
            (output_dir / "nav_partition_progress.json", self.nav_partition_progress_path),
            (output_dir / "raw_records", self.raw_records_dir),
            (output_dir / "geolocation" / "ok", self.geolocation_ok_dir),
            (output_dir / "geolocation" / "failed", self.geolocation_failed_dir),
            (output_dir / "batches.json", self.llm_batches_path),
            (output_dir / "prompts.json", self.llm_prompts_path),
            (output_dir / "batch_results", self.llm_batch_results_dir),
        ]
        self.create()
        for source, target in copy_specs:
            if not source.exists():
                continue
            if source.is_dir():
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(source, target)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)

        for source in sorted(output_dir.glob("batch_request_*.jsonl")):
            target = self.llm_batch_requests_dir / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    def publish_current_output_snapshot(
        self,
        output_dir: Path = Path("output"),
        photos_geojson_path: Path = Path("viewer/static/data/photos.geojson"),
    ) -> None:
        """Publish a completed run back to the legacy snapshot and web dataset."""
        self.assert_snapshot_inputs()
        self.validate_publish_snapshot()

        output_dir = Path(output_dir)
        photos_geojson_path = Path(photos_geojson_path)
        publish_id = uuid.uuid4().hex
        output_staging = output_dir.parent / f".{output_dir.name}.publish-{publish_id}"
        output_backup = output_dir.parent / f".{output_dir.name}.backup-{publish_id}"
        photo_staging = photos_geojson_path.parent / (
            f".{photos_geojson_path.name}.publish-{publish_id}"
        )
        photo_backup = photos_geojson_path.parent / (
            f".{photos_geojson_path.name}.backup-{publish_id}"
        )

        output_dir.parent.mkdir(parents=True, exist_ok=True)
        photos_geojson_path.parent.mkdir(parents=True, exist_ok=True)
        record_directory_specs = [
            (self.raw_records_dir, output_staging / "raw_records"),
            (self.geolocation_ok_dir, output_staging / "geolocation" / "ok"),
            (self.geolocation_failed_dir, output_staging / "geolocation" / "failed"),
        ]
        immutable_directory_specs = [
            (self.llm_batch_results_dir, output_staging / "batch_results"),
        ]
        json_array_specs = [
            (self.available_record_ids_path, output_staging / "available_record_ids.json"),
            (
                self.missing_details_xids_path,
                output_staging / "missing_details_xids.json",
            ),
        ]
        json_object_specs = [
            (
                self.nav_partition_progress_path,
                output_staging / "nav_partition_progress.json",
            ),
            (self.llm_batches_path, output_staging / "batches.json"),
            (self.llm_prompts_path, output_staging / "prompts.json"),
        ]
        jsonl_specs = [
            (self.failed_xids_path, output_staging / "failed_xids.jsonl"),
        ]
        replace_file_specs = [
            (self.photos_csv_path, output_staging / "old_prague_photos.csv"),
        ]

        try:
            if output_dir.exists():
                shutil.copytree(output_dir, output_staging)
            else:
                output_staging.mkdir()
            for source, target in record_directory_specs:
                if source.exists():
                    self._merge_record_directory(source, target)
            for source, target in immutable_directory_specs:
                if source.exists():
                    self._merge_immutable_directory(source, target)
            for source, target in json_array_specs:
                if source.exists():
                    self._merge_json_file(source, target, expected_type=list)
            for source, target in json_object_specs:
                if source.exists():
                    self._merge_json_file(source, target, expected_type=dict)
            for source, target in jsonl_specs:
                if source.exists():
                    self._merge_jsonl_file(source, target)
            for source, target in replace_file_specs:
                if source.exists():
                    self._replace_file(source, target)

            for source in sorted(
                self.llm_batch_requests_dir.glob("batch_request_*.jsonl")
            ):
                target = output_staging / source.name
                self._copy_immutable_file(source, target)

            self._stage_merged_geojson(
                source=self.photos_geojson_path,
                current=photos_geojson_path,
                target=photo_staging,
            )
            self._commit_staged_publication(
                output_dir=output_dir,
                output_staging=output_staging,
                output_backup=output_backup,
                photos_path=photos_geojson_path,
                photo_staging=photo_staging,
                photo_backup=photo_backup,
            )
        finally:
            if output_staging.exists():
                shutil.rmtree(output_staging)
            if photo_staging.exists():
                photo_staging.unlink()

    @staticmethod
    def _commit_staged_publication(
        *,
        output_dir: Path,
        output_staging: Path,
        output_backup: Path,
        photos_path: Path,
        photo_staging: Path,
        photo_backup: Path,
    ) -> None:
        output_had_original = output_dir.exists()
        photo_had_original = photos_path.exists()
        output_committed = False
        photo_backed_up = False
        publication_settled = False
        try:
            if output_had_original:
                os.replace(output_dir, output_backup)
            os.replace(output_staging, output_dir)
            output_committed = True
            if photo_had_original:
                os.replace(photos_path, photo_backup)
                photo_backed_up = True
            os.replace(photo_staging, photos_path)
        except Exception:
            if photo_backed_up:
                if photos_path.exists():
                    photos_path.unlink()
                os.replace(photo_backup, photos_path)
            if output_committed and output_dir.exists():
                shutil.rmtree(output_dir)
            if output_had_original and output_backup.exists():
                os.replace(output_backup, output_dir)
            publication_settled = True
            raise
        else:
            publication_settled = True
        finally:
            if publication_settled:
                if output_backup.exists():
                    shutil.rmtree(output_backup)
                if photo_backup.exists():
                    photo_backup.unlink()

    @staticmethod
    def _replace_file(source: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        staging = target.parent / f".{target.name}.publish-{uuid.uuid4().hex}"
        shutil.copy2(source, staging)
        os.replace(staging, target)

    @staticmethod
    def _merge_directory(source: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target, dirs_exist_ok=True)

    @classmethod
    def _merge_record_directory(cls, source: Path, target: Path) -> None:
        target.mkdir(parents=True, exist_ok=True)
        for source_path in sorted(source.rglob("*")):
            if source_path.is_symlink():
                raise ValueError(
                    f"Refusing to publish symbolic link from record directory: {source_path}"
                )
            relative = source_path.relative_to(source)
            target_path = target / relative
            if source_path.is_dir():
                target_path.mkdir(parents=True, exist_ok=True)
                continue
            if source_path.suffix.lower() != ".json":
                cls._copy_immutable_file(source_path, target_path)
                continue
            incoming = cls._read_json_value(source_path, expected_type=dict)
            cls._validate_record_xid(source_path, incoming)
            if target_path.exists():
                existing = cls._read_json_value(target_path, expected_type=dict)
                cls._validate_record_xid(target_path, existing)
                merged = cls._merge_record_value(existing, incoming)
            else:
                merged = incoming
            atomic_write_json(target_path, merged, trailing_newline=True)

    @classmethod
    def _merge_immutable_directory(cls, source: Path, target: Path) -> None:
        target.mkdir(parents=True, exist_ok=True)
        for source_path in sorted(source.rglob("*")):
            if source_path.is_symlink():
                raise ValueError(
                    f"Refusing to publish symbolic link from Gemini artifacts: {source_path}"
                )
            relative = source_path.relative_to(source)
            target_path = target / relative
            if source_path.is_dir():
                target_path.mkdir(parents=True, exist_ok=True)
            else:
                cls._copy_immutable_file(source_path, target_path)

    @classmethod
    def _copy_immutable_file(cls, source: Path, target: Path) -> None:
        if target.exists():
            if not target.is_file() or not cls._files_equal(source, target):
                raise ValueError(
                    "Refusing to overwrite differing immutable Gemini artifact: "
                    f"{target}"
                )
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    @staticmethod
    def _files_equal(first: Path, second: Path) -> bool:
        if first.stat().st_size != second.stat().st_size:
            return False
        with first.open("rb") as first_handle, second.open("rb") as second_handle:
            while True:
                first_chunk = first_handle.read(1024 * 1024)
                second_chunk = second_handle.read(1024 * 1024)
                if first_chunk != second_chunk:
                    return False
                if not first_chunk:
                    return True

    @classmethod
    def _merge_record_value(cls, existing: Any, incoming: Any) -> Any:
        if isinstance(existing, dict) and isinstance(incoming, dict):
            merged = dict(existing)
            for key, value in incoming.items():
                if key in merged:
                    merged[key] = cls._merge_record_value(merged[key], value)
                else:
                    merged[key] = value
            return merged
        return incoming

    @staticmethod
    def _validate_record_xid(path: Path, payload: dict[str, Any]) -> None:
        xid = payload.get("xid")
        if xid != path.stem:
            raise ValueError(
                f"Record XID does not match filename: {path} contains {xid!r}"
            )

    @classmethod
    def _merge_json_file(
        cls,
        source: Path,
        target: Path,
        *,
        expected_type: type[list] | type[dict],
    ) -> None:
        incoming = cls._read_json_value(source, expected_type=expected_type)
        if target.exists():
            existing = cls._read_json_value(target, expected_type=expected_type)
            merged = cls._merge_json_value(existing, incoming)
        else:
            merged = incoming
        atomic_write_json(target, merged, trailing_newline=True)

    @staticmethod
    def _read_json_value(path: Path, *, expected_type: type[list] | type[dict]):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValueError(f"Invalid JSON in {path}: {exc}") from exc
        if not isinstance(payload, expected_type):
            raise ValueError(
                f"Expected {expected_type.__name__} in {path}, "
                f"found {type(payload).__name__}"
            )
        return payload

    @classmethod
    def _merge_json_value(cls, existing: Any, incoming: Any) -> Any:
        if isinstance(existing, dict) and isinstance(incoming, dict):
            merged = dict(existing)
            for key, value in incoming.items():
                if key in merged:
                    merged[key] = cls._merge_json_value(merged[key], value)
                else:
                    merged[key] = value
            return merged
        if isinstance(existing, list) and isinstance(incoming, list):
            merged = list(existing)
            for value in incoming:
                if value not in merged:
                    merged.append(value)
            return merged
        return incoming

    @staticmethod
    def _merge_jsonl_file(source: Path, target: Path) -> None:
        def validated_lines(path: Path) -> list[str]:
            lines: list[str] = []
            for line_number, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(),
                start=1,
            ):
                if not line.strip():
                    continue
                try:
                    json.loads(line)
                except Exception as exc:
                    raise ValueError(
                        f"Invalid JSONL in {path}:{line_number}: {exc}"
                    ) from exc
                lines.append(line)
            return lines

        existing = validated_lines(target) if target.exists() else []
        incoming = validated_lines(source)
        shared_prefix = 0
        while (
            shared_prefix < len(existing)
            and shared_prefix < len(incoming)
            and existing[shared_prefix] == incoming[shared_prefix]
        ):
            shared_prefix += 1
        # A run initialized from output carries the published ledger as a
        # prefix. Append its later attempt events verbatim: identical failures
        # or resolutions are still separate events and cannot be set-deduped.
        merged = [*existing, *incoming[shared_prefix:]]
        payload = "\n".join(merged)
        if payload:
            payload += "\n"
        atomic_write_text(target, payload)

    def validate_publish_snapshot(self) -> dict[str, int]:
        raw_ids = self._validate_record_directory(
            self.raw_records_dir,
            label="raw record",
            require_geolocation=False,
        )
        geolocation_ids = self._validate_record_directory(
            self.geolocation_ok_dir,
            label="geolocation record",
            require_geolocation=True,
        )
        geojson = self._read_geojson(self.photos_geojson_path, label="run viewer data")
        viewer_ids = {self._feature_id(feature) for feature in geojson["features"]}
        missing_geolocation = sorted(viewer_ids - geolocation_ids)
        if missing_geolocation:
            raise ValueError(
                "Viewer features have no matching geolocation record: "
                f"{missing_geolocation[:5]}"
            )
        return {
            "raw_records": len(raw_ids),
            "geolocation_records": len(geolocation_ids),
            "viewer_features": len(viewer_ids),
        }

    @staticmethod
    def _validate_record_directory(
        directory: Path,
        *,
        label: str,
        require_geolocation: bool,
    ) -> set[str]:
        paths = sorted(directory.glob("*.json"))
        if not paths:
            raise ValueError(f"No {label}s found in {directory}")
        xids: set[str] = set()
        for path in paths:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:
                raise ValueError(f"Invalid {label} JSON in {path}: {exc}") from exc
            if not isinstance(payload, dict):
                raise ValueError(f"{label.capitalize()} must be an object: {path}")
            xid = payload.get("xid")
            if xid != path.stem:
                raise ValueError(
                    f"{label.capitalize()} XID does not match filename: "
                    f"{path} contains {xid!r}"
                )
            if require_geolocation and not isinstance(
                payload.get("geolocation"), dict
            ):
                raise ValueError(f"Missing geolocation result in {path}")
            xids.add(xid)
        return xids

    @classmethod
    def _read_geojson(cls, path: Path, *, label: str) -> dict[str, Any]:
        if not path.exists():
            raise FileNotFoundError(f"Missing {label}: {path}")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValueError(f"Invalid {label} JSON in {path}: {exc}") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("features"), list):
            raise ValueError(f"{label.capitalize()} must contain a feature list: {path}")
        if not payload["features"]:
            raise ValueError(f"{label.capitalize()} has no features: {path}")
        seen: set[str] = set()
        for feature in payload["features"]:
            feature_id = cls._feature_id(feature)
            if feature_id in seen:
                raise ValueError(f"Duplicate viewer feature ID {feature_id!r} in {path}")
            seen.add(feature_id)
        return payload

    @staticmethod
    def _feature_id(feature: Any) -> str:
        if not isinstance(feature, dict):
            raise ValueError("Viewer feature must be a JSON object")
        properties = feature.get("properties")
        value = properties.get("id") if isinstance(properties, dict) else None
        value = value or feature.get("id")
        if not isinstance(value, str) or not value:
            raise ValueError("Viewer feature is missing a stable string ID")
        return value

    @classmethod
    def _stage_merged_geojson(
        cls,
        *,
        source: Path,
        current: Path,
        target: Path,
    ) -> None:
        incoming = cls._read_geojson(source, label="run viewer data")
        if not current.exists():
            shutil.copy2(source, target)
            return

        existing = cls._read_geojson(current, label="published viewer data")
        incoming_ids = {cls._feature_id(item) for item in incoming["features"]}
        preserved = [
            item
            for item in existing["features"]
            if cls._feature_id(item) not in incoming_ids
        ]
        merged = {**incoming, "features": [*incoming["features"], *preserved]}
        atomic_write_json(target, merged, trailing_newline=True)

    def _relative(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()
