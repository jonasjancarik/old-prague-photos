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

batch_app = typer.Typer(help="Manage Gemini Batch Geolocation jobs.")
app.add_typer(batch_app, name="geolocate-batch")


@app.command()
def collect(
    rescrape: Annotated[
        bool, typer.Option("--rescrape", help="Re-scrape existing records")
    ] = False,
    fetch_ids: Annotated[
        bool, typer.Option("--fetch-ids", help="Fetch new record IDs from the archive")
    ] = True,
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


@app.command()
def geolocate(
    llm_limit: Annotated[
        Optional[int],
        typer.Option(
            "--llm-limit", help="Limit LLM processing to N records (for testing)"
        ),
    ] = None,
    force: Annotated[
        bool,
        typer.Option("--force", help="Re-process records even if already geolocated"),
    ] = False,
):
    """
    Geolocate photo records using Mapy.cz API and LLM.

    First processes records with structured addresses using Mapy.cz API,
    then uses LLM to extract addresses from unstructured descriptions.
    Results saved to output/geolocation/.
    """
    import sys

    # Build argv for the geolocate script's argparse
    sys.argv = ["geolocate"]
    if llm_limit is not None:
        sys.argv.extend(["--llm-limit", str(llm_limit)])
    if force:
        sys.argv.append("--force")

    import geolocate  # noqa: F401 - runs at module level with argparse


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
    llm_limit: Annotated[
        Optional[int],
        typer.Option("--llm-limit", help="Limit LLM processing to N records"),
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
    geolocate(llm_limit=llm_limit)

    typer.echo("\n💾 Step 4/4: Exporting to CSV...")
    export(minimal=True)

    typer.echo("\n✅ Pipeline complete! Output: output/old_prague_photos.csv")


@batch_app.command("submit")
def batch_submit(
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
            help="Include failed structured address records for LLM processing",
        ),
    ] = False,
):
    """Submit a new Gemini Batch API job."""
    from batch_geolocate import BatchManager

    manager = BatchManager()
    manager.submit(limit=limit, redo_llm=redo_llm, include_failed_cp=include_failed_cp)


@batch_app.command("collect")
def batch_collect():
    """Check status and collect results from Gemini Batch API jobs."""
    from batch_geolocate import BatchManager

    manager = BatchManager()
    manager.collect_results()


if __name__ == "__main__":
    app()
