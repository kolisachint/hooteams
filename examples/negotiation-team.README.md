# Negotiation-first team on hooteams (no engine changes)

This shows that hooteams **already supports** a negotiation-first six-agent team —
where the task graph behaves like a living contract that adapts when agents detect
cross-layer conflicts — using only existing primitives. Nothing was added to the engine
to make this work.

- `negotiation-team.json` — a runnable `{goal, roles, tasks}` plan (`hooteams run`).
- `negotiation-team.verify.ts` — a credential-free proof you can run yourself:
  `bun run examples/negotiation-team.verify.ts`. It drives the real `TeamOrchestrator`
  + `TaskDag` + `TeamMemory` through a contract conflict and resolution and asserts the
  loop converges.

## The one reframe that makes it work

The negotiation spec wants the graph to *mutate itself* mid-run (pause branches, insert
validators, reassign owners). Those are exactly the operations our design review flagged
as deadlock/live-mutation hazards. hooteams gets the **same behavior** a safe way:

> **The graph doesn't mutate. It re-runs.** The "contract" is a **versioned Blueprint
> stored on the shared board**; a **validator** (BridgeAgent) checks contract
> compatibility at the end of each pass and, on conflict, bounces the shared `blueprint`
> node, whose **cascading rework** re-runs every implementation branch against the
> revised Blueprint. Repeat until it passes.

## Agent → primitive mapping

| Spec agent | Realized as | Primitive |
|---|---|---|
| **SpecAgent** | `scope` node (root) | board: Scope Lock / NCs |
| **ArchAgent** | `blueprint` node | board: owns the `blueprint` key, versioned |
| **BridgeAgent** | the **run validator** | verdict bounces `blueprint`; cascade re-runs branches |
| **BackendAgent** | `backend` node (deps: blueprint) | defaultTools + board + `ask_agent` |
| **FrontendAgent** | `frontend` node (deps: blueprint) | same |
| **QAAgent** | `qa` node (deps: blueprint), test-first | board |

```
scope ─→ blueprint ─┬─→ backend  ─┐
(Spec)   (Arch)     ├─→ frontend ─┼─→ integrate (gate: true)
                    └─→ qa       ─┘        │
                                    Bridge = validator
                             conflict → bounce blueprint → cascade re-run
```

## Every GraphOp from the spec, realized safely

| Spec GraphOp | Hazard avoided | How hooteams does it |
|---|---|---|
| `CONTRACT_CHANGE` / `CONTRACT_CONFLICT` | — | An impl agent `board_append`s the conflict; the Bridge validator detects it |
| `PAUSE_BRANCH` | pauseSubtree **deadlock** | Don't pause — the validator **bounces + cascades**, resetting the branches |
| `INSERT_VALIDATION` | insertAfter **live mutation** | The validation checkpoint (Bridge) is authored up front; it runs every pass |
| `COMMIT_BLUEPRINT(vN)` | — | ArchAgent re-runs, `board_write`s the next blueprint version; deps read it |
| `REORDER_NEGOTIATION` | — | Bounce `scope` (SpecAgent) → cascade re-runs the whole graph |
| `REASSIGN_OWNER` | reassignRole | **Not supported** — out of scope (and avoidable: re-plan / spawn another role) |

How a conflict travels (one pass):
1. ArchAgent publishes `blueprint` v1 to the board.
2. BackendAgent reads it, finds a field missing, `board_append`s a `conflict/*` entry
   (CONTRACT_CHANGE) instead of adapting silently.
3. The pass completes; **BridgeAgent (validator)** sees an unresolved conflict and
   returns `GOAL_UNMET: … | blueprint`.
4. The orchestrator bounces `blueprint`; **cascading rework** resets `backend`,
   `frontend`, `qa`, `integrate` to idle.
5. ArchAgent re-runs, reads the conflicts, publishes `blueprint` **v2** + a
   `resolution/*` entry (COMMIT_BLUEPRINT).
6. The branches re-run against v2; the conflict is resolved; Bridge returns `GOAL_MET`;
   the gated `integrate` settles.

## Required server config (`hooteams.config.json`)

```jsonc
{
  "allowAutonomous": true,   // run default = no gate; integrate opts in with gate:true
  "memory": true,            // on by default; powers the board / Blueprint
  "validator": "You are BridgeAgent, the cross-layer contract validator. Read the task outputs and judge whether the backend and frontend data contracts are compatible and every conflict has a resolution. If any conflict is unresolved, reply GOAL_UNMET: <reason> | blueprint. Otherwise GOAL_MET."
}
```

Then: `hooteams run examples/negotiation-team.json`.

## What this does NOT give you (would need engine work)

- **Synchronous mid-pass negotiation.** Here agents negotiate *between* passes (raise on
  the board, resolve on re-run). Letting BackendAgent block on a live ArchAgent *during*
  a pass needs the "advisor roles" change (an agent that stays live after its task
  settles). The batch loop above needs none of that.
- **Instant branch freeze.** A branch finishes its current pass before being reset — same
  convergence, coarser timing than a true `PAUSE_BRANCH`.
- **`REASSIGN_OWNER`** load-balancing.

## Verify it yourself

```
bun run examples/negotiation-team.verify.ts
```

Drives the real engine (no API keys) and prints the negotiation transcript, the final
board, and five PASS checks: the run completes, `blueprint` and `backend` re-run on the
cascade, the blueprint converges to v2, and the integrate gate fires and is approved.
