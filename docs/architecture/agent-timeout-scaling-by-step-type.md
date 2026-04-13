---
slug: agent-timeout-scaling-by-step-type
spec: docs/specs/agent-timeout-scaling-by-step-type.md
---
# Agent Timeout Scaling by Step Type — Architecture Design

## Overview
Replace the flat 5-minute agent timeout with step-aware scaling. Complex generation steps (QA test writing, engineer implementation) get longer timeouts. Values are configurable per project.

## Components

### 1. Timeout Resolution (`src/orchestrator/timeouts.ts`)
New module for timeout calculation:

```typescript
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes cap
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const STEP_TIMEOUT_DEFAULTS: Record<string, number> = {
  "Write tests": 15 * 60 * 1000,        // 15 min — QA generates BDD + integration + performance tests
  "Implement (TDD)": 10 * 60 * 1000,    // 10 min — Engineer reads artifacts + writes code + runs tests
  "Architecture design": 7 * 60 * 1000, // 7 min — Architect reads spec + produces design doc
  "Collect retro proposals": 5 * 60 * 1000, // 5 min — 4 agents in sequence
};

interface TimeoutConfig {
  default?: number;
  stepOverrides?: Record<string, number>;
}

function resolveStepTimeout(stepName: string, config?: TimeoutConfig): number
```

Resolution order:
1. Config `stepOverrides[stepName]` (if present and valid)
2. Config `default` (if present and valid)
3. `STEP_TIMEOUT_DEFAULTS[stepName]` (built-in per-step default)
4. `DEFAULT_TIMEOUT_MS` (global fallback)

Validation: timeout must be > 0 and <= MAX_TIMEOUT_MS. Invalid values fall back to the next level.

### 2. Agent Spawn Extension (`src/orchestrator/agents.ts`)
Add optional `timeoutMs` parameter to `spawnAgent`:

```typescript
function spawnAgent(
  role: Role,
  systemPrompt: string,
  context: string,
  taskDescription: string,
  cwd: string,
  timeoutMs?: number  // NEW — optional, falls back to AGENT_TIMEOUT_MS
): Promise<AgentResult>
```

The `execFile` call uses `timeoutMs` or the existing `AGENT_TIMEOUT_MS` constant.

### 3. Runner Integration (`src/orchestrator/runner.ts`)
In `runSprintFromStep`, resolve the timeout for each step before spawning the agent:

```typescript
const stepTimeout = resolveStepTimeout(step.name, config?.timeouts);
const result = await spawnAgent(step.role, systemPrompt, context, taskDesc, projectPath, stepTimeout);
```

### 4. Config Extension (`src/config.ts`)
Add optional `timeouts` field to `RaptorConfig`:

```typescript
interface RaptorConfig {
  // ... existing
  timeouts?: {
    default?: number;
    stepOverrides?: Record<string, number>;
  };
}
```

### 5. Progress Display (`src/orchestrator/progress.ts`)
When a step is in-progress with a non-default timeout, show it:

```
| 3 | 🔍 Vex (QA) | Write tests | 🔄 (15min timeout) |
```

## Data Model
No state schema changes. Timeouts are resolved at runtime.

## API Contracts
No new MCP tools. Timeout behavior is transparent to the user.

## Non-Functional Requirements
- Timeout resolution is synchronous and cached per sprint run
- No new dependencies

## Technology Choices

| Area | Choice | Rationale |
|------|--------|-----------|
| Config | Existing `config.json` | No new config files; consistent with dinoNames pattern |
| Cap | 30 minutes | Prevents runaway agents; can be adjusted if needed |

## Constraints & Patterns
- Backward compatible: existing behavior unchanged if no config is set
- AGENT_TIMEOUT_MS constant remains for code that doesn't use the new parameter
- The 30-minute cap is a safety net, not a recommendation
