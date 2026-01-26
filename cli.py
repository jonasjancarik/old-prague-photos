#!/usr/bin/env python3
"""
Old Prague Photos - CLI Entrypoint

A pipeline for scraping, processing, and geolocating historical photos
of Prague from the City Archives.
"""

import typer
from typing import Optional
from typing_extensions import Annotated

app = typer.Typer(
    name="old-prague-photos",
    help="Scrape, process, and geolocate historical photos of Prague.",
    no_args_is_help=True,
)

geolocate_app = typer.Typer(help="Geolocation commands.")
geolocate_llm_app = typer.Typer(help="Gemini Batch LLM geolocation jobs.")
app.add_typer(geolocate_app, name="geolocate")
geolocate_app.add_typer(geolocate_llm_app, name="llm")


@geolocate_app.callback(invoke_without_command=True)
def geolocate_root(ctx: typer.Context):
    if ctx.invoked_subcommand is None:
        typer.echo(
            "Choose a geolocation mode: `uv run cli geolocate mapy` or `uv run cli geolocate llm ...`"
        )
        raise typer.Exit(code=0)


@app.command()
def collect(
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
):
    """
    Scrape photo records from the Prague City Archives.

    Fetches record IDs and scrapes detailed metadata for each record.
    Results are saved to output/raw_records/.
    """
    import os
    import asyncio

    # Set env vars based on CLI args
    os.environ["RESCRAPE_EXISTING_RECORDS"] = str(rescrape)
    os.environ["GET_RECORD_IDS"] = str(fetch_ids)
    os.environ["FETCH_IDS_ONLY"] = str(ids_only)

    from collect import main_async

    asyncio.run(main_async())


@app.command()
def filter():
    """
    Filter and categorize scraped records.

    Separates records into categories based on whether they contain
    structured addresses (čp.) or not. Results saved to output/filtered/.
    """
    import filter as filter_module  # noqa: F401 - runs at module level

    # filter.py runs at module level, so importing it runs the logic
    # This is a known issue - ideally we'd refactor filter.py


@geolocate_app.command("mapy")
def geolocate_mapy(
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
    """
    Geolocate photo records using Mapy.cz API.

    Processes records with structured addresses (čp.) and saves results
    to output/geolocation/.
    """
    from geolocate import main as geolocate_main

    geolocate_main(limit=limit, force=force)


@app.command()
def export(
    minimal: Annotated[
        bool, typer.Option("--minimal/--full", help="Export minimal or full columns")
    ] = True,
):
    """
    Export geolocated records to CSV.

    Reads all successfully geolocated JSON files and exports them
    to output/old_prague_photos.csv.
    """
    import export as export_module  # noqa: F401 - runs at module level

    # export.py also runs at module level


@app.command()
def pipeline(
    geolocate_limit: Annotated[
        Optional[int],
        typer.Option("--geolocate-limit", help="Limit geolocation to N records"),
    ] = None,
    skip_collect: Annotated[
        bool, typer.Option("--skip-collect", help="Skip the collect step")
    ] = False,
):
    """
    Run the full pipeline: collect → filter → geolocate → export.
    """
    typer.echo("🚀 Starting full pipeline...\n")

    if not skip_collect:
        typer.echo("📥 Step 1/4: Collecting records...")
        collect(rescrape=False, fetch_ids=False)
    else:
        typer.echo("⏭️  Step 1/4: Skipping collect...")

    typer.echo("\n📋 Step 2/4: Filtering records...")
    filter()

    typer.echo("\n📍 Step 3/4: Geolocating records...")
    geolocate_mapy(limit=geolocate_limit)

    typer.echo("\n💾 Step 4/4: Exporting to CSV...")
    export(minimal=True)

    typer.echo("\n✅ Pipeline complete! Output: output/old_prague_photos.csv")


@geolocate_llm_app.command("submit")
def llm_submit(
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
    """Submit a new Gemini Batch API job."""
    from batch_geolocate import BatchManager

    manager = BatchManager()
    manager.submit(
        limit=limit,
        redo_llm=redo_llm,
        include_failed_cp=include_failed_cp,
        retry_missing_content=retry_missing_content,
    )


@geolocate_llm_app.command("collect")
def llm_collect(
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
    """Download batch results from Gemini Batch API jobs."""
    from batch_geolocate import BatchManager

    manager = BatchManager()
    manager.download_results(redownload=redownload, job_filter=job)


@geolocate_llm_app.command("process")
def llm_process(
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
    """Process downloaded batch results and geocode via Mapy.cz."""
    from batch_geolocate import BatchManager

    manager = BatchManager()
    manager.process_results(reprocess=reprocess, job_filter=job)


@geolocate_llm_app.command("status")
def llm_status():
    """Check status of Gemini Batch API jobs."""
    from batch_geolocate import BatchManager

    manager = BatchManager()
    manager.check_status()


if __name__ == "__main__":
    app()
