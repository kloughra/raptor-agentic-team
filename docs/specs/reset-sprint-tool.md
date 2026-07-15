---
slug: reset-sprint-tool
status: ready
sprint: 16
---
# Reset Sprint Tool

## User Story
As a Raptor user (or an autonomous driver) whose sprint is wedged in circuit-breaker limbo — escalated, failed, or stuck `in-progress` with no resume path — I want a first-class `reset_sprint` MCP tool that clears the persisted sprint state so I can start that sprint over cleanly, so that I never have to drop to a shell and `rm ~/.raptor/{project}/sprint-N.json` by hand to escape a dead end.

## Background

**The gap this closes.** When a sprint gets wedged, the only way out today is a manual filesystem delete: `rm ~/.raptor/{project}/sprint-N.json`. That is exactly the kind of manual-intervention surface Sprint 16's *Autonomy substrate* theme aims to cut (Sprint 15 alone took 53 `resume_sprint` calls). `reset_sprint` makes the escape hatch first-class.

**Why `resume_sprint` is not enough.** `resume_sprint` re-engages a parked sprint but only from three states, and it *carries directional feedback into a re-attempt* — it never wipes the slate:
- `paused` (a pending checkpoint) → approve / request-changes.
- `escalated` → resets the escalated step's `attempts`/`failures` and re-enters (`runner.ts:1734`, `:1767`).
- `failed` → resets the failed step and re-enters (`runner.ts:1801`).

Any other status falls through to the wall at `runner.ts:1815-1820`:
```
Sprint is in '<status>' status and cannot be resumed.
```
The most painful case is a sprint stuck `in-progress` — the `orchestrator-recovery-after-mixed-completion` limbo, where a mixed-completion sprint is marked `in-progress` and neither `resume_sprint` nor `run_sprint` can re-engage it. There is **no** built-in path to abandon that state and start fresh short of hand-deleting the JSON.

`reset_sprint` is the deliberate complement to `resume_sprint`, and the two are distinct by design (per the `orchestrator-recovery-after-mixed-completion` Inbox note): **resume carries the user's feedback into a re-attempt; reset clears state to start over.**

### Verified current behavior (2026-07-12, current `sprint-16` branch base)
- Sprint state lives at `~/.raptor/{projectSlug}/sprint-{N}.json`, resolved by `sprintStatePath` (`state.ts:133`). `loadSprintState` returns `null` when the file is absent (`state.ts:141-148`).
- Raptor exposes **6** MCP tools, registered in `src/index.ts`: `bootstrap_project`, `adopt_project`, `list_projects`, `get_project_status`, `run_sprint`, `resume_sprint`. Each tool implementation in `src/tools.ts` returns a `{ status, ... }` object (`status: "success" | "error"`), never throws to the transport.
- `resumeSprintTool` (`tools.ts:719`) resolves the project via `ctx.registry.findProject`, guards `!project` and missing `project.path` with `{status:"error"}`, then delegates to `resumeSprint`.
- `resumeSprint` (`runner.ts:1516`) has no branch for `in-progress` (or `complete`) status — those hit the un-resumable wall at `:1818`.
- Committed artifacts (specs, architecture, tests, code), git branches/PRs, `docs/sprints/` summaries, `docs/backlog.md`, and the project registry (`~/.raptor/projects.json`) are **separate** from the per-sprint state file. A manual `rm` of `sprint-N.json` touches none of them — it only discards orchestration state (step statuses, attempts, failure records, checkpoints).

## Acceptance Criteria

1. **New first-class MCP tool `reset_sprint`.** Registered in `src/index.ts` alongside the existing six and implemented in `src/tools.ts`, returning the standard `{ status: "success" | "error", ... }` shape (never throwing to the transport), consistent with every other tool. Raptor now exposes seven tools.

2. **Inputs.** The tool accepts `name` (project name/slug) and `sprint` (sprint number), validated with Zod exactly as `run_sprint` / `resume_sprint` do. It also accepts a **confirmation input** guarding destructive resets (see AC 7); the exact input name/shape is the Architect's call (Open Question 2).

3. **Project-resolution parity.** Unknown project → `{status:"error"}` with a clear message (mirrors `run_sprint`/`resume_sprint`); registered project whose `project.path` is missing on disk → `{status:"error"}`. Failures are returned, never thrown.

4. **Core behavior — clean slate.** A successful reset clears the persisted state for `~/.raptor/{slug}/sprint-{N}.json` such that a subsequent `run_sprint {slug} {N}` begins that sprint **from step 1 with a clean slate**: no leftover `attempts`, `failures`, `checkpoints`, escalated/failed step statuses, or non-terminal sprint status. The observable post-condition is pinned; the mechanism (delete the file vs. rewrite it to `createInitialState`) is the Architect's decision (Open Question 1) — either is acceptable if the post-condition holds.

5. **Rescues every wedged status — including `in-progress`.** Reset succeeds regardless of the sprint's current status: `escalated`, `failed`, `in-progress` (the un-resumable `orchestrator-recovery` limbo at `runner.ts:1818`), and `paused`. This is the crux of the feature: it must free a sprint that `resume_sprint` refuses.

6. **No-state → informative no-op success.** Resetting a sprint that has no `sprint-N.json` on disk returns `{status:"success"}` with a message noting there was nothing to reset — **not** an error. Reset is idempotent: calling it twice is safe.

7. **Guard against wiping a completed sprint.** A `complete` sprint (code merged, DoD satisfied) must NOT be silently discarded — reset without the confirmation input (AC 2) refuses with a clear message stating the sprint is complete and how to force it. With the confirmation input present, the reset proceeds. (Whether `paused` also warrants the guard is Open Question 2; escalated/failed/in-progress do not — freeing those is the whole point.)

8. **Scope boundary — state file only.** Reset touches ONLY `~/.raptor/{slug}/sprint-{N}.json`. It does NOT delete or modify: git branches or PRs, committed artifacts (specs/architecture/tests/code), `docs/sprints/` summaries or demo docs, `docs/backlog.md`, or the project registry (`~/.raptor/projects.json`). A reset is recoverable in the sense that all durable, version-controlled work survives it.

9. **Response names the outcome and next action.** A successful response reports the project, the sprint number, the prior status that was cleared (or "no state found"), and the next action to take (`run_sprint {slug} {N}` to start fresh), so a human or an autonomous driver knows exactly what happened and what to do next.

10. **Real failures surface as errors, not swallowed successes.** A genuine failure to clear the state (e.g. the state path is present but unwritable/undeletable) returns `{status:"error"}` with the underlying reason — never a false `success`. This aligns with the `surface-tool-errors-to-openstory` direction shipping in the same sprint (a "reset succeeded" report must be truthful), though the structured-error mechanism itself is that item's concern, not this one's.

11. **Distinct from resume / orchestrator-recovery — no feedback, no re-attempt.** Reset does NOT carry directional feedback, does NOT re-engage a parked step, and does NOT auto-run the sprint. It clears state and stops; the user/driver then calls `run_sprint`. No shared or forked control flow with `resumeSprint`'s re-attempt path that could let the two diverge or double-implement step re-entry.

12. **Tests exercise the production seam.** Regression tests drive the real `reset_sprint` tool function against a real temp `~/.raptor` state file (not a mock of the filesystem layer), asserting: (a) an escalated/failed/`in-progress` state file is cleared to a clean slate and a subsequent `run_sprint` would start from step 1; (b) resetting with no state file is a success no-op; (c) a `complete` sprint is refused without confirmation and cleared with it; (d) unknown-project and missing-dir error parity. Per TEAM.md QA rule 12, each constraint-guarding test carries a RED-verification note proving it FAILS before the tool exists (today there is no `reset_sprint`; the `in-progress` case is un-resumable).

## Edge Cases
- **Sprint stuck `in-progress` (primary target).** The `orchestrator-recovery-after-mixed-completion` limbo — `resume_sprint` refuses it and `run_sprint` just re-reports status. Reset must free it. This is the case the feature exists for.
- **No `sprint-N.json` present.** Informative success no-op (AC 6), not an error. Covers a typo'd sprint number, a never-started sprint, or a double reset.
- **`complete` / merged sprint.** Guarded (AC 7): refuse without the confirmation input so a user doesn't accidentally wipe the record of a shipped sprint. The committed summary/demo/PR survive regardless (AC 8), but the orchestration state is still worth protecting from an accidental wipe.
- **Multi-feature sprint state.** Reset clears the **whole** `sprint-N.json` — all features at once. Per-feature or per-step partial reset is out of scope (that is `orchestrator-recovery`'s territory).
- **Registered project, missing disk directory.** Error, mirroring `run_sprint`/`resume_sprint` (AC 3).
- **Reset while a sprint is actively running.** Out of scope / user responsibility — resetting a live in-flight run is undefined and the user should not do it; the tool is not required to detect or lock against a concurrently-running orchestrator in this sprint. Document the expectation in the response/tool description.
- **Invalid sprint number (0, negative, non-existent section).** Resolves to "no state found" → informative no-op success (AC 6) rather than a hard error, unless project resolution itself fails (AC 3).

## Out of Scope
- **Per-feature or per-step partial reset.** Resetting one escalated feature while preserving siblings, or rewinding a single step, is `orchestrator-recovery-after-mixed-completion` (Inbox) — a different mechanism that carries feedback into a re-attempt. This tool wipes the whole sprint.
- **Carrying directional feedback into a re-attempt.** That is `resume_sprint --action=request-changes`. Reset is feedback-free (AC 11).
- **Auto-running the sprint after reset.** Reset clears state and returns; the user/driver invokes `run_sprint` next (AC 11). No implicit re-run.
- **Touching durable/version-controlled artifacts.** Git branches, PRs, specs/architecture/tests/code, `docs/sprints/` summaries, the backlog, and the registry are never modified (AC 8).
- **Notifications on reset.** Emitting an out-of-band ping on reset is `notification-egress` (same sprint, separate item). Reset is a user-initiated recovery action, not a sprint lifecycle event.
- **A structured error-event surface.** Truthful `{status:"error"}` returns are required (AC 10); the richer structured-error/exception surface is `surface-tool-errors-to-openstory`.
- **Making the state-file location configurable.** Reset uses the existing `~/.raptor/{slug}/sprint-{N}.json` resolution; no new config surface.
- **Autonomous auto-reset loops.** An autonomy driver may *call* `reset_sprint`, but logic that decides to auto-reset a wedged sprint is not part of this item.

## Open Questions
1. **Delete vs. rewrite-to-initial.** Should reset `fs.unlink` the `sprint-N.json` file (byte-identical to the manual `rm` it replaces, letting `run_sprint` recreate state from scratch), or rewrite it to `createInitialState(...)`? Both satisfy AC 4's post-condition — Architect to choose based on how `runSprintFromStep` builds/loads state at step 1 (AC 4 interaction). — technical decision.
2. **Confirmation input shape and guard scope.** Is the guard a boolean `confirm`/`force` input, or a status allowlist? Does the guard cover only `complete`, or also `paused`? (Escalated/failed/in-progress are never guarded — freeing them is the point.) — Architect to finalize (AC 2, AC 7).
3. **Auditability of the discarded state.** Should the successful response include a snapshot of what was discarded (prior progress table, attempt counts, last failure) for post-mortem readability, or just the prior status string? PO leans toward at least the prior status + a one-line summary; Architect/QA to size.
4. **Reset audit trail.** `~/.raptor` is not version-controlled, so a reset leaves no history. Is any record of the reset needed (e.g. a log line), or is the fire-and-forget clear acceptable? PO leans acceptable-as-is for this sprint; confirm.
5. **Concurrent-run detection.** Should the tool make any attempt to detect that a sprint is actively running before clearing its state, or is that explicitly the user's responsibility this sprint (as stated in Edge Cases)? — confirm the no-lock decision with Architect.
