---
slug: agent-parallel-execution
spec: docs/specs/agent-parallel-execution.md
---
# Agent Parallel Execution — Architecture Design

## Overview
Extend the sprint runner to execute workflow steps concurrently when they share the same dependency and are marked as parallel-eligible. This replaces the purely sequential step loop with a hybrid sequential/parallel executor.

## Components

### 1. Workflow Definition Extension
Add an optional `parallelWith` field to `WorkflowStep`:

```typescript
interface WorkflowStep {
  // ... existing fields
  parallelWith?: number;  // step number this step runs in parallel with
}
```

Parallel groups are pairs. If step 7 has `parallelWith: 7` on step 6, then steps 6 and 7 run concurrently. The lower-numbered step is the "primary" — execution waits until both complete before advancing.

For Sprint 5, two parallel groups:
- **Step 3 (QA) partial with Step 2 (Architect)**: QA starts early with spec-only context. This is a special case — QA doesn't truly run in parallel with step 2; instead, QA is spawned with partial context (spec only) while architecture is being written, then re-spawned with full context after architecture completes. Implemented as a `partialParallelWith` field.
- **Step 7 (QA test run) with Step 7 (Architect review)**: These are the same step number in TEAM.md but split into two runner steps. We'll split the current step 7 into 7a (Architect review) and 7b (QA test run), both running concurrently.

### 2. Runner Parallel Executor (`src/orchestrator/parallel.ts`)
New module with:

```typescript
interface ParallelStepResult {
  step: number;
  success: boolean;
  result: AgentResult;
  escalated: boolean;
}

async function executeParallelSteps(
  steps: WorkflowStep[],
  context: ParallelContext
): Promise<ParallelStepResult[]>
```

- Uses `Promise.allSettled` (not `Promise.all`) to let both steps complete even if one fails
- Each parallel step gets its own circuit breaker (3 retries)
- Results are collected and both must succeed for the group to advance

### 3. Runner Integration
The main loop in `runSprintFromStep` detects parallel groups:
1. When reaching a step that has `parallelWith`, collect both steps
2. Spawn both agents via `executeParallelSteps`
3. Process results — if both succeed, advance; if either fails after retries, escalate
4. Progress table updated after each agent completes (not just after the group)

### 4. State Tracking
Parallel steps are tracked independently in `state.steps[]`. Both show as `in-progress` simultaneously. Their `attempts` and `failures` arrays are independent.

## Data Model

No changes to `SprintState` — existing `steps[]` array already supports independent step tracking. The `WorkflowStep` interface gains:

```typescript
parallelWith?: number;          // run concurrently with this step
partialParallelWith?: number;   // start early with partial context, re-run with full context
```

## API Contracts
No new MCP tools. The existing `run_sprint` and `resume_sprint` tools handle parallel execution transparently.

## Non-Functional Requirements
- Parallel steps must not share mutable state (each gets its own agent process)
- Total timeout for a parallel group = max(individual timeouts), not sum
- Memory: two concurrent agent processes instead of one — acceptable for the host machine

## Technology Choices

| Area | Choice | Rationale |
|------|--------|-----------|
| Concurrency | `Promise.allSettled` | Allows both steps to complete; avoids early rejection |
| State | Existing `steps[]` | No schema migration needed; steps already independent |

## Constraints & Patterns
- Parallel groups are always pairs (no 3+ parallel steps in Sprint 5)
- The sequential-then-parallel-then-sequential pattern keeps the runner loop simple
- Partial parallelism (step 3) is a special case with two agent spawns, not true concurrency
