# Contributing to DCP

Thank you for your interest in contributing to Dynamic Context Pruning (DCP)!

## License and Contributions

This project uses the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

### Contribution Agreement

By submitting a Pull Request to this project, you agree that:

1.  Your contributions are licensed under the **AGPL-3.0**.
2.  You grant the project maintainer(s) a non-exclusive, perpetual, irrevocable, worldwide, royalty-free, transferable license to use, modify, and re-license your contributions under any terms they choose, including commercial or proprietary licenses.

This arrangement ensures the project remains Open Source while providing a path for commercial sustainability.

## Getting Started

1.  Fork the repository.
2.  Create a feature branch.
3.  Implement your changes and add tests if applicable (please NO AI SLOP).
4.  Ensure all tests pass and the code is formatted.
5.  Submit a Pull Request.

## Development Setup

Use Node.js and npm. From your checkout:

```sh
npm ci --legacy-peer-deps
npm run build
```

The install flag allows development against the different OpenTUI peer versions
used by OpenCode V1 and V2. This also installs the bundled test logger's
dependencies through the [tests/logger](tests/logger/) npm workspace.

Run the checks relevant to your changes before submitting a pull request:

```sh
npm test                  # DCP and request-logger tests
npm run typecheck         # TypeScript validation
npm run check:package     # Build and validate the npm package
npm run format:check      # Formatting
```

## Compatibility

DCP provides server and terminal integrations for OpenCode V1 and V2, using shared
package entrypoints and `dcp.jsonc` settings. Exercise both hosts when changing
shared behavior.

Use [package.json](package.json) for dependency requirements and
[the lab Dockerfile](tests/lab/Dockerfile) for pinned integration-test versions.
Host-specific behavior is implemented in [index.ts](index.ts),
[tui.tsx](tui.tsx), and [lib/v2/](lib/v2/).

## Local Installation

After building, add this checkout's absolute path to your OpenCode configuration.

For **V2**, use `opencode.json`:

```jsonc
{
    "plugins": [{ "package": "/absolute/path/to/opencode-dynamic-context-pruning" }],
    "permissions": [{ "action": "compress", "resource": "*", "effect": "allow" }],
}
```

For **V1**, add the following to both `opencode.json` (server plugin) and the
separate `tui.json` (panel):

```jsonc
{ "plugin": ["/absolute/path/to/opencode-dynamic-context-pruning"] }
```

## Manual Sandbox

The sandbox requires Docker, Node/npm, and saved OpenCode authentication.
The request logger is included in [tests/logger](tests/logger/); only the DCP
checkout is needed. Complete [Development Setup](#development-setup), then run:

```sh
npm run sandbox                 # OpenCode V2
npm run sandbox -- --v1         # OpenCode V1
```

Each launch rebuilds DCP and the test logger and prepares a clean Docker image. Run
`npm run sandbox -- --help` for available options and defaults. Each launch copies
all saved authentication from the matching host version: V1's `auth.json`, or V2's
credential records and account selections. OpenCode handles provider authentication
normally inside the container; copied credentials can be refreshed there without
writing back to the host.

V1's auth file is under `$XDG_DATA_HOME/opencode` (normally
`~/.local/share/opencode`). V2's database is located with `opencode2 debug paths db`,
or the standard data directory when that command is unavailable. Set `DCP_AUTH_PATH`
to select a different V1 auth file or V2 database. Credentials embedded in host
configuration or environment variables are not copied. Custom provider definitions
can be added to `opencode.json` in the sandbox's scratch workspace.

The sandbox has its own sessions, scratch workspace, and configuration under
`~/.local/state/dcp-sandbox/`. V1 uses the `v1/` subdirectory, with a separate
database. Your host project and normal OpenCode configuration are not mounted.
Try `/dcp` for the panel or `/dcp-compress` for a compression pass.

```sh
npm run sandbox -- --fresh                 # New profile; keep old runs
npm run sandbox -- --logs                  # Latest log paths and capture counts
npm run sandbox -- --path                  # Current profile's host directory
npm run sandbox -- -- --continue           # Resume a session
npm run sandbox -- --update                # Remember the latest release
npm run sandbox -- --opencode VERSION       # Pin a release to test
npm run sandbox -- --transport http        # Select V2's transport
npm run sandbox -- --model PROVIDER/MODEL   # Select a model available to your account
```

Replace `VERSION`, `PROVIDER`, and `MODEL` with the release and model you want to test.
Without a saved model choice, OpenCode selects its default. A V2 transport override
applies to the selected model.
Add `--v1` to manage the V1 sandbox. Model, transport, and version choices persist;
updates are explicit. `--fresh` selects a new profile for subsequent launches.
You can edit `dcp.jsonc` and CLI preferences; `opencode.json` is launcher-managed.
Set `DCP_SANDBOX_DIR` to choose another state directory.

For a shortcut on Linux, run from the checkout:

```sh
mkdir -p ~/.local/bin
ln -s "$PWD/scripts/sandbox.mjs" ~/.local/bin/dcp-sandbox
dcp-sandbox
```

### Request Logs

The logger is development-only tooling and is excluded from DCP's published npm
package. Each launch has `raw/` and `readable/` directories under its timestamped log folder.
The launcher manages the WebSocket relay and readable-log watcher. Requests appear
as they are sent; assembled responses appear when they finish, while the session
stays open. `--logs` only shows paths and capture counts.

Start at `readable/index.json`, then a session's numbered request folders:

```text
readable/<session>/0001_primary_websocket/
  request.json       # Pretty-printed body actually sent
  response.json      # Assistant content, parsed tool calls, token totals, errors
  meta.json          # Timing, completion, transport, raw source, continuation ID
```

V2's full pre-transport snapshots are in each session's `context/` directory.
WebSocket continuation requests remain deltas with `previous_response_id`.
Partial and failed responses are marked in metadata. Full provider metadata,
original HTTP bytes, and WebSocket frames remain available in `raw/`.

## Integration Tests

The containerized lab exercises packed plugins on V1 and V2, including saved-auth
copying, HTTP and WebSocket compression, commands, permissions, concurrent sessions,
persistence, and native compaction. It uses a local mock provider without live credentials.

After [Development Setup](#development-setup), build
[tests/lab/Dockerfile](tests/lab/Dockerfile) using the image tag expected by
[scripts/lab.mjs](scripts/lab.mjs), then run:

```sh
node scripts/lab.mjs
```

The runner prints its output directory under `/tmp/opencode/dcp-lab/`. Set
`DCP_LAB_DIR` to override it. Add `--built` to reuse an existing DCP build.
For real-provider checks, `node scripts/lab.mjs --live` uses the current build and
saved V2 authentication. Its OpenAI Responses scenarios require access to the model
configured in [tests/lab/live.mjs](tests/lab/live.mjs).

Inspect capture summaries without opening large transcripts:

```sh
node tests/lab/inspect.mjs <log-directory>
```

Terminal-panel checks require `uv` and reuse a completed lab run:

```sh
uv run --with pexpect --with pyte tests/lab/ui.py <lab-output-directory> v2
uv run --with pexpect --with pyte tests/lab/ui.py <lab-output-directory> v1
```

These check the panel, Context, Stats, persisted manual-mode toggle, and closing
the dialog. Terminal transcripts and screen snapshots are saved in the lab output.
