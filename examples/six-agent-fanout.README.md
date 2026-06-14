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

## Caveats found in review (read before relying on this)

1. **`ask_agent` / `delegate_task` reach only *concurrently-live* peers.** The
   factory now registers each node as a messaging target (`Team.adopt`) on dispatch
   and releases it on settle, so siblings running at the same time (the four workers)
   can message each other. But a node that has finished is released and is no longer
   addressable — so the workers cannot ask the `lead` (already done), and the
   `integrator` cannot ask the workers (all done by then). Those cross-phase cases use
   the memory board. Also note `ask_agent` resolves on the target's *next* `agent_end`,
   which can race the target's own task — prefer the board when timing matters.
2. **Memory is project-scoped, not run-scoped.** Coordination keys can collide across
   runs and leak into the next run's bootstrap context. Mitigated by the per-run
   `board/<id>/` namespace and a "ignore prior-run board entries" instruction in the
   lead prompt.
3. **Validator rework is non-cascading** (`dag.resetToIdle` resets only the named
   node). Bouncing an upstream worker would leave `integrate` stale, so the validator
   prompt aims rework at the **integrator**; deep correctness rests on the integrator's
   tests passing before its gate.
4. **The integrator gate must not loop.** Its prompt finalizes on `ship` without
   re-emitting the marker, and only re-gates after a `revise`.
