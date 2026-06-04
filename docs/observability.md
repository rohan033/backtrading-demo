# Observability

## Structured logging

Include when available: `engine_id`, `broker`, `account_env`, `execution_id`, `component`.

Control plane logs: see `control_plane/ops_logging.py` (`[CONTROL]` prefix).

Live engine logs: `live_engine_log_path(engine_id)` under repo `logs/`.

## Health

| Endpoint | Meaning |
|----------|---------|
| CP `GET /health` (if exposed) / docs | Control plane liveness |
| `GET /api/control/engines` | Registry + `heartbeatFresh`, `status` (stale/running) |
| Live `GET /health` | Engine liveness |
| Live `GET /api/live/engine-info` | Payload for CP heartbeat (keep fields stable for UI) |

## Degraded live engine

Mark `degraded` when strategy executor stopped, broker WS disconnected, or tick stall exceeds timeout (configurable in live app).

## CP ↔ live

Live process registers via heartbeat; CP marks engines `stale` when heartbeats stop. UI reads this via `/api/control/engines`.
