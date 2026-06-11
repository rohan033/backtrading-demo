#!/usr/bin/env python3
"""Direct eToro market-data search request with manually edited keys."""

import sys
import uuid

import requests


symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
url = "https://public-api.etoro.com/api/v1/market-data/search"

# Use internalSymbolFull to filter specifically for the symbol
params = {
    "internalSymbolFull": symbol
}

headers = {
    "User-Agent": "python-requests/2.33.1",
    "x-api-key": "sdgdskldFPLGfjHn1421dgnlxdGTbngdflg6290bRjslfihsjhSDsdgGHH25hjf",
    "x-user-key": "eyJjaSI6IjYwY2FiYjBiLTU1OTctNDQ4NS04ZjYzLTdlOWUwNTZlMGJiOCIsImVhbiI6IlVucmVnaXN0ZXJlZEFwcGxpY2F0aW9uIiwiZWsiOiJ1RU9nQXdRLnFWSUQ4eGsuaG9ZUDdCRTg3UWpRWGR5QlY5SjZ2cndSZkpuVi1NaXB3QXhzaHoxZjhwcUlGRVJNS1dIQTNEbXIuaERsc2ZSS1k1SHE5Qld0OGlsRFFQamtGT2JycWVOejkyOF8ifQ__",
    "x-request-id": str(uuid.uuid4())
}

response = requests.get(url, headers=headers, params=params)

if response.status_code == 200:
    data = response.json()
    # Find the exact match in the returned items list
    instrument = next((item for item in data['items'] if item['internalSymbolFull'] == symbol), None)

    if instrument:
        print(f"Instrument ID: {instrument['instrumentId']}")
    else:
        print("Instrument not found")
else:
    print(f"Error: {response.status_code}")
