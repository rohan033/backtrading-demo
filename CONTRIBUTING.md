# Contributing

Hobby project — manual UI smoke per [docs/ui-smoke.md](docs/ui-smoke.md); no new automated test requirements.

## Extension points

1. **Strategy** — add under `strategies/` and register in `strategies/factory.py` (future: `pyproject.toml` entry points).
2. **Broker** — implement `brokers/interfaces.py` protocols; register in `backtrading.brokers.registry`.
3. **Skill** — add `src/backtrading/agentic/skills/<id>/SKILL.md` (universal Markdown + YAML frontmatter).
4. **MCP tool** — extend `api/control_plane_mcp_tools.py`; constants re-exported from `mcps/catalog.py`.
5. **Telegram command** — `event/telegram_commands.py` (shim: `backtrading.telegram`).

## Layer rules

See [ARCHITECTURE.md](ARCHITECTURE.md). Prefer importing facades from `src/backtrading/` in new code.

## Skills + Cursor IDE

```bash
chmod +x scripts/link-cursor-skills.sh
./scripts/link-cursor-skills.sh
```

Canonical skills live under `src/backtrading/agentic/skills/` only.
