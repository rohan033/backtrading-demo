from brokers.etoro.adapters.portfolio import metadata_from_etoro_record
from brokers.etoro.client import EtoroClient


def test_instruments_from_market_data_response_parses_display_datas():
    response = {
        "instrumentDisplayDatas": [
            {
                "instrumentID": 100002,
                "symbolFull": "AAPL",
                "internalInstrumentDisplayName": "Apple Inc",
            },
        ],
    }
    rows = EtoroClient._instruments_from_market_data_response(response)
    assert len(rows) == 1
    assert rows[0]["instrumentID"] == 100002


def test_metadata_from_images_array():
    meta = metadata_from_etoro_record({
        "symbolFull": "NVDA",
        "internalInstrumentDisplayName": "NVIDIA Corp",
        "images": [
            {"format": "png", "width": 50, "uri": "https://example.com/nvda-50.png"},
            {"format": "png", "width": 150, "uri": "https://example.com/nvda-150.png"},
        ],
    })
    assert meta["tradingsymbol"] == "NVDA"
    assert meta["logo50x50"] == "https://example.com/nvda-50.png"
    assert meta["logo150x150"] == "https://example.com/nvda-150.png"
