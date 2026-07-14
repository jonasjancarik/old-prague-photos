from __future__ import annotations

import json
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


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
            self.config_path.write_text(
                json.dumps(config, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

    def assert_snapshot_inputs(self) -> None:
        missing = [path for path in self.required_snapshot_inputs() if not path.exists()]
        if missing:
            joined = ", ".join(str(path) for path in missing)
            raise FileNotFoundError(f"Missing run snapshot input(s): {joined}")

    def copy_current_output_snapshot(self, output_dir: Path = Path("output")) -> None:
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
        if not self.photos_geojson_path.exists():
            raise FileNotFoundError(
                f"Missing derived viewer dataset: {self.photos_geojson_path}"
            )

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
        directory_specs = [
            (self.raw_records_dir, output_staging / "raw_records"),
            (self.geolocation_ok_dir, output_staging / "geolocation" / "ok"),
            (self.geolocation_failed_dir, output_staging / "geolocation" / "failed"),
            (self.llm_batch_results_dir, output_staging / "batch_results"),
        ]
        file_specs = [
            (self.available_record_ids_path, output_staging / "available_record_ids.json"),
            (self.failed_xids_path, output_staging / "failed_xids.jsonl"),
            (self.missing_details_xids_path, output_staging / "missing_details_xids.json"),
            (self.nav_partition_progress_path, output_staging / "nav_partition_progress.json"),
            (self.llm_batches_path, output_staging / "batches.json"),
            (self.llm_prompts_path, output_staging / "prompts.json"),
            (self.photos_csv_path, output_staging / "old_prague_photos.csv"),
        ]

        try:
            if output_dir.exists():
                shutil.copytree(output_dir, output_staging)
            else:
                output_staging.mkdir()
            for source, target in directory_specs:
                if source.exists():
                    self._replace_directory(source, target)
            for source, target in file_specs:
                if source.exists():
                    self._replace_file(source, target)
                elif target.exists():
                    target.unlink()

            published_requests = set()
            for source in sorted(
                self.llm_batch_requests_dir.glob("batch_request_*.jsonl")
            ):
                target = output_staging / source.name
                self._replace_file(source, target)
                published_requests.add(target.name)
            for target in output_staging.glob("batch_request_*.jsonl"):
                if target.name not in published_requests:
                    target.unlink()

            shutil.copy2(self.photos_geojson_path, photo_staging)
            self._commit_staged_publication(
                output_dir=output_dir,
                output_staging=output_staging,
                output_backup=output_backup,
                photos_path=photos_geojson_path,
                photo_staging=photo_staging,
                photo_backup=photo_backup,
            )
        finally:
            for path in (output_staging, output_backup):
                if path.exists():
                    shutil.rmtree(path)
            for path in (photo_staging, photo_backup):
                if path.exists():
                    path.unlink()

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
            raise

    @staticmethod
    def _replace_file(source: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        staging = target.parent / f".{target.name}.publish-{uuid.uuid4().hex}"
        shutil.copy2(source, staging)
        os.replace(staging, target)

    @staticmethod
    def _replace_directory(source: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        staging = target.parent / f".{target.name}.publish-{uuid.uuid4().hex}"
        shutil.copytree(source, staging)
        if target.exists():
            shutil.rmtree(target)
        os.replace(staging, target)

    def _relative(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()
