---
sprint: 8
feature: multi-feature-sprint-dispatch
presenter: Brax (Team)
date: 2026-04-27
---
# Sprint 8 Demo — Multi-Feature Sprint Dispatch

> Brax the Brachiosaurus presenting — towering over the whole picture.

## 1. Sprint Goals

**Primary goal:** Wire the existing `multi-runner.ts` helpers into `runSprintFromStep` so every backlog item in a sprint section gets the full per-feature workflow — instead of silently dropping everything after the first item.

**Source of work:** dora-metrics adopt-and-run failure on 2026-04-26. A sprint with three planned items completed only the first slug and reported the sprint as "done."

**Bundled scope (Architect decision, ratified):**
- `sprint-branch-auto-create` — folded into this PR via `ensureFeatureBranch` (~30 LOC). Same code path serves single- and multi-feature dispatch, fixes the original 2026-04-26 single-feature regression in the same PR.
- `request-changes-feedback-injection` — single-feature `request-changes` branch in `resumeSprint` now resets `attempts = 0` / `failures = []` so the retry loop re-enters and the feedback-injection condition fires.

### Acceptance Criteria (14 total)

| # | Criterion | Status |
|---|---|---|
| 1 | Detection on entry via `detectSprintFeatures` | ✅ |
| 2 | State population via `createFeatureStates` before any step | ✅ |
| 3 | Per-feature dispatch for steps 1–9 | ✅ |
| 4 | Per-feature branch via `ensureFeatureBranch` | ✅ |
| 5 | Per-feature step state tracked under `state.features[i].steps[j]` | ✅ |
| 6 | Sprint-shared steps 10–13 run once per sprint | ✅ |
| 7 | Failure isolation across features | ✅ |
| 8 | Per-feature DoD checklist | ✅ |
| 9 | `renderProgressTable` per-feature rows + `(per-feature)` annotation | ✅ |
| 10 | Single-feature backward compatibility | ✅ |
| 11 | Empty sprint returns existing error | ✅ |
| 12 | Resume safety — `state.features` not re-seeded | ✅ |
| 13 | Streaming checkpoints, one feature at a time, payload identifies feature | ✅ |
| 14 | `run_sprint` / `resume_sprint` tool surface unchanged | ✅ |

---

## 2. Feature Demonstration

### What changed

| Module | Change |
|---|---|
| `src/orchestrator/multi-runner.ts` | New `ensureFeatureBranch(projectPath, sprint, featureSlug)` — idempotent create-or-checkout, returns `{ created, checkedOut, error? }` (errors are returned, never thrown, so failure isolation works). |
| `src/orchestrator/runner.ts` | `runSprintFromStep` is now a dispatcher: detects features → 0 / 1 / 2+ branching, seeds `state.features` once via `createFeatureStates`, then iterates `SPRINT_WORKFLOW`. Per-feature steps (1–9) delegate to `dispatchPerFeatureStep`; shared steps (10–13) run once. |
| `src/orchestrator/runner.ts` | New `runStepForFeature` extracts the per-step body so the single- and multi-feature paths share identical execution semantics (prompts, retries, scope narrowing, BLOCKER detection, output validation). |
| `src/orchestrator/checkpoints.ts` | `CheckpointPrompt` gains optional `feature?: string`. `buildCheckpointPrompt(type, summary, dinoNames?, featureSlug?)` — title suffixed `— {slug}`, context prefixed with `**Feature:** {slug}`. Single-feature behavior unchanged. |
| `src/orchestrator/state.ts` | `SprintState.currentFeatureSlug?` added; `CheckpointState.feature?` added. Backward-compat defaults in `loadSprintState`. |
| `src/orchestrator/progress.ts` | Per-feature subtables already existed; top-level rows for steps 1–9 are now annotated `(per-feature)` when `state.features` is non-empty. |
| `docs/backlog.md` | `multi-feature-sprint-dispatch`, `sprint-branch-auto-create`, and `request-changes-feedback-injection` moved Inbox → Done with bundling note. |

### How dispatch flows

1. **First run, multi-feature sprint:**
   ```
   detectSprintFeatures(projectPath, sprint) → ["feat-a", "feat-b", "feat-c"]
   ↓ duplicate-slug check, [x] post-processing
   createFeatureStates(...) → state.features seeded
   saveSprintState() → persisted before any step
   ↓ for each WorkflowStep i in SPRINT_WORKFLOW:
       step.step ≤ 9 → dispatchPerFeatureStep(state, step, i, …)
                       ↓ for each feature in state.features:
                           ensureFeatureBranch(projectPath, sprint, slug)
                           runStepForFeature(...) → complete | checkpoint | escalated | failed
       step.step ≥ 10 → existing single-shot logic against state.steps[i]
   ```

2. **Streaming checkpoint:** when any per-feature step has `checkpointAfter`, the dispatcher annotates `CheckpointPrompt.feature = slug`, persists `state.status = "paused"` + `state.currentFeatureSlug = slug`, and returns. The next `resume_sprint approve` re-enters the dispatcher and naturally lands on the next feature whose step is still pending.

3. **Failure isolation:** if a feature escalates or fails, the dispatcher records it on that feature's `FeatureState` and **continues** to the next feature in the same step. Sprint-level escalation is propagated *only after* every feature has had a chance, computed by `deriveSprintStatus(state.features)`.

4. **Single-feature path:** when `detectSprintFeatures` returns exactly one slug, `state.features` stays `null` and the existing inline code path runs verbatim. Same `extractFeatureSlug` helper, same prompts, same validation. The only behavioral change: branch tracking now runs through `ensureFeatureBranch` instead of "record whatever HEAD points to" — fixing the dora-metrics 2026-04-26 regression in passing.

### Tool surface

`run_sprint` and `resume_sprint` MCP inputs/outputs are **unchanged**. Multi-feature mode is fully driven by what's in `docs/backlog.md`. Clients that already read `state.features` from `get_project_status` get per-feature breakdowns for free.

---

## 3. Test Execution (live)

```
$ npx jest

Test Suites: 27 passed, 27 total
Tests:       435 passed, 435 total
Snapshots:   0 total
Time:        5.761 s
```

### Feature-scoped suite

```
$ npx jest tests/integration/multi-feature-sprint-dispatch.integration.test.ts --verbose

Test Suites: 1 passed, 1 total
Tests:       40 passed, 40 total
Time:        1.815 s
```

40 scenarios cover all 14 ACs plus six edge cases. A full breakdown lives in PR #15's QA comment.

---

## 4. Test Results Summary

### Coverage by AC

| AC bucket | Tests |
|---|---|
| AC #1 detection | duplicate slugs surface as backlog error; empty sprint surfaces existing error message; mixed `[ ]` / `[x]` items both counted |
| AC #2 state population | `state.features` seeded once and persisted before step 1 |
| AC #3–#5 per-feature dispatch | per-feature step state lives under `state.features[i].steps[j]`; shared `state.steps` untouched for steps 1–9 |
| AC #4 branching | `ensureFeatureBranch` create-new, checkout-existing, and divergent-error all asserted |
| AC #6 shared steps | retro / feedback steps run exactly once regardless of feature count |
| AC #7 failure isolation | one feature escalates → others still execute; `deriveSprintStatus` only escalates once all features are terminal |
| AC #8 DoD | per-feature DoD flips don't bleed across features; `allFeaturesComplete` gates sprint completion |
| AC #9 progress table | per-feature subtables render in multi-mode; top-level steps 1–9 annotated `(per-feature)`; single-feature output unchanged |
| AC #10–#11 backward compat | single-feature sprint goes through unchanged code path; legacy state files with no `features` field default to `null` |
| AC #12 resume safety | `state.features` survives reload even if backlog mutates; already-`complete` per-feature steps skipped on resume |
| AC #13 streaming checkpoints | `CheckpointPrompt.feature` is additive; `CheckpointState.feature` and `SprintState.currentFeatureSlug` round-trip; `request-changes` resets only the affected feature |
| AC #14 tool surface | `SprintResult` exposes `feature` only as additive checkpoint metadata; no breaking changes |

### Defects found and resolved during the sprint

1. **Single-feature `request-changes` reset missing** — caught in PR review (commit `164add8`). The single-feature `resumeSprint` path was leaving `attempts > 0` after a `request-changes`, so the feedback-injection condition never fired on the next run. Fixed by mirroring the multi-feature reset (`attempts = 0`, `failures = []`) in the single-feature branch. Also closes the bundled `request-changes-feedback-injection` backlog item.
2. **AC #9 annotation assertion absent** — caught in PR review (commit `164add8`). New test added: top-level rows for steps 1–9 contain `(per-feature)` when `state.features` is non-empty.
3. **Backlog cleanup** — `multi-feature-sprint-dispatch` was still in Sprint Planned with no Done entry, and the bundled `sprint-branch-auto-create` was still in Inbox. Cleaned up in `164add8` so the backlog reflects what shipped.

### Defects deferred to backlog (filed during sprint, not blocking)

- `expected-outputs-glob-resolution` — `resolveExpectedOutputPaths` does literal `.replace("*", featureSlug)`; QA's first attempt to write tests at `tests/integration/{slug}.integration.test.ts` (repo convention) was rejected because the validator was looking for a literal `tests/integration/multi-feature-sprint-dispatch` path. Filed in Inbox.
- `artifact-injection-directory-handling` — `artifact-injection.ts:84` calls `fs.readFileSync` without checking whether the path is a file; threw EISDIR mid-flight when QA's workaround left a directory at the literal path. Filed in Inbox.

Both are real bugs in the orchestrator's expected-output plumbing — they hit Sprint 8 itself but are out-of-scope for this spec. PO has them prioritized for triage.

### Verdict

- ✅ **27/27 suites pass, 435/435 tests pass** — full repo green
- ✅ **40/40 feature tests pass** — every AC covered, every edge case covered
- ✅ **No regressions** — all 18 prior integration suites still green
- ✅ **Architect + QA peer review** complete, request-changes addressed, PR #15 ready
- ✅ **DoD satisfied** — code committed, tests pass, PR opened, peer review approved, PO acceptance pending demo

---

## 5. Stakeholder Feedback Request

The increment is ready. I'd like your call on:

1. **Acceptance:** Does the demoed behavior match the intent of the spec (every backlog item dispatches, failure isolation works, single-feature sprints unchanged)?
2. **Bundling decision:** Are you comfortable with the Architect's call to fold `sprint-branch-auto-create` and `request-changes-feedback-injection` into this PR rather than splitting them into separate hotfixes?
3. **Streaming checkpoints (AC #13):** One checkpoint per feature, presented sequentially, no batching. The spec's rationale was that batched checkpoints would either force all-or-nothing decisions or require holding N specs in your head at once. Confirm this matches your expectation, or flag if you'd rather defer to a `batchCheckpoints` config knob now (currently filed as a follow-up).
4. **Deferred bugs:** `expected-outputs-glob-resolution` and `artifact-injection-directory-handling` are real plumbing bugs surfaced by this sprint — should they jump to Ready for Sprint 9, or stay in Inbox for triage?
5. **Anything else** you'd like changed before merge.

Brax out. 🦕
