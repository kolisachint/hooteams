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

### Start the team server

```bash
bun run apps/cli/src/index.ts start --config hooteams.config.json --port 4242
```

`hooteams.config.json`:

```json
{
  "team": [
    { "role": "planner", "model": "claude-sonnet-4-5", "systemPrompt": "You are the planner…" },
    { "role": "coder",   "model": "claude-sonnet-4-5", "systemPrompt": "You are the coder…" }
  ],
  "maxConcurrent": 3
}
```

### Attach a terminal to a running agent

Like `tmux attach` — replays the last events (default 100), then follows live:

```bash
bun run apps/cli/src/index.ts attach coder
bun run apps/cli/src/index.ts attach planner --replay 50
```

While attached: press **n** to type a nudge (injected mid-run via steering), **q** to detach without stopping the agent.

### Nudge an agent from anywhere

```bash
bun run apps/cli/src/index.ts nudge coder "skip auth tests, focus on unit tests only"
```

### Status and shutdown

```bash
bun run apps/cli/src/index.ts status
bun run apps/cli/src/index.ts stop
```

## HTTP API

| Route | Method | Description |
|---|---|---|
| `/events` | GET | SSE stream of all agents (replay + live) |
| `/events/:role` | GET | SSE stream of one agent; `?replay=N` limits replayed history |
| `/steer` | POST | `{ "role": "coder", "message": "…" }` — queue a mid-run steering message |
| `/status` | GET | `{ [role]: { status, lastEventType } }` |
| `/health` | GET | `{ "ok": true }` |
| `/stop` | POST | graceful shutdown (abort agents, close streams) |

## Architecture notes

- The orchestrator imports `@kolisachint/hoocode-agent-core` (the `Agent` class). hoocode never imports hooteams.
- `TeamChannel` wraps every agent's `subscribe()`, tags each `AgentEvent` with `{ role, agentId, ts }`, and keeps a 100-event ring buffer per agent so late subscribers replay what they missed.
- The bridge serializer strips accumulated state from streaming events (`message_update` carries only the delta) — clients accumulate buffers themselves.
- hoocanvas has no npm dependency on this repo; it only knows the SSE wire format.
