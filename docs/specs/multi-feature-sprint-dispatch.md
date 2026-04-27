---
slug: multi-feature-sprint-dispatch
status: draft
sprint: 8
---
# Multi-Feature Sprint Dispatch

## User Story
As the Raptor orchestrator, when a sprint section in `docs/backlog.md` contains multiple backlog items, I want `runSprintFromStep` to detect every item and dispatch the per-feature workflow for each one — so that multi-item sprints execute every feature instead of silently dropping all but the first.

## Background
Sprint 5 introduced `multi-runner.ts` (`detectSprintFeatures`, `createFeatureStates`, `featureBranchName`, `allFeaturesComplete`, `anyFeaturesEscalated`, `deriveSprintStatus`) and the `SprintState.features?` field, but the helpers were never wired into `runSprintFromStep`. Today the runner calls `extractFeatureSlug` (`src/orchestrator/runner.ts:57–70` and `:312`), which pulls only the first `- [ ] slug:` item out of the sprint section. Every subsequent item is silently ignored. The dora-metrics adopt-and-run failure on 2026-04-26 surfaced this regression: a sprint with three planned items completed only the first slug and reported the sprint as "done."

This spec is the **wiring** spec — most of the building blocks exist. The gap is the dispatch path inside `runSprintFromStep` and the per-feature loop semantics.

## Acceptance Criteria

1. **Detection on entry.** When `runSprintFromStep` initializes (or resumes) sprint state, it calls `detectSprintFeatures(projectPath, sprint)` to enumerate all `- [ ] slug:` items in the sprint section of `docs/backlog.md`.
2. **State population.** When two or more features are detected and `state.features` is null/empty, the runner populates `state.features` via `createFeatureStates(features, sprint)` and persists it via `saveSprintState` before executing any step.
3. **Per-feature dispatch (steps 1–9).** For workflow steps 1 through 9 (spec → architecture → tests → PO test review → implement → PR → run tests → demo → merge), the runner iterates each feature in `state.features` and runs the step's agent flow once per feature, using that feature's slug for prompt substitution and validation.
4. **Per-feature branch.** Before the first code-producing step for a feature, the runner ensures the feature is on `featureBranchName(sprint, slug)` (i.e. `sprint-{N}/{slug}`). Each feature's commits land on its own branch, never on `main` and never on another feature's branch.
5. **Per-feature step state.** Each feature's per-step status, attempts, failures, artifacts, and completion timestamp are tracked under `state.features[i].steps[j]` (not the top-level `state.steps`, which remains the source of truth for shared steps 10–13).
6. **Sprint-shared steps (10–13).** Steps 10–13 (process feedback, collect retro proposals, review retro proposals, apply retro improvements) run exactly once per sprint regardless of feature count, using the top-level `state.steps` entries.
7. **Failure isolation.** If one feature's step fails or escalates, other features' execution is not blocked — the runner continues dispatching the remaining features for that step before propagating the escalation upward. Sprint-level status is derived from `deriveSprintStatus(state.features)`.
8. **Per-feature DoD.** Each feature has its own `dod` checklist updated as its work progresses; the sprint is only `complete` when `allFeaturesComplete(state.features)` returns true.
9. **Progress visibility.** `renderProgressTable` shows per-feature rows for steps 1–9 when multi-feature mode is active, and shows a single row per shared step (10–13). Single-feature sprints render unchanged.
10. **Backward compatibility — single-feature.** When `detectSprintFeatures` returns exactly one slug, the runner takes the existing single-feature path: `state.features` stays `null`, output validation, branch handling, and progress rendering behave exactly as they do today.
11. **Backward compatibility — empty sprint.** When `detectSprintFeatures` returns zero slugs, the runner returns the existing error result (`"Could not extract feature slug from backlog. Ensure the sprint section has items in the format: - [ ] slug: description"`) and marks the sprint `failed`.
12. **Resume safety.** Resuming a sprint that was started in multi-feature mode preserves the existing `state.features` array — the runner does not re-seed it from `detectSprintFeatures` once features exist in state. Already-`complete` per-feature steps are skipped on resume just like single-feature mode skips already-`complete` top-level steps.
13. **Checkpoint behavior.** When a step has a `checkpointAfter`, the checkpoint fires once per feature in multi-feature mode (so the user can review each feature's spec, design, PR, etc. independently). The checkpoint payload identifies which feature it belongs to.
14. **Tool surface unchanged.** The `run_sprint` and `resume_sprint` MCP tool inputs and return shapes do not change. Multi-feature mode is fully driven by the contents of `docs/backlog.md`.

## Edge Cases

- **Mid-sprint added item.** A new `- [ ]` item appended to the sprint section *after* `state.features` is populated must NOT be auto-added — it is treated as next-sprint scope. The runner only seeds `state.features` once, on first run.
- **Duplicate slugs in the sprint section.** `detectSprintFeatures` returning duplicates is treated as a backlog error: the runner returns an error result naming the duplicate slug and does not start.
- **Already-checked items (`- [x]`).** Items checked off in the sprint section are still counted by `detectSprintFeatures` (the regex matches `[ x]`); the runner treats them as features whose work is already done and marks their `FeatureState.status = "complete"` with all per-feature steps skipped.
- **Branch already exists.** If `sprint-{N}/{slug}` already exists locally for a feature, the runner checks it out rather than recreating it. If the branch exists with divergent commits the runner does NOT auto-resolve — it surfaces a clear error and stops that feature only.
- **Feature escalation while others continue.** When one feature escalates, its `FeatureState.status` becomes `escalated`; remaining features continue. After all features have completed or escalated, the sprint enters `escalated` status (per `deriveSprintStatus`) and the user is notified at the next checkpoint.
- **Single feature → restart with multi.** A sprint that started single-feature (no `state.features`) is not silently upgraded if the user later edits the backlog. Behavior remains single-feature for that sprint state file.

## Out of Scope

- **Concurrent execution of features.** This spec specifies *dispatch* (every feature gets the workflow). Whether per-feature steps run sequentially or in parallel is owned by `agent-parallel-execution` / `multi-engineer-coordination` and is not changed here. Default behavior is sequential per-feature dispatch.
- **Cross-feature merge conflict resolution.** Each feature merges to `main` independently via the existing `Merge PR` step; conflict handling is unchanged.
- **Dynamic feature add/remove mid-sprint.** Once `state.features` is seeded, the set is frozen for the life of the sprint state file.
- **Refactoring `extractFeatureSlug` away.** It may remain as a single-feature helper or be removed by the Architect — implementation choice, not a requirement of this spec.
- **Updating `multi-runner.ts` helper signatures.** The existing exports are assumed correct; this spec only requires wiring them in.

## Open Questions

- None at spec time. If the Architect identifies a need to change `multi-runner.ts` exports or `SprintState.features` shape during design, raise back to PO before proceeding.
