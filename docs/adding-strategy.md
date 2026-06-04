# Adding a strategy

1. Subclass `strategies.base.BaseStrategy`.
2. Implement `provide_signal(tick, available_capital)`.
3. Register aliases in `strategies/factory.py` `create_strategy()`.

Deploy via control plane UI or `POST /api/control/executions`.
