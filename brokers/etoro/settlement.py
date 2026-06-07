"""eToro instrument class → v2 order settlement type mapping."""

from __future__ import annotations

INSTRUMENT_CLASS_EQUITY = "equity"
INSTRUMENT_CLASS_CRYPTO = "crypto"

ETORO_SETTLEMENT_EQUITY = "real"
ETORO_SETTLEMENT_CRYPTO = "marginTrade"


def normalize_instrument_class(value: str | None) -> str:
    if str(value or "").strip().lower() == INSTRUMENT_CLASS_CRYPTO:
        return INSTRUMENT_CLASS_CRYPTO
    return INSTRUMENT_CLASS_EQUITY


def etoro_settlement_type(instrument_class: str | None) -> str:
    if normalize_instrument_class(instrument_class) == INSTRUMENT_CLASS_CRYPTO:
        return ETORO_SETTLEMENT_CRYPTO
    return ETORO_SETTLEMENT_EQUITY
