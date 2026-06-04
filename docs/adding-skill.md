# Adding an agent skill

1. Create `src/backtrading/agentic/skills/<skill-id>/SKILL.md`.
2. YAML frontmatter: `name`, `description`, optional `triggers`.
3. Body: agent-neutral instructions (no Cursor-only paths).
4. Load with `backtrading.agentic.loader.load_skill("<skill-id>")`.
5. Optional runtime wrapper in `backtrading/agentic/adapters/`.

Optional IDE symlink: `./scripts/link-cursor-skills.sh`.
