#!/usr/bin/env python3
"""
Old Prague Photos - CLI Entrypoint

A pipeline for scraping, processing, and geolocating historical photos
of Prague from the City Archives.
"""

from pathlib import Path

import typer
from typing_extensions import Annotated

from src.pipeline.cli_run import run_app

app = typer.Typer(
    name="old-prague-photos",
    help="Scrape, process, and geolocate historical photos of Prague.",
    no_args_is_help=True,
)

app.add_typer(run_app, name="run")


@app.command()
def derive(
    run_dir: Annotated[
        Path,
        typer.Option("--run-dir", help="Run directory with collected/geolocated snapshot"),
    ],
    minimal: Annotated[
        bool,
        typer.Option("--minimal/--full", help="Export minimal or full CSV columns"),
    ] = True,
):
    """
    Rebuild no-network derived data from a run-directory snapshot.

    Requires:
    - <run-dir>/collect/raw_records/
    - <run-dir>/geolocation/ok/
    """
    from src.pipeline.derive import derive_snapshot

    result = derive_snapshot(run_dir, minimal_export=minimal)
    typer.echo(
        "Derived snapshot: "
        f"records_with_places={result['records_with_places']} "
        f"exported_records={result['exported_records']} "
        f"geojson_features={result['geojson_features']} "
        f"manifest={result['manifest']}"
    )


if __name__ == "__main__":
    app()
