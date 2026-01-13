import asyncio
import logging
import os
import re
from dataclasses import dataclass
from typing import Dict, List, Tuple
from urllib.parse import urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup

from src.utils.helpers import fetch


TOTAL_RE = re.compile(r"\(\s*<strong>\s*([\d\s.,]+)\s*</strong>", re.IGNORECASE)
FOUND_RE = re.compile(r"Nalezeno\s*<b>(\d+)</b>", re.IGNORECASE)
XID_RE = re.compile(r"xid=([A-Z0-9]+)", re.IGNORECASE)


@dataclass(frozen=True)
class NavNode:
    label: str
    href: str
    count: int | None
    margin: int


def _derive_base_url(seed_url: str) -> str:
    parts = urlsplit(seed_url)
    base_path = ""
    if "/pragapublica" in parts.path:
        idx = parts.path.index("/pragapublica")
        base_path = parts.path[: idx + len("/pragapublica")]
    return urlunsplit((parts.scheme, parts.netloc, base_path, "", ""))


def _parse_margin(style: str | None) -> int:
    if not style:
        return 0
    match = re.search(r"margin-left:\s*(\d+)px", style)
    return int(match.group(1)) if match else 0


def _parse_nav_nodes(html: str) -> List[NavNode]:
    soup = BeautifulSoup(html, "html.parser")
    nodes: List[NavNode] = []
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
            NavNode(
                label=label,
                href=href,
                count=count,
                margin=_parse_margin(li.get("style")),
            )
        )
    return nodes


def _find_deepest_label(nodes: List[NavNode], label: str) -> NavNode | None:
    matches = [node for node in nodes if node.label == label]
    if not matches:
        return None
    return max(matches, key=lambda node: node.margin)


def _children_of(nodes: List[NavNode], parent: NavNode) -> List[NavNode]:
    children: List[NavNode] = []
    seen_parent = False
    for node in nodes:
        if node is parent:
            seen_parent = True
            continue
        if not seen_parent:
            continue
        if node.margin <= parent.margin:
            break
        if node.margin == parent.margin + 20:
            children.append(node)
    return children


def _find_next_nav_page(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    for link in soup.find_all("a", href=re.compile("PaginatorNavig.action")):
        icon = link.find("i", class_=re.compile("icon-forward3"))
        if icon:
            return link.get("href")
    return None


def _parse_total(html: str) -> int | None:
    total_match = TOTAL_RE.search(html)
    if total_match:
        raw = total_match.group(1).replace(" ", "").replace(",", ".")
        try:
            return int(float(raw))
        except ValueError:
            pass
    found_match = FOUND_RE.search(html)
    if found_match:
        return int(found_match.group(1))
    soup = BeautifulSoup(html, "html.parser")
    set_row = soup.find("span", class_="setRow")
    if set_row:
        for span in set_row.find_all_next("span"):
            if span.get("class"):
                continue
            text = span.get_text(" ", strip=True)
            match = re.match(r"\d+\s*-\s*(\d+)", text)
            if match:
                return int(match.group(1))
    return None


def _parse_search_form(html: str) -> Tuple[str, Dict[str, str]]:
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


def _parse_view_fields(html: str) -> Tuple[str | None, str | None]:
    soup = BeautifulSoup(html, "html.parser")
    form = soup.find("form", {"name": "myPages"})
    if not form:
        return None, None
    source = form.find("input", {"name": "_sourcePage"})
    fp = form.find("input", {"name": "__fp"})
    return (source.get("value") if source else None), (fp.get("value") if fp else None)


def _extract_xids(html: str) -> List[str]:
    return sorted(set(XID_RE.findall(html)))


async def _fetch_text_with_retry(
    session,
    url: str,
    *,
    method: str = "GET",
    data: Dict[str, str] | None = None,
    retries: int = 4,
    delay_s: float = 1.5,
    label: str = "",
) -> str:
    target = label or url
    for attempt in range(1, retries + 1):
        try:
            text = await fetch(session, url, method=method, data=data)
        except Exception as exc:
            logging.warning("nav fetch failed %s attempt %s: %s", target, attempt, exc)
            await asyncio.sleep(delay_s * attempt)
            continue
        if text and text.strip():
            return text
        logging.warning("nav fetch empty %s attempt %s", target, attempt)
        await asyncio.sleep(delay_s * attempt)
    raise RuntimeError(f"empty response for {target}")


async def _set_nav_page_rows(
    session, base_url: str, html: str, page_rows: int
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
    return await _fetch_text_with_retry(
        session,
        post_url,
        method="POST",
        data={
            "pageRows": str(page_rows),
            "_sourcePage": source.get("value"),
            "__fp": fp.get("value"),
        },
        label="nav page rows",
    )


async def fetch_record_ids_via_nav(
    session,
    seed_url: str,
    *,
    label: str = "Sbírka fotografií",
    max_rows: int = 10000,
    delay_s: float | None = None,
) -> List[str]:
    base_url = _derive_base_url(seed_url)
    delay = delay_s if delay_s is not None else float(
        os.getenv("ARCHIVE_REQUEST_DELAY_S", "1.5")
    )
    retries = int(os.getenv("ARCHIVE_FETCH_RETRIES", "4"))

    seed_html = await _fetch_text_with_retry(
        session, seed_url, delay_s=delay, retries=retries, label="seed"
    )
    nodes = _parse_nav_nodes(seed_html)
    parent = _find_deepest_label(nodes, label)
    if not parent:
        raise RuntimeError(f"navigation label not found: {label}")

    parent_url = urljoin(base_url + "/", parent.href)
    parent_html = await _fetch_text_with_retry(
        session, parent_url, delay_s=delay, retries=retries, label=f"nav {label}"
    )
    parent_html = await _set_nav_page_rows(session, base_url, parent_html, page_rows=51)

    children: List[NavNode] = []
    seen_children = set()
    seen_pages = set()
    page_html = parent_html

    while True:
        nodes = _parse_nav_nodes(page_html)
        parent = _find_deepest_label(nodes, label)
        if not parent:
            raise RuntimeError(f"navigation label not found after expand: {label}")
        for child in _children_of(nodes, parent):
            if child.href in seen_children:
                continue
            seen_children.add(child.href)
            children.append(child)

        next_href = _find_next_nav_page(page_html)
        if not next_href or next_href in seen_pages:
            break
        seen_pages.add(next_href)
        next_url = urljoin(base_url + "/", next_href)
        await asyncio.sleep(delay)
        page_html = await _fetch_text_with_retry(
            session, next_url, delay_s=delay, retries=retries, label="nav page"
        )

    if not children:
        raise RuntimeError("no navigation children found")

    all_ids: List[str] = []
    for child in children:
        child_url = urljoin(base_url + "/", child.href)
        await asyncio.sleep(delay)
        nav_html = await _fetch_text_with_retry(
            session,
            child_url,
            delay_s=delay,
            retries=retries,
            label=f"nav child {child.label}",
        )
        action, payload = _parse_search_form(nav_html)
        search_url = urljoin(base_url + "/", action)
        results_html = ""
        source_page = None
        fp = None
        for attempt in range(1, retries + 1):
            await asyncio.sleep(delay)
            try:
                results_html = await _fetch_text_with_retry(
                    session,
                    search_url,
                    method="POST",
                    data=payload,
                    delay_s=delay,
                    retries=1,
                    label=f"search {child.label}",
                )
            except Exception as exc:
                logging.warning(
                    "search fetch failed for %s attempt %s: %s",
                    child.label,
                    attempt,
                    exc,
                )
                continue
            source_page, fp = _parse_view_fields(results_html)
            if source_page and fp:
                break
            logging.warning(
                "missing view fields for %s attempt %s (len=%s)",
                child.label,
                attempt,
                len(results_html),
            )
            await asyncio.sleep(delay * attempt)

        total = _parse_total(results_html)
        if total is not None and total > max_rows:
            raise RuntimeError(f"node {child.label} exceeds max rows: {total}")

        if not source_page or not fp:
            raise RuntimeError(f"missing view fields for {child.label}")

        view_url = urljoin(base_url + "/", "ViewControlImpl.action?_eventName=myPageRows")
        ids: List[str] = []
        for attempt in range(1, retries + 1):
            await asyncio.sleep(delay)
            try:
                view_html = await _fetch_text_with_retry(
                    session,
                    view_url,
                    method="POST",
                    data={
                        "pageRows": str(max_rows),
                        "_sourcePage": source_page,
                        "__fp": fp,
                    },
                    delay_s=delay,
                    retries=1,
                    label=f"view rows {child.label}",
                )
            except Exception as exc:
                logging.warning(
                    "view fetch failed for %s attempt %s: %s",
                    child.label,
                    attempt,
                    exc,
                )
                continue
            ids = _extract_xids(view_html)
            if ids or total == 0:
                break
            logging.warning(
                "empty id list for %s attempt %s (len=%s)",
                child.label,
                attempt,
                len(view_html),
            )
        if total is None and ids:
            total = len(ids)
        all_ids.extend(ids)
        logging.info(
            "nav node %s -> %s ids (reported %s)",
            child.label,
            len(ids),
            total if total is not None else "unknown",
        )

    unique_ids = sorted(set(all_ids))
    logging.info("nav partition total unique ids: %s", len(unique_ids))
    return unique_ids
