#!/usr/bin/env python3
import argparse
import json
import re
import sys
import time
from typing import Dict, List, Tuple
from urllib.parse import urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup


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
    sleep_s: float = 1.5,
    timeout_s: int = 30,
) -> str:
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            resp = session.request(method, url, data=data, timeout=timeout_s)
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


def parse_margin(li) -> int:
    style = li.get("style") or ""
    m = re.search(r"margin-left:\s*(\d+)px", style)
    return int(m.group(1)) if m else 0


def parse_nav_nodes(html: str) -> List[Dict[str, str | int | None]]:
    soup = BeautifulSoup(html, "html.parser")
    nodes = []
    for li in soup.select("li.navigatorLine.treeComponent"):
        link = li.find("a", href=re.compile("NavigBean.action"))
        if not link:
            continue
        label = link.get_text(" ", strip=True)
        href = link.get("href") or ""
        count_el = li.find("span", class_=re.compile("infoCount"))
        count = None
        if count_el:
            count_raw = re.sub(r"[^0-9]", "", count_el.get_text())
            count = int(count_raw) if count_raw else None
        nodes.append(
            {
                "label": label,
                "href": href,
                "count": count,
                "margin": parse_margin(li),
            }
        )
    return nodes


def find_deepest_label(nodes: List[Dict[str, str | int | None]], label: str):
    matches = [n for n in nodes if n["label"] == label]
    if not matches:
        return None
    return max(matches, key=lambda n: int(n["margin"] or 0))


def children_of(
    nodes: List[Dict[str, str | int | None]], parent: Dict[str, str | int | None]
) -> List[Dict[str, str | int | None]]:
    parent_margin = int(parent["margin"] or 0)
    children = []
    seen_parent = False
    for node in nodes:
        if node is parent:
            seen_parent = True
            continue
        if not seen_parent:
            continue
        node_margin = int(node["margin"] or 0)
        if node_margin <= parent_margin:
            break
        if node_margin == parent_margin + 20:
            children.append(node)
    return children


def parse_total(html: str) -> int | None:
    total_match = TOTAL_RE.search(html)
    if total_match:
        raw = total_match.group(1).replace(" ", "").replace(",", ".")
        try:
            return int(float(raw))
        except ValueError:
            pass
    found_match = re.search(r"Nalezeno\\s*<b>(\\d+)</b>", html, re.IGNORECASE)
    if found_match:
        return int(found_match.group(1))
    soup = BeautifulSoup(html, "html.parser")
    set_row = soup.find("span", class_="setRow")
    if set_row:
        for span in set_row.find_all_next("span"):
            if span.get("class"):
                continue
            text = span.get_text(" ", strip=True)
            m = re.match(r"\\d+\\s*-\\s*(\\d+)", text)
            if m:
                return int(m.group(1))
    return None


def parse_search_form(html: str) -> Tuple[str, Dict[str, str]]:
    soup = BeautifulSoup(html, "html.parser")
    form = soup.find("form", {"action": re.compile("SearchBean.action")})
    if not form:
        raise RuntimeError("search form not found")
    action = form.get("action") or ""
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

    return action, payload


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


def find_next_nav_page(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    for link in soup.find_all("a", href=re.compile("PaginatorNavig.action")):
        icon = link.find("i", class_=re.compile("icon-forward3"))
        if icon:
            return link.get("href")
    return None


def set_nav_page_rows(
    session: requests.Session, base_url: str, html: str, page_rows: int, sleep_s: float
) -> str:
    soup = BeautifulSoup(html, "html.parser")
    form = soup.find("form", {"name": "myPages", "action": re.compile("NavigBean.action")})
    if not form:
        return html
    source = form.find("input", {"name": "_sourcePage"})
    fp = form.find("input", {"name": "__fp"})
    if not source or not fp:
        return html
    post_url = urljoin(base_url + "/", "NavigBean.action?_eventName=myPageRows")
    return request_with_retry(
        session,
        "POST",
        post_url,
        data={
            "pageRows": str(page_rows),
            "_sourcePage": source.get("value"),
            "__fp": fp.get("value"),
        },
        sleep_s=sleep_s,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Partition AHMP records via navigation tree."
    )
    parser.add_argument(
        "--seed-url",
        default="https://katalog.ahmp.cz/pragapublica/permalink?xid=7BAF2038B67611DF820F00166F1163D4&fcDb=&onlyDigi=&modeView=MOSAIC&searchAsPhrase=&patternTxt=",
    )
    parser.add_argument("--expand-label", default="Sbírka fotografií")
    parser.add_argument("--sleep", type=float, default=1.6)
    parser.add_argument("--max-rows", type=int, default=10000)
    parser.add_argument("--json-out")
    parser.add_argument("--counts-out")
    parser.add_argument("--only-labels", help="Comma-separated labels to include")
    args = parser.parse_args()

    base_url = derive_base_url(args.seed_url)
    session = requests.Session()

    seed_html = request_with_retry(session, "GET", args.seed_url, sleep_s=args.sleep)
    nodes = parse_nav_nodes(seed_html)
    parent = find_deepest_label(nodes, args.expand_label)
    if not parent:
        raise SystemExit(f"expand label not found: {args.expand_label}")

    parent_url = urljoin(base_url + "/", parent["href"] or "")
    parent_html = request_with_retry(session, "GET", parent_url, sleep_s=args.sleep)
    parent_html = set_nav_page_rows(
        session, base_url, parent_html, page_rows=51, sleep_s=args.sleep
    )

    children: List[Dict[str, str | int | None]] = []
    seen_child = set()
    page_html = parent_html
    seen_pages = set()

    while True:
        nodes = parse_nav_nodes(page_html)
        parent = find_deepest_label(nodes, args.expand_label)
        if not parent:
            raise SystemExit(
                f"expand label not found after expand: {args.expand_label}"
            )
        page_children = children_of(nodes, parent)
        for child in page_children:
            href = str(child["href"])
            if href in seen_child:
                continue
            seen_child.add(href)
            children.append(child)

        next_href = find_next_nav_page(page_html)
        if not next_href or next_href in seen_pages:
            break
        seen_pages.add(next_href)
        next_url = urljoin(base_url + "/", next_href)
        page_html = request_with_retry(session, "GET", next_url, sleep_s=args.sleep)

    if not children:
        raise SystemExit("no child nodes found")

    only_labels = None
    if args.only_labels:
        only_labels = {label.strip() for label in args.only_labels.split(",") if label.strip()}

    counts = []
    all_ids: List[str] = []
    fetch_ids = args.json_out is not None

    for child in children:
        label = str(child["label"])
        if only_labels and label not in only_labels:
            continue
        child_url = urljoin(base_url + "/", str(child["href"]))
        nav_html = request_with_retry(session, "GET", child_url, sleep_s=args.sleep)
        search_action, search_payload = parse_search_form(nav_html)
        search_url = urljoin(base_url + "/", search_action)
        results_html = request_with_retry(
            session, "POST", search_url, data=search_payload, sleep_s=args.sleep
        )

        total = parse_total(results_html)

        if total and total > args.max_rows:
            status = "over"
            counts.append((label, total))
            print(f"{label}\t{total}\t{status}", flush=True)
            continue

        ids: List[str] = []
        if fetch_ids:
            source_page, fp = parse_view_fields(results_html)
            if not source_page or not fp:
                print(f"warn: missing view fields for {label}", file=sys.stderr)
            else:
                view_url = urljoin(
                    base_url + "/", "ViewControlImpl.action?_eventName=myPageRows"
                )
                view_html = request_with_retry(
                    session,
                    "POST",
                    view_url,
                    data={
                        "pageRows": str(args.max_rows),
                        "_sourcePage": source_page,
                        "__fp": fp,
                    },
                    sleep_s=args.sleep,
                    timeout_s=60,
                )
                ids = extract_xids(view_html)
                all_ids.extend(ids)
                if total is None:
                    total = len(ids)

        status = "ok" if total is not None and total <= args.max_rows else "over"
        counts.append((label, total))
        print(f"{label}\t{total}\t{status}", flush=True)

        time.sleep(args.sleep)

    all_ids = sorted(set(all_ids))

    if args.counts_out:
        with open(args.counts_out, "w", encoding="utf-8") as handle:
            for label, total in counts:
                handle.write(f"{label}\t{total}\n")

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(all_ids, handle, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
