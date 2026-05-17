# pi-opencode-session-import

Import OpenCode sessions into native vanilla-Pi (`@earendil-works/pi-coding-agent`) and OMP (`@oh-my-pi/pi-coding-agent`) sessions.

Runs OpenCode's SQLite database in read-only mode, converts a selected session into a native Pi/OMP session, and switches the agent into it. Bulk import, filters, idempotent registry, and dry runs included.

## Features

- `/opencode-import` slash command
- Interactive session selector
- `list`, `status`, `all`, `all --dry-run`, `open <ses_id>` subcommands
- Filters: `--cwd`, `--since`, `--updated-since`, `--limit`, `--max-tool-chars`
- Idempotent per-runtime import registry (`~/.pi/agent/opencode-import-registry.json`, `~/.omp/agent/opencode-import-registry.json`)
- OpenCode tool calls preserved as text — never re-emitted as runtime `toolCall` blocks
- Reads OpenCode DB read-only and asserts mtime is unchanged after each import

## Install

### Vanilla Pi

```bash
pi install /path/to/pi-opencode-session-import
```

…or add the absolute repo path to `~/.pi/agent/settings.json:packages[]`.

### OMP

Symlink the OMP adapter into OMP's discovery directory:

```bash
ln -s /path/to/pi-opencode-session-import/adapters/omp ~/.omp/agent/extensions/opencode-import
```

…or add `./adapters/omp/index.ts` to your `~/.omp/agent/settings.json:extensions[]`.

## Usage

```text
/opencode-import                          # interactive selector
/opencode-import ses_xxx                  # import a specific session
/opencode-import list [search]
/opencode-import status
/opencode-import all --dry-run            # preview bulk import
/opencode-import all                      # bulk import, idempotent
/opencode-import open ses_xxx             # switch to an already-imported session
```

Flags:

```text
--db /path/to/opencode.db
--registry /path/to/registry.json
--limit 100
--cwd /repo/path
--since 2026-05-01
--updated-since 2026-05-15
--max-tool-chars 0   (0 = drop historical tool output)
--force              (reimport even when already in registry)
--dry-run
```

## Requirements

- `sqlite3` on PATH (CLI is invoked with `-readonly -json`)
- Bun runtime (Pi and OMP both run Bun)
- OpenCode DB at `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db` (override with `--db`)

## Safety

- OpenCode DB is opened with `sqlite3 -readonly`
- Each import asserts the DB mtime did not change
- Imports never produce native `toolCall` blocks — OpenCode tool history is serialized as text inside assistant messages
- Per-runtime registry prevents accidental double-imports

## Tests

```bash
bun test
```
