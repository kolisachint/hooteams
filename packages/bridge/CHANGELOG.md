# Changelog

## [0.1.28] - 2026-06-18

## [0.1.27] - 2026-06-18

## [0.1.26] - 2026-06-17

## [0.1.25] - 2026-06-17

## [0.1.24] - 2026-06-16

## [0.1.23] - 2026-06-16

## [0.1.22] - 2026-06-16

## [0.1.21] - 2026-06-14

## [0.1.20] - 2026-06-14

## [0.1.19] - 2026-06-14

## [0.1.18] - 2026-06-14

## [0.1.17] - 2026-06-14

## [0.1.16] - 2026-06-14

## [0.1.15] - 2026-06-13

## [0.1.14] - 2026-06-13

## [0.1.13] - 2026-06-12

## [0.1.12] - 2026-06-12

### Added
- `POST /runs` accepts three new optional fields (all backward compatible): `retries` per task (non-negative integer, validated), a run-level `goal` string (judged by the host's goal validator when one is configured), and `roles` — per-run role configs (e.g. from a `hooteams plan` dry run) the host merges into its team for that run.
- The new additive `task_retried` TeamEvent passes through the serializer unchanged, like the other synthetic task events.

## [0.1.11] - 2026-06-12

## [0.1.10] - 2026-06-12

### Added
- HITL wire contract, consumed identically by hoocanvas and hoocode `--team`: `GET /tasks/pending`, `POST /tasks/:taskId/resume` (`{ option, feedback? }`; 409 when nothing is pending — first answer wins), `GET /trace`, and `GET /runs/:runId/trace`. Routes 404 until the host attaches a run via `RouterOptions.hitl`.
- `HitlRun`/`RouterOptions`/`ApprovalRequestWire` types; `createRouter` takes an optional fourth options argument (backward compatible).
- The serializer passes the new `task_paused`/`task_resumed`/`task_started`/`task_finished`/`dag_complete`/`dag_failed` TeamEvents through unchanged (covered by tests).

## [0.1.9] - 2026-06-12

## [0.1.8] - 2026-06-11

## [0.1.7] - 2026-06-11

## [0.1.6] - 2026-06-11

## [0.1.5] - 2026-06-11

## [0.1.4] - 2026-06-11

## [0.1.3] - 2026-06-11

## [0.1.2] - 2026-06-11

## [0.1.1] - 2026-06-11

### Added
- Initial release of hooteams-bridge package

### Changed
- 

### Fixed
- 
