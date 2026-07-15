# Sprint 16 Summary — raptor-agentic-team

## Sprint Goal

**Autonomy substrate** — advance the autonomous-Raptor north star (run sprints → notify the user out-of-band → stay informed → ask for guidance when the backlog is dry) and cut the manual-shepherding surface. Three features, all shipped:

- **surface-tool-errors-to-openstory** — PR #38 (merge `b89ee78`)
- **notification-egress** — PR #39 (merge `efc1b84`)
- **reset-sprint-tool** — PR #40 (merge `53b4242`)

Full suite grew 963 → 1053 tests across the sprint; all green at each merge.

## Features Delivered

- **surface-tool-errors-to-openstory** — MCP tool failures are now first-class at the tool-call boundary (`isError:true` on failure, omitted on success for byte-parity; message never stack). New pure `src/error-surfacing.ts`; single seam at the `src/index.ts` registration layer wrapping all handlers; `tools.ts` untouched. `escalated`/`complete`/`paused`/`in-progress` correctly not flagged (D4).
- **notification-egress** — Out-of-band sprint notifications via an egress-free append-only JSONL sink (`~/.raptor/{slug}/notifications.jsonl`); payload derived EXCLUSIVELY from persisted state (anti-counterfeit, pairs with surface-tool-errors); `notifications.enabled:false` off-switch = byte parity; exactly-once dedup; triple exception-isolation; config parsed with a parsed-vs-declared conformance test. Architecture redesigned mid-sprint from a Slack-webhook egress to the local sink (Slack/Discord deferred to future drivers).
- **reset-sprint-tool** — Raptor's 7th MCP tool, the first-class complement to `resume_sprint`: deletes the persisted sprint state to free a sprint wedged in any status resume refuses (esp. the un-resumable `in-progress` limbo). `deleteSprintState` in `state.ts` (delete, not rewrite); `resetSprintTool` in `tools.ts` (never throws to transport); guarded `complete` behind a `confirm` flag; touches ONLY the state file.

## Key Technical Decisions

- **Single failure-surfacing seam** at `index.ts` registration (`registerTools`), extracted so it's importable/testable; `main()` guarded behind `require.main === module`.
- **Notifications key off persisted state, never agent self-report** — emission reloads `loadSprintState` at the tool boundary; the off-switch lives in driver resolution so parity is structural.
- **Reset deletes, does not rewrite** (OQ1) — byte-identical to the manual `rm` it replaces, zero coupling to `createInitialState`.
- **Guard `complete` only** (OQ2) — escalated/failed/in-progress/paused reset freely.
- All additive; no `SprintState` schema change; no new dependencies.

## Patterns & Conventions Established

- **Drift-guard conformance test for tool registration** — capture every real registered handler and assert it routes through the surfacing seam; a new unwired tool fails the suite (extended to the 7th tool automatically).
- **Real-seam tests, not transcriptions** — a "production seam" test must drive the real tool function, not reimplement the boundary inline.
- **Mutation-verify constraint-guarding tests** — remove the production seam, require RED (see the standout finding below).

## Issues Encountered — the standout finding

**All three features shipped test-adequacy defects that the prose adversarial gate (Sprint 14) did not catch — only an actual MUTATION test did:**

1. **surface-tool-errors R1** — a blocking "guard the real `index.ts` seam" requirement was signed off with an *empty-diff handoff* and never implemented; the test transcribed the handler instead of importing `index.ts`. Closed by extracting `registerTools` + a real-seam drift-guard (RED-verified).
2. **notification-egress AC-12** — (a) the seam test mocked `spawnAgent` without writing the required spec artifact, so the sprint escalated instead of parking (the test asserted a checkpoint → committed RED); (b) the "production seam" test reimplemented the boundary inline, so deleting *both* `dispatchNotification` call sites left the suite green. Closed with real `runSprint`/`resumeSprintTool` boundary tests, mutation-verified.
3. **reset-sprint-tool AC-10** — the delivered fault-injection test couldn't even run (`jest.spyOn(fs,"rmSync")` → "Cannot redefine property"); switched to spying the `deleteSprintState` export. Its gate then ran four mutations, all RED — the clean template.

→ Filed **`review-gate-mutation-check`** (Ready): make the step-7 QA gate mechanically mutation-test the system-under-test rather than reasoning about coverage. Strongest retro signal of the sprint.

Also: **`main` was branch-locked (`lock_branch:true`) mid-sprint**, blocking PR #40's automated merge (required user unlock/merge). Filed **`branch-protection-merge-lockout`** (Ready) — the step-9 merge should classify a lock/protection refusal as `user-actionable` and escalate immediately.

## Process Note

This sprint was **hand-driven** (roles played directly as `[ROLE]`/`[HANDOFF]` commits) because the orchestrator was parked in the `in-progress` limbo that `reset-sprint-tool` itself now fixes — a fitting dogfood. Per-feature branches were reconciled onto the merged seam changes (`index.ts` conflict resolution for notification-egress).

## Context for Future Sprints

- State: `~/.raptor/{slug}/sprint-N.json` via `loadSprintState`/`saveSprintState`/`deleteSprintState`.
- Seven MCP tools now; every handler routes through `surfaceOutcome`/`buildThrownErrorResult` — keep new tools wrapped (the conformance test enforces it).
- Notifications sink is default-on and local; a future Slack/Discord driver plugs into `resolveDrivers` without touching the emission seam.
- Top Ready follow-ups: `review-gate-mutation-check`, `branch-protection-merge-lockout`, `registersurfacedtool-hof-refactor`.
