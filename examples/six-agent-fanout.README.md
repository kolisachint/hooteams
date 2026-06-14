# Six-agent fan-out / fan-in run plan

`six-agent-fanout.json` is a `{goal, roles, tasks}` document for `hooteams run`. It
instantiates a fan-out/fan-in team using only existing primitives — no orchestrator
changes.

```
contract ─┬─→ storage  ─┐
(lead)    ├─→ shorten  ─┤
          ├─→ redirect ─┼─→ integrate ──→ [global validator]
          └─→ tests    ─┘    (gate here)     (server-level)
```

- **Topology:** one `lead` writes a build contract; four workers build against it in
  parallel (each `deps: ["contract"]`); `integrator` fans them in.
- **Gate at merges:** only `integrator` emits the `AWAITING_APPROVAL` marker, so the
  single human gate fires at the merge.
- **Validation:** one global goal-validator runs after `integrate` settles.

## Required server config

This plan only behaves as designed when the server runs with these in
`hooteams.config.json`:

```jsonc
{
  "allowAutonomous": true,   // gate fires ONLY at the integrator's marker;
                             // false (default) gates every task instead
  "validator": "You are the goal validator. Judge whether the URL shortener goal was actually achieved from the task outputs. When it was not, name the integrator task to re-run (see caveat below).",
  "memory": true             // on by default; powers the coordination board
}
```

Then: `hooteams run examples/six-agent-fanout.json`.

## Coordination board (shared task list + conflict list)

The shared `TeamMemory` (`memory_read`/`memory_write`) is the primary coordination
channel — reliable, asynchronous, and it survives after an agent finishes. (Live
siblings can also `ask_agent` each other directly; see caveat 1.)

- The `lead` mints a short board id in the contract; workers prefix all keys with
  `board/<id>/`.
- **Task list:** each worker writes only its own `board/<id>/task/<task>` key
  (single writer per key — safe under concurrency).
- **Conflict list:** any worker registers `board/<id>/conflict/<slug>`; the
  `integrator` is the sole resolver and writes `.../resolution`.

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

2. **Messaging only reaches *concurrently-live* peers.** **[By design]** A settled node
   is released and is no longer addressable — workers can't ask the finished `lead`,
   and the `integrator` can't ask the finished workers. Cross-phase coordination uses
   the memory board instead. (Registration deliberately skips `channel.attach`, since
   the orchestrator already mirrors node events — attaching would double-publish.)

3. **`ask_agent` resolves on the target's *next* `agent_end`.** **[Open]** If the
   target is busy on its own task, that task's `agent_end` can resolve the question
   with the wrong content. Inherent to the existing `ask_agent` design; prefer the
   memory board when timing matters.

4. **`allowAutonomous` is run-wide, not per-task.** **[Mitigated]** "Gate at merges"
   only works with `allowAutonomous: true` (config) plus an `AWAITING_APPROVAL` marker
   in the integrator prompt alone. With the default `false`, a completion gate fires on
   *every* task. See "Required server config".

5. **Memory is project-scoped, not run-scoped.** **[Mitigated]** Coordination keys can
   collide across runs and leak into the next run's bootstrap context. Handled by the
   per-run `board/<id>/` namespace and an "ignore prior-run board entries" instruction
   in the lead prompt.

6. **Concurrent memory writes can lose updates.** **[Mitigated]** `memory_write` is a
   whole-value, last-writer-wins upsert per key. The board uses one key per item with a
   single writer (each worker writes only its own `task/` key; the integrator owns
   `resolution` keys), so parallel writes never clobber each other.

7. **Validator rework is non-cascading.** **[Mitigated]** `dag.resetToIdle` resets only
   the named node, so bouncing an upstream worker would leave `integrate` stale. The
   validator prompt aims rework at the **integrator**; deep correctness rests on the
   integrator's tests passing before its gate.

8. **The integrator approval gate can loop.** **[Mitigated]** On resume the chosen
   option is just steered back, so a re-emitted marker would re-gate forever. The
   prompt finalizes on `ship` without re-emitting the marker, and only re-gates after a
   `revise`.

9. **Pure fan-out leaves siblings blind to each other.** **[Mitigated]** Workers build
   against a frozen contract and can't see each other's code until `integrate`. The
   shared task list + conflict list give them a coordination surface during the
   parallel phase; the integrator backstops anything missed.
