# Agent Task Loop Repository Rules

- Treat a real Obsidian Vault as writable only when both `ATL_VAULT_ROOT` is set and `ATL_ALLOW_REAL_WRITES=1`.
- Tests must use temporary fixtures. Never use personal, customer, secret, or real task data in tests.
- Route all state changes through services; do not mutate persisted state directly from adapters, commands, or UI code.
- Agent execution may write only metadata, audit records, and artifacts. It must not write domain state directly.
- Follow test-driven development: write and observe a failing test before implementation.
- Keep commits scoped to one coherent change.
