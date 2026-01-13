#!/usr/bin/env python3
import argparse
import csv
import re
import sys
import time
from typing import Dict, Iterable, List, Tuple
from urllib.parse import urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup


COUNT_RE = re.compile(r"Celkem\s*:\s*([\d\s]+)", re.IGNORECASE)
TOTAL_RE = re.compile(r"\(\s*<strong>\s*([\d\s.,]+)\s*</strong>", re.IGNORECASE)
XID_RE = re.compile(r"xid=([A-Z0-9]+)", re.IGNORECASE)


def derive_base_url(seed_url: str) -> str:
    parts = urlsplit(seed_url)
    base_path = ""
    if "/pragapublica" in parts.path:
        idx = parts.path.index("/pragapublica")
        base_path = parts.path[: idx + len("/pragapublica")]
    return urlunsplit((parts.scheme, parts.netloc, base_path, "", ""))


def request_with_retry(
    session: requests.Session,
    method: str,
    url: str,
    *,
    data: Dict[str, str] | None = None,
    retries: int = 5,
    sleep_s: float = 1.2,
) -> str:
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            resp = session.request(method, url, data=data, timeout=20)
            if resp.status_code == 200 and resp.text:
                return resp.text
            print(
                f"warn: {method} {url} status={resp.status_code} len={len(resp.text)} attempt={attempt}",
                file=sys.stderr,
            )
        except requests.RequestException as exc:
            last_exc = exc
            print(
                f"warn: {method} {url} error={exc} attempt={attempt}",
                file=sys.stderr,
            )
        time.sleep(sleep_s * attempt)
    if last_exc:
        raise last_exc
    raise RuntimeError(f"failed: {method} {url}")


def parse_search_form(html: str) -> Tuple[str, Dict[str, str], List[Tuple[str, str]]]:
    soup = BeautifulSoup(html, "html.parser")
    form = soup.find("form", {"action": re.compile("SearchBean.action")})
    if not form:
        raise RuntimeError("search form not found")
    action = form.get("action")
    payload: Dict[str, str] = {}

    for inp in form.find_all("input"):
        name = inp.get("name")
        if not name:
            continue
        input_type = (inp.get("type") or "text").lower()
        value = inp.get("value") or ""
        if input_type in {"hidden", "text", "submit"}:
            payload[name] = value

    for inp in form.find_all("input", {"type": "radio"}):
        if inp.has_attr("checked"):
            name = inp.get("name")
            if name:
                payload[name] = inp.get("value") or ""

    themes: List[Tuple[str, str]] = []
    for inp in form.find_all("input", {"type": "checkbox"}):
        name = inp.get("name") or ""
        if not name.isdigit():
            continue
        label = ""
        if inp.get("id"):
            lab = form.find("label", {"for": inp.get("id")})
            if lab:
                label = lab.get_text(" ", strip=True)
        themes.append((name, label))

    return action, payload, themes


def parse_counts(html: str) -> Tuple[int | None, int | None]:
    displayed = None
    total = None
    count_match = COUNT_RE.search(html)
    if count_match:
        displayed = int(count_match.group(1).replace(" ", ""))
    total_match = TOTAL_RE.search(html)
    if total_match:
        raw = total_match.group(1).replace(" ", "").replace(",", ".")
        try:
            total = int(float(raw))
        except ValueError:
            total = None
    return displayed, total


def parse_view_fields(html: str) -> Tuple[str | None, str | None]:
    soup = BeautifulSoup(html, "html.parser")
    form = soup.find("form", {"name": "myPages"})
    if not form:
        return None, None
    source = form.find("input", {"name": "_sourcePage"})
    fp = form.find("input", {"name": "__fp"})
    return (source.get("value") if source else None), (fp.get("value") if fp else None)


def extract_xids(html: str) -> List[str]:
    return sorted(set(XID_RE.findall(html)))


def run_probe(
    seed_url: str,
    *,
    sleep_s: float,
    max_rows: int,
    csv_out: str | None,
    fetch_ids: bool,
    ids_out: str | None,
    only_themes: Iterable[str] | None,
) -> None:
    base_url = derive_base_url(seed_url)
    session = requests.Session()

    seed_html = request_with_retry(session, "GET", seed_url, sleep_s=sleep_s)
    action, base_payload, themes = parse_search_form(seed_html)
    action_url = urljoin(base_url + "/", action)

    if only_themes:
        themes = [t for t in themes if t[0] in set(only_themes)]

    rows: List[Tuple[str, str, int | None, int | None]] = []
    ids_by_theme: Dict[str, List[str]] = {}

    for theme_id, label in themes:
        payload = dict(base_payload)
        payload[theme_id] = theme_id
        html = request_with_retry(
            session, "POST", action_url, data=payload, sleep_s=sleep_s
        )
        displayed, total = parse_counts(html)
        rows.append((theme_id, label, displayed, total))

        status = "ok"
        if total is not None and total > max_rows:
            status = "over"
        print(
            f"{theme_id}\t{label}\tshown={displayed}\ttotal={total}\t{status}",
            flush=True,
        )

        if fetch_ids and (total is None or total <= max_rows):
            source_page, fp = parse_view_fields(html)
            if not source_page or not fp:
                print(
                    f"warn: view fields missing for {theme_id}",
                    file=sys.stderr,
                )
                continue
            view_url = urljoin(
                base_url + "/", "ViewControlImpl.action?_eventName=myPageRows"
            )
            view_html = request_with_retry(
                session,
                "POST",
                view_url,
                data={
                    "pageRows": str(max_rows),
                    "_sourcePage": source_page,
                    "__fp": fp,
                },
                sleep_s=sleep_s,
            )
            ids_by_theme[theme_id] = extract_xids(view_html)

        time.sleep(sleep_s)

    if csv_out:
        with open(csv_out, "w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["theme_id", "label", "shown", "total"])
            writer.writerows(rows)

    if ids_out and fetch_ids:
        with open(ids_out, "w", encoding="utf-8") as handle:
            for theme_id, ids in ids_by_theme.items():
                for xid in ids:
                    handle.write(f"{theme_id}\\t{xid}\\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Probe AHMP search filters to bypass 10k cap."
    )
    parser.add_argument(
        "--seed-url",
        default="https://katalog.ahmp.cz/pragapublica/permalink?xid=7BAF2038B67611DF820F00166F1163D4&fcDb=&onlyDigi=&modeView=MOSAIC&searchAsPhrase=&patternTxt=",
    )
    parser.add_argument("--sleep", type=float, default=1.5)
    parser.add_argument("--max-rows", type=int, default=10000)
    parser.add_argument("--csv-out")
    parser.add_argument("--fetch-ids", action="store_true")
    parser.add_argument("--ids-out")
    parser.add_argument("--only-themes", help="Comma-separated theme ids")
    args = parser.parse_args()

    only = None
    if args.only_themes:
        only = [x.strip() for x in args.only_themes.split(",") if x.strip()]

    if args.fetch_ids and not args.ids_out:
        parser.error("--fetch-ids requires --ids-out")

    run_probe(
        args.seed_url,
        sleep_s=args.sleep,
        max_rows=args.max_rows,
        csv_out=args.csv_out,
        fetch_ids=args.fetch_ids,
        ids_out=args.ids_out,
        only_themes=only,
    )


if __name__ == "__main__":
    main()
