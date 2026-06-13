# Human-in-the-loop (HITL) gates

hooteams can pause an agent and wait for a human to make a decision before the
run continues. A paused task surfaces over the wire as a `task_paused`
`TeamEvent` and is answered with `POST /tasks/:taskId/resume` — the same
contract hoocode's AskOptions pane and hoocanvas already consume. This document
describes the gate mechanisms and the `--allow-autonomous` switch.

## Gate mechanisms

There are three ways a task can pause. All of them reuse one machinery
(`ApprovalRegistry` + `openGate()` + `task_paused`/`task_resumed` events), so
every consumer renders them identically.

### 1. Marker gate (agent-driven, mid-session)

The agent ends a reply with one line in exactly this form and stops:

```
AWAITING_APPROVAL: <question> | <option 1>, <option 2>
```

`onHarnessEvent` matches `APPROVAL_MARKER` on `message_end`, calls
`pauseNode()`, frees the node's concurrency slot, and resumes by re-prompting /
steering the agent with the chosen option once answered.

This is **model-dependent**: the agent only pauses if it chooses to emit the
marker, and small/free models often never do. It is appended to every node
agent's system prompt via `HITL_SYSTEM_PROMPT` (`node-harness.ts`).

### 2. Completion gate (deterministic, end-of-task)

When HITL is active, the orchestrator opens a gate **before a node settles
`done`**, independent of anything the model emits:

```
Review the output of "<taskId>" before it is marked done.
Options: approve, revise
```

- `approve` → the node settles `done`.
- `revise` (optionally followed by feedback on later lines) → the live
  `ActiveNode` is re-prompted with the feedback; when it settles again the
  completion gate re-opens, so a human can iterate until satisfied.

Failed runs settle as `error` directly and never open a completion gate.

### 3. Tool-approval gate (deterministic, mid-session) — _planned, not yet built_

agent-core's `AgentHarness` exposes `harness.on("tool_call", handler)` (backed
by `agent.beforeToolCall`), an async hook that can `{ block, reason }` a tool
call. A planned tool-approval gate registers this hook in
`createNodeHarnessFactory` so that, for a **configurable list of tools (default
empty = off)**, the agent pauses before running the tool:

```
Allow <role> to run <tool>? Options: allow, deny
```

`deny` returns `{ block: true, reason: <feedback> }`, so the agent receives an
error tool result and adapts. Open question to settle at build time: whether a
node holds its concurrency slot while a tool gate waits (simplest: yes, since
the run stays alive — unlike the marker/completion gates which release it).

## The `--allow-autonomous` switch

| Layer | Default | Notes |
| --- | --- | --- |
| `TeamOrchestratorOptions.allowAutonomous` | `true` (autonomous) | Library default is backward-compatible: no enforced gates unless asked. Existing orchestrator/server tests rely on this. |
| `hooteams start` (server/CLI) | `false` (HITL active) | The product default is human-in-the-loop. The completion gate is on unless `--allow-autonomous`. |

Resolution order (first defined wins):

```
CLI --allow-autonomous  >  hooteams.config.json "allowAutonomous"  >  server default (HITL active)
```

- `hooteams start` → completion gate active for every task.
- `hooteams start --allow-autonomous` → no enforced gates; only the agent's own
  marker gate can pause a task.
- `"allowAutonomous": true` in the config file → same as the flag, persisted.

The marker gate (mechanism 1) is **always** available regardless of this switch
— `--allow-autonomous` only disables the orchestrator-enforced gates (2 and,
when built, 3).

## Wire contract (unchanged)

```
task_paused   { taskId, role, agentId, question, options, ts }
task_resumed  { taskId, role, agentId, chosenOption, ts }
POST /tasks/:taskId/resume { option, feedback? } -> { ok, taskId }
GET  /tasks/pending -> { runId, pending: [{ taskId, question, options }] }
```

`approval_request` entries persist a `kind` field (`"marker"` | `"completion"`)
so `restoreFromSession()` re-opens a crashed run's gate with the right
resume semantics.

## Slot accounting

- Marker gate and completion gate **release** the node's slot while waiting
  (`slotsInUse--` in `openGate`), so other ready nodes can run meanwhile. The
  slot is reclaimed by `fill()` on `revise`/resume; an `approve` settles with
  `holdsSlot: false` so the slot is not double-freed.
- A tool-approval gate (when built) keeps the run alive and therefore holds its
  slot.
