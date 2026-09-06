# 3DWebAgent

A browser-native 3D editor and agent environment with portable MuJoCo episodes.
The browser provides editing, WebMCP, image observations and trajectory inspection;
the headless Python runtime executes and verifies the same state commands.

Open the editor at **[3dwebagent.davidz.cn](https://3dwebagent.davidz.cn/)**.

## Install and run

Requires Node.js 22.12+, pnpm 11.25.0, Python 3.11+ and uv. Browser and native
physics both use MuJoCo 3.12.0.

```sh
pnpm install --frozen-lockfile
uv sync --project python --locked
pnpm dev
```

Open the local URL printed by Vite. Use `pnpm build` and `pnpm preview` for a
production build. WebMCP uses the browser's native `modelContext` API; discovery
requires a compatible browser/client. No substitute bridge is included.

## Edit and record

Import OBJ parts or open an episode. During setup, edit objects, physics, enabled
tools and the agent camera with Undo/Redo. Groups are logical, not physical welds;
pose editing supports independent free bodies. Mesh collision uses convex geometry.
The View menu reopens panels or resets the layout. Select Camera to edit its pose,
or use Align Camera to View during setup.

Drop a single episode ZIP anywhere in the workspace to open it. Unsaved edits
require confirmation before replacement; invalid archives leave the current scene
intact. Panel dragging continues to work normally.

The first agent call, including a query, freezes setup and starts recording.
Subsequent manual world edits become human intervention events. Start episode and
End episode provide explicit lifecycle control; saving does not end a run. Active
archives continue from their latest committed state. Full export retains history;
current-as-initial export creates a fresh setup from a committed state.

Physics advances only during physical operations or `advance_simulation`. Free
View, selection, visibility and history browsing do not change the agent camera,
observations or execution state. The Timeline exposes calls, physics frames,
original PNGs and failed attempts. Captures use the latest world even with the
viewport closed. Verify actions runs in an isolated world.

## Python and generated examples

Examples and verification reports are generated locally and are not stored in the
repository. Create the basic archives before using these commands:

```sh
pnpm examples
uv run --project python python python/replay.py inspect examples/two-objects.episode.zip
uv run --project python python python/replay.py verify examples/two-objects.episode.zip --atol 1e-9 --rtol 1e-7
```

Create a local `commands.jsonl` file, with one command per line:

```jsonl
{"name":"get_state","arguments":{}}
{"name":"translate_objects","arguments":{"ids":["a"],"delta":[0,0,0.1]}}
{"name":"end_episode","arguments":{"reason":"user_stop"}}
```

```sh
uv run --project python python python/replay.py run examples/two-objects.initial.episode.zip commands.jsonl -o examples/result.episode.zip
```

The CLI emits JSON. Failed commands are retained and subsequent commands are
attempted. Verification exit codes are 0 passed, 2 diverged, 3 incompatible and
4 failed. `--mode operation` diagnoses each command independently. Without explicit
tolerances, verification requires exact numeric equality.

## Public contract

The contract is `3dwebagent-runtime-1`; archives use `3dwebagent-episode`, version 1.
The authoritative definitions are:

- [Episode schema](schema/episode.schema.json)
- [Public tools](schema/tools.json)
- [Results and error codes](schema/results.schema.json)
- [Recorded internal commands](schema/commands.json)
- [Cross-backend conformance fixture](schema/conformance.json)

Independent producers can create setup archives without importing the editor.
Python's `Runtime` in [episode_runtime.py](python/episode_runtime.py) supports load,
restore, execute, save and verify. Coordinates are Z-up, quaternions are wxyz, and
physical models use SI units. Tool IDs are explicit and independent of selection.
Direct pose edits clear the edited body's velocities. Calls execute serially;
failed transactions roll back and overlapping calls are rejected as busy.

Archives contain `manifest.json`, `frames.jsonl`, `frames.bin`, `calls.jsonl`,
`events.jsonl`, model assets under `world/`, and optional content-addressed PNGs
under `observations/`. Frame metadata orders initial, committed and trace rows;
each row maps to `stateSize` little-endian Float64 integration values in
`frames.bin`. Trace intervals are start-inclusive and end-exclusive. The manifest
hashes every other member. Readers validate paths, schemas, checksums and frame
references before replacing a live world.

Restoration requires exact saved-state readback. Cross-backend re-execution uses
explicit tolerances; the fixture's `atol=1e-9, rtol=1e-7` is not a guarantee for
arbitrary long trajectories. Build hashes record provenance, not numerical or
visual equality. Python preserves and verifies stored PNGs but cannot create new
image observations.

## Development and verification

```sh
pnpm format
pnpm format:check
pnpm check
pnpm test:all
pnpm validate:episodes
```

`test:all` generates basic examples and the WASM/native portability fixture, then
runs TypeScript, Python and Playwright tests, including a production build.
Individual commands are `pnpm test`, `pnpm test:python` and `pnpm test:ui`; run
`pnpm test:prepare` first when generated fixtures are absent or source has changed.
`pnpm verify:portable` regenerates the mixed-backend episode and verification report.
Tests include real WASM/native round trips and 30,000 physics steps on each backend.

UI tests use an isolated headless profile. Installed Edge is used when available;
otherwise install Chromium with `pnpm exec playwright install chromium`.
`BROWSER_PATH` selects another compatible browser executable. Cross-backend tests
use `python/.venv/bin/python`; `EPISODE_PYTHON` can override that interpreter.

Prettier formats frontend code, configuration and this README; Ruff formats and
checks Python. Build and format commands regenerate `schema/wasm-build.json` from
the runtime sources and WASM binary. Generated examples, reports and caches are
ignored. The small OBJ fixture under `tests/fixtures/` is a source test asset.

## Deployment

GitHub Actions tests and builds every pull request to `main`. Pushes to `main`
and manual workflow runs on `main` publish `dist/` to GitHub Pages after all tests
pass. Failed builds leave the deployed website unchanged. To roll back, revert
the relevant commit on `main`; the same workflow tests and publishes the revert.

The repository's Pages publishing source is GitHub Actions, with the custom
domain `3dwebagent.davidz.cn` and Enforce HTTPS enabled. Cloudflare provides a
DNS-only CNAME from `3dwebagent` to `davidzhang73.github.io`. The custom domain
uses Vite's default root base path (`/`). Domain binding is managed in Pages
settings, not by a generated `CNAME` file.

Only browser assets are published, including MuJoCo WASM. Python and generated
test episodes are not deployed. Imported files stay in the browser; deployment
adds no upload service. WebMCP still requires a compatible browser/client.

## Limitations

Episodes stay in memory until exported. Older development archive formats are
unsupported and are not migrated. Native MCP transport, native image rendering,
batch scheduling, robot controllers, Gymnasium adapters, continuous simulation and
history branching are outside this release. No cross-renderer pixel equality is
claimed. Production builds currently report MuJoCo wrapper externalization and
large-bundle warnings.
