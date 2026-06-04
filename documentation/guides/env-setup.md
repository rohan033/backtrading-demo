# Environment setup

Copy the root template and optional feature-specific files. **Never commit** filled-in env files (they are gitignored).

```bash
cp env.example .env
```

## Core variables

{%
   include-markdown "../../env.example"
%}

## Optional integrations

| Feature | Files |
|---------|--------|
| Angel One | `.env` keys `ANGEL_*` + `pip install -e ".[angel]"` |
| eToro | `brokers/etoro` templates → `.demo.env` / `.live.env` |
| Cursor Strategy AI | `.cursor-api.env` from `.cursor-api.env.example` |
| Telegram | `.telegram.env` |

Broker-specific details: [Brokers overview](brokers.md).
