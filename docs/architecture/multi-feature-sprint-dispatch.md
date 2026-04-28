---
slug: multi-feature-sprint-dispatch
spec: docs/specs/multi-feature-sprint-dispatch.md
---
# Multi-Feature Sprint Dispatch — Architecture Design

## Overview

This is a **wiring** design — the building blocks already exist in `src/orchestrator/multi-runner.ts` (`detectSprintFeatures`, `createFeatureStates`, `featureBranchName`, `allFeaturesComplete`, `anyFeaturesEscalated`, `deriveSprintStatus`) and the `SprintState.features?` field. The gap is inside `runSprintFromStep` (`src/orchestrator/runner.ts`), which today extracts only the first slug via `extractFeatureSlug` and silently drops the rest.

The design preserves the existing single-feature path verbatim. Multi-feature mode is a new dispatch shell that reuses the per-step execution logic via a refactored inner helper. Checkpoints in multi-feature mode **stream** — one feature at a time, using the existing `run_sprint` / `resume_sprint` tool surface unchanged.

This design also resolves the spec's open dependency on `sprint-branch-auto-create` by **bundling** it (see Open Question Resolution below).

---

## Components

### 1. `runSprintFromStep` — dispatcher (src/orchestrator/runner.ts)

The top-level loop becomes a *dispatcher* that:

1. On first run (when no `state` yet exists or `state.features` is null/empty):
   - Calls `detectSprintFeatures(projectPath, sprint)`.
   - If 0 features → returns the existing error result (`"Could not extract feature slug from backlog…"`) and marks sprint `failed` (AC #11).
   - If 1 feature → falls through to the **single-feature path** (existing behavior, untouched). `state.features` stays `null` (AC #10).
   - If 2+ features → checks for duplicate slugs; if any duplicate, returns `"Duplicate slug '{slug}' in sprint section of backlog.md"` and marks the sprint `failed` (Edge Case: duplicates).
   - Otherwise calls `createFeatureStates(features, sprint)` and persists `state.features` via `saveSprintState` **before executing any step** (AC #2).
2. On resume (state already loaded with `state.features` populated): does NOT re-seed. The set is frozen for the life of the state file (AC #12, Edge Case: mid-sprint added item).
3. Iterates `SPRINT_WORKFLOW`:
   - For per-feature steps (1–9): delegates to `dispatchPerFeatureStep(...)` (new helper).
   - For sprint-shared steps (10–13): runs the existing single-shot logic against `state.steps[i]` (AC #6).

The single-feature path is the existing inline code, unchanged. It still uses `extractFeatureSlug` (kept as a single-feature helper — its removal is explicitly out of scope per the spec).

### 2. `runStepForFeature` — extracted inner helper (src/orchestrator/runner.ts)

The per-step body of today's loop (lines 338–818 of `runner.ts`) is refactored into a reusable inner function:

```typescript
async function runStepForFeature(
  projectPath: string,
  projectSlug: string,
  sprint: number,
  step: WorkflowStep,
  stepState: StepState,
  featureSlug: string,
  dod: DodChecklist,
  branchName: string,
  feedback: string | undefined,
  fromStep: number,
  i: number,
  ctx: StepRunContext  // git, dinoNames, testFramework, sprintSummaries, isMultiFeature
): Promise<StepRunOutcome>;

type StepRunOutcome =
  | { kind: "complete" }
  | { kind: "checkpoint"; checkpoint: CheckpointPrompt }
  | { kind: "escalated"; message: string }
  | { kind: "failed"; message: string };
```

This helper encapsulates: prompt building, codebase/cross-sprint context injection, artifact resolution, retry loop with circuit breaker, scope narrowing, BLOCKER detection, output validation, and step-state mutation. It does **not** call `saveSprintState` itself — the caller is responsible because state shape (top-level vs. nested-under-feature) differs by caller.

The single-feature path calls it once per step with `stepState = state.steps[i]`, `dod = state.dod`, `branchName = state.branchName`. The multi-feature path calls it once per (feature, step) pair with the per-feature equivalents.

### 3. `dispatchPerFeatureStep` — multi-feature step dispatcher (src/orchestrator/runner.ts)

```typescript
async function dispatchPerFeatureStep(
  state: SprintState,
  step: WorkflowStep,
  i: number,                       // step index in SPRINT_WORKFLOW
  ...projectArgs
): Promise<SprintResult | null>;   // null = continue to next step in workflow
```

Behavior:

1. Iterate `state.features` in array order, skipping features whose `status` is `complete` or whose per-feature step is already `complete` (AC #12 resume safety; Edge Case: already-checked items where the whole feature is pre-marked complete).
2. For each remaining feature:
   - Ensure the feature is on its branch via `ensureFeatureBranch(...)` (see Component 4) before invoking the per-feature step body. This runs once per feature per dispatch — `simple-git`'s `branch --list` check is cheap.
   - Resolve the feature's per-step state: `state.features[fIdx].steps[i]` (per-feature steps are indexed identically to `SPRINT_WORKFLOW` for steps 1–9; the helper enforces `step.step <= 9` via `createFeatureStates`).
   - Set `state.currentStep = step.step` and `state.currentFeatureSlug = feature.slug` (new field — see §6 Data Model). Persist state.
   - Call `runStepForFeature(...)`.
   - On `complete`: mark per-feature step complete; update per-feature `dod`; persist; create handoff commit (per-feature, with feature slug appended). Continue to next feature.
   - On `escalated` / `failed`: mark per-feature step + `feature.status` as `escalated`/`failed`; persist; **do not** return immediately — continue to next feature (AC #7 failure isolation). Track that we've seen at least one escalation for end-of-step propagation.
   - On `checkpoint` (AC #13 streaming): annotate the checkpoint payload with the feature slug (see Component 5), persist `state.status = "paused"` plus a new `CheckpointState` whose `feedback` field is initially null, then **return** the `SprintResult` immediately. The next `resume_sprint approve` re-enters this dispatcher and skips features whose step is already complete, naturally landing on the next un-checkpointed feature.
3. After all features have been dispatched for this step:
   - Recompute sprint status via `deriveSprintStatus(state.features)`.
   - If any feature escalated, return an `escalated` `SprintResult` (AC #7 — escalation propagated upward only after every feature has had a chance).
   - Otherwise return `null` so the dispatcher advances to the next workflow step.

### 4. `ensureFeatureBranch` — bundled `sprint-branch-auto-create` (new in src/orchestrator/multi-runner.ts)

Resolves the spec's open question: **bundle**, not sequence. Rationale in §Open Question Resolution.

```typescript
export async function ensureFeatureBranch(
  projectPath: string,
  sprint: number,
  featureSlug: string
): Promise<{ created: boolean; checkedOut: boolean; error?: string }>;
```

Behavior (uses `simple-git`):

1. Compute `branchName = featureBranchName(sprint, featureSlug)`.
2. Inspect local branches via `git.branchLocal()`.
3. If `branchName` exists locally:
   - If we are already on it (per `git.revparse(["--abbrev-ref", "HEAD"])`) → no-op, return `{ created: false, checkedOut: false }`.
   - Otherwise check it out: `git.checkout(branchName)`. Return `{ created: false, checkedOut: true }`.
   - If checkout fails because the branch has divergent commits with the working tree (uncommitted changes), **do not auto-resolve** — return `{ created: false, checkedOut: false, error: "Branch '{branchName}' exists with divergent state; resolve manually." }` (Edge Case: branch already exists / divergent).
4. If `branchName` does not exist:
   - Create from current HEAD (which after a fresh `adopt`/`bootstrap` is the project default — `main` or `master`): `git.checkoutLocalBranch(branchName)` (= `git checkout -b`).
   - Return `{ created: true, checkedOut: true }`.

Idempotent: safe to call before every per-feature step. Errors are returned, not thrown, and propagate to `dispatchPerFeatureStep` which converts them into a per-feature `failed` outcome (failure isolation).

This **also satisfies the single-feature case** for `sprint-branch-auto-create`: the dispatcher calls `ensureFeatureBranch(projectPath, sprint, featureSlug)` once at the top of `runSprintFromStep` for the single-feature path too, replacing the existing "record whatever HEAD points to" logic at `runner.ts:282–310`. The current `state.branchName` field is populated from the resulting branch (whether created or pre-existing). Hotfix item `sprint-branch-auto-create` will be marked complete in the same PR.

### 5. Checkpoint payload — feature identification (src/orchestrator/checkpoints.ts)

`CheckpointPrompt` gains an optional `feature?: string` field:

```typescript
export interface CheckpointPrompt {
  type: CheckpointType;
  title: string;
  context: string;
  options: string[];
  feedbackLabel: string;
  feature?: string;  // present in multi-feature mode; identifies which feature the checkpoint pertains to
}
```

`buildCheckpointPrompt` accepts an optional `featureSlug` argument. When set, the prompt's `title` is suffixed with ` — {featureSlug}` and the `context` is prefixed with `**Feature:** {featureSlug}\n\n` (AC #13: payload identifies the feature). Single-feature mode behavior is unchanged.

### 6. `resumeSprint` — multi-feature aware (src/orchestrator/runner.ts)

The existing `resumeSprint` already calls `runSprintFromStep` after handling checkpoint approval/changes-requested. Two adjustments:

- **`approve` in multi-feature mode**: The pending checkpoint's `feature` field identifies which feature is being approved. On approve:
  - Mark the per-feature step complete (mirrors the existing top-level `currentStepState.status = "complete"` flow but at `state.features[fIdx].steps[i]`).
  - Update that feature's `dod` (e.g. `pr-review` → `feature.dod.prReviewApproved = true`; `demo-feedback` → `feature.dod.poAccepted = true`).
  - Re-enter `runSprintFromStep` from the **same** `state.currentStep` so `dispatchPerFeatureStep` resumes its iteration with the next feature whose per-feature step is still pending.
- **`request-changes` in multi-feature mode**: Reset only the **affected feature's** per-feature step (status → `pending`, `artifacts` → `[]`, `completedAt` → `null`, `attempts` → `0`, `failures` → `[]`). Other features are untouched. Re-enter `runSprintFromStep` from `state.currentStep` so the dispatcher re-runs that feature with feedback.

The single-feature `resumeSprint` flow is unchanged — selected via `state.features == null`.

### 7. `renderProgressTable` — already multi-feature aware

`progress.ts:83–117` already renders per-feature subtables when `state.features` is populated. No change required for AC #9. The top-level `state.steps` table continues to render shared steps 10–13 (which is what users see for sprint-level progress) — this is correct because steps 1–9 are also present in `state.steps` but stay `pending` for the sprint duration. We will adjust the existing table renderer to **annotate steps 1–9 with `(per-feature)`** in their status column when `state.features` is non-empty, so the user is not confused into thinking those top-level rows are "stuck." Single-feature rendering unchanged (AC #9, AC #10).

### 8. New `state.currentFeatureSlug` field (src/orchestrator/state.ts)

To support resuming streaming checkpoints, `SprintState` gains:

```typescript
export interface SprintState {
  // ... existing
  currentFeatureSlug?: string | null;  // present only in multi-feature mode
}
```

Backward compat: `loadSprintState` defaults missing `currentFeatureSlug` to `null`. Single-feature sprints leave it `null` for the life of the state file.

This does **not** require raising back to PO for an `SprintState.features` shape change — `currentFeatureSlug` is sibling metadata, not a shape change to `features` itself. The spec's Open Question only flagged shape changes to `features` (which are not needed) and `multi-runner.ts` exports (also not needed).

---

## Data Model

```typescript
// Existing (no shape change)
interface FeatureState {
  slug: string;
  branchName: string | null;          // populated by ensureFeatureBranch on first dispatch
  status: "pending" | "in-progress" | "complete" | "failed" | "escalated";
  currentStep: number;
  steps: StepState[];                 // 9 entries, one per per-feature step
  dod: DodChecklist;
}

// Extended
interface SprintState {
  // ... all existing fields preserved
  features?: FeatureState[] | null;       // existing
  currentFeatureSlug?: string | null;     // NEW: drives streaming checkpoint resume
}

// Extended
interface CheckpointPrompt {
  // ... existing
  feature?: string;                       // NEW: feature slug in multi-feature mode
}

// Extended
interface CheckpointState {
  // ... existing
  feature?: string | null;                // NEW: which feature this checkpoint belongs to
}
```

State migration: `loadSprintState` already defaults missing fields to safe values (see `state.ts:85–99`). We extend it for `currentFeatureSlug` and per-checkpoint `feature` defaulting to `null`. Existing single-feature state files load and resume identically.

---

## API Contracts

**No change to MCP tool surface.** `run_sprint` and `resume_sprint` inputs and return shapes are unchanged (AC #14). Multi-feature mode is fully driven by the contents of `docs/backlog.md`.

**`SprintResult` shape unchanged** — its `state.features` field is the existing carrier of multi-feature info. The `checkpoint` field's `CheckpointPrompt` gains the optional `feature` annotation (additive, backward-compatible).

**`get_project_status`** continues to return `state` directly; clients reading `state.features` get the per-feature breakdown for free.

**Internal contracts (new):**

| Function | Module | Responsibility |
|---|---|---|
| `ensureFeatureBranch(...)` | `multi-runner.ts` | Idempotent branch create/checkout for a feature (also used by single-feature path) |
| `runStepForFeature(...)` | `runner.ts` | Per-step execution body (extracted, reusable) |
| `dispatchPerFeatureStep(...)` | `runner.ts` | Iterate features for a single workflow step |
| `buildCheckpointPrompt(type, summary, dinoNames?, featureSlug?)` | `checkpoints.ts` | Optional feature annotation |

---

## Non-Functional Requirements

| NFR | Threshold | Rationale |
|---|---|---|
| **Dispatch overhead** | < 50 ms per feature per step (excluding agent execution itself) | Pure JS state mutation + a `git branchLocal()` call (~10 ms locally). Agent spawns are seconds-to-minutes, so dispatch must not be a bottleneck. |
| **Checkpoint latency** | First checkpoint surfaces ≤ 100 ms after the first feature's step completes | Streaming model requires immediate return; no batching, no aggregation pause. |
| **Failure isolation** | One feature's failure does NOT change the timing or success of other features in the same step | Required by AC #7. Verified by integration tests with one feature forced to fail. |
| **State file size** | Linear in `features × 9` step entries — acceptable up to ~50 features per sprint (~5 KB per feature) | JSON storage; no DB. Realistic sprints are 1–5 features. |
| **Resume idempotency** | Resuming a paused multi-feature sprint produces identical `state.features` array (no re-seeding from backlog) | AC #12. Verified by mutating backlog mid-sprint and asserting state is unchanged. |
| **Branch correctness** | `git rev-parse --abbrev-ref HEAD` returns `sprint-{N}/{slug}` before any commit-producing step for that feature | AC #4. Asserted in integration tests by inspecting commit history per branch. |
| **Backward compatibility** | All existing single-feature tests pass without modification | AC #10. Existing `tests/integration/*` suite is the regression bar. |

**Security:** No new attack surface. Branch names are interpolated from backlog slugs which already match `[a-z][a-z0-9-]*` per the project name regex (Edge Case: backlog parser rejects malformed slugs upstream).

**Performance:** Sequential per-feature dispatch (per spec Out of Scope: concurrency owned by `agent-parallel-execution`). Wall-clock = sum over features of step times. Parallelism is a follow-up.

**Observability:** Per-feature handoff commits land on each feature's branch (`[HANDOFF] <Role> -> <Role>: <artifact> for {featureSlug}`), so `git log` per branch tells the story. The progress table surfaces per-feature status icons.

---

## Technology Choices

**No new dependencies.** Uses `simple-git` (already in use) for branch ops, existing `Promise` semantics for sequential dispatch, existing JSON state storage. **No user approval required for new tech.**

| Area | Choice | Rationale |
|---|---|---|
| Branch create/checkout | `simple-git` (`git.checkoutLocalBranch`, `git.checkout`, `git.branchLocal`) | Already in `merge.ts`, `runner.ts`. No new dep. |
| Per-feature dispatch | Sequential `for`-loop over `state.features` | Spec Out of Scope: concurrency. Sequential is the explicit default. |
| Checkpoint streaming | Reuse existing `state.status = "paused"` + `state.checkpoints[]` + early `return` | Already proven by single-feature checkpoints; AC #13 streaming is "do this N times" not "design new flow." |
| State extension | Additive optional fields with backward-compat defaults | Same pattern used for prior multi-feature additions in `state.ts:85–99`. |
| Branch-creation strategy resolution | **Bundle** `sprint-branch-auto-create` into this PR | See §Open Question Resolution. |

**The only "decision" needing user approval** is the bundling of `sprint-branch-auto-create` (a backlog item from Inbox) into this sprint's scope. This is a scope/process decision more than a tech decision, but the Architect surfaces it explicitly per CLAUDE.md.

---

## Constraints & Patterns

- **Single dispatcher entry point.** All execution flows through `runSprintFromStep`. The single- vs multi-feature branching happens once, at the top, based on `state.features`. No parallel implementation forks (e.g. no separate `runMultiFeatureSprint` exported from `multi-runner.ts` — the prior `multi-engineer-coordination` design floated that, but it would duplicate the runner. We keep one entry, with shared inner helpers).
- **Inner helpers don't persist state.** `runStepForFeature` mutates the passed-in `stepState` and `dod` references but never calls `saveSprintState`. Persistence is owned by callers so they can decide *when* to flush (e.g. between features).
- **Branch ownership.** `ensureFeatureBranch` is the only code that calls `git.checkout` / `git.checkoutLocalBranch`. The existing `executeMerge` path already handles checkout-to-default-branch for merging — unchanged.
- **Handoff commits per feature.** When in multi-feature mode, the handoff commit message format becomes `[HANDOFF] <From> -> <To>: <artifact> for {featureSlug} (sprint {N})` — feature slug already on every handoff per existing code, no change.
- **Frozen feature set.** Once `state.features` is populated, the runner never re-reads the backlog to add/remove features (Edge Case: mid-sprint added item, single-feature → multi restart).
- **Already-checked items.** When `detectSprintFeatures` returns a slug for an item that is already `[x]` in the backlog, `createFeatureStates` still seeds it. The dispatcher detects pre-completed features by checking whether **all** per-feature workflow steps are absent from on-disk artifacts — but a simpler rule satisfies the spec: on initial seeding, set `feature.status = "complete"` and all per-feature `steps[*].status = "complete"` for any feature whose backlog item is `[x]`. This is detected by extending `detectSprintFeatures` to return `{ slug, checked }` pairs, OR (simpler, no signature change per Out of Scope) by re-reading the backlog inside `createFeatureStates`'s caller and post-processing. **Decision:** post-process inside `runSprintFromStep` after `createFeatureStates` returns — matches the spec's Out of Scope constraint that we "do not update `multi-runner.ts` helper signatures."
- **`extractFeatureSlug` retained.** Used for the single-feature path. Its removal is explicitly out of scope.

---

## Open Question Resolution

### Branch-creation strategy: **BUNDLE**, not sequence

The Architect chooses to **bundle** `sprint-branch-auto-create` into this PR, rather than sequencing it as a separate hotfix.

**Rationale:**

1. **AC #4 is unimplementable without it.** Per-feature branch handling is a hard requirement of this spec. Sequencing would mean blocking the engineer step on a separate hotfix that only makes sense in service of this work.
2. **The capability is small (~30 LOC).** A single new function (`ensureFeatureBranch`) plus replacing one block in `runSprintFromStep` (`runner.ts:282–310`). It does not warrant a standalone PR, branch, demo, or retro cycle.
3. **It naturally serves both modes.** The single-feature path also benefits — today it records `master` as `state.branchName` in the dora-metrics failure scenario. Bundling means single-feature sprints created on `main` also get auto-branched, fixing the original 2026-04-26 regression in the same PR that fixes the multi-feature regression.
4. **Test coverage overlaps.** QA tests for AC #4 (per-feature branch correctness) exercise the same code paths that `sprint-branch-auto-create` tests would exercise. Bundling avoids duplicating test setup.
5. **Backlog hygiene.** PO will mark `sprint-branch-auto-create` complete in the Inbox / Done section as part of the merge step; no orphaned items.

**QA implication:** BDD scenarios and integration tests target the bundled behavior. Tests must cover:
- Single-feature sprint started on `main` → auto-branches to `sprint-{N}/{slug}` before any commit.
- Multi-feature sprint → each feature ends up on its own `sprint-{N}/{slug}` branch.
- Pre-existing branch (no divergence) → checked out, not recreated.
- Pre-existing branch (divergent) → surfaced as per-feature `failed`, other features unaffected.

### Helper signature / `SprintState.features` shape change: **NOT NEEDED**

No changes required to `multi-runner.ts` exports or `FeatureState` / `features` shape. The new `currentFeatureSlug` field on `SprintState` is sibling metadata, not a shape change to `features`. The new `feature` field on `CheckpointPrompt` / `CheckpointState` is additive and backward-compatible. **No raise-back to PO required.**

---

## Implementation Order (for Engineer reference)

1. Add `currentFeatureSlug` and per-checkpoint `feature` fields to `state.ts` with backward-compat defaults in `loadSprintState`.
2. Add optional `feature?: string` to `CheckpointPrompt`; thread `featureSlug?` parameter through `buildCheckpointPrompt`.
3. Implement `ensureFeatureBranch` in `multi-runner.ts`. Add unit tests.
4. Extract `runStepForFeature` from the existing `runSprintFromStep` body. Single-feature path uses it directly. Verify all existing tests still pass.
5. Implement `dispatchPerFeatureStep` and the top-of-`runSprintFromStep` dispatcher logic (detection, error cases, multi-feature seeding with already-checked post-processing).
6. Wire the single-feature path's branch tracking through `ensureFeatureBranch` (replaces lines 282–310 of current `runner.ts`).
7. Update `resumeSprint` to find the right feature's step from `state.currentFeatureSlug` when resuming a multi-feature checkpoint, and to reset only that feature's step on `request-changes`.
8. Adjust `renderProgressTable` to annotate steps 1–9 with `(per-feature)` when `state.features` is non-empty (top-level rows only — the per-feature subtables already exist).
9. Update `docs/backlog.md` Inbox to remove `sprint-branch-auto-create` and Done to reflect its bundled completion.
