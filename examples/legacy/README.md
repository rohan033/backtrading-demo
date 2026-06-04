# Legacy root modules

These top-level files predate `src/backtrading/` and remain for backward compatibility:

| Legacy | Use instead |
|--------|-------------|
| `client.py` | `brokers/angel/client.py` |
| `strategy.py`, `backtesting.py` | `core_trading/backtest/` (future) |
| `tick.py` | `brokers.protocols.TickData` |
| `core/` (moved) | [`examples/legacy/core/`](core/) — unused stubs |
| `main.py`, `temp.py`, `test.py` | `examples/` or CLI |

Do not import these in new code.
