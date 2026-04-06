---
slug: multi-engineer-coordination
spec: docs/specs/multi-engineer-coordination.md
---
# Multi-Engineer Coordination — Architecture Design

## Overview
Extend the sprint runner to support multiple features within a single sprint, each tracked independently with its own branch, PR, DoD, and merge step. The runner orchestrates per-feature workflows that share common early steps (spec, architecture) but diverge at engineer implementation.

## Components

### 1. Feature-Level State (`src/orchestrator/state.ts`)
Add a `features` field to `SprintState` for multi-feature tracking:

```typescript
interface FeatureState {
  slug: string;
  branchName: string | null;
  status: "pending" | "in-progress" | "complete" | "failed" | "escalated";
  currentStep: number;
  steps: StepState[];
  dod: DodChecklist;
}

interface SprintState {
  // ... existing fields (kept for single-feature backward compat)
  features?: FeatureState[];  // null/undefined = single-feature mode
}
```

**Backward compatibility**: If `features` is undefined/null, the runner uses the existing single-feature path. Multi-feature mode is activated when the backlog has multiple items in the sprint section.

### 2. Multi-Feature Runner (`src/orchestrator/multi-runner.ts`)
New module that extends the runner for multi-feature coordination:

```typescript
async function runMultiFeatureSprint(
  projectPath: string,
  projectSlug: string,
  sprint: number,
  features: string[]
): Promise<SprintResult>
```

Execution strategy:
1. **Steps 1-4** (spec, arch, tests, review): Run sequentially per feature, but features can be at different steps. Feature A might be at step 3 while Feature B is at step 1.
2. **Step 5** (implementation): All features at step 5 run their engineer agents concurrently via `Promise.allSettled`.
3. **Steps 6-9** (PR, review, demo, merge): Each feature runs independently. One feature's demo/merge doesn't block another.
4. **Steps 10-13** (feedback, retro): Run once for the whole sprint, not per-feature.

### 3. Branch Management
Each feature gets its own branch: `sprint-{N}/{feature-slug}`. The runner:
- Creates feature branches from the sprint base branch at step 5
- Tracks branch names in `FeatureState.branchName`
- Each feature opens its own PR and merges independently

### 4. Progress Table
When multi-feature mode is active, `renderProgressTable` groups rows by feature:

```
## 🦖 Sprint 5 — my-project

### Feature: agent-parallel-execution
| Step | Role | Task | Status |
| ... |

### Feature: dino-agent-names
| Step | Role | Task | Status |
| ... |
```

### 5. Feature Detection
The runner detects multi-feature sprints by parsing the backlog:
- Single `- [ ] slug:` item → single-feature mode (existing path)
- Multiple `- [ ] slug:` items → multi-feature mode

## Data Model

```typescript
// New
interface FeatureState {
  slug: string;
  branchName: string | null;
  status: "pending" | "in-progress" | "complete" | "failed" | "escalated";
  currentStep: number;
  steps: StepState[];      // per-feature copy of workflow steps
  dod: DodChecklist;       // per-feature DoD
}

// Extended
interface SprintState {
  // ... all existing fields preserved
  features?: FeatureState[] | null;  // null = single-feature mode
}
```

## API Contracts
No new MCP tools. `run_sprint` and `resume_sprint` auto-detect multi-feature mode. The `get_project_status` response gains a `features` array when in multi-feature mode.

## Non-Functional Requirements
- Agent processes are independent — one feature's agent cannot read another's uncommitted work
- Feature isolation via separate branches prevents cross-contamination
- Sprint state file may grow larger with per-feature step arrays (acceptable for JSON storage)

## Technology Choices

| Area | Choice | Rationale |
|------|--------|-----------|
| Feature concurrency | `Promise.allSettled` | Same pattern as parallel execution; features are independent |
| State storage | Extended `SprintState` | Backward compatible; single-feature sprints unchanged |
| Branch strategy | One branch per feature | Follows TEAM.md convention; clean PR isolation |

## Constraints & Patterns
- Shared steps (spec, architecture) must complete for a feature before its engineer step starts
- Cross-feature dependencies are not supported in Sprint 5 (each feature is independent)
- The existing single-feature `runSprintFromStep` is not modified — `runMultiFeatureSprint` wraps it
- Retro and feedback steps run once per sprint, not per feature
