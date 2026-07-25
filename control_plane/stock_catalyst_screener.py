"""Parse the public Stock Catalyst NYSE/Nasdaq pre-market and after-hours movers tables."""

from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Any

import requests

STOCK_CATALYST_COLUMNS = [
    "mover_direction",
    "change_pct",
    "change_abs",
    "last_price",
    "volume",
    "free_float",
    "short_float",
    "recent_headlines",
]

STOCK_CATALYST_PM_SOURCE_TYPE = "stock_catalyst_nyse_pm"
STOCK_CATALYST_PM_NAME = "Stock Catalyst PM Movers"
STOCK_CATALYST_PM_URL = "https://www.thestockcatalyst.com/NYSEPMMovers?ShowFloats=true"

STOCK_CATALYST_AH_SOURCE_TYPE = "stock_catalyst_nyse_ah"
STOCK_CATALYST_AH_NAME = "Stock Catalyst AH Movers"
STOCK_CATALYST_AH_URL = "https://www.thestockcatalyst.com/NYSEAHMovers?ShowFloats=true"

# Back-compat aliases used by existing imports.
STOCK_CATALYST_SOURCE_TYPE = STOCK_CATALYST_PM_SOURCE_TYPE
STOCK_CATALYST_NAME = STOCK_CATALYST_PM_NAME
STOCK_CATALYST_URL = STOCK_CATALYST_PM_URL

STOCK_CATALYST_SOURCE_TYPES = frozenset(
    {STOCK_CATALYST_PM_SOURCE_TYPE, STOCK_CATALYST_AH_SOURCE_TYPE}
)

_SPACE_RE = re.compile(r"\s+")
_CHANGE_RE = re.compile(r"([-+]?\d+(?:\.\d+)?)\s*\(([-+]?\d+(?:\.\d+)?)%\)")
_NUMBER_RE = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?")


def _clean_text(value: str) -> str:
    return _SPACE_RE.sub(" ", value or "").strip()


def _parse_number(value: str) -> float | int | None:
    text = _clean_text(value).replace(",", "")
    match = _NUMBER_RE.search(text)
    if not match:
        return None
    number = float(match.group(0))
    suffix = text[match.end() :].strip().upper()[:1]
    multiplier = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get(suffix, 1)
    result = number * multiplier
    return int(result) if result.is_integer() else result


class _MoversTableParser(HTMLParser):
    """Small purpose-built parser for the two mvc-grid tables on the page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[dict[str, Any]] = []
        self._div_depth = 0
        self._section_depth: int | None = None
        self._direction: str | None = None
        self._in_row = False
        self._in_cell = False
        self._cell_text: list[str] = []
        self._cell_links: list[dict[str, str]] = []
        self._cells: list[dict[str, Any]] = []
        self._active_link: dict[str, Any] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = dict(attrs)
        if tag == "div":
            self._div_depth += 1
            table_name = attr_map.get("data-name")
            if self._direction is None and table_name in {"TopGaining", "TopLosing"}:
                self._direction = "Gainer" if table_name == "TopGaining" else "Loser"
                self._section_depth = self._div_depth
        if not self._direction:
            return
        if tag == "tr":
            self._in_row = True
            self._cells = []
        elif tag == "td" and self._in_row:
            if self._in_cell:
                self._finish_cell()
            self._in_cell = True
            self._cell_text = []
            self._cell_links = []
        elif tag == "a" and self._in_cell:
            self._active_link = {"href": attr_map.get("href") or "", "text": []}

    def handle_endtag(self, tag: str) -> None:
        if self._direction:
            if tag == "a" and self._active_link is not None:
                text = _clean_text("".join(self._active_link["text"]))
                href = str(self._active_link["href"])
                if text:
                    self._cell_links.append({"title": text, "url": href})
                self._active_link = None
            elif tag == "td" and self._in_cell:
                self._finish_cell()
            elif tag == "tr" and self._in_row:
                # The source currently emits malformed "<br /</td>" for headline
                # cells. HTMLParser therefore never sees the final </td>.
                if self._in_cell:
                    self._finish_cell()
                self._append_row()
                self._in_row = False
        if tag == "div":
            if self._section_depth == self._div_depth:
                self._direction = None
                self._section_depth = None
            self._div_depth = max(0, self._div_depth - 1)

    def handle_data(self, data: str) -> None:
        if not self._in_cell:
            return
        self._cell_text.append(data)
        if self._active_link is not None:
            self._active_link["text"].append(data)

    def _finish_cell(self) -> None:
        if self._active_link is not None:
            text = _clean_text("".join(self._active_link["text"]))
            if text:
                self._cell_links.append(
                    {"title": text, "url": str(self._active_link["href"])}
                )
            self._active_link = None
        self._cells.append(
            {
                "text": _clean_text("".join(self._cell_text)),
                "links": list(self._cell_links),
            }
        )
        self._in_cell = False

    def _append_row(self) -> None:
        if len(self._cells) < 8 or not self._direction:
            return
        change_text = self._cells[0]["text"]
        change_match = _CHANGE_RE.search(change_text)
        symbol = _clean_text(self._cells[2]["text"])
        if not symbol:
            return
        headlines = [
            link
            for link in self._cells[7]["links"]
            if link.get("title")
            and str(link.get("url") or "").lower().startswith(("https://", "http://"))
        ][:3]
        self.rows.append(
            {
                "ticker": symbol,
                "name": _clean_text(self._cells[3]["text"]) or symbol,
                "mover_direction": self._direction,
                "change_abs": (
                    float(change_match.group(1))
                    if change_match
                    else _parse_number(change_text)
                ),
                "change_pct": float(change_match.group(2)) if change_match else None,
                "last_price": _parse_number(self._cells[1]["text"]),
                "volume": _parse_number(self._cells[4]["text"]),
                "free_float": _parse_number(self._cells[5]["text"]),
                "short_float": _parse_number(self._cells[6]["text"]),
                "recent_headlines": headlines,
            }
        )


def parse_stock_catalyst_html(html: str) -> list[dict[str, Any]]:
    parser = _MoversTableParser()
    parser.feed(html)
    parser.close()
    if not parser.rows:
        raise ValueError("Stock Catalyst returned no mover rows")
    return parser.rows


def run_stock_catalyst_screener(
    url: str | None = STOCK_CATALYST_PM_URL,
) -> tuple[int, list[dict[str, Any]], list[str]]:
    fetch_url = url or STOCK_CATALYST_PM_URL
    response = requests.get(
        fetch_url,
        timeout=25,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
            ),
        },
    )
    response.raise_for_status()
    rows = parse_stock_catalyst_html(response.text)
    return len(rows), rows, ["ticker", *STOCK_CATALYST_COLUMNS]
