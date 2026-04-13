# Progressive Retry with Scope Narrowing — Architecture Design

## Overview
Enhance the circuit breaker retry logic so the third attempt (final before escalation) automatically decomposes the failed task into smaller sub-tasks. Each sub-task runs independently, and results are aggregated. This converts "all-or-nothing" failures into partial progress.

## Components

### 1. `src/orchestrator/scope-narrowing.ts` (new module)
Decomposition strategies and sub-task execution.

```typescript
export interface SubTask {
  id: string;              // e.g. "ac-1", "scenario-happy-path"
  description: string;     // focused task description
  scope: string;           // what this sub-task covers
  inputContext: string;     // relevant subset of the full context
}

export interface NarrowingResult {
  strategy: string;        // "by-acceptance-criteria" | "by-scenario-group" | "by-component"
  subTasks: SubTask[];
  completedIds: string[];
  failedIds: string[];
  aggregatedOutput: string;
  partialProgress: boolean; // true if some but not all sub-tasks succeeded
}

export interface NarrowingConfig {
  enabled: boolean;          // default true
  disabledSteps?: string[];  // step names to skip narrowing for
}

// Decompose a failed task into sub-tasks based on role
export function decomposeTask(
  role: Role,
  step: WorkflowStep,
  featureSlug: string,
  projectPath: string,
  originalTaskDesc: string
): SubTask[];

// Execute sub-tasks sequentially and aggregate results
export async function executeNarrowedRetry(
  subTasks: SubTask[],
  role: Role,
  systemPrompt: string,
  baseContext: string,
  projectPath: string,
  timeoutMs: number
): Promise<NarrowingResult>;
```

### 2. Decomposition Strategies

**Engineer (by acceptance criteria):**
- Parse the spec file for `## Acceptance Criteria` section
- Extract individual criteria (lines starting with `- [ ]`)
- Each sub-task targets one criterion: "Implement ONLY the following acceptance criterion: {criterion}"
- If no parseable criteria, fall back to single retry with simplified instructions

**QA (by scenario group):**
- Split BDD scenarios into groups: happy path, error cases, edge cases
- Heuristic: scenarios with "error", "invalid", "fail" → error group; "edge", "boundary", "empty" → edge group; rest → happy path
- Each sub-task: "Write BDD scenarios and integration tests for the following group only: {group}"

**Architect (by component):**
- Parse the spec for distinct components (## sections or bullet points under ## Components)
- Each sub-task: "Design the architecture for the following component only: {component}"
- If only one component, fall back to simplified retry with explicit constraints

**PO and Team roles:** Not narrowed — these are checkpoint-adjacent and don't benefit from decomposition.

### 3. Changes to `src/orchestrator/runner.ts`
In the standard agent step retry loop, replace attempt 3 logic:

```typescript
for (let attempt = stepState.attempts + 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
  // ... existing prompt building ...

  // On final attempt, try scope narrowing
  if (attempt === MAX_RETRY_ATTEMPTS && isNarrowable(step.role)) {
    const subTasks = decomposeTask(step.role, step, featureSlug, projectPath, taskDesc);
    
    if (subTasks.length > 1) {
      const narrowResult = await executeNarrowedRetry(
        subTasks, step.role, systemPrompt, context, projectPath, stepTimeout
      );
      
      if (narrowResult.completedIds.length === narrowResult.subTasks.length) {
        // All sub-tasks succeeded
        succeeded = true;
        break;
      }
      
      if (narrowResult.partialProgress) {
        // Some succeeded — record partial progress in failure, then escalate
        stepState.failures.push({
          attempt,
          errorSummary: `Narrowed retry: ${narrowResult.completedIds.length}/${subTasks.length} sub-tasks completed. Failed: ${narrowResult.failedIds.join(", ")}`,
          timestamp: new Date().toISOString(),
          hadPartialArtifacts: true,
        });
        // Don't break — fall through to escalation with better context
        continue;
      }
    }
    
    // Fall through to normal retry if decomposition produced ≤1 sub-task
  }
  
  // ... existing normal attempt logic ...
}
```

### 4. Progress table integration
Changes to `src/orchestrator/progress.ts`:
- When a step is in narrowed retry mode, show `"narrowed (2/4)"` in the status column
- Add optional `narrowingProgress` field to step state

### 5. State extension in `src/orchestrator/state.ts`
```typescript
// Add to StepState:
narrowingProgress?: {
  totalSubTasks: number;
  completedSubTasks: number;
  strategy: string;
};
```

### 6. Config extension in `src/config.ts`
```typescript
scopeNarrowing?: {
  enabled?: boolean;          // default true
  disabledSteps?: string[];   // step names to skip
}
```

## Sub-Task Execution Flow
```
Attempt 3 triggered
  → decomposeTask(role, step, slug, path, taskDesc)
  → returns SubTask[] (e.g., 4 acceptance criteria)
  → for each subTask:
      → spawnAgent(role, systemPrompt, subTask.inputContext, subTask.description, path, timeout)
      → record success/failure per sub-task
  → aggregateResults()
  → if all pass: step succeeds
  → if partial: escalate with detailed progress report
  → if all fail: escalate normally
```

Sub-tasks run **sequentially**, not in parallel. Rationale: they may have implicit ordering dependencies (e.g., AC-2 builds on code from AC-1), and sequential execution lets later sub-tasks see artifacts from earlier ones.

## Non-Functional Requirements
- Decomposition must complete in < 200ms (regex parsing only, no LLM calls)
- Each sub-task gets the same timeout as the original step (not divided)
- Total narrowed retry time is bounded by `subTasks.length * stepTimeout` — worst case 4 × 15min = 60min for QA

## Constraints
- Narrowing only on attempt 3 — attempts 1-2 are unchanged (preserves current behavior)
- No LLM-based decomposition — strategies are deterministic regex/heuristic
- PO and Team roles are never narrowed
- If decomposition fails to produce >1 sub-task, falls back to normal retry
- Sub-task count capped at 6 to prevent runaway execution
