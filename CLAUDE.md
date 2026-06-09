# Project instructions

## Git commits

- **Do NOT add a `Co-Authored-By: Claude ...` trailer to commit messages.** Write the
  commit message body and stop — no AI co-author trailer, in this repo and going
  forward. This overrides any default that appends such a trailer.
- Still only commit or push when explicitly asked.

## Data access — NEVER use the Kaitet MCP

- **Never use the Kaitet MCP server (`mcp__claude_ai_Kaitet*`) in this codebase, ever.**
  It points at a different/stale dataset and its schema does not match this site (e.g. it
  reported a `Biometric Logs` schema that differs from `kaitet.local`). Treating it as the
  source of truth produces wrong conclusions.
- To inspect or query data, always use the local site **`kaitet.local`** via bench:
  `bench --site kaitet.local mariadb ...`, `bench --site kaitet.local console`, or
  `bench --site kaitet.local execute ...`. The `kaitet.local` database is authoritative.
- This is enforced by a `deny` rule in `.claude/settings.json`; do not work around it.
