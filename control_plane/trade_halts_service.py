from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from typing import Any

import httpx

log = logging.getLogger("backtrading")

NASDAQ_TRADE_HALTS_RSS = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts"
NDAQ_NS = {"ndaq": "http://www.nasdaqtrader.com/"}


def _text(parent: ET.Element, path: str) -> str | None:
    node = parent.find(path, NDAQ_NS)
    if node is None or node.text is None:
        return None
    value = node.text.strip()
    return value or None


def parse_trade_halts_rss(xml_text: str) -> list[dict[str, Any]]:
    """Parse NASDAQ Trade Halts RSS into normalized dicts."""
    root = ET.fromstring(xml_text)
    channel = root.find("channel")
    if channel is None:
        return []

    entries: list[dict[str, Any]] = []
    for item in channel.findall("item"):
        symbol = _text(item, "ndaq:IssueSymbol") or _text(item, "title")
        if not symbol:
            continue
        entries.append(
            {
                "symbol": symbol.strip().upper(),
                "issue_name": _text(item, "ndaq:IssueName"),
                "market": _text(item, "ndaq:Market"),
                "reason_code": _text(item, "ndaq:ReasonCode"),
                "pause_threshold_price": _text(item, "ndaq:PauseThresholdPrice"),
                "halt_date": _text(item, "ndaq:HaltDate"),
                "halt_time": _text(item, "ndaq:HaltTime"),
                "resumption_date": _text(item, "ndaq:ResumptionDate"),
                "resumption_quote_time": _text(item, "ndaq:ResumptionQuoteTime"),
                "resumption_trade_time": _text(item, "ndaq:ResumptionTradeTime"),
                "pub_date": _text(item, "pubDate"),
            }
        )
    return entries


async def fetch_trade_halts_rss(
    *,
    url: str = NASDAQ_TRADE_HALTS_RSS,
    timeout: float = 20.0,
) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.get(
            url,
            headers={
                "User-Agent": "backtrading-demo/trade-halts-poller",
                "Accept": "application/rss+xml, application/xml, text/xml, */*",
            },
        )
        response.raise_for_status()
        return parse_trade_halts_rss(response.text)
