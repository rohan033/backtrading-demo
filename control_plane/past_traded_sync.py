"""Keep an auto-maintained "Past Traded" watchlist in sync with the durable
traded-instruments registry so it surfaces inside Watch & Trade as a real
watchlist (with live prices) instead of a standalone screen.

The sync is idempotent and best-effort: the "Past Traded" panel + per-env
watchlist are created on demand and only missing symbols are appended, so it
never duplicates rows and never raises into the caller.
"""

from __future__ import annotations

import json
import logging

log = logging.getLogger(__name__)

PAST_TRADED_LABEL = "Past Traded"


def sync_past_traded_watchlist(*, broker: str = "etoro", account_env: str = "demo") -> None:
    broker = (broker or "etoro").lower()
    account_env = (account_env or "demo").lower()
    try:
        from control_plane.traded_instruments_store import get_traded_instruments_store
        from control_plane.watchlist_store import get_watchlist_store

        instruments = get_traded_instruments_store().list_instruments(
            broker=broker, account_env=account_env
        )
        if not instruments:
            return

        store = get_watchlist_store()
        panel_id = next(
            (
                panel["id"]
                for panel in store.list_panels()
                if (panel.get("name") or "").strip().lower() == PAST_TRADED_LABEL.lower()
            ),
            None,
        )
        if panel_id is None:
            panel_id = store.create_panel(PAST_TRADED_LABEL)["id"]

        all_watchlists = store.list_watchlists()

        # Reuse logos/names already resolved in any other watchlist for the same
        # instrument, so the auto list shows real icons instead of letter
        # fallbacks (positions capture often lacks logos). Local-only.
        enrichment: dict[str, dict] = {}
        for wl in all_watchlists:
            if (wl.get("broker") or "").lower() != broker:
                continue
            for sym in wl.get("symbols") or []:
                token = str(sym.get("symboltoken") or "").strip()
                if not token:
                    continue
                current = enrichment.setdefault(token, {})
                for key in (
                    "logo35x35",
                    "logo50x50",
                    "logo150x150",
                    "instrument_display_name",
                    "internal_asset_class_name",
                ):
                    if not current.get(key) and sym.get(key):
                        current[key] = sym.get(key)

        watchlist = next(
            (
                wl
                for wl in all_watchlists
                if (wl.get("name") or "").strip().lower() == PAST_TRADED_LABEL.lower()
                and (wl.get("broker") or "").lower() == broker
                and (wl.get("account_env") or "").lower() == account_env
            ),
            None,
        )
        if watchlist is None:
            watchlist = store.create_watchlist(
                PAST_TRADED_LABEL,
                broker=broker,
                account_env=account_env,
                panel_id=panel_id,
            )

        watchlist_id = watchlist["id"]
        existing = {str(sym.get("symboltoken")) for sym in (watchlist.get("symbols") or [])}
        for inst in instruments:
            token = str(inst.get("symboltoken") or "").strip()
            if not token or token in existing:
                continue
            raw_metadata = None
            raw_json = inst.get("raw_metadata_json")
            if raw_json:
                try:
                    raw_metadata = json.loads(raw_json)
                except Exception:
                    raw_metadata = None
            extra = enrichment.get(token, {})
            store.add_symbol(
                watchlist_id,
                symboltoken=token,
                tradingsymbol=str(inst.get("tradingsymbol") or token),
                exchange=str(inst.get("exchange") or "ETORO"),
                symbol=inst.get("symbol") or inst.get("instrument_display_name"),
                internal_asset_class_name=inst.get("internal_asset_class_name")
                or extra.get("internal_asset_class_name"),
                instrument_display_name=inst.get("instrument_display_name")
                or inst.get("symbol")
                or extra.get("instrument_display_name"),
                logo35x35=inst.get("logo35x35") or extra.get("logo35x35"),
                logo50x50=inst.get("logo50x50") or extra.get("logo50x50"),
                logo150x150=inst.get("logo150x150") or extra.get("logo150x150"),
                raw_metadata=raw_metadata,
            )
            existing.add(token)
    except Exception as exc:
        log.debug("[PAST_TRADED_WL] sync skipped broker=%s env=%s: %s", broker, account_env, exc)
