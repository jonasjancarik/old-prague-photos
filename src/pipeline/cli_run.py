from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Optional

import typer
from typing_extensions import Annotated


run_app = typer.Typer(help="Run-directory snapshot commands.")
run_geolocate_llm_app = typer.Typer(
    help="Run-directory Gemini Batch LLM geolocation jobs."
)
run_app.add_typer(run_geolocate_llm_app, name="geolocate-llm")


def configure_collect_env(
    *,
    rescrape: bool,
    fetch_ids: bool,
    ids_only: bool,
    retry_failed: bool,
    rescrape_missing_details: bool,
    nav_progress_file: Path | None = None,
) -> None:
    if retry_failed or rescrape_missing_details:
        os.environ["RESCRAPE_EXISTING_RECORDS"] = "True"
        os.environ["GET_RECORD_IDS"] = "False"
    else:
        os.environ["RESCRAPE_EXISTING_RECORDS"] = str(rescrape)
        os.environ["GET_RECORD_IDS"] = str(fetch_ids)
    os.environ["FETCH_IDS_ONLY"] = str(ids_only)
    os.environ["RETRY_FAILED_RECORDS"] = str(retry_failed)
    os.environ["RESCRAPE_MISSING_DETAILS"] = str(rescrape_missing_details)
    if nav_progress_file is not None:
        os.environ["NAV_PROGRESS_FILE"] = str(nav_progress_file)


def _run_paths(run_dir: Path):
    from src.pipeline.paths import PipelinePaths

    paths = PipelinePaths.from_run_dir(run_dir)
    paths.create()
    if not paths.config_path.exists():
        config = {
            "schema_version": 1,
            "mode": "run",
            "description": "Pipeline run directory for old-prague-photos",
        }
        paths.config_path.write_text(
            json.dumps(config, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return paths


def _record_run_stage(paths, stage: str, details: dict | None = None) -> None:
    from src.pipeline.run_manifest import append_stage_event, write_run_manifest

    append_stage_event(paths, stage, details=details or {})
    write_run_manifest(paths)


def _refresh_run_filter(paths) -> None:
    from src.pipeline import filter as filter_module

    filter_module.run_filter(
        raw_records_dir=paths.raw_records_dir,
        filtered_dir=paths.filter_dir,
        records_with_places_path=paths.records_with_places_path,
    )


def _run_batch_manager(paths):
    from src.pipeline.batch_geolocate import BatchManager

    return BatchManager(
        batches_file=paths.llm_batches_path,
        batch_results_dir=paths.llm_batch_results_dir,
        batch_requests_dir=paths.llm_batch_requests_dir,
        input_records_dir=paths.filter_dir,
        output_dir=paths.geolocation_ok_dir,
        failed_base_dir=paths.geolocation_failed_dir,
        failed_dir=paths.llm_failed_dir,
        prompts_file=paths.llm_prompts_path,
    )


@run_app.command("init")
def run_init(
    run_dir: Annotated[
        Path,
        typer.Argument(help="Run directory to create"),
    ],
    from_output: Annotated[
        bool,
        typer.Option(
            "--from-output",
            help="Seed the run directory from the current output/ snapshot",
        ),
    ] = False,
):
    """Create a reproducible pipeline run directory."""
    from src.pipeline.paths import PipelinePaths

    paths = PipelinePaths.from_run_dir(run_dir)
    config = {
        "schema_version": 1,
        "mode": "snapshot" if from_output else "run",
        "description": "Pipeline run directory for old-prague-photos",
    }
    if from_output:
        paths.copy_current_output_snapshot()
        paths.config_path.write_text(
            json.dumps(config, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        _record_run_stage(paths, "init", {"from_output": True})
        typer.echo(f"Created {run_dir} from current output/ snapshot")
    else:
        paths.create(config=config)
        _record_run_stage(paths, "init", {"from_output": False})
        typer.echo(f"Created {run_dir}")


@run_app.command("collect")
def run_collect(
    run_dir: Annotated[
        Path,
        typer.Argument(help="Run directory to collect into"),
    ],
    rescrape: Annotated[
        bool, typer.Option("--rescrape", help="Re-scrape existing records")
    ] = False,
    fetch_ids: Annotated[
        bool,
        typer.Option(
            "--fetch-ids/--no-fetch-ids",
            help="Fetch new record IDs from the archive",
        ),
    ] = True,
    ids_only: Annotated[
        bool,
        typer.Option(
            "--ids-only/--no-ids-only",
            help="Only fetch record IDs and skip record scraping",
        ),
    ] = False,
    retry_failed: Annotated[
        bool,
        typer.Option(
            "--retry-failed",
            help="Retry only IDs from this run's failed_xids.jsonl",
        ),
    ] = False,
    rescrape_missing_details: Annotated[
        bool,
        typer.Option(
            "--rescrape-missing-details",
            help="Rescrape only this run's records with incomplete scan metadata",
        ),
    ] = False,
):
    """Collect archive IDs and raw records into a run directory."""
    paths = _run_paths(run_dir)
    configure_collect_env(
        rescrape=rescrape,
        fetch_ids=fetch_ids,
        ids_only=ids_only,
        retry_failed=retry_failed,
        rescrape_missing_details=rescrape_missing_details,
        nav_progress_file=paths.nav_partition_progress_path,
    )

    from src.pipeline.collect import main_async as collect_main_async

    asyncio.run(
        collect_main_async(
            record_ids_path=paths.available_record_ids_path,
            failed_xids_path=paths.failed_xids_path,
            missing_details_path=paths.missing_details_xids_path,
            raw_records_dir=paths.raw_records_dir,
        )
    )
    _record_run_stage(
        paths,
        "collect",
        {
            "rescrape": rescrape,
            "fetch_ids": fetch_ids,
            "ids_only": ids_only,
            "retry_failed": retry_failed,
            "rescrape_missing_details": rescrape_missing_details,
        },
    )
    typer.echo(f"Collected into {paths.collect_dir}")


@run_app.command("geolocate-mapy")
def run_geolocate_mapy(
    run_dir: Annotated[
        Path,
        typer.Argument(help="Run directory with collected raw records"),
    ],
    limit: Annotated[
        Optional[int],
        typer.Option(
            "--limit", help="Limit geolocation to N records (for testing)"
        ),
    ] = None,
    force: Annotated[
        bool,
        typer.Option("--force", help="Re-process records even if already geolocated"),
    ] = False,
):
    """Geolocate a run directory with Mapy.cz."""
    from src.pipeline.geolocate import main as geolocate_main

    paths = _run_paths(run_dir)
    _refresh_run_filter(paths)
    geolocate_main(
        limit=limit,
        force=force,
        records_with_cp_path=paths.filter_dir / "records_with_cp.json",
        records_with_cp_in_obsah_path=(
            paths.filter_dir / "records_with_cp_in_record_obsah.json"
        ),
        output_ok_dir=paths.geolocation_ok_dir,
        failed_base_dir=paths.geolocation_failed_dir,
    )
    _record_run_stage(paths, "geolocate_mapy", {"limit": limit, "force": force})
    typer.echo(f"Geolocation outputs written under {paths.geolocation_dir}")


@run_app.command("pipeline")
def run_pipeline(
    run_dir: Annotated[
        Path,
        typer.Argument(help="Run directory to create or update"),
    ],
    skip_collect: Annotated[
        bool,
        typer.Option("--skip-collect", help="Skip archive collection"),
    ] = False,
    rescrape: Annotated[
        bool,
        typer.Option("--rescrape", help="Re-scrape existing raw records"),
    ] = False,
    fetch_ids: Annotated[
        bool,
        typer.Option(
            "--fetch-ids/--no-fetch-ids",
            help="Fetch record IDs from archive or reuse the run's cached ID list",
        ),
    ] = True,
    skip_mapy: Annotated[
        bool,
        typer.Option("--skip-mapy", help="Skip Mapy.cz geolocation"),
    ] = False,
    geolocate_limit: Annotated[
        Optional[int],
        typer.Option("--geolocate-limit", help="Limit Mapy.cz geolocation to N records"),
    ] = None,
    force_mapy: Annotated[
        bool,
        typer.Option(
            "--force-mapy",
            help="Re-process Mapy.cz records already marked ok/failed",
        ),
    ] = False,
    derive_outputs: Annotated[
        bool,
        typer.Option(
            "--derive/--no-derive",
            help="Rebuild export, GeoJSON, and manifest",
        ),
    ] = True,
    minimal: Annotated[
        bool,
        typer.Option("--minimal/--full", help="Export minimal or full CSV columns"),
    ] = True,
):
    """
    Run the standard run-directory pipeline.

    This covers synchronous stages only: archive collect, Mapy.cz geolocation,
    and deterministic derived outputs. Gemini Batch remains a separate async
    submit/status/collect/process flow.
    """
    from src.pipeline.derive import derive_snapshot

    paths = _run_paths(run_dir)
    typer.echo(f"Run directory: {paths.root}")

    if not skip_collect:
        typer.echo("Step 1/3: collect")
        run_collect(
            run_dir=paths.root,
            rescrape=rescrape,
            fetch_ids=fetch_ids,
            ids_only=False,
            retry_failed=False,
            rescrape_missing_details=False,
        )
    else:
        typer.echo("Step 1/3: collect skipped")

    if not skip_mapy:
        typer.echo("Step 2/3: geolocate Mapy.cz")
        run_geolocate_mapy(
            run_dir=paths.root,
            limit=geolocate_limit,
            force=force_mapy,
        )
    else:
        typer.echo("Step 2/3: Mapy.cz geolocation skipped")

    if derive_outputs:
        typer.echo("Step 3/3: derive")
        result = derive_snapshot(paths.root, minimal_export=minimal)
        typer.echo(
            "Derived snapshot: "
            f"records_with_places={result['records_with_places']} "
            f"exported_records={result['exported_records']} "
            f"geojson_features={result['geojson_features']} "
            f"manifest={result['manifest']}"
        )
    else:
        typer.echo("Step 3/3: derive skipped")
        _record_run_stage(paths, "pipeline", {"derive_outputs": False})


@run_geolocate_llm_app.command("submit")
def run_llm_submit(
    run_dir: Annotated[
        Path,
        typer.Argument(help="Run directory with collected raw records"),
    ],
    limit: Annotated[
        Optional[int],
        typer.Option("--limit", help="Limit number of records to process"),
    ] = None,
    redo_llm: Annotated[
        bool,
        typer.Option(
            "--redo-llm", help="Re-process records previously geolocated via LLM"
        ),
    ] = False,
    include_failed_cp: Annotated[
        bool,
        typer.Option(
            "--include-failed-cp",
            help="Include failed Mapy.cz records (čp.) for LLM processing",
        ),
    ] = False,
    retry_missing_content: Annotated[
        bool,
        typer.Option(
            "--retry-missing-content",
            help="Include LLM failures with missing content parts",
        ),
    ] = False,
):
    """Submit a run-directory Gemini Batch API job."""
    paths = _run_paths(run_dir)
    _refresh_run_filter(paths)
    manager = _run_batch_manager(paths)
    manager.submit(
        limit=limit,
        redo_llm=redo_llm,
        include_failed_cp=include_failed_cp,
        retry_missing_content=retry_missing_content,
    )
    _record_run_stage(
        paths,
        "geolocate_llm_submit",
        {
            "limit": limit,
            "redo_llm": redo_llm,
            "include_failed_cp": include_failed_cp,
            "retry_missing_content": retry_missing_content,
        },
    )


@run_geolocate_llm_app.command("status")
def run_llm_status(
    run_dir: Annotated[
        Path,
        typer.Argument(help="Run directory with LLM batch metadata"),
    ],
):
    """Check status of run-directory Gemini Batch API jobs."""
    paths = _run_paths(run_dir)
    manager = _run_batch_manager(paths)
    manager.check_status()
    _record_run_stage(paths, "geolocate_llm_status")


@run_geolocate_llm_app.command("collect")
def run_llm_collect(
    run_dir: Annotated[
        Path,
        typer.Argument(help="Run directory with LLM batch metadata"),
    ],
    redownload: Annotated[
        bool,
        typer.Option(
            "--redownload",
            help="Re-download batch results even if present",
        ),
    ] = False,
    job: Annotated[
        Optional[list[str]],
        typer.Option(
            "--job",
            help="Only run against specific batch jobs (full name or suffix)",
        ),
    ] = None,
):
    """Download run-directory batch results from Gemini Batch API jobs."""
    paths = _run_paths(run_dir)
    manager = _run_batch_manager(paths)
    manager.download_results(redownload=redownload, job_filter=job)
    _record_run_stage(
        paths,
        "geolocate_llm_collect",
        {"redownload": redownload, "job": job or []},
    )


@run_geolocate_llm_app.command("process")
def run_llm_process(
    run_dir: Annotated[
        Path,
        typer.Argument(help="Run directory with downloaded LLM batch results"),
    ],
    reprocess: Annotated[
        bool,
        typer.Option(
            "--reprocess",
            help="Re-process downloaded batches (for geocoding fixes)",
        ),
    ] = False,
    job: Annotated[
        Optional[list[str]],
        typer.Option(
            "--job",
            help="Only run against specific batch jobs (full name or suffix)",
        ),
    ] = None,
):
    """Process run-directory batch results and geocode via Mapy.cz."""
    paths = _run_paths(run_dir)
    _refresh_run_filter(paths)
    manager = _run_batch_manager(paths)
    manager.process_results(reprocess=reprocess, job_filter=job)
    _record_run_stage(
        paths,
        "geolocate_llm_process",
        {"reprocess": reprocess, "job": job or []},
    )
