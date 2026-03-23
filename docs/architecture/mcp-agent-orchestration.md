---
slug: mcp-agent-orchestration
spec: docs/specs/mcp-agent-orchestration.md
---

# Agent Orchestration — Architecture Design

## Overview

A new `run_sprint` MCP tool is added to Raptor. When invoked, an **Orchestrator** drives the sprint workflow sequentially — spawning a Claude CLI subagent for each role, committing artifacts, and pausing at four user checkpoints. The orchestrator renders a structured progress table to the main session after each step completes.

## Components

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code (main session)              │
│                        MCP Client, stdio                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ stdin/stdout
┌──────────────────────────▼──────────────────────────────────┐
│                      Raptor Server                           │
│                       (index.ts)                             │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ bootstrap_   │  │ list_        │  │ get_project_       │ │
│  │ project      │  │ projects     │  │ status             │ │
│  └──────────────┘  └──────────────┘  └────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   run_sprint (NEW)                      │ │
│  │                                                         │ │
│  │  ┌─────────────────────────────────────────────────┐    │ │
│  │  │              Orchestrator                        │    │ │
│  │  │                                                  │    │ │
│  │  │  workflow.ts   — step definitions & ordering     │    │ │
│  │  │  runner.ts     — execute steps, manage state     │    │ │
│  │  │  agents.ts     — spawn CLI subagents per role    │    │ │
│  │  │  prompts.ts    — role-scoped system prompts      │    │ │
│  │  │  progress.ts   — render progress table           │    │ │
│  │  │  checkpoints.ts— user checkpoint interactions    │    │ │
│  │  └─────────────────────────────────────────────────┘    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │ registry   │  │ template   │  │ config     │             │
│  └────────────┘  └────────────┘  └────────────┘             │
└──────────────────────────────────────────────────────────────┘
         │                              │
         │  claude CLI (subagents)      │  simple-git
         ▼                              ▼
┌──────────────────┐          ┌──────────────────────┐
│  Role Subagents  │          │  Project Git Repo    │
│  (PO, Architect, │          │  ~/projects/{name}/  │
│   QA, Engineer)  │          └──────────────────────┘
└──────────────────┘
```

## Technology Choice: Subagent Invocation

**Decision**: Use the `claude` CLI to spawn subagents via `child_process.execFile`.

| Option | Pros | Cons |
|--------|------|------|
| **claude CLI** (chosen) | No new dependencies; works in the user's existing Claude Code environment; inherits auth, model config, and MCP servers; simple to invoke | Less control over streaming; output captured after completion; requires `claude` on PATH |
| Claude API (Anthropic SDK) | Full control over system prompts, streaming, tool use | New dependency; requires API key management; doesn't inherit user's Claude Code config; more complex |

**Rationale**: Raptor runs inside Claude Code — the `claude` CLI is already available. Shelling out to it keeps the dependency footprint minimal and lets subagents inherit the user's environment. The tradeoff (less streaming control) is acceptable for Sprint 2's sequential execution model.

**Status**: Proposed — requires user approval per TEAM.md.

### CLI Invocation Pattern

```bash
claude --print --system-prompt "$(cat role-prompt.txt)" --append-system-prompt "$(cat context.txt)" "Execute your role for this sprint step"
```

- `--print`: non-interactive mode, outputs result to stdout
- `--system-prompt`: role-scoped prompt (responsibilities, boundaries from TEAM.md)
- `--append-system-prompt`: sprint-specific context (spec content, architecture, test files, etc.)
- The working directory is set to the project repo so the subagent can read/write files and use git

Subagent output is captured as a string, parsed for expected artifacts, and committed by the orchestrator.

## Data Model

### Sprint State (`~/.raptor/{project-slug}/sprint-{N}.json`)

Persisted after each step so a crashed sprint can report its last known state via `get_project_status`.

```json
{
  "project": "my-app",
  "sprint": 2,
  "status": "in-progress",
  "currentStep": 3,
  "steps": [
    {
      "step": 1,
      "role": "po",
      "name": "Author specification",
      "status": "complete",
      "artifacts": ["docs/specs/user-login.md"],
      "completedAt": "2026-03-22T10:00:00Z"
    },
    {
      "step": 2,
      "role": "architect",
      "name": "Architecture design",
      "status": "complete",
      "artifacts": ["docs/architecture/user-login.md"],
      "completedAt": "2026-03-22T10:02:00Z"
    },
    {
      "step": 3,
      "role": "qa",
      "name": "Write tests",
      "status": "in-progress",
      "artifacts": [],
      "completedAt": null
    }
  ],
  "checkpoints": [
    {
      "type": "spec-review",
      "status": "approved",
      "feedback": null,
      "resolvedAt": "2026-03-22T10:01:00Z"
    }
  ]
}
```

### Workflow Steps (hardcoded in `workflow.ts`)

```typescript
interface WorkflowStep {
  step: number;
  role: "po" | "architect" | "qa" | "engineer";
  name: string;
  description: string;
  checkpointAfter?: CheckpointType;  // pause for user after this step
  inputArtifacts: string[];           // glob patterns for files to pass as context
  expectedOutputs: string[];          // glob patterns for expected artifacts
}

type CheckpointType = "spec-review" | "tech-approval" | "pr-review" | "demo-feedback";
```

The workflow steps map directly to TEAM.md Sprint Workflow steps 1–9:

| Step | Role | Checkpoint After? | Input Artifacts | Expected Outputs |
|------|------|-------------------|-----------------|------------------|
| 1 | PO | `spec-review` | `docs/backlog.md` | `docs/specs/{slug}.md` |
| 2 | Architect | `tech-approval` | spec | `docs/architecture/{slug}.md`, `docs/adr/ADR-*.md` |
| 3 | QA | — | spec, architecture | `tests/bdd/{slug}.feature`, `tests/integration/*` |
| 4 | PO | — | tests (for review) | approval (commit message) |
| 5 | Engineer | — | spec, architecture, tests | `src/**`, unit tests |
| 6 | Engineer | `pr-review` | (continues from 5) | PR opened, code committed |
| 7 | QA | — | PR, code | test execution results |
| 8 | Demo | `demo-feedback` | all artifacts | demo notes |
| 9 | PO | — | user feedback | backlog updates |

## API Contract

### `run_sprint` Tool

**Input Schema (Zod)**:
```typescript
{
  name: z.string().describe("Project name as registered in Raptor"),
  sprint: z.number().int().positive().describe("Sprint number to run"),
}
```

**Output**:

The tool returns a structured result after each significant event (step completion, checkpoint reached, error). Because MCP tool results are single responses, the orchestrator uses **progressive content** — it returns multiple `text` content blocks as the sprint progresses:

```json
{
  "content": [
    { "type": "text", "text": "## Sprint Progress\n\n| Step | Role | Status |\n..." },
    { "type": "text", "text": "\n## Checkpoint: Spec Review\n\nThe PO has authored the following spec...\n\n**Action required**: Approve / Request changes\nFeedback (optional): " }
  ]
}
```

However, since MCP tools return a single response, the orchestrator must complete the full sprint in one tool call. **Checkpoints are implemented by returning control to the MCP client (Claude Code) with a prompt for the user, then using a `resume_sprint` tool to continue.**

### `resume_sprint` Tool

**Input Schema (Zod)**:
```typescript
{
  name: z.string().describe("Project name"),
  sprint: z.number().int().positive().describe("Sprint number"),
  action: z.enum(["approve", "request-changes"]).describe("User's decision at the checkpoint"),
  feedback: z.string().optional().describe("Free-text feedback from the user"),
}
```

**Output**: Same progressive format as `run_sprint` — continues from the last checkpoint through to the next checkpoint or sprint completion.

## Sequence Diagram

```
User          Claude Code         Raptor MCP           claude CLI
  │               │                   │                     │
  │ "run sprint"  │                   │                     │
  │──────────────>│                   │                     │
  │               │  run_sprint(name) │                     │
  │               │──────────────────>│                     │
  │               │                   │ validate project    │
  │               │                   │ load backlog items  │
  │               │                   │                     │
  │               │                   │ spawn PO subagent   │
  │               │                   │────────────────────>│
  │               │                   │    spec artifacts   │
  │               │                   │<────────────────────│
  │               │                   │ commit [PO] + [HANDOFF]
  │               │                   │ save sprint state   │
  │               │   progress table  │                     │
  │               │   + checkpoint    │                     │
  │               │<──────────────────│                     │
  │  "Here's the  │                   │                     │
  │   spec..."    │                   │                     │
  │<──────────────│                   │                     │
  │               │                   │                     │
  │ "Approve"     │                   │                     │
  │──────────────>│                   │                     │
  │               │ resume_sprint     │                     │
  │               │ (approve)         │                     │
  │               │──────────────────>│                     │
  │               │                   │ spawn Architect     │
  │               │                   │────────────────────>│
  │               │                   │  ... continues ...  │
```

## Module Design

### `src/orchestrator/workflow.ts`
- Exports `SPRINT_WORKFLOW: WorkflowStep[]` — the ordered list of steps
- Exports `CheckpointType` and `StepStatus` types
- Pure data, no side effects

### `src/orchestrator/runner.ts`
- `runSprintFromStep(ctx, project, sprint, fromStep): SprintResult` — executes steps sequentially from a given step until completion or the next checkpoint
- Reads sprint state from disk, runs each step, saves state after each step
- On checkpoint: saves state and returns with checkpoint info
- On error: saves state with error details and returns

### `src/orchestrator/agents.ts`
- `spawnAgent(role, systemPrompt, context, cwd): AgentResult` — shells out to `claude` CLI
- Uses `child_process.execFile` with `--print`, `--system-prompt`, `--append-system-prompt`
- Captures stdout as the agent's output
- Returns `{ output: string, exitCode: number }`
- Timeout: 5 minutes per agent invocation (configurable)

### `src/orchestrator/prompts.ts`
- `buildRolePrompt(role): string` — extracts the relevant role section from TEAM.md
- `buildStepContext(step, projectPath): string` — reads input artifacts from disk and formats them as context for the subagent
- Role prompts include: responsibilities, boundaries, decision authority, and the specific task for this step

### `src/orchestrator/progress.ts`
- `renderProgressTable(sprintState): string` — renders a markdown table showing all steps with status indicators
- Format:

```
## 🦖 Sprint 2 — my-app

| Step | Role       | Task                  | Status |
|------|------------|-----------------------|--------|
| 1    | PO         | Author specification  | ✅      |
| 2    | Architect  | Architecture design   | ✅      |
| 3    | QA         | Write tests           | 🔄      |
| 4    | PO         | Review tests          | ⬜      |
| 5    | Engineer   | Implement (TDD)       | ⬜      |
| 6    | Engineer   | Open PR               | ⬜      |
| 7    | QA         | Run test suite        | ⬜      |
| 8    | Team       | Demo                  | ⬜      |
| 9    | PO         | Process feedback      | ⬜      |
```

### `src/orchestrator/checkpoints.ts`
- `buildCheckpointPrompt(type, context): CheckpointResult` — formats the checkpoint message with structured options
- Returns the relevant artifacts for the user to review plus the action prompt
- Format:

```
## Checkpoint: Spec Review

[spec content or summary]

**What would you like to do?**
- **Approve** — proceed to architecture design
- **Request changes** — provide feedback for the PO to revise

Feedback (optional):
```

### `src/orchestrator/state.ts`
- `loadSprintState(project, sprint): SprintState | null`
- `saveSprintState(project, sprint, state): void`
- Reads/writes `~/.raptor/{project-slug}/sprint-{N}.json`

## Non-Functional Requirements

- **Latency**: Each subagent invocation may take 30s–3min depending on complexity. Full sprint: 5–15min. Acceptable for v1.
- **Reliability**: Sprint state is persisted after every step. A crash mid-sprint leaves the state recoverable — `get_project_status` reports the last completed step.
- **Resource usage**: One subagent at a time (sequential). No risk of spawning runaway processes.
- **Security**: Subagents run as the user's `claude` CLI process with the same permissions. No privilege escalation. Subagent system prompts are constructed from TEAM.md content, not user input (no injection risk).

## Constraints & Patterns

- All new orchestrator code goes in `src/orchestrator/` — kept separate from existing tool modules
- The orchestrator imports existing modules (`registry`, `config`, `backlog-parser`, `git-parser`) but does not modify them
- Sprint state is stored under `~/.raptor/{project-slug}/` alongside the existing project registry
- Subagent output is treated as untrusted — the orchestrator validates expected artifacts exist on disk after each step before proceeding
- Git operations continue to use `simple-git` — the orchestrator commits handoff and status messages, subagents commit their own work artifacts
