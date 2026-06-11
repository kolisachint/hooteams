# hooteams

Multi-agent team orchestration on top of [hoocode](https://github.com/kolisachint/hoocode) agents, plus an SSE bridge that exposes the live team event stream to any client — the `hooteams` CLI or [hoocanvas](https://github.com/kolisachint/hoocanvas).

```
packages/
  orchestrator/   team DAG, planner, agent registry, tagged event channel
  bridge/         SSE fan-out, wire serializer, HTTP routes
apps/
  server/         Bun.serve() entry: orchestrator → bridge → HTTP
  cli/            hooteams start / attach / nudge / status / stop
```

Everything speaks one wire format: `TeamEvent = AgentEvent & { role, agentId, ts }`, one JSON object per SSE `data:` line.

## Quick start

```bash
bun install
bun test
```

### Dependencies

This project uses:
- `@kolisachint/hoocode-agent-core` v0.4.49+
- `@kolisachint/hoocode-ai` v0.4.49+

These versions include the MCP tool exports (`getDefaultTools`, `loadMcpTools`, `closeMcpTools`) required for per-role tool configuration.

---

## CLI commands

After `bun install` the `hooteams` binary is linked globally (via `npm link` in postinstall).

```
hooteams — multi-agent orchestration for hoocode

Usage:
  hooteams start  [--config path] [--port 4242]     start the team server
  hooteams attach <role> [--replay 50] [--host …]   attach this terminal to an agent
  hooteams nudge  <role> "<message>" [--host …]     inject a message mid-run
  hooteams status [--host …]                        all agents at a glance
  hooteams stop   [--host …]                        stop the server gracefully
  hooteams help                                     show usage
```

### `hooteams start`

Start the team server. Spawns all agents defined in the config and opens an HTTP/SSE endpoint.

```bash
hooteams start --config hooteams.config.json --port 4242
```

| Flag       | Default                 | Description                                     |
|------------|-------------------------|-------------------------------------------------|
| `--config` | `hooteams.config.json`  | Path to config file. Missing default → empty team (agents spawned via planner or API) |
| `--port`   | `4242`                  | HTTP port to listen on                          |

Shuts down cleanly on `SIGINT` / `SIGTERM` (aborts agents, closes SSE streams, stops the server).

### `hooteams attach`

Attach this terminal to a running agent — replays recent events then follows live output, like `tmux attach`.

```bash
hooteams attach coder
hooteams attach planner --replay 50 --host http://remote:4242
```

| Flag       | Default                      | Description                          |
|------------|------------------------------|--------------------------------------|
| `--replay` | `100`                        | Number of past events to replay      |
| `--host`   | `http://localhost:4242`      | Bridge base URL                      |

**Keyboard shortcuts while attached:**

| Key   | Action                                                        |
|-------|---------------------------------------------------------------|
| `n`   | Open a prompt to type a nudge (injected mid-run via steering) |
| `q`   | Detach without stopping the agent                             |
| `^C`  | Detach without stopping the agent                             |

### `hooteams nudge`

Inject a steering message into a running agent from anywhere (no need to attach first).

```bash
hooteams nudge coder "skip auth tests, focus on unit tests only"
```

| Flag     | Default                      | Description     |
|----------|------------------------------|-----------------|
| `--host` | `http://localhost:4242`      | Bridge base URL |

If the agent is mid-run the message is queued as a steering message. If the agent is idle it starts/resumes a run with the nudge.

### `hooteams status`

Show a snapshot of all agents and their current state.

```bash
hooteams status
hooteams status --host http://remote:4242
```

Output example:

```
planner  done    (last: agent_end)
coder    streaming  (last: message_update)
tester   idle
```

Agent statuses: `idle` · `thinking` · `streaming` · `tool` · `done` · `error`

| Flag     | Default                      | Description     |
|----------|------------------------------|-----------------|
| `--host` | `http://localhost:4242`      | Bridge base URL |

### `hooteams stop`

Gracefully stop the server — aborts all agents, drops SSE clients, and shuts down.

```bash
hooteams stop
hooteams stop --host http://remote:4242
```

| Flag     | Default                      | Description     |
|----------|------------------------------|-----------------|
| `--host` | `http://localhost:4242`      | Bridge base URL |

---

## Configuration

The server reads `hooteams.config.json` (or the path given via `--config`). If the default file is missing, the server starts with an empty team — agents are spawned dynamically by the planner or via the `/steer` API.

### Full config reference

```jsonc
{
  // Team-wide fallbacks for roles that don't set their own
  "defaults": {
    "provider": "anthropic",                            // model provider (default: "anthropic")
    "model": "claude-sonnet-4-5",                       // model id used by roles without one
    "thinkingLevel": "off"                              // "off" | "low" | "medium" | "high"
  },

  // Array of team members to spawn at startup
  "team": [
    {
      "role": "planner",                                // unique role name (required)
      "model": "claude-sonnet-4-5",                     // model id for hoocode-ai (required unless defaults.model is set)
      "systemPrompt": "You are the planner…",           // system prompt (required)
      "provider": "anthropic",                          // model provider (falls back to defaults.provider, then "anthropic")
      "thinkingLevel": "off",                           // "off" | "low" | "medium" | "high" (falls back to defaults.thinkingLevel, then "off")
      "defaultTools": true,                             // include built-in coding tools: bash/read/edit/write/grep/find/ls
      "mcpConfigPath": "./mcp.json",                    // path to mcp.json for MCP server tools (requires async spawn)
      "cwd": "/path/to/project"                         // working directory for agent tools (default: process.cwd())
    },
    {
      "role": "coder",
      "model": "claude-sonnet-4-5",
      "systemPrompt": "You are the coder. Implement tasks handed to you, one at a time, with tests.",
      "defaultTools": true,
      "cwd": "."
    }
  ],

  // Max agents that can run concurrently
  "maxConcurrent": 3,

  // Server port (can also be set via --port flag or PORT env var)
  "port": 4242
}
```

### Role config fields

| Field           | Type       | Required | Default           | Description                                                                                     |
|-----------------|------------|----------|-------------------|-------------------------------------------------------------------------------------------------|
| `role`          | `string`   | ✓        |                   | Unique name for this team member (e.g. `planner`, `coder`, `tester`)                            |
| `model`         | `string`   | ✓*       |                   | Model id resolved via `hoocode-ai` `getModel()` (e.g. `claude-sonnet-4-5`). *Optional when `defaults.model` is set |
| `systemPrompt`  | `string`   | ✓        |                   | System prompt defining the agent's responsibilities                                              |
| `provider`      | `string`   |          | `"anthropic"`     | Model provider for `getModel()` (falls back to `defaults.provider` first)                        |
| `thinkingLevel` | `string`   |          | `"off"`           | Extended thinking level: `off`, `low`, `medium`, `high` (falls back to `defaults.thinkingLevel` first) |
| `defaultTools`  | `boolean`  |          | `false`           | Give the agent hoocode's built-in coding tools (`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`) |
| `mcpConfigPath` | `string`   |          |                   | Path to an `mcp.json` file; MCP server tools are loaded and appended to the agent's tool set     |
| `cwd`           | `string`   |          | `process.cwd()`   | Working directory for the agent's tools                                                          |

### Minimal config example

`defaults` keeps per-role entries small — roles only override what differs:

```json
{
  "defaults": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "team": [
    {
      "role": "planner",
      "systemPrompt": "You are the planner. Break the user's goal into tasks and coordinate the team."
    },
    {
      "role": "coder",
      "systemPrompt": "You are the coder. Implement tasks handed to you, one at a time, with tests."
    }
  ],
  "maxConcurrent": 3
}
```

### Config with tools enabled

```json
{
  "team": [
    {
      "role": "planner",
      "model": "claude-sonnet-4-5",
      "systemPrompt": "You are the planner. Break the user's goal into tasks and spawn specialist agents.",
      "thinkingLevel": "medium"
    },
    {
      "role": "coder",
      "model": "claude-sonnet-4-5",
      "systemPrompt": "You are the coder. Write clean, tested code.",
      "defaultTools": true,
      "cwd": "/Users/me/myproject"
    },
    {
      "role": "researcher",
      "model": "claude-sonnet-4-5",
      "systemPrompt": "You are the researcher. Gather information using your MCP tools.",
      "mcpConfigPath": "./mcp.json"
    }
  ],
  "maxConcurrent": 2
}
```

### Environment variables

| Variable                   | Default      | Description                       |
|----------------------------|--------------|-----------------------------------|
| `PORT`                     | `4242`       | Server port (lowest priority; `--port` flag and config `port` take precedence) |
| `HOOCODE_CODING_AGENT_DIR` | `~/.hoocode` | Where to find hoocode's `auth.json` (see Authentication) |

---

## Authentication

hooteams has no login flow of its own — it reuses hoocode's credential store. For each provider, credentials resolve in this order:

1. **`~/.hoocode/auth.json` API key entry** — written by hoocode's `/login` for API-key providers.
2. **`~/.hoocode/auth.json` OAuth entry** — e.g. an Anthropic Claude Pro/Max login. Expired tokens are refreshed automatically and written back; the file is locked with the same mechanism hoocode uses, so concurrent hoocode sessions and hooteams agents never clobber each other.
3. **Provider environment variable** — e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

To set up credentials, either run `hoocode` and `/login`, or export the provider's API key env var. No keys ever go in `hooteams.config.json` — the config only names the `provider` and `model`.

Embedders can override this entirely by passing their own resolver: `startServer(config, { teamOptions: { getApiKey } })`, or build the default one with `createHoocodeAuth({ authPath })` from `@kolisachint/hooteams-orchestrator`.

---

## HTTP API

The server exposes an HTTP API that any client (CLI, hoocanvas, curl) can use.

| Route            | Method | Description                                                            |
|------------------|--------|------------------------------------------------------------------------|
| `/events`        | GET    | SSE stream of all agents (replay + live)                               |
| `/events/:role`  | GET    | SSE stream of one agent; `?replay=N` limits replayed history           |
| `/steer`         | POST   | `{ "role": "coder", "message": "…" }` — queue a mid-run steering message |
| `/status`        | GET    | `{ [role]: { status, lastEventType } }`                                |
| `/health`        | GET    | `{ "ok": true }`                                                      |
| `/stop`          | POST   | Graceful shutdown (abort agents, close streams)                        |

All endpoints return JSON (except `/events` which returns SSE). CORS is enabled for all origins.

### Examples

```bash
# Stream all agent events
curl -N http://localhost:4242/events

# Stream only the coder agent, replaying the last 20 events
curl -N "http://localhost:4242/events/coder?replay=20"

# Nudge an agent via the API
curl -X POST http://localhost:4242/steer \
  -H "Content-Type: application/json" \
  -d '{"role": "coder", "message": "focus on the auth module first"}'

# Check agent statuses
curl http://localhost:4242/status

# Health check
curl http://localhost:4242/health

# Stop the server
curl -X POST http://localhost:4242/stop
```

---

## Dynamic agent spawning (Planner)

The planner agent has a built-in `spawn_agent` tool that lets it grow the team dynamically at runtime. When the planner is running, it can spawn new agents with:

| Parameter       | Type      | Required | Description                                                     |
|-----------------|-----------|----------|-----------------------------------------------------------------|
| `role`          | `string`  | ✓        | Unique role name for the new agent                              |
| `systemPrompt`  | `string`  | ✓        | System prompt defining the agent's responsibilities             |
| `model`         | `string`  | ✓        | Model id (e.g. `claude-sonnet-4-5`)                       |
| `provider`      | `string`  |          | Model provider (default: `anthropic`)                           |
| `task`          | `string`  |          | If given, immediately prompt the new agent with this task       |
| `defaultTools`  | `boolean` |          | Give the agent built-in coding tools                            |
| `mcpConfigPath` | `string`  |          | Path to `mcp.json` for MCP server tools                        |
| `cwd`           | `string`  |          | Working directory for the agent's tools                         |

This means you can start with just a planner and let it assemble the right team for the goal.

---

## Architecture notes

- The orchestrator imports `@kolisachint/hoocode-agent-core` (the `Agent` class). hoocode never imports hooteams.
- `TeamChannel` wraps every agent's `subscribe()`, tags each `AgentEvent` with `{ role, agentId, ts }`, and keeps a 100-event ring buffer per agent so late subscribers replay what they missed.
- The bridge serializer strips accumulated state from streaming events (`message_update` carries only the delta) — clients accumulate buffers themselves.
- hoocanvas has no npm dependency on this repo; it only knows the SSE wire format.

---

## Development

```bash
# Install dependencies
bun install

# Run all tests
bun test

# Type check
bun run check
```

### Monorepo structure

| Package                            | Path                    | Description                                    |
|------------------------------------|-------------------------|------------------------------------------------|
| `@kolisachint/hooteams-orchestrator` | `packages/orchestrator` | Team, TeamChannel, DAG, Planner, agent registry |
| `@kolisachint/hooteams-bridge`       | `packages/bridge`       | SSE fan-out, wire serializer, HTTP router       |
| `@kolisachint/hooteams-server`       | `apps/server`           | Bun.serve() entry: orchestrator → bridge → HTTP |
| `@kolisachint/hooteams-cli`          | `apps/cli`              | CLI binary (`hooteams`)                         |

### Running from source (without global install)

```bash
bun run apps/cli/src/index.ts start --config hooteams.config.json --port 4242
bun run apps/cli/src/index.ts attach coder
bun run apps/cli/src/index.ts nudge coder "focus on tests"
bun run apps/cli/src/index.ts status
bun run apps/cli/src/index.ts stop
```

## License

MIT
