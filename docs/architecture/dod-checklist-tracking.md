---
slug: dod-checklist-tracking
spec: docs/specs/dod-checklist-tracking.md
---

# DoD Checklist Tracking — Architecture Design

## Overview

Add a `dod` object to `SprintState` that tracks each Definition of Done item as a boolean. The orchestrator updates these flags as steps and checkpoints complete. Before the merge step (step 9), the orchestrator updates the PR description via `gh pr edit` to show all checklist items as checked. Small, surgical changes across state, runner, merge, and tools.

## Components

### 1. State Extension in `state.ts`

```typescript
export interface DodChecklist {
  codeCommitted: boolean;      // step 6 (Open PR) complete
  testsPass: boolean;          // step 7 (Run test suite) complete
  prReviewApproved: boolean;   // "pr-review" checkpoint approved
  poAccepted: boolean;         // "demo-feedback" checkpoint approved
  demoCompleted: boolean;      // step 8 (Demo) complete
}

// Add to SprintState:
export interface SprintState {
  // ... existing fields
  dod: DodChecklist;
}
```

Default in `createInitialState`: all `false`. Backward-compatible: `loadSprintState` defaults missing `dod` to all-false.

### 2. Runner Updates in `runner.ts`

After each relevant step/checkpoint, update the corresponding DoD flag:

| Event | DoD Field | Where in Code |
|---|---|---|
| Step 6 completes | `codeCommitted = true` | After step 6 marked complete |
| "pr-review" checkpoint approved | `prReviewApproved = true` | In `resumeSprint` when resolving pr-review |
| Step 7 completes | `testsPass = true` | After step 7 marked complete |
| Step 8 completes | `demoCompleted = true` | After step 8 marked complete |
| "demo-feedback" checkpoint approved | `poAccepted = true` | In `resumeSprint` when resolving demo-feedback |

These are simple one-line assignments after existing state transitions — minimal code change.

### 3. PR Description Update in `merge.ts`

Before executing the merge, update the PR description:

```typescript
export async function updatePrDodChecklist(cwd: string, dod: DodChecklist): Promise<boolean>
```

This function:
1. Runs `gh pr view --json body --jq .body` to get current PR description
2. Replaces unchecked DoD items (`- [ ]`) with checked (`- [x]`) based on the DoD flags
3. Runs `gh pr edit --body "{updated body}"` to update
4. Returns `true` if successful, `false` if `gh` is unavailable or the update fails

If `gh` is not available, returns `false` — the merge step proceeds anyway and includes a DoD summary in the merge commit message instead.

Called from `runner.ts` just before `executeMerge`:

```typescript
if (step.name === "Merge PR") {
  // Update PR description with DoD checklist
  await updatePrDodChecklist(projectPath, state.dod);
  // Then proceed with merge...
}
```

### 4. Progress Table in `progress.ts`

After the step table, if all DoD items are satisfied, add:

```
**Definition of Done: ✅ all items satisfied**
```

If not all satisfied (shouldn't happen at merge time, but defensive), show which are missing.

### 5. Status Extension in `tools.ts`

Add `dod` to the orchestrator state in `get_project_status`:

```typescript
orchestratorState = {
  // ... existing fields
  dod: sprintState.dod,
};
```

## Data Model

No new files. `DodChecklist` is a sub-object of `SprintState` in `~/.raptor/{project}/sprint-{N}.json`.

## Non-Functional Requirements

- **Latency**: DoD flag updates are in-memory assignments. PR description update is one `gh` call (~2s).
- **Robustness**: `gh` failure for PR update is non-blocking — merge proceeds anyway.

## Technology Choices

No new dependencies. Uses `gh` CLI (already used by merge module).

## Constraints & Patterns

- DoD flags are set individually at the exact moment each condition is met — not batch-computed
- PR description update is best-effort — failure doesn't block the merge
- The DoD regex replacement in `updatePrDodChecklist` matches the standard PR template markers (e.g., `- [ ] All tests pass` → `- [x] All tests pass`)
