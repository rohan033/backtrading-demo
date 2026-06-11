#!/usr/bin/env python3
"""Direct eToro watchlists request with manually edited keys."""

import json
import uuid

import requests


URL = "https://public-api.etoro.com/api/v1/watchlists"
X_API_KEY = "sdgdskldFPLGfjHn1421dgnlxdGTbngdflg6290bRjslfihsjhSDsdgGHH25hjf"
X_USER_KEY = "eyJjaSI6IjYwY2FiYjBiLTU1OTctNDQ4NS04ZjYzLTdlOWUwNTZlMGJiOCIsImVhbiI6IlVucmVnaXN0ZXJlZEFwcGxpY2F0aW9uIiwiZWsiOiJ1RU9nQXdRLnFWSUQ4eGsuaG9ZUDdCRTg3UWpRWGR5QlY5SjZ2cndSZkpuVi1NaXB3QXhzaHoxZjhwcUlGRVJNS1dIQTNEbXIuaERsc2ZSS1k1SHE5Qld0OGlsRFFQamtGT2JycWVOejkyOF8ifQ__"

def main() -> int:
    response = requests.get(
        URL,
        headers={
            "User-Agent": "python-requests/2.33.1",
            "x-request-id": str(uuid.uuid4()),
            "x-api-key": X_API_KEY,
            "x-user-key": X_USER_KEY,
        },
        timeout=20,
    )

    print("Status:", response.status_code)
    print("Content-Type:", response.headers.get("content-type"))

    try:
        payload = response.json()
    except ValueError:
        payload = response.text

    print(json.dumps(payload, indent=2, default=str))
    return 0 if response.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
