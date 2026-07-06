---
slug: sprint-completes-despite-failed-merge
spec: docs/specs/sprint-completes-despite-failed-merge.md
---
# Sprint Completes Despite Failed Merge — Architecture Design

## Overview

The Merge PR step (step 9) is orchestrator-managed (no subagent) and carries its own hand-rolled retry, which is broken in both execution modes:

- **Single-feature** (`runner.ts:967-969`): on merge failure below the cap, the failure branch executes `continue` inside the step loop (`for (let i = fromStep - 1; ...)` at `runner.ts:773`), which advances `i` — the merge is *skipped*, not retried. Steps 10–13 then run, and the finalization block (`runner.ts:1361`) sets `state.status = "complete"` **unconditionally**.
- **Multi-feature** (`runner.ts:2038-2041`): `runMergeStepForFeature` correctly returns `"complete" | "escalated" | "retry"` (`runner.ts:2271-2341`), but the dispatcher ignores the return value and `continue`s to the next feature — a `"retry"` outcome leaves that feature's step 9 `in-progress`. The multi-feature finalizer (`runner.ts:2255`) won't falsely say `complete`, but the sprint can march through shared steps 10–13 and land in unresumable `in-progress` limbo.

This design fixes the **control flow around a failed merge** and adds **truthfulness guards** at finalization. It does not touch `executeMerge` mechanics, `MAX_RETRY_ATTEMPTS`, or the squash-merge strategy (spec Out of Scope). All source citations below were re-verified against current `main` on 2026-07-06.

**Design invariant (the one-sentence contract):** *`state.status === "complete"` implies every step in `state.steps` is `complete` — and in multi-feature mode, every feature is terminal (`complete` or `escalated`) before any shared step runs.*

## Components

### C1. Single-feature in-place merge retry (AC #1, #2, #3)

Replace the skip-a-step `continue` with an **explicit bounded attempt loop** inside the `step.name === "Merge PR"` branch:

```
// inside the step-9 branch, replacing the single-shot executeMerge call
let mergeResult;
do {
  mergeResult = await executeMerge(projectPath, featureSlug, sprint, branchName);
  if (!mergeResult.success) {
    // existing failure accounting — unchanged (AC #2):
    //   stepState.attempts++;
    //   stepState.failures.push({ ...truncateErrorSummary..., hadPartialArtifacts: false, ... })
    if (stepState.attempts >= MAX_RETRY_ATTEMPTS) {
      // existing escalation block verbatim (AC #3):
      //   step 9 -> escalated, sprint -> escalated, [ESCALATE] commit, return SprintResult
    }
    saveSprintState(projectSlug, sprint, state); // persist before every retry (persist-before-yield pattern)
  }
} while (!mergeResult.success);
// fall through to the existing success path (attempts++, complete, [HANDOFF], continue)
```

**Deliberately NOT `i--; continue;`.** Mutating the loop index inside a `for` body is exactly the class of control-flow subtlety that produced this defect (a `continue` whose comment said "retry"). The inner `do/while` makes the retry local, readable, and provably bounded.

**Termination proof:** `stepState.attempts` increments on *every* failed `executeMerge` invocation (AC #2: attempts count == invocation count); the escalation branch `return`s when `attempts >= MAX_RETRY_ATTEMPTS (3)`. The loop therefore executes at most `MAX_RETRY_ATTEMPTS` iterations (fewer if `attempts` was already non-zero from a resumed state — correct: resumed attempts still count toward the cap).

### C2. Multi-feature retry honored (AC #5, #8)

The dispatcher consumes the return value it currently discards (`runner.ts:2038-2041`):

```
if (step.name === "Merge PR") {
  let outcome;
  do {
    outcome = await runMergeStepForFeature(feature, featureStepState, ctx);
  } while (outcome === "retry");
  continue; // "complete" and "escalated" both proceed to the next feature — existing park semantics
}
```

`runMergeStepForFeature` is **unchanged**: its failure accounting, escalation-at-cap, `[ESCALATE]` commit, feature-complete transition, and `[HANDOFF]` commit (`runner.ts:2271-2341`) are already correct in isolation. Termination is inherited from the same argument as C1 — the function increments `attempts` on every failure and returns `"escalated"` at the cap, so `"retry"` can be returned at most `MAX_RETRY_ATTEMPTS - 1` times per feature.

**Sibling isolation (AC #8)** falls out structurally: the retry loop closes over one `feature` / `featureStepState` pair; sibling features are untouched, exactly as today. The existing post-step `deriveSprintStatus` park (`runner.ts:2143-2153`) is unchanged.

### C3. Single-feature finalization guard (AC #4 — defense in depth)

Immediately before the finalization block (`runner.ts:1343-1369`), assert the invariant:

```
const incomplete = state.steps.filter((s) => s.status !== "complete");
if (incomplete.length > 0) {
  state.status = "escalated";                      // Open Question 3 ruling — see Constraints #5
  saveSprintState(projectSlug, sprint, state);
  return {
    status: "escalated",
    progress: renderProgressTable(state),
    message: `Sprint NOT complete: step(s) ${incomplete.map((s) => `${s.step} (${s.name}, ${s.status})`).join(", ")} did not finish. Resume with resume_sprint.`,
    state,
  };
}
```

Sprint-summary generation and the `state.status = "complete"` assignment run only past this guard. No `[ESCALATE]` commit is created here: a guard trip means an escalation/park path upstream already committed (or a new defect exists) — the guard's job is truthful status, not duplicate git noise.

### C4. Multi-feature shared-step gate (AC #6 — defense in depth)

At the per-feature → shared-step boundary (before dispatching any step with `step.step >= 10`, i.e. before `runner.ts:2158`), gate once:

```
const nonTerminal = state.features.filter(
  (f) => f.status !== "complete" && f.status !== "escalated"
);
if (nonTerminal.length > 0) {
  state.status = "escalated";
  saveSprintState(projectSlug, sprint, state);
  return { status: "escalated", ..., message: `Shared steps blocked: feature(s) ${slugs} not terminal at step 9.` };
}
```

Notes:
- With C2 in place, a feature can only exit the step-9 dispatch as `complete` or `escalated` (`failed` only via the existing missing-`branchName` hard-fail, which the reducer already parks). This gate exists for the same reason as C3: the finalizer must never be reachable through a hole we haven't imagined.
- The existing `deriveSprintStatus` park after each per-feature step already handles the *escalated/failed* mixes (Sprint 10 behavior, preserved verbatim). This gate closes the remaining `in-progress`-at-step-9 hole (`deriveSprintStatus` returns `"in-progress"` for that mix and today the loop would `continue` into shared steps — `runner.ts:2154-2155`).
- Gate placement is *inside the step loop at the first shared step*, not duplicated per shared step — steps 10–13 are sequential, so one gate at entry suffices.

### C5. Failure-record enrichment (recommended, additive)

Merge `FailureRecord`s currently omit the Sprint 12 CB fields. When recording a merge failure (both modes), also set:

```
classification: classifyFailure(errorSummary),   // pure fn, failure-classification.ts:45
signature: deriveFailureSignature(errorSummary), // pure fn, failure-classification.ts:76
```

Both fields are optional on `FailureRecord` (`state.ts:16,21`), read sites use `?? "deterministic"` / never-match conventions, so this is zero-risk and makes Sprint 10/12-style post-mortems (and a future merge short-circuit — Open Question 2) possible from state files alone. **This does NOT change retry behavior this sprint** — no `decideAfterFailure` wiring for merges (see Constraints #6).

### Unchanged components (explicit)

| Component | Why unchanged |
|---|---|
| `executeMerge` (gh CLI + simple-git fallback, squash) | Spec Out of Scope |
| `MAX_RETRY_ATTEMPTS = 3` | Spec Out of Scope; established pattern (not config-exposed) |
| `runMergeStepForFeature` body (`runner.ts:2271-2341`) | Correct in isolation; only its caller changes |
| Missing-`branchName` hard-fail (`runner.ts:912-922`, `2283-2288`) | Spec edge case: unchanged |
| Escalated-resume / `resume_sprint` flows (Sprint 10) | AC #7 requires no regression; escalated step 9 re-enters via existing paths |
| `deriveSprintStatus` (pure reducer, `multi-runner.ts:107-116`) | Stays pure; C4 is a runner-side gate, not a reducer change |

## Data Model

**No schema changes.** No new persisted fields, no state-file migration (spec Out of Scope; established no-migration pattern). C5 populates *existing* optional `FailureRecord` fields (`classification`, `signature`) at write time. Pre-fix state files (Sprint 10/12 specimens: step 9 `in-progress`, sprint `complete`) load without crashing — `loadSprintState` is untouched and both guards operate only on freshly-run sprints.

## API Contracts

No MCP tool signature changes. `SprintResult` shape is unchanged; two new *values* flow through existing fields:

| Path | Contract |
|---|---|
| C3 guard trip | `{ status: "escalated", message: "Sprint NOT complete: step(s) …" , progress, state }` |
| C4 gate trip | `{ status: "escalated", message: "Shared steps blocked: …", progress, state }` |
| C1/C2 escalation at cap | Existing contract verbatim: `{ status: "escalated", message: "Merge failed after N attempts: …" }` + `[ESCALATE]` commit |
| Successful retry | Existing success contract: step 9 `complete`, exactly one `[HANDOFF]` commit (success only — AC #9) |

Internal contract made load-bearing: `runMergeStepForFeature(): "complete" | "escalated" | "retry"` — previously advisory, now consumed. Do not add variants without updating the C2 loop.

## Non-Functional Requirements

1. **Status truthfulness (correctness NFR — the point of the feature).** `complete` ⇒ all steps `complete` (single) / all features terminal-complete (multi). Verified by AC #10 seam tests.
2. **Bounded latency on failure.** Worst case adds `MAX_RETRY_ATTEMPTS - 1 = 2` extra `executeMerge` invocations, executed back-to-back with **no retry delay/backoff** (spec Out of Scope; merge failures like branch protection fail in <5s, so the deterministic worst case adds ~seconds, not minutes). No timers, no new timeout surface.
3. **Guaranteed termination.** Both retry loops are bounded by the monotonic `attempts` counter reaching `MAX_RETRY_ATTEMPTS` (proofs in C1/C2). No unbounded loop on a permanently-failing merge (spec edge case).
4. **Crash safety / persist-before-yield.** `saveSprintState` is called after every failure record and before every retry iteration, escalation return, and guard return — a process crash mid-retry resumes with accurate `attempts`/`failures`.
5. **Backward compatibility.** Zero schema change; old state files load; resume paths (AC #7) re-enter escalated step 9 unchanged. Availability of historical falsely-`complete` states: readable, not auto-repaired.
6. **Observability.** Every failure appends a truncated `failures[]` record (existing 500-char-class truncation via `truncateErrorSummary` — unchanged); guard/gate trips name the offending step(s)/feature(s) in the returned message; C5 adds classification/signature for post-mortems.

## Technology Choices

**No new technologies, frameworks, or dependencies.** ⚠️ *Presented for user approval per process — this feature is pure control-flow repair on the existing stack:*

| Aspect | Choice | Status |
|---|---|---|
| Language / runtime | TypeScript on Node.js | existing |
| Retry mechanism | Plain bounded `do/while` in `runner.ts` (mirrors Sprint 6 in-process-loop decision) | existing pattern |
| Git / merge | `simple-git` + `gh` CLI fallback inside `executeMerge` | existing, untouched |
| State persistence | JSON sprint-state files via `loadSprintState`/`saveSprintState` | existing |
| Failure metadata | Pure functions from `failure-classification.ts` (Sprint 12) | existing module, reused |
| Tests | jest / ts-jest; seam tests in `tests/integration/`, BDD in `tests/bdd/` | existing |

If the user rejects any row (none is new, so rejection is unexpected), implementation must halt pending re-design.

## Constraints & Patterns

1. **No index mutation for retry.** The retry is an inner `do/while` around the merge attempt — never `i--`/`continue` games on the step loop. The step-loop index only ever advances.
2. **Failure accounting frozen.** `attempts` increments exactly once per `executeMerge` invocation; every failure appends one `FailureRecord` with truncated summary (AC #2). Do not reset `attempts` on retry or resume.
3. **Escalation block verbatim.** The at-cap path (step 9 → `escalated`, sprint → `escalated`, `[ESCALATE]` commit, early return, steps 10–13 never run) is preserved byte-for-byte in behavior (AC #3, #9). Exactly one `[HANDOFF]` commit, only on merge success.
4. **Guards are defense-in-depth, not primary control flow.** C3/C4 must be unreachable when C1/C2 work; their tests deliberately violate the invariant (hand-crafted state) to prove the guard fires. They forbid `complete`; they never *repair* state.
5. **Open Question 3 ruling: guard trips map to `escalated`.** Rationale: (a) `in-progress` is the Sprint 9 unresumable limbo — forbidden; (b) `failed` implies a recorded step failure that may not exist; (c) `escalated` means "needs user intervention" — exactly right for an invariant violation — and is resumable via the Sprint 10 escalated-resume path (AC #7). No git commit on guard trip (upstream paths already commit when they escalate).
6. **Open Question 2 ruling: no `decideAfterFailure` wiring for merges this sprint.** The Sprint 12 pipeline (no-progress short-circuit, transient-cap) was designed for agent steps with minutes-long attempts; merge attempts are seconds, so burning 3 identical attempts costs ~nothing, while wiring merges into `decideAfterFailure` would expand this fix's blast radius into freshly-shipped Sprint 12 code. C5 persists `classification`/`signature` now so a future `merge-failure-short-circuit` backlog item is state-compatible. Deferred, not rejected.
7. **Open Question 1 ruling: pre-merge push is a follow-up backlog item, not bundled.** It changes `executeMerge` mechanics — explicitly Out of Scope here — and deserves its own tests (push failures, no-remote repos, force-push hazards). It is a small item (~10 lines + tests) and I recommend the PO schedule `push-before-merge` for Sprint 14; bundling it would make *this* sprint's regression surface include remote-git behavior for a control-flow fix.
8. **Tests exercise the production seam (AC #10, TEAM.md QA rule 12).** Regression tests drive `runSprintFromStep` (single-feature) and the multi-feature dispatcher with a failing-then-succeeding `executeMerge` — mock/stub at the `executeMerge` boundary (and `spawnAgent`/git as existing integration tests already do), never by reimplementing the loop. Each constraint-guarding test must FAIL against the pre-fix `continue` control flow. A unit test of an extracted helper alone is inadequate.
9. **`deriveSprintStatus` stays a pure reducer** — C4's gate lives in the runner; finalization side effects never move into `multi-runner.ts` (Sprint 10 constraint, upheld).
10. **Single dispatcher entry point** — all flow stays in `runSprintFromStep`; no parallel merge-runner fork (Sprint 8/9 constraint, upheld).
11. **No migration** — historical falsely-`complete` state files (Sprints 10, 12) are left as-is; loading them must not crash (they don't touch the new code paths).
12. **Errors returned, not thrown** — guard/gate trips return `SprintResult`s, consistent with the established pattern.
