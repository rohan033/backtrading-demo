from brokers.etoro.adapters.portfolio import etoro_position_to_portfolio_row


def test_etoro_position_uses_display_metadata_for_numeric_symbol():
    position = {"instrumentID": 1048640, "units": 1.5, "openRate": 100, "currentRate": 110}
    symbol_map = {}
    display_map = {
        1048640: {
            "instrument_display_name": "Micron Technology Inc",
            "logo35x35": "https://example.com/mu.png",
        },
    }

    row = etoro_position_to_portfolio_row(position, symbol_map, display_map)

    assert row["tradingsymbol"] == "Micron Technology Inc"
    assert row["symbol"] == "Micron Technology Inc"
    assert row["instrument_display_name"] == "Micron Technology Inc"
    assert row["logo35x35"] == "https://example.com/mu.png"
    assert row["symboltoken"] == "1048640"


def test_rehydrate_etoro_portfolio_rows_replaces_numeric_tickers():
    from brokers.etoro.adapters.portfolio import rehydrate_etoro_portfolio_rows

    class FakeClient:
        async def aget_instrument_symbol_map(self, instrument_ids):
            return {1048640: "MU"}

        async def aget_instrument_display_data(self, instrument_ids):
            return [{
                "instrumentID": 1048640,
                "internalInstrumentDisplayName": "Micron Technology Inc",
                "logo35x35": "https://example.com/mu.png",
            }]

        async def aget_instrument_records(self, instrument_ids):
            return {
                1048640: {
                    "instrumentID": 1048640,
                    "symbolFull": "MU",
                    "displayName": "Micron Technology Inc",
                },
            }

    rows = [{
        "tradingsymbol": "1048640",
        "symboltoken": "1048640",
        "broker": "etoro",
    }]

    import asyncio
    enriched = asyncio.run(rehydrate_etoro_portfolio_rows(FakeClient(), rows))

    assert enriched[0]["tradingsymbol"] == "MU"
    assert enriched[0]["instrument_display_name"] == "Micron Technology Inc"
