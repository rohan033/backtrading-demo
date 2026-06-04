# Manual UI smoke checklist

Run after each migration phase with `make dev` (or `make cp` + `make fe`).

## Phase 0

- [ ] http://localhost:8000/docs loads
- [ ] http://localhost:3000 loads

## Phase 1

- [ ] Executions list (`/api/control/executions`)
- [ ] Portfolio page (or graceful error without creds)
- [ ] OpenAPI unchanged paths under `/api/control/*`

## Phase 2

- [ ] `pip install -e .` then `make dev` still works

## Phase 3

- [ ] Fake broker deploy: engine appears on Live Servers
- [ ] Live WS / logs when engine running

## Phase 4–5

- [ ] Strategy AI WebSocket (if Cursor env configured)
- [ ] Telegram flows (if `.telegram.env` configured)

## Phase 6–7

- [ ] Stop-all / unschedule-all succeed
- [ ] Deploy + stop single execution

## Phase 8

- [ ] README quickstart matches actual commands
