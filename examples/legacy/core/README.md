# Legacy `core/` stubs (unused)

Pre-modular experiment; **no production imports**.

| File | Notes |
|------|--------|
| `trading_context.py` | In-memory order/position maps |
| `order_service.py` | Thin wrapper around client + context |

Use instead: `managers/trading_manager.py`, `src/backtrading/core_trading/`.

Do not recreate `core/logic/` — that naming came from an external refactor template, not this project.
