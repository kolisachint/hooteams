# AGENTS.md

Operating guide for AI/code agents (and humans) working in **hooteams**. Read this
first — it exists to make *adding a feature* or *updating the UI* low-friction by
documenting the architecture, the data flow, the conventions, and the exact
end-to-end recipes for the most common changes.

---

## 1. What this repo is

Multi-agent team orchestration on top of [hoocode](https://github.com/kolisachint/hoocode)
agents, plus an SSE bridge that streams the live team event stream to any client
(the `hooteams` CLI, the built-in web UI, or any consumer of the wire format).

Everything speaks **one wire format**:

```
TeamEvent = AgentEvent & { role, agentId, ts }   // + synthetic team/dag events
```

One JSON object per SSE `data:` line. Keep this contract sacred — it is the seam
every consumer depends on.

---

## 2. Layout

```
packages/
  dag/            dependency-free task DAG: topological order, ready/blocked, immutable snapshots
  orchestrator/   team execution, planner, agent registry, tagged event channel, TeamOrchestrator
  bridge/         SSE fan-out, wire serializer, HTTP routes (Bun-native router)
  webui/          live mission control (React 19 + Vite + Tailwind v4 + zustand)
apps/
  server/         Bun.serve() entry: orchestrator → bridge → HTTP → web UI
  cli/            hooteams start / run / attach / nudge / status / stop
examples/         runnable task graphs (*.json) + verify scripts
docs/             feature notes (e.g. hitl-gates.md)
```

Bun **workspaces** (`packages/*`, `apps/*`). Internal deps are published as
`@kolisachint/hooteams-*` and symlinked through `node_modules`.

---

## 3. The data flow (memorize this)

The single most useful mental model. A change to live UI almost always touches a
contiguous slice of this pipeline:

```
TeamOrchestrator.publish(event)          packages/orchestrator/src/team-orchestrator.ts
        │  (also persist(...) → session JSONL for replay)
        ▼
TeamChannel  (tag + ring-buffer per role) packages/orchestrator/src/channel.ts
        ▼
SSEBridge + serializer (toWire)           packages/bridge/src/{sse,serializer}.ts
        ▼   GET /events  (SSE)
stream.ts  (EventSource → dispatch)       packages/webui/src/lib/stream.ts
        ▼
store.ts  (zustand reducer)               packages/webui/src/lib/store.ts
        ▼
React components                          packages/webui/src/components/*
```

Two parallel sinks from the orchestrator:
- **Live:** `publish()` → channel → SSE → web UI (ephemeral, real-time).
- **Replay:** `persist(customType, data)` → session JSONL → `GET /sessions/:runId`
  → `lib/session.ts` parser → the same `DagViewer`. This is "session mode"
  (`?runId=…` in the URL).

> Rule of thumb: if a new signal must show up **live**, add it to the `publish`
> path *and* (usually) the `persist` path so replay stays faithful.

---

## 4. Wire-format rules (do not break consumers)

- The `TeamEvent` union lives in `packages/orchestrator/src/types.ts`. **Extend it
  additively only** — hoocanvas, hoocode `--team`, and the CLI consume it by shape
  over SSE. Never rename/remove/retype an existing variant.
- Run-level events (`dag_snapshot`, `dag_complete`, `dag_failed`) use
  `role: "orchestrator"`. The web store must route these to run/DAG state and
  **must not** create an agent card for `"orchestrator"`.
- The bridge serializer (`packages/bridge/src/serializer.ts`) passes unknown event
  types through its `default` case, scrubbed by `safeStringify`. New simple events
  need **no serializer change**; only `message_update` / `tool_execution_update`
  have special slimming.
- The web UI **re-declares** wire types in `packages/webui/src/lib/types.ts` on
  purpose (no build dependency on the orchestrator). When you add an orchestrator
  event you intend to render, mirror its shape there too.

---

## 5. Commands

```bash
bun install              # install + link workspaces + global `hooteams` bin
bun test                 # full suite (bun:test)
bun run check            # tsc --noEmit across the repo  (also the pre-commit hook)
bun run build:webui      # build the web UI bundle served by `hooteams start`

# Web UI iteration (hot reload against a running bridge):
cd packages/webui && bun run dev          # vite dev server
cd packages/webui && bun run check        # biome (lint+format, --error-on-warnings) + tsc

# Run the product end-to-end:
hooteams start --config hooteams.config.json   # server + live web UI on :4242
hooteams run examples/six-agent-fanout.json    # drive a task graph
```

Point a standalone `vite dev` UI at a remote bridge with
`VITE_HOOTEAMS_HOST=http://host:4242`. When served by `hooteams start`, the UI is
same-origin, so `/events` resolves with no CORS and no port config.

---

## 6. Conventions

- **Commits:** Conventional Commits enforced by the `commit-msg` hook
  (`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`). Scope optional.
- **Pre-commit:** `bun run check` must pass (no type errors).
- **Style:** match surrounding code. Tabs for indentation. The web UI is formatted
  by **Biome** (`biome.json`); run `bun run check` in `packages/webui` before
  committing UI changes — it errors on warnings.
- **Comments:** the codebase favors dense, intent-explaining doc comments on
  exported types/functions. Keep that bar; explain *why*, not *what*.
- **Tests:** add/extend `bun:test` files next to the package under test
  (`packages/*/test/*.test.ts`). Run after every logical unit of change.

---

## 7. Web UI design system (paper & ink)

Defined as CSS variables in `packages/webui/src/index.css`. Use the variables —
never hardcode hex (except the semantic status colors already centralized in the
components). Key tokens:

```
--bg #09090b   --panel #101013   --panel-raised #18181b
--text #e4e4e7 --text-dim #a1a1aa --text-faint #71717a
--cyan #00f0ff (accent)  --cyan-dim (selection/glow)
--line / --line-bright (borders)
```

Status palette (centralized in `components/DagViewer.tsx`):
`done #6FA98A · error #D9788A · retrying/gate #D6A84F · running var(--cyan)`.

Visual conventions: 4px radii, 6px status dots, 10px uppercase eyebrows with
`0.12em` letter-spacing, JetBrains Mono for code/labels. Reuse `AgentCard`,
`ToolChip`, `ThinkingBlock`, `TokenStream`, `DagViewer` rather than re-styling.

---

## 8. Recipe: add a new **live UI signal** (end to end)

This is the highest-frequency UI task. Example: surfacing the live task graph in
the stream view followed this exact path.

1. **Orchestrator type** — add an interface to `packages/orchestrator/src/types.ts`
   and append it to the `TeamEvent` union (additive only). Run-level → `role: "orchestrator"`.
2. **Emit it** — `this.publish({ type: …, role, agentId, ts, … })` from
   `packages/orchestrator/src/team-orchestrator.ts`. If it should survive reloads,
   also `this.persist("…", …)` and parse it in `packages/webui/src/lib/session.ts`.
3. **Bridge** — usually nothing (the `default` serializer case handles it). Only
   touch `serializer.ts` if the payload needs slimming.
4. **Web wire type** — mirror the shape into `packages/webui/src/lib/types.ts`.
5. **Reduce it** — handle the new type in `packages/webui/src/lib/store.ts`. Keep
   `"orchestrator"`-role events out of the `agents` map.
6. **Render it** — add/extend a component in `packages/webui/src/components/` and
   mount it in `packages/webui/src/app.tsx`.
7. **Test** — assert the broadcast in `packages/orchestrator/test/team-orchestrator.test.ts`
   (subscribe to a `TeamChannel`, run a `TeamOrchestrator`, filter events).
8. **Verify** — `bun test`, `bun run check`, `bun run build:webui`.

## 9. Recipe: add a **CLI command**

Add the handler in `apps/cli/src/commands.ts`, wire arg parsing/dispatch in
`apps/cli/src/index.ts`, document it in the usage block and `README.md`. CLI talks
to the server over the same HTTP routes the web UI uses (`/events`, `/steer`,
`/runs`, `/status`, …).

## 10. Recipe: add an **HTTP route**

Add it to the Bun-native router in `packages/bridge/src/router.ts`, then register
the path in `apps/server/src/server.ts` `isApiPath()` so it isn't swallowed by the
web-UI fallthrough. Keep CORS headers consistent with existing routes.

## 11. Recipe: add a **team/agent capability**

New per-agent tools, memory, or collaboration features live in
`packages/orchestrator/src/` (see `team.ts`, `channel.ts`, `memory.ts`,
`node-harness.ts`, `team-tools.ts`). Role/config shapes are in `types.ts`
(`RoleConfig`, `TeamConfig`) and `hooteams.config.json`.

---

## 12. Gotchas

- The channel only ring-buffers events for **attached roles**. Run-level
  `"orchestrator"` events are **not** replayed to late subscribers (page reloads);
  state recovers on the next snapshot. Prefer periodic/idempotent snapshots over
  one-shot run-level events when reload-survival matters.
- SSE connections are long-lived; the server sets `idleTimeout: 0`. Don't add code
  that assumes request/response completion on `/events`.
- The web UI has **no build dependency** on orchestrator packages — keep wire types
  duplicated, not imported.
- Session files are JSONL of `{ type: "custom", customType, data }`; the parser in
  `lib/session.ts` is the source of truth for replay shapes.

---

## 13. Definition of done

- [ ] `bun test` green (new behavior covered by a test).
- [ ] `bun run check` clean.
- [ ] `bun run build:webui` succeeds (for UI changes) + `packages/webui` biome check.
- [ ] Wire changes are additive; replay (`?runId=…`) still renders.
- [ ] Conventional Commit message.
