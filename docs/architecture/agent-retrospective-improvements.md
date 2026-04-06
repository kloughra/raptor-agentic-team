---
slug: agent-retrospective-improvements
spec: docs/specs/agent-retrospective-improvements.md
---

# Agent Retrospective Improvements — Architecture Design

## Overview

After the PO processes feedback (step 10), the workflow enters a retro phase: steps 11-13. The orchestrator spawns each role agent to propose one TEAM.md improvement, collects proposals into a retro document, presents them at a new user checkpoint, and applies selected improvements. This extends the workflow from 10 to 13 steps and adds a new checkpoint type.

## Components

### 1. Workflow Extension in `workflow.ts`

Add three new steps and a new checkpoint type:

```typescript
// New checkpoint type
export type CheckpointType = "spec-review" | "tech-approval" | "pr-review" | "demo-feedback" | "retro-review";

// New steps
{
  step: 11,
  role: "team",
  name: "Collect retro proposals",
  description: "Each role proposes one TEAM.md improvement based on their sprint experience",
  inputArtifacts: ["TEAM.md"],
  expectedOutputs: ["docs/sprints/*.md"],
},
{
  step: 12,
  role: "team",
  name: "Review retro proposals",
  description: "User reviews all proposals and selects which improvements to adopt",
  checkpointAfter: "retro-review",
  inputArtifacts: ["docs/sprints/*.md"],
  expectedOutputs: [],
},
{
  step: 13,
  role: "po",
  name: "Apply retro improvements",
  description: "Apply selected TEAM.md improvements and finalize the sprint",
  inputArtifacts: ["TEAM.md", "docs/sprints/*.md"],
  expectedOutputs: ["TEAM.md"],
},
```

Handoff map additions:
```typescript
10: { from: "po", to: "team", artifact: "feedback processed" },
11: { from: "team", to: "team", artifact: "retro proposals" },
12: { from: "team", to: "po", artifact: "retro selections" },
```

### 2. Retro Module: `src/orchestrator/retro.ts`

New module encapsulating retro logic:

```typescript
export interface RetroProposal {
  role: Role;
  section: string;
  type: "addition" | "modification" | "removal";
  proposal: string;
  rationale: string;
  impact: string;
}

export function buildRetroPrompt(role: Role, teamMd: string, sprintContext: string): string
export function parseRetroProposal(role: Role, agentOutput: string): RetroProposal | null
export function generateRetroDocument(projectSlug: string, sprint: number, proposals: RetroProposal[]): string
export function applyImprovements(teamMdContent: string, proposals: RetroProposal[]): string
```

**`buildRetroPrompt`**: Builds a focused prompt for the role asking it to propose exactly one improvement. Includes:
- The role's section of TEAM.md
- A brief sprint summary (from sprint state: which steps had failures, what was built)
- The proposal template format
- Clear instruction: "Propose ONE improvement. Focus on what would have helped you this sprint."

**`parseRetroProposal`**: Parses the agent's markdown output into a structured `RetroProposal`. Extracts section, type, proposal, rationale, and impact from the template headings. Returns `null` if the output can't be parsed (agent produced nothing useful).

**`generateRetroDocument`**: Creates the `docs/sprints/sprint-{N}-retro.md` file from all collected proposals. Follows the retro document template from the spec.

**`applyImprovements`**: Takes current TEAM.md content and a list of selected proposals, applies them sequentially. For each proposal:
- Find the target section by header matching
- For "addition": append the content after the section
- For "modification": include a comment marker showing what was changed
- For "removal": comment out the section (don't delete — keep traceability)

This is best-effort — if a section can't be found, skip it and note in the retro document.

### 3. Runner Integration in `runner.ts`

Step 11 ("Collect retro proposals") is special — it spawns 4 agents (one per role) rather than one. The runner detects this by step name:

```typescript
if (step.name === "Collect retro proposals") {
  const proposals = await collectRetroProposals(projectPath, projectSlug, sprint, state);
  // Write retro doc, commit, continue to checkpoint
}
```

New function `collectRetroProposals`:
1. Read current TEAM.md
2. Build a sprint context summary from the state (steps completed, failures, checkpoints)
3. For each role (PO, Architect, QA, Engineer):
   - Build retro prompt via `buildRetroPrompt`
   - Spawn agent with the retro prompt
   - Parse result via `parseRetroProposal`
   - If agent fails: use circuit breaker. If escalated, record "No proposal from {role}" and continue with other roles
4. Generate retro document via `generateRetroDocument`
5. Write to `docs/sprints/sprint-{N}-retro.md` and commit
6. Return the proposals for the checkpoint

Step 13 ("Apply retro improvements") is also orchestrator-managed (no subagent):
1. Read the user's selections from the checkpoint feedback
2. Parse which proposals were selected (by index numbers or "all")
3. Apply via `applyImprovements`
4. Commit the updated TEAM.md

### 4. Checkpoint Extension in `checkpoints.ts`

Add the `"retro-review"` checkpoint configuration:

```typescript
"retro-review": {
  title: "Retrospective Review",
  nextAction: "apply selected improvements and complete the sprint",
  feedbackLabel: "Enter proposal numbers to adopt (e.g., '1,3'), 'all' to adopt all, or 'skip' to skip:",
},
```

The checkpoint context includes all proposals formatted with numbers for selection.

### 5. Resume Sprint Extension

`resumeSprint` already handles checkpoints generically. The `"retro-review"` checkpoint follows the same approve/request-changes pattern:
- **"approve" with feedback "all"**: Adopt all proposals
- **"approve" with feedback "1,3"**: Adopt proposals 1 and 3
- **"approve" with feedback "skip"** or **no feedback**: Skip adoption, complete the sprint
- **"request-changes"**: Not applicable for retro — treat as "skip"

The selected proposal indices are stored in the checkpoint's `feedback` field and read by step 13.

### 6. State Extension

Add to `SprintState`:
```typescript
retroProposals: RetroProposal[] | null;  // stored after step 11
```

This allows step 13 to access the proposals without re-reading the retro document. Backward-compatible: defaults to `null` on load.

## Sequence Diagram

```
Orchestrator          PO Agent   Arch Agent   QA Agent   Eng Agent   User
    |                    |           |           |           |         |
    | [step 11: collect retro proposals]                               |
    |--- retro prompt -->|           |           |           |         |
    |<-- proposal -------|           |           |           |         |
    |--- retro prompt ------------->|           |           |         |
    |<-- proposal ------------------|           |           |         |
    |--- retro prompt ------------------------->|           |         |
    |<-- proposal --------------------------------|           |         |
    |--- retro prompt ---------------------------------------->|         |
    |<-- proposal ---------------------------------------------|         |
    |                                                                    |
    | [write retro doc, commit]                                          |
    |                                                                    |
    | [step 12: retro-review checkpoint]                                 |
    |--- proposals -------------------------------------------------------->|
    |<-- "adopt 1,3" ------------------------------------------------------|
    |                                                                    |
    | [step 13: apply improvements]                                      |
    | [update TEAM.md, commit]                                           |
    | [sprint complete]                                                  |
```

## Non-Functional Requirements

- **Latency**: 4 agent spawns for retro proposals (~30s each sequentially, or could be parallelized in a future sprint). Total retro phase: ~2-3 minutes.
- **Robustness**: If any role fails to produce a proposal, the retro continues with the others. A completely failed retro (all 4 roles fail) still produces a retro doc noting the failures.
- **TEAM.md safety**: `applyImprovements` operates on a copy. If application fails, the original TEAM.md is preserved and the error is noted in the retro document.

## Technology Choices

No new dependencies. Agent spawning uses existing `spawnAgent`. File operations use `fs` and `simple-git`.

## Constraints & Patterns

- Retro proposals are collected sequentially (not parallel) in this sprint — parallel collection is deferred to `agent-parallel-execution`
- `applyImprovements` uses section header matching, not line numbers, for robustness
- The retro document is always saved, regardless of which improvements are adopted — it's the historical record
- Step 13 is orchestrator-managed (no subagent) — it applies text changes directly
- If "skip retro" is selected, TEAM.md is not modified but the sprint still completes
