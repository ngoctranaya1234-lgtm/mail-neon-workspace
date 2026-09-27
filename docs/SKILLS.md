# Audited project skills

- `ui-ux-design` from https://github.com/arvindand/agent-skills, commit `064c5eee3b8a3d438478a202038d6d1a9c081088`. MIT. The selected directory contains Markdown guidance and no executable scripts. Its stop hook is a prompt-only checklist. Installed at `.agents/skills/ui-ux-design`.
- `backend-engineering` from https://github.com/magnus919/agent-skills, commit `9a5adbcbe7877bcf3137664a5abb76dd4c6692fc`. MIT. Its Python N+1 spotter and tests were read before copying; no installer or postinstall hook is present in the selected directory. Installed at `.agents/skills/backend-engineering`.
- `supabase/agent-skills` was inspected but not installed because this release uses SQLite and no Supabase access path. Install its official Postgres skill if/when a PostgreSQL migration is undertaken.

No copied script is executed by the application. Skills are project-local and are not runtime dependencies.
