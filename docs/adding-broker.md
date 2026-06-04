# Adding a broker

1. Implement protocols in `brokers/interfaces.py` (ticks, orders, portfolio as needed).
2. Add package under `brokers/<name>/`.
3. Register factory: `backtrading.brokers.registry.register("<name>", factory)`.
4. Wire control-plane portfolio/search routes via adapters (see `brokers/etoro/adapters/`).

Do not import concrete brokers from `apps` route modules.
