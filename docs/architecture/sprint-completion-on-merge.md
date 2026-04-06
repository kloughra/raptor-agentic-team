---
slug: sprint-completion-on-merge
spec: docs/specs/sprint-completion-on-merge.md
---

# Sprint Completion on Merge — Architecture Design

## Overview

Restructure the end-of-sprint workflow so that after the demo checkpoint is approved, the orchestrator merges the sprint PR (squash-merge) and then runs PO feedback processing on the main branch. A new workflow step 9.5 ("Merge PR") is inserted between the current steps 9 (process feedback) and the sprint completion. The workflow becomes: demo (8) → merge PR (new 9) → process feedback (new 10) → complete.

## Components

### 1. Workflow Update in `workflow.ts`

Renumber steps and insert a merge step. The new workflow:

| Old Step | New Step | Role | Name | Checkpoint |
|----------|----------|------|------|------------|
| 1 | 1 | PO | Author specification | spec-review |
| 2 | 2 | Architect | Architecture design | tech-approval |
| 3 | 3 | QA | Write tests | — |
| 4 | 4 | PO | Review tests | — |
| 5 | 5 | Engineer | Implement (TDD) | — |
| 6 | 6 | Engineer | Open PR | pr-review |
| 7 | 7 | QA | Run test suite | — |
| 8 | 8 | Team | Demo | demo-feedback |
| — | **9** | **Engineer** | **Merge PR** | — |
| 9 | **10** | PO | Process feedback | — |

The new step 9 ("Merge PR"):
```typescript
{
  step: 9,
  role: "engineer",
  name: "Merge PR",
  description: "Squash-merge the sprint PR after all approvals are in",
  inputArtifacts: [],
  expectedOutputs: [],
}
```

Step 9 does NOT have a checkpoint — the demo-feedback checkpoint at step 8 is the last user interaction. After approval there, the merge proceeds automatically.

### 2. Merge Logic in `runner.ts`

Instead of spawning a subagent for the merge step, the orchestrator handles it directly. When executing step 9 ("Merge PR"):

```typescript
if (step.name === "Merge PR") {
  const mergeResult = await executeMerge(projectPath, featureSlug, sprint);
  // handle result...
  // skip to next step
}
```

New function `executeMerge(projectPath, featureSlug, sprint)`:

1. **Detect merge method**: Check if a GitHub PR exists for the current branch
   - Run `gh pr view --json state,number,headRefName` from the project directory
   - If `gh` succeeds and PR is open → use `gh pr merge --squash`
   - If `gh` fails (not installed, no remote, not a GitHub repo) → use local `git merge --squash`
   - If PR is already merged → skip merge, return success

2. **GitHub merge path**:
   ```
   gh pr merge --squash --body "Sprint {N}: {feature-slug}\n\nSquash-merged by Raptor orchestrator"
   ```

3. **Local merge path**:
   ```
   git checkout main
   git merge --squash {branch}
   git commit -m "Sprint {N}: {feature-slug} — squash-merge"
   git checkout {branch}  // return to branch for remaining steps
   ```
   Wait — after local merge we need step 10 (PO feedback) to run on main. So:
   ```
   git checkout main
   git merge --squash sprint-{N}/{feature-slug}
   git commit -m "Sprint {N}: {feature-slug} — squash-merge by Raptor"
   ```
   Step 10 then runs in the project directory which is now on `main`.

4. **Failure handling**: If merge fails (conflicts, branch protection, etc.), return an error result that triggers the retry/escalation logic from `agent-failure-recovery`. The merge step participates in the same retry circuit breaker as agent steps.

### 3. Merge Module: `src/orchestrator/merge.ts`

New module to encapsulate merge logic, keeping `runner.ts` clean:

```typescript
export interface MergeResult {
  success: boolean;
  method: "github" | "local";
  error?: string;
  alreadyMerged?: boolean;
}

export async function executeMerge(
  projectPath: string,
  featureSlug: string,
  sprint: number,
  branchName: string
): Promise<MergeResult>
```

This function:
- Detects whether to use `gh` or local git
- Executes the merge
- Returns a structured result
- Does NOT throw — all errors are returned in the result object

### 4. Branch Name Tracking in State

The runner needs to know the sprint branch name for the merge step. Currently it's not tracked in state.

Add to `SprintState`:
```typescript
interface SprintState {
  // ... existing fields
  branchName: string | null;  // e.g., "sprint-3/runner-hardening"
}
```

The branch name is detected when the sprint starts (in `runSprintFromStep`) by reading the current git branch:
```typescript
const git = simpleGit(projectPath);
const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
state.branchName = branch;
```

### 5. Progress Table in `progress.ts`

The merge step appears in the progress table like any other step. No special rendering needed — the existing status icons cover it:
- ⬜ pending → 🔄 in-progress → ✅ complete
- ❌ failed / 🚨 escalated (if merge fails, via agent-failure-recovery)

### 6. `get_project_status` in `tools.ts`

Add a `merged` field to the sprint section of the status response:
```typescript
sprint: {
  current: sprintNumber,
  items: [...],
  merged: boolean,  // true if the merge step is complete
}
```

### 7. TEAM.md Sprint Workflow Update

Update the Sprint Workflow section in TEAM.md to reflect the new step ordering:
```
9.  Orchestrator: Squash-merge the sprint PR (automatic after demo approval)
      Depends on: step 8 (demo approved by user)
      
10. PO: Collect user feedback → triage → update backlog
      Depends on: step 9 (merge complete)
```

Also update the Definition of Done to include "PR merged to main".

### 8. Handoff Map Update in `workflow.ts`

Add the new handoff entry:
```typescript
9: { from: "engineer", to: "po", artifact: "merged PR" },
```

Renumber the existing step 8 handoff:
```typescript
8: { from: "team", to: "engineer", artifact: "demo approval" },
```

## Data Model

**New file**: `src/orchestrator/merge.ts` — merge execution logic  
**Modified state**: `SprintState.branchName` added (nullable, backward-compatible)  
**Modified workflow**: Step numbering changes from 9 steps to 10 steps

### State Migration

Old sprint states (with 9 steps) will have `branchName: undefined`. The code handles this by:
- Defaulting `branchName` to `null` on load
- Detecting the branch at runtime if not in state

Old sprint states with 9 steps won't match the new 10-step workflow. Since sprints 1-2 are already complete, this is not a practical concern — only new sprints use the new workflow. No migration needed.

## Sequence Diagram — End of Sprint

```
User              Orchestrator           Git/GitHub
  |                    |                     |
  |-- approve demo --->|                     |
  |                    |                     |
  |                    | [step 9: merge PR]  |
  |                    |-- gh pr merge ------>|
  |                    |<-- merged -----------|
  |                    |                     |
  |                    | [step 10: PO feedback]
  |                    |-- spawn PO agent     |
  |                    |<-- backlog updated   |
  |                    |                     |
  |                    | [status: complete]   |
  |<-- sprint done ----|                     |
```

## Non-Functional Requirements

- **Latency**: Merge via `gh` takes 2-5s. Local merge <1s. Negligible addition to sprint time.
- **Reliability**: Merge failures are handled by the circuit breaker from agent-failure-recovery — no silent failures
- **External dependency**: `gh` CLI is optional; local git merge is the fallback. No hard dependency added.

## Technology Choices

| Choice | Option | Status |
|---|---|---|
| GitHub merge | `gh` CLI (already available in dev environment) | No new dependency — user-approved |
| Local merge fallback | `simple-git` (already used) | No new dependency — user-approved |

No new technology choices requiring user approval.

## Constraints & Patterns

- The merge step does NOT spawn a subagent — it's orchestrator-managed logic
- The merge step participates in the retry/escalation circuit breaker (from agent-failure-recovery)
- Squash-merge is always used — no configurable merge strategy
- After merge, the PO feedback step runs on `main` (the orchestrator's working directory is the project root, and after merge the active branch is `main`)
- Branch cleanup (remote delete) is explicitly out of scope
