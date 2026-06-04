# Broker adapters index

Adapters translate **vendor API shapes** into **control-plane JSON** (portfolio rows, search results). They are not a second broker implementation layer.

| Broker | Module |
|--------|--------|
| Angel | [`../angel/adapters/portfolio.py`](../angel/adapters/portfolio.py) |
| eToro | [`../etoro/adapters/portfolio.py`](../etoro/adapters/portfolio.py) |
| Fake | [`../fake/adapters/portfolio.py`](../fake/adapters/portfolio.py) |

Protocols (ticks, orders): [`../protocols.py`](../protocols.py).

Consumers: [`api/server.py`](../../api/server.py) control-plane portfolio/search routes.
