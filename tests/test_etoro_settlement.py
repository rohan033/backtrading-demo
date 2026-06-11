from brokers.etoro.order_client import EtoroV2OrderClient
from brokers.etoro.settlement import (
    etoro_settlement_type,
    normalize_instrument_class,
)


class _LeverageStub(EtoroV2OrderClient):
    def _default_leverage(self):
        return 1


def test_normalize_instrument_class_defaults_to_equity():
    assert normalize_instrument_class(None) == "equity"
    assert normalize_instrument_class("equity") == "equity"
    assert normalize_instrument_class("CRYPTO") == "crypto"


def test_etoro_settlement_type_mapping():
    assert etoro_settlement_type("equity") == "real"
    assert etoro_settlement_type("crypto") == "marginTrade"


def test_build_v2_bracket_payload_uses_real_and_units():
    client = _LeverageStub.__new__(_LeverageStub)
    payload = client._build_v2_open_payload(
        instrument_id=1130,
        is_buy=True,
        units=2.129123,
        stop_loss_rate=905.775,
        take_profit_rate=947.58,
        settlement_type="real",
    )
    assert payload["settlementType"] == "real"
    assert payload["units"] == 2.129123
    assert "amount" not in payload
    assert payload["stopLossRate"] == 905.77
    assert payload["takeProfitRate"] == 947.58


def test_build_v2_open_payload_uses_instrument_id_only():
    client = _LeverageStub.__new__(_LeverageStub)
    payload = client._build_v2_open_payload(
        instrument_id=100000,
        is_buy=True,
        amount=50.0,
        settlement_type="marginTrade",
    )
    assert payload["instrumentId"] == 100000
    assert payload["settlementType"] == "marginTrade"
    assert "symbol" not in payload
