---
slug: orchestrator-recovery-after-mixed-completion
spec: docs/specs/orchestrator-recovery-after-mixed-completion.md
---
# Orchestrator Recovery After Mixed Completion — Architecture Design

## Overview

A multi-feature sprint that ends with one feature merged and a sibling stuck at
the 3-attempt circuit breaker is currently unrecoverable in-band: the sprint
lands in `in-progress`, `resume_sprint` refuses it, and the only escape is
hand-editing `~/.raptor/{project}/sprint-N.json` or shipping the rest as a
hotfix. This design fixes that with **three surgical, additive changes** to the
existing multi-feature dispatcher and resume path — no new modules, no new
dependencies, no schema-breaking changes.

The three changes map directly to the spec's three-part fix:

1. **Mark a feature `complete`** the instant its terminal per-feature step
   (Merge PR, step 9) completes — the single missing state transition that
   poisons everything downstream.
2. **Finalize mixed sprints as `escalated`** — falls out automatically once (1)
   is correct, because `deriveSprintStatus` already encodes the rule; we only
   need to ensure the dispatcher consults it correctly and parks instead of
   advancing to shared steps 10–13.
3. **Route `request-changes` feedback to an escalated feature** — extend the
   resume escalated branch to look in `state.features[i].steps`, accept an
   optional `feature` selector, reset that feature's per-step `attempts`/
   `failures`, and re-enter the per-feature runner at the escalated step.

The root cause is a single **missing state transition**: `runMergeStepForFeature`
(`runner.ts:1737-1751`) sets the *step* complete but never the *feature*
complete. Every observable symptom in the spec traces back to that one omission
plus the resume path's top-level-only search.

## Components

All changes are confined to two existing modules plus an additive Zod field in
`src/index.ts`. No files are created; no module signatures in `multi-runner.ts`
change (honoring the Sprint 8 constraint).

| Component | File | Change |
|-----------|------|--------|
| Terminal-step completion | `src/orchestrator/runner.ts` `runMergeStepForFeature` | On successful merge, set `feature.status = "complete"` and `feature.currentStep = step.step + 1` (10), alongside the existing `stepState.status = "complete"`. **(AC #1)** |
| Dispatch finalization | `src/orchestrator/runner.ts` per-feature loop (`~1561-1574`) | Replace the brittle `anyEscalated && sprintStatus !== "in-progress"` guard with a direct check: after the Merge PR step (and after every per-feature step), if `deriveSprintStatus(state.features)` is `escalated`, persist `state.status = "escalated"` and park. **(AC #2, #10)** |
| Resume — escalated, multi-feature | `src/orchestrator/runner.ts` `resumeSprint` escalated branch (`~1127-1162`) | When `state.features` is present, resolve the target escalated feature (explicit `feature` arg or implicit single target), find its escalated step under `feature.steps`, reset `attempts=0`/`failures=[]`/`status="pending"`, set `feature.status="in-progress"`, `state.status="in-progress"`, and re-enter `runSprintFromStep` at that step with `feedback`. **(AC #5, #6, #7, #12)** |
| Resume — `approve` on escalated | `src/orchestrator/runner.ts` `resumeSprint` | Add an explicit guard: `approve` on an `escalated` sprint returns a clear redirect message (does not mutate state). **(Edge case)** |
| Tool input | `src/index.ts` `resume_sprint` registration | Add optional `feature: z.string().optional()`; thread through to `resumeSprintTool` → `resumeSprint`. `run_sprint` unchanged in behavior; signatures additive only. **(AC #4)** |
| Tool plumbing | `src/tools.ts` `resumeSprintTool` | Accept and forward the optional `feature` slug to `resumeSprint`. |
| Reporting | `src/orchestrator/progress.ts` `renderProgressTable` + escalated return messages in `runner.ts` | Escalated returns name which feature(s) escalated, at which step, and instruct `resume_sprint --action=request-changes [--feature=<slug>]`. **(AC #11)** |

### Why completion lives in the dispatch path, not `deriveSprintStatus`

The spec's Open Question asks where feature-status finalization should live.
**Decision: finalize feature status at the point of the terminal step
transition (inside the dispatcher), and keep `deriveSprintStatus` a pure
read-only reducer over `feature.status` values.**

Rationale:
- `deriveSprintStatus` is already a pure function consumed in multiple places
  (the loop guard at `runner.ts:1562`, the final finalize at `runner.ts:1674`).
  Making it mutate `feature.status` as a side effect would violate that
  contract and risk double-application.
- A feature becomes `complete` for exactly one reason — its terminal step
  merged. That is a *dispatch event*, so it belongs where the event is
  observed (`runMergeStepForFeature`), mirroring how non-terminal steps already
  bump `feature.currentStep` at their completion site (`runner.ts:1517`).
- This keeps the fix to one transition and makes the reducer trivially testable.

## Data Model

**No schema changes.** All required fields already exist on `FeatureState` and
`StepState` (`src/orchestrator/state.ts`):

```ts
interface FeatureState {
  slug: string;
  branchName: string | null;
  status: "pending" | "in-progress" | "complete" | "failed" | "escalated"; // ← already has "complete" & "escalated"
  currentStep: number;
  steps: StepState[];   // ← per-feature steps; escalated step lives here
  dod: DodChecklist;
}

interface StepState {
  step: number;
  status: StepStatus;   // reset to "pending" on resume
  attempts: number;     // reset to 0 on request-changes resume
  failures: FailureRecord[];  // reset to [] on request-changes resume
  // ...
}
```

The fix is a **state-transition correctness fix**, not a data-model change. The
existing backward-compat defaulting in `loadSprintState` (`state.ts:96-114`)
already tolerates older state files; **no migration is performed** (per spec Out
of Scope — Sprint 9 incident files are not backfilled).

### State-transition invariant (new, enforced by this design)

> A `FeatureState` is `complete` **iff** its terminal per-feature step (step 9,
> Merge PR) has `status === "complete"`. A multi-feature sprint's persisted
> `status` is always `deriveSprintStatus(state.features)` at every point the
> dispatch loop yields control (parks, pauses, or finalizes).

This invariant is what makes the three observable defects impossible to recur.

## API Contracts

### MCP tool: `resume_sprint` (additive change — AC #4)

```ts
resume_sprint({
  project: string,              // unchanged
  sprint: number,               // unchanged
  action: "approve" | "request-changes",  // unchanged
  feedback?: string,            // unchanged
  feature?: string,             // NEW — optional escalated-feature slug selector
})
```

Backward compatible: every existing call omits `feature` and behaves exactly as
before. `run_sprint` is **unchanged** (the spec mentions it only insofar as it
must keep reporting status correctly, which it does once finalization is fixed).

### Resume routing semantics (escalated sprint, `request-changes`)

| Condition | Behavior |
|-----------|----------|
| `state.features` absent (single-feature) | Existing path unchanged — search top-level `state.steps`, reset, re-enter. **(AC: single-feature edge)** |
| `feedback` missing | Error: "Cannot resume an escalated sprint without guidance…" (unchanged). |
| Exactly one feature `escalated`, no `feature` arg | Implicitly target it. **(AC #5)** |
| >1 feature `escalated`, no `feature` arg | Error listing all escalated slugs: "Multiple features are escalated: [a, b]. Re-run with `--feature=<slug>`." **(AC #6)** |
| `feature` arg supplied, slug not in `state.features` | Error naming valid escalated slugs. **(Edge)** |
| `feature` arg supplied, slug exists but not `escalated` | Error naming valid escalated slugs. **(Edge)** |
| Valid escalated `feature` resolved | Find escalated step in `feature.steps`; `attempts=0`, `failures=[]`, `status="pending"`; `feature.status="in-progress"`; `state.status="in-progress"`; re-enter `runSprintFromStep(…, escalatedStep.step, feedback)`. **(AC #7)** |

### `approve` on an escalated sprint (Edge case — Architect proposal)

`approve` does **not** complete a parked feature. Proposed response (PO to
confirm wording against AC):

> **Message:** *"Sprint {N} is escalated: feature(s) {slugs} stalled at the
> circuit breaker. `approve` cannot finalize a stalled feature. To re-engage,
> run `resume_sprint --action=request-changes --feedback="…" [--feature=<slug>]`.
> To abandon and restart a feature from scratch, use the reset path
> (`reset-sprint-tool`, separate)."*

State is not mutated. This keeps `approve` meaningful only for `paused`
(checkpoint) sprints, as today.

### Re-entry contract (AC #7, #8, #9)

`runSprintFromStep` re-entered at the escalated step:
- Iterates `state.features`; the **completed sibling**'s `feature.status ===
  "complete"` short-circuits the per-feature loop (`runner.ts:1425`) so its
  steps/artifacts are never touched. **(AC #8 — sibling preservation)**
- The re-targeted feature (now `in-progress`, step `pending`) re-runs the
  failed step. `feedback` is injected via the existing attempt-1 feedback path
  (same mechanism as single-feature `request-changes`). **(AC #7)**
- If it succeeds through Merge PR, `runMergeStepForFeature` marks it `complete`;
  if all features are now `complete`, the loop proceeds to shared steps 10–13
  and finalizes `complete`. **(AC: re-attempt completes the sprint)**
- If it re-escalates, the finalization guard re-parks the sprint at `escalated`,
  resumable again with no cap. **(AC #9)**

## Non-Functional Requirements

| NFR | Target | Notes |
|-----|--------|-------|
| **Correctness (primary)** | The state-transition invariant above holds at every loop yield point. A mixed sprint (≥1 complete, ≥1 escalated, none in-progress) **always** persists as `escalated`, never `in-progress`. | This is the feature's entire reason for existing; verified by integration tests over the dispatcher + resume path. |
| **Backward compatibility** | 100% — existing single-feature sprints, all-complete multi-feature sprints, and existing `resume_sprint` calls (no `feature` arg) behave identically. No regression to the all-success path (AC #3). | Enforced by additive-only Zod field and the `state.features` presence branch. |
| **Idempotent resume** | Re-issuing `resume_sprint --action=request-changes` on an escalated feature is safe and deterministic: each call resets that feature's step and re-enters; completed siblings are untouched on every call. | No accumulation of state; `attempts`/`failures` reset, not appended-then-grown. |
| **Latency** | The status/resume logic adds **O(features × steps)** in-memory work (≤ ~13 steps × small N features) plus existing `simple-git` calls. Negligible relative to agent-spawn latency (minutes). No new I/O on the hot path beyond existing `saveSprintState` writes. | No new network or disk round-trips introduced. |
| **Durability** | Every state transition (feature→complete, sprint→escalated, per-step reset) is flushed via `saveSprintState` before control yields, so a crash mid-resume leaves a resumable, internally-consistent state file. | Matches existing "persist before yield" convention. |
| **Observability** | Escalated returns and the progress table name the escalated feature(s), the step, and the exact resume command. `[ESCALATE]` git commits already record the failing feature/step (unchanged). | AC #11. |
| **Failure isolation** | Resetting/re-running one escalated feature never reads or writes another feature's `steps`, `dod`, or artifacts. | AC #8; guaranteed by per-feature loop scoping. |
| **Safety / no data loss** | No migration or rewrite of existing state files; `approve`-on-escalated and invalid-`feature` paths are pure (no mutation) and return before any `saveSprintState`. | Spec Out of Scope: no backfilling. |

## Technology Choices

**No new technology, framework, or dependency is introduced.** Per the Architect
boundary (no new tech without user approval) and the spec's "Context for Future
Sprints," this design reuses the established stack:

| Concern | Choice | Status |
|---------|--------|--------|
| Language / runtime | TypeScript / Node.js | Existing |
| State storage | JSON files under `~/.raptor/{slug}/sprint-N.json` via `loadSprintState`/`saveSprintState` | Existing |
| Git operations | `simple-git` (escalate/handoff commits) | Existing |
| Tool input validation | Zod (`z.string().optional()` for `feature`) | Existing |
| Status reduction | `deriveSprintStatus` in `multi-runner.ts` (kept pure) | Existing |
| Feedback injection | Existing attempt-1 feedback mechanism in `runAgentStepCycle` | Existing |

The **only** change requiring user sign-off is the *additive MCP tool-surface
change* — adding optional `feature` to `resume_sprint` (spec Open Question;
decision authority: user). This is backward-compatible and introduces no
dependency. No ADR is warranted (no architectural-stack decision); this design
doc plus the spec are the record. *(User confirmation pending — see Open
Questions.)*

## Constraints & Patterns

- **Additive-only, backward-compatible** — every change degrades gracefully for
  single-feature and legacy state files; the `feature` arg is optional; missing
  fields are defaulted by `loadSprintState`. (Established Sprint 5–8 pattern.)
- **No `multi-runner.ts` signature changes** — honoring the Sprint 8 Out-of-Scope
  constraint. `deriveSprintStatus`, `allFeaturesComplete`, `anyFeaturesEscalated`
  keep their current signatures; we only *consume* them correctly.
- **`deriveSprintStatus` stays a pure reducer** — finalization side effects live
  in the dispatcher at the transition site, not in the reducer.
- **Single dispatcher entry point** — all execution still flows through
  `runSprintFromStep`; no new fork. (Sprint 8 pattern.)
- **Persist before yield** — `saveSprintState` is called before every park,
  pause, or finalize so resume always sees a consistent file.
- **Per-feature isolation** — re-engaging one feature never mutates a sibling's
  state; the completed-feature short-circuit at the top of the per-feature loop
  is the guard.
- **No silent advancement** — the dispatcher must not proceed to shared steps
  10–13 while any feature is `escalated`; finalization is checked after the
  terminal per-feature step. (AC #10.)
- **Circuit breaker unchanged** — `MAX_RETRY_ATTEMPTS` (3) is not touched; re-
  attempts get a fresh 3-attempt budget by resetting `attempts`. (Spec Out of
  Scope.)
- **No migration** — Sprint 9 incident state files are not auto-fixed; this
  governs new and resumable runs only. (Spec Out of Scope.)
- **Errors returned, not thrown** — resume validation failures (multi-target
  without `feature`, unknown/non-escalated slug, `approve`-on-escalated) return
  `{status: "error", …}` with actionable messages; they do not mutate state.

## Open Questions (for PO / User)

1. **Tool-surface confirmation (user authority).** Adding optional `feature` to
   `resume_sprint` is additive and backward-compatible (AC #4). *Recommended:
   approve.* Proceeding on this assumption; flag if the additive signature is
   not acceptable.
2. **`approve`-on-escalated wording (PO to confirm).** Proposed message above —
   PO to confirm it satisfies the edge-case acceptance criterion.
