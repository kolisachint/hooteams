# Six-agent fan-out / fan-in run plan

`six-agent-fanout.json` is a `{goal, roles, tasks}` document for `hooteams run`. It
instantiates a fan-out/fan-in team. The design review behind it drove a set of
orchestrator hardening changes (peer messaging, the coordination board, per-task gates,
cascading rework) — see "Issues identified in review" at the bottom.

```
contract ─┬─→ storage  ─┐
(lead)    ├─→ shorten  ─┤
          ├─→ redirect ─┼─→ integrate ──→ [global validator]
          └─→ tests    ─┘    (gate here)     (server-level)
```

- **Topology:** one `lead` writes a build contract; four workers build against it in
  parallel (each `deps: ["contract"]`); `integrator` fans them in.
- **Gate at merges:** only the `integrate` task sets `gate: true`, so the single
  human approval gate (structured approve/revise) fires at the merge.
- **Validation:** one global goal-validator runs after `integrate` settles.

## Required server config

This plan only behaves as designed when the server runs with these in
`hooteams.config.json`:

```jsonc
{
  "allowAutonomous": true,   // run default = no gate; the integrate task opts in
                             // with "gate": true, so only the merge gates
  "validator": "You are the goal validator. Judge whether the URL shortener goal was actually achieved from the task outputs. When it was not, name the single task whose work is wrong to re-run — its dependents re-run automatically.",
  "memory": true             // on by default; powers the coordination board
}
```

Then: `hooteams run examples/six-agent-fanout.json`. The gate is per-task: `gate: true`
forces an approval gate on a task even in an autonomous run, `gate: false` skips it even
in an HITL run, and unset follows `allowAutonomous`.

## Coordination board (shared task list + conflict list)

Agents on a run share a **run-scoped coordination board** via the `board_read` /
`board_write` / `board_append` tools (keys live under `board/<runId>/` and are tagged
so they never leak into a later run's bootstrap). It is the primary coordination
channel — reliable, asynchronous, and it survives after an agent finishes. (Live
siblings can also `ask_agent` each other directly; see issue 2.)

- **Task list:** each worker `board_write`s only its own `task/<task>` key (single
  writer per key).
- **Conflict list:** any worker `board_append`s to the shared `conflicts` list —
  `board_append` is an atomic read-modify-write, so concurrent workers never clobber
  each other's items. The `integrator` resolves them and appends resolutions back.

## Issues identified in review

Reviewing this design against the orchestrator surfaced the following. Each is tagged
with its disposition: **[Fixed]** (code changed), **[Mitigated]** (handled in the plan
/ prompts / config), **[By design]** (an accepted property to work within), or
**[Open]** (a known limitation, not addressed here).

1. **Peer messaging didn't reach DAG nodes.** **[Fixed]** `ask_agent`/`delegate_task`
   routed only to `Team`-spawned agents; orchestrator nodes (built by
   `createNodeHarnessFactory`) were never registered, so in a `hooteams run` path every
   call threw `No agent for role`. Nodes are now registered via `Team.adopt` on
   dispatch and released via `NodeHandle.dispose` on settle.

2. **Messaging only reaches *concurrently-live* peers.** **[Fixed — opt-in]** By default a
   settled node is released and unaddressable, so cross-phase coordination uses the memory
   board. A node marked `advisor: true` instead keeps its agent live and adopted until the
   run ends, so later-phase nodes can `ask_agent` it across phases (e.g. a schema owner
   answering implementers mid-build — see `negotiation-team.json`). Released at run finish;
   restored runs don't rehydrate live advisors. (Registration skips `channel.attach`, since
   the orchestrator already mirrors node events — attaching would double-publish.)

3. **`ask_agent` resolves on the target's *next* `agent_end`.** **[Open]** If the
   target is busy on its own task, that task's `agent_end` can resolve the question
   with the wrong content. Inherent to the existing `ask_agent` design; prefer the
   memory board when timing matters.

4. **`allowAutonomous` is run-wide, not per-task.** **[Fixed]** A task can now set
   `gate: true`/`false` to override the run default (`TaskNode.gate` → `shouldGate`), so
   "gate at merges" is just `gate: true` on the `integrate` task — no global flag
   juggling and no per-prompt convention. `allowAutonomous` is only the fallback.

5. **Memory is project-scoped, not run-scoped.** **[Fixed]** The `board_*` tools write
   under a per-run `board/<runId>/` namespace (so runs can't collide) and tag entries
   `board`, which `bootstrapContext` now excludes (so a run's transient task/conflict
   notes never leak into a later run's prompts). No manual board id needed.

6. **Concurrent memory writes can lose updates.** **[Fixed]** `memory_write` is still a
   whole-value upsert, but `TeamMemory.append` (behind `board_append`) does its
   read-modify-write inside the store's serialized chain, so many agents can append to
   one shared list (`conflicts`) without clobbering each other.

7. **Validator rework is non-cascading.** **[Fixed]** When the validator bounces a node,
   the orchestrator now resets its already-done transitive dependents to idle too
   (`TaskDag.dependentsOf` + `reworkWithDependents`), so e.g. bouncing a worker re-runs
   the `integrator` against the corrected work instead of leaving it stale. The dag
   keeps dependents blocked until the reworked node completes, preserving order.

8. **The integrator approval gate can loop.** **[Fixed]** Using `gate: true` routes the
   integrator through the orchestrator's *structural* completion gate
   (`resolveCompletionGate`): `approve` settles it directly, `revise` re-prompts with
   feedback and re-gates. No `AWAITING_APPROVAL` marker, so there is no re-emission loop
   to manage in the prompt.

9. **Pure fan-out leaves siblings blind to each other.** **[Mitigated]** Workers build
   against a frozen contract and can't see each other's code until `integrate`. The
   shared task list + conflict list give them a coordination surface during the
   parallel phase; the integrator backstops anything missed.
