---
slug: agent-failure-recovery
spec: docs/specs/agent-failure-recovery.md
---

# Agent Failure Recovery — Architecture Design

## Overview

Extend the orchestrator's runner loop with a configurable retry mechanism (default 3 attempts), progressive context enrichment on each retry, a new `"escalated"` sprint status, and the ability to resume sprints from failed/escalated states. Changes are concentrated in `runner.ts`, `state.ts`, `progress.ts`, and `tools.ts` — the workflow definition, prompts, and checkpoints modules are unchanged.

## Components

### 1. Retry Loop in `runner.ts`

The existing single-retry block in `runSprintFromStep` is replaced with a loop:

```
for attempt 1..MAX_RETRIES:
  result = spawnAgent(role, systemPrompt, enrichedContext, taskDesc, cwd)
  if result.exitCode === 0 → break (success)
  if result contains [BLOCKER] → immediate escalation (skip remaining retries)
  record failure in step state (attempt number, error summary, timestamp)
  enrich context for next attempt with: attempt number, previous error output, partial artifacts
```

**Progressive context enrichment**: Each retry appends to the agent's context:
- Attempt N of M
- Previous attempt's output (truncated to 3000 chars)
- Any partial artifacts the previous attempt produced (detected via `validateStepOutputs`)
- Specific guidance: "Your previous attempt failed. Here is what went wrong: {error summary}"

**Immediate escalation on `[BLOCKER]`**: If the agent output contains the string `[BLOCKER]`, skip remaining retries and escalate immediately — the agent has identified a problem it cannot solve.

### 2. Escalation in `runner.ts`

After MAX_RETRIES failures (or immediate `[BLOCKER]` escalation):

1. Set `stepState.status = "escalated"` 
2. Set `state.status = "escalated"`
3. Create an `[ESCALATE]` commit in the project repo via `simple-git`:
   ```
   [ESCALATE] {Role}: step {N} ({name}) failed {attempts} times — requesting user intervention.
   Summary: {concatenated error summaries}
   ```
4. Save state and return a `SprintResult` with `status: "escalated"` and the escalation details

### 3. State Extensions in `state.ts`

**SprintState.status** adds `"escalated"` to the union type:
```typescript
status: "in-progress" | "paused" | "complete" | "failed" | "escalated"
```

**StepState** gains failure tracking fields:
```typescript
interface StepState {
  // ... existing fields
  attempts: number;           // total attempts made (default 0)
  failures: FailureRecord[];  // history of failed attempts
}

interface FailureRecord {
  attempt: number;
  errorSummary: string;     // first 500 chars of agent output
  timestamp: string;        // ISO 8601
  hadPartialArtifacts: boolean;
}
```

`createInitialState` sets `attempts: 0` and `failures: []` for each step. Backward-compatible: if loading old state without these fields, default them.

### 4. Resume from Failed/Escalated in `runner.ts` → `resumeSprint`

Currently `resumeSprint` only accepts `state.status === "paused"`. Extend to also accept `"escalated"` and `"failed"`:

- **With user guidance**: Reset the failed step's attempt counter to 0, clear its failure history, pass the user guidance as feedback context, set `state.status = "in-progress"`, and call `runSprintFromStep` from the failed step.
- **Without guidance (failed only)**: Re-run from the failed step with the existing attempt counter (no reset). If the step has already hit MAX_RETRIES, it will immediately escalate again — this is intentional to prevent silent infinite retries.
- **Escalated without guidance**: Return an error prompting the user to provide guidance, since escalation explicitly means the agent needs human help.

### 5. Progress Table in `progress.ts`

Add new status icons and retry info:
```typescript
STATUS_ICONS["escalated"] = "🚨";

// In the table row, append retry info:
// "⚠ attempt 2/3" when attempts > 0 and status is in-progress
// "🚨 escalated (3/3)" when escalated
```

### 6. `get_project_status` in `tools.ts`

When `orchestratorState.status === "escalated"`, include in the response:
- The escalated step number and role
- The failure records for that step
- The `[ESCALATE]` commit message

### 7. Constants

```typescript
// In runner.ts or a new constants.ts
export const MAX_RETRY_ATTEMPTS = 3;
export const ERROR_SUMMARY_MAX_LENGTH = 500;
export const RETRY_CONTEXT_MAX_LENGTH = 3000;
```

## Data Model

No new files or storage locations. All changes are to the existing `SprintState` shape in `~/.raptor/{project}/sprint-{N}.json`. The shape is backward-compatible — old state files missing `attempts`/`failures` fields are defaulted at load time.

## Sequence Diagram — Retry Flow

```
Orchestrator          Agent              Git
    |                   |                  |
    |--- spawn(ctx) --->|                  |
    |<-- exitCode: 1 ---|                  |
    |                                      |
    | [record failure, enrich context]     |
    |                                      |
    |--- spawn(ctx+err) -->|               |
    |<-- exitCode: 1 ------|               |
    |                                      |
    | [record failure, enrich context]     |
    |                                      |
    |--- spawn(ctx+err) -->|               |
    |<-- exitCode: 1 ------|               |
    |                                      |
    | [3 failures → escalate]              |
    |--- [ESCALATE] commit --------------->|
    | [set status="escalated", save state] |
    | [return to user]                     |
```

## Sequence Diagram — Resume from Escalated

```
User                  Orchestrator         Agent
  |                       |                  |
  |-- resume(guidance) -->|                  |
  |                       | [reset counter]  |
  |                       | [add guidance]   |
  |                       |--- spawn(ctx) -->|
  |                       |<-- exitCode: 0 --|
  |                       | [continue sprint]|
```

## Non-Functional Requirements

- **Latency**: Each retry adds one agent spawn cycle (~5-60s depending on task). MAX_RETRIES=3 means worst case is 3x the current single-retry time.
- **Storage**: Failure records add ~200 bytes per failure. Negligible impact.
- **Backward compatibility**: Old sprint state files load without error. Missing `attempts`/`failures` fields default to 0/[].

## Technology Choices

| Choice | Option | Status |
|---|---|---|
| Retry mechanism | In-process loop in runner.ts | No new dependencies — user-approved |
| Escalation commit | simple-git (already used) | No new dependencies — user-approved |

No new technology choices. All implementation uses existing dependencies (`simple-git`, `child_process`).

## Constraints & Patterns

- The retry loop must NOT catch errors silently — every failure is recorded in state
- `[BLOCKER]` detection uses simple string matching on agent output (case-insensitive)
- Error summaries are truncated to prevent state file bloat
- The `MAX_RETRY_ATTEMPTS` constant is a module-level export, not user-configurable via config.json (out of scope)
- Backward compatibility: always use `stepState.attempts ?? 0` and `stepState.failures ?? []` when reading state
