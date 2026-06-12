# Changelog

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
