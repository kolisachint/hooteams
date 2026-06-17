<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/hooteams.svg">
    <img alt="HooTeams" src="assets/hooteams-light.svg" height="64">
  </picture>
</p>

<p align="center">Multi-agent team orchestration with a live event stream.</p>

Multi-agent team orchestration on top of [hoocode](https://github.com/kolisachint/hoocode) agents, plus an SSE bridge that exposes the live team event stream to any client — the `hooteams` CLI, the built-in web UI, or any consumer of the wire format.

```
packages/
  dag/            dependency-free task DAG: topological order, ready/blocked, immutable snapshots
  orchestrator/   team execution, planner, agent registry, tagged event channel
  bridge/         SSE fan-out, wire serializer, HTTP routes
  webui/          live mission control (React + Vite); served by `hooteams start`
apps/
  server/         Bun.serve() entry: orchestrator → bridge → HTTP → web UI
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
  hooteams work   "<goal>" [--config p] [--model id] [--keep] [--out f] [--host …]  plan + run a goal end-to-end
  hooteams start  [--config path] [--port 4242] [--resume] [--no-webui]  start the team server + live web UI
  hooteams plan   "<goal>" [--out tasks.json] [--model id]  plan a goal without executing (dry run)
  hooteams run    <tasks.json> [--detach] [--host …]        start a task-graph run
  hooteams pending [--host …]                               list approval gates awaiting an answer
  hooteams resume <taskId> "<option>" [--feedback "…"]      answer an approval gate
  hooteams attach <role> [--replay 50] [--host …]           attach this terminal to an agent
  hooteams nudge  <role> "<message>" [--host …]             inject a message mid-run
  hooteams status [--host …]                                all agents at a glance
  hooteams stop   [--host …]                                stop the server gracefully
  hooteams help                                             show usage
```

### `hooteams work`

The one-liner: plan a goal, make sure a server is running, submit the plan, and follow it to completion — no separate `start` then `run`.

```bash
hooteams work "build the auth module"
```

If a server is already reachable at `--host`, `work` reuses it; otherwise it boots an ephemeral in-process server (and the live web UI) for the duration and stops it when the run settles. Pass `--keep` to leave that server (and the UI) running afterward. This is the decomposed `plan` → `run` flow collapsed into one command; the individual commands remain for when you want to review the plan or drive an existing server.

| Flag                | Default                | Description                                                        |
|---------------------|------------------------|--------------------------------------------------------------------|
| `--config`          | auto-discovered        | Team config used when booting an ephemeral server                  |
| `--model`           | `claude-sonnet-4-5`    | Planner model id                                                   |
| `--keep`            | off                    | Leave the booted server + web UI running after the run            |
| `--loop`            | off                    | Re-plan and re-run until the goal validator verifies it (see below) |
| `--max-iterations`  | `3`                    | Cap on `--loop` iterations                                          |
| `--verify`          | default prompt         | Goal-completion validator prompt used by `--loop`                  |
| `--out`             | off                    | Also write the plan to this file                                   |
| `--host`            | `http://localhost:4242`| Reuse a server here instead of booting one                        |
| `--detach`          | off                    | Submit and exit without following (requires a running server)      |
| `--allow-autonomous`| off                    | Skip the human-in-the-loop completion gate                         |
| `--no-webui`        | off                    | Don't serve the web UI when booting a server                       |

#### `--loop` — keep going until verified done

```bash
hooteams work --loop "implement full test coverage for src/auth"
```

`--loop` re-plans and re-runs until the goal is **verified**, not merely attempted. Verification reuses the server's goal validator: after each run the validator judges the goal against every task's output and either passes (a clean settle → done) or reports what's missing. On an unmet verdict, `work` feeds that reason into the next iteration's plan and runs again, up to `--max-iterations` (default 3).

Verification needs a validator. When `work --loop` boots a server it injects a default one if the config sets none; pass `--verify "<prompt>"` to supply your own, or set `validator` in the config. (Against a reused `--host` server, looping relies on that server's configured validator.) `--loop` follows every run, so it can't be combined with `--detach`. Exits non-zero if the goal isn't verified within the iteration cap.

### `hooteams plan`

Run the planner in dry-run mode against a goal: its `spawn_agent` / `delegate_task` calls record a plan instead of starting agents, so the task graph can be inspected (and edited) before anything executes.

```bash
hooteams plan "ship a haiku about software" --out tasks.json
# review tasks.json, then:
hooteams run tasks.json
```

The output file carries `goal`, `roles`, and `tasks`, and `hooteams run` accepts it directly — the server merges the plan's roles into the configured team for that run, and the goal feeds the goal validator (when one is configured). No server needs to be running to plan; credentials resolve the same way as for the server (see Authentication).

| Flag         | Default              | Description                                  |
|--------------|----------------------|----------------------------------------------|
| `--out`      | print to stdout      | Write the plan to this file                  |
| `--model`    | `claude-sonnet-4-5`  | Planner model id                             |
| `--provider` | `anthropic`          | Planner model provider                       |

### `hooteams start`

Start the team server. Spawns all agents defined in the config, opens an HTTP/SSE endpoint, and serves the live web UI from the **same port** — open `http://localhost:4242` in a browser to watch the team work in real time (token streams, tool calls, nudges, DAG progress). Because the UI is served from the same origin as the bridge there's no CORS or host config: it just works on whatever `--port` you choose.

The first `hooteams start` after install builds the web UI once (`tsc + vite build`); subsequent starts reuse the built assets. Pass `--no-webui` to run headless (API only).

```bash
hooteams start --config hooteams.config.json --port 4242
```

| Flag         | Default                 | Description                                     |
|--------------|-------------------------|-------------------------------------------------|
| `--config`   | auto-discovered         | Path to config file. Default: `.agents/teams/team.json` → `hooteams.config.json`; none → empty team |
| `--port`     | `4242`                  | HTTP port for the API/SSE bridge **and** the web UI |
| `--resume`   | off                     | Restore and continue the newest interrupted run from session storage |
| `--no-webui` | off                     | Do not serve the web UI (run API only)          |

Shuts down cleanly on `SIGINT` / `SIGTERM` (aborts agents, closes SSE streams, stops the server).

> The web UI lives in `packages/webui` (`@kolisachint/hooteams-webui`). For UI development run `bun run --filter @kolisachint/hooteams-webui dev` (Vite dev server with HMR) and point it at a running bridge via `VITE_HOOTEAMS_HOST`, or rebuild the bundled assets with `bun run build:webui`.

### `hooteams run`

Start a task-graph run: every task is dispatched to its role's agent once its dependencies finish, up to `maxConcurrent` at a time. The command follows the run's lifecycle on the event stream until the graph settles (`--detach` prints the run id and exits; the run keeps going server-side).

```bash
hooteams run examples/demo-run.json
```

The file holds the task graph (a bare task array works too):

```json
{
  "tasks": [
    { "id": "draft", "role": "coder", "prompt": "Write a haiku about shipping software." },
    { "id": "ship", "role": "planner", "deps": ["draft"], "prompt": "Ask the human for approval, then declare the haiku shipped." }
  ]
}
```

| Task field | Required | Description                                            |
|------------|----------|--------------------------------------------------------|
| `id`       | ✓        | Unique task id                                         |
| `role`     | ✓        | Role from the server config (or the file's `roles`) that executes this task |
| `prompt`   |          | Text that starts the task's run (default: the task id) |
| `deps`     |          | Task ids that must be `done` before this one starts. Their final outputs are appended to this task's prompt, so results chain through the graph |
| `retries`  |          | Extra attempts the task gets after a failed run (default: `0`). When retries are exhausted, the failure is steered to the `planner` agent (if one is configured) for structural recovery |

Top-level file fields besides `tasks`: `goal` (what the run pursues — judged by the goal validator when one is configured) and `roles` (per-run role configs merged into the team, e.g. from `hooteams plan`).

Each task runs on a fresh agent with its own persisted session under `~/.hooteams/sessions`, with the human-in-the-loop protocol appended to its system prompt: an agent that needs a human decision ends its reply with `AWAITING_APPROVAL: <question> | <option1>, <option2>` and the task pauses (releasing its concurrency slot) until someone answers — from this CLI, `hoocode --team`, or the web UI. First answer wins.

### `hooteams pending` / `hooteams resume`

Inspect and answer the active run's approval gates.

```bash
hooteams pending
# ship: Publish the haiku?
#   options: yes, no

hooteams resume ship "yes" --feedback "love it"
```

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

The server reads a team config discovered in this order (an explicit `--config` path always wins and must exist): `.agents/teams/team.json`, then `hooteams.config.json` in the current directory. Both use the same schema below. If none is found, the server starts with an empty team — agents are spawned dynamically by the planner or via the `/steer` API.

When a config defines a team, `hooteams plan`/`work` feed that roster — each role's `category`, model, and one-line brief — to the planner, so it routes tasks to the right existing agent (matching by category tier, e.g. `plan`/`deep`/`quick`) instead of spawning new ones blind.

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
      "cwd": "/path/to/project",                        // working directory for agent tools (default: process.cwd())
      "category": "deep",                               // optional grouping label (cosmetic today)
      "appendSystemPrompt": "Focus on safety.",         // optional appendix after the role prompt
      "skillPaths": ["./skills"]                        // extra skill directories beyond hoocode's defaults
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

  // Directory of project rule files (*.md, searched recursively) injected into
  // every role's system prompt as extra context (default: ".hooteams/rules";
  // a missing directory is ignored). This is hooteams' own rule channel, added
  // after the project context hoocode discovers (AGENTS.md, CLAUDE.md, …).
  "rulesDir": ".hooteams/rules",

  // Server port (can also be set via --port flag or PORT env var)
  "port": 4242,

  // Root directory for run/node session storage (default: ~/.hooteams/sessions)
  "sessionsRoot": "~/.hooteams/sessions",

  // Restore and continue an interrupted run on startup (default: false; also --resume)
  "resumeInterrupted": false,

  // Cross-run shared team memory (default: true). Task outputs are recorded to a
  // project-scoped store at run end, new runs bootstrap from prior ones, and every
  // agent gets the memory_read/memory_write tools. Set false to disable.
  "memory": true,

  // Root directory for the per-project memory stores (default: ~/.hooteams/memory)
  "memoryRoot": "~/.hooteams/memory",

  // Project the memory store is scoped to (default: derived from the server's cwd,
  // so reruns from the same directory share memory)
  "project": "my-app",

  // System prompt for a goal-completion validator (optional). When set, every
  // run that completes cleanly is reviewed by a validator agent (running on
  // defaults.model or the first role's model): it sees the run's goal and every
  // task's output and replies GOAL_MET, or "GOAL_UNMET: <reason> | <taskId>"
  // to send that task back for rework before the run settles.
  "validator": "You are a strict reviewer. Judge whether the team's outputs achieve the goal."
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
| `category`      | `string`   |          |                   | Capability tier (e.g. `plan`, `deep`, `quick`); fed to the planner so it routes tasks by tier    |
| `appendSystemPrompt` | `string` |       |                   | Appendix injected after the role prompt (before project context)                                |
| `promptGuidelines` | `string[]` |      |                   | Extra guideline bullets added to hoocode's tool-aware guidelines                                 |
| `skillPaths`    | `string[]` |          |                   | Extra skill directories beyond hoocode's defaults                                                |

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

The server exposes an HTTP API that any client (CLI, the web UI, curl) can use.

| Route                   | Method | Description                                                            |
|-------------------------|--------|------------------------------------------------------------------------|
| `/events`               | GET    | SSE stream of all agents (replay + live)                               |
| `/events/:role`         | GET    | SSE stream of one agent; `?replay=N` limits replayed history           |
| `/steer`                | POST   | `{ "role": "coder", "message": "…" }` — queue a mid-run steering message |
| `/runs`                 | POST   | `{ "tasks": [{ id, role, prompt?, deps?, retries? }], "goal"?, "roles"? }` → `202 { runId }`; `409` while a run is active; `400` on unknown roles or cyclic deps |
| `/tasks/pending`        | GET    | `{ runId, pending: [{ taskId, question, options }] }` — open approval gates |
| `/tasks/:taskId/resume` | POST   | `{ "option": "yes", "feedback": "…" }` — answer a gate; `409` if another surface answered first |
| `/trace`                | GET    | Audit trail of the active run (tasks, timings, approvals)              |
| `/runs/:runId/trace`    | GET    | Audit trail for one run id                                             |
| `/status`               | GET    | `{ [role]: { status, lastEventType } }`                                |
| `/health`               | GET    | `{ "ok": true }`                                                      |
| `/stop`                 | POST   | Graceful shutdown (abort agents, close streams)                        |

All endpoints return JSON (except `/events` which returns SSE). CORS is enabled for all origins. The run/HITL routes respond `404` while no run is attached.

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

# Start a task-graph run
curl -X POST http://localhost:4242/runs \
  -H "Content-Type: application/json" \
  -d '{"tasks": [{"id": "deploy", "role": "ops", "prompt": "deploy the app"}]}'

# See which tasks are paused on an approval gate, and answer one
curl http://localhost:4242/tasks/pending
curl -X POST http://localhost:4242/tasks/deploy/resume \
  -H "Content-Type: application/json" \
  -d '{"option": "yes"}'

# Audit a run
curl http://localhost:4242/trace

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
| `taskId`        | `string`  |          | Register the task under this id in the team's task DAG          |
| `deps`          | `string[]`|          | Task ids whose results this agent's task needs                  |
| `retries`       | `number`  |          | Extra attempts the task gets if its run fails                   |
| `defaultTools`  | `boolean` |          | Give the agent built-in coding tools                            |
| `mcpConfigPath` | `string`  |          | Path to `mcp.json` for MCP server tools                        |
| `cwd`           | `string`  |          | Working directory for the agent's tools                         |

This means you can start with just a planner and let it assemble the right team for the goal. In dry-run mode (`hooteams plan`, or `new Planner({ dryRun: true })`) the same tools write to a plan buffer instead, producing an inspectable task graph without executing anything.

---

## Inter-agent messaging

Agents collaborate through two tools with different blocking semantics:

| Tool            | Pattern            | Behavior                                                                 |
|-----------------|--------------------|--------------------------------------------------------------------------|
| `delegate_task` | fire-and-forget    | Steers the task into the target agent and returns immediately            |
| `ask_agent`     | request-response   | Steers the question into the target agent and **blocks** until the target's next completed run, returning its final reply text |

`ask_agent(role, question, timeoutSeconds?)` enables genuinely collaborative reasoning — e.g. a `coder` asking a `security-auditor` "is this approach safe?" mid-task and having the answer in hand before continuing. Asking your own role is rejected (the answer could never arrive while the asking run blocks), unknown roles fail with the available roles listed, and the wait is bounded by `timeoutSeconds` (default 120).

Both tools are available to the live planner, to every task-run agent (the `TeamOrchestrator` node harnesses), and to config-spawned team members. Embedders can call the underlying promise directly: `askAgent(team, role, question, timeoutMs)` from `@kolisachint/hooteams-orchestrator`.

---

## Shared team memory

`TeamMemory` is a knowledge store scoped to a **project, not a run**: one JSON file per project under `~/.hooteams/memory`, shared by every agent and surviving across runs. It is on by default (disable with `"memory": false` in the config) and closes the loop in three places:

1. **Agents read and write it via tools.** Every agent gets `memory_read(query)` (token search over keys, values, and tags, recency-ranked) and `memory_write(key, value, tags?)`. Entries are stamped with the writing run/role for provenance.
2. **Task outputs are auto-recorded at run end.** When a run settles, the orchestrator writes each completed task's final output under `run/<runId>/<taskId>`, tagged with the role and status — no agent cooperation required.
3. **New runs bootstrap from prior runs.** The most recent entries are injected into the prompts of a run's root tasks (tasks with no dependencies), so a team that runs twice on the same project starts the second run knowing what the first one learned.

This is what makes a team that learns across goals instead of executing one-shot: decisions, conventions, and results persist in `~/.hooteams/memory/<project>.json` (configurable via `memoryRoot`/`project`), with writes serialized and saved atomically so concurrent agents never corrupt the store.

Programmatic use:

```ts
import { TeamMemory, createMemoryReadTool, createMemoryWriteTool } from "@kolisachint/hooteams-orchestrator";

const memory = new TeamMemory({ project: "my-app" });
await memory.write("auth/approach", "JWT with refresh rotation", { tags: ["auth", "decision"] });
const matches = await memory.read("auth");
const context = await memory.bootstrapContext(); // digest for a new run's prompts
```

---

## Architecture notes

- The orchestrator imports `@kolisachint/hoocode-agent-core` (the `Agent` class). hoocode never imports hooteams.
- `TeamChannel` wraps every agent's `subscribe()`, tags each `AgentEvent` with `{ role, agentId, ts }`, and keeps a 100-event ring buffer per agent so late subscribers replay what they missed.
- The bridge serializer strips accumulated state from streaming events (`message_update` carries only the delta) — clients accumulate buffers themselves.
- The web UI (`packages/webui`) re-declares the wire types instead of importing the orchestrator — it only depends on the SSE/HTTP wire format, so the contract stays decoupled from the server internals.

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

The dependency stack is strictly layered — `dag ← orchestrator ← bridge ← server ← cli` — with each package depending only on those below it.

| Package                            | Path                    | Description                                    |
|------------------------------------|-------------------------|------------------------------------------------|
| `@kolisachint/hooteams-dag`          | `packages/dag`          | Dependency-free task DAG + node types           |
| `@kolisachint/hooteams-orchestrator` | `packages/orchestrator` | Team, TeamChannel, TeamOrchestrator, Planner, agent registry |
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
