---
slug: cross-sprint-context
spec: docs/specs/cross-sprint-context.md
---

# Cross-Sprint Context — Architecture Design

## Overview

After a sprint completes, the orchestrator generates a structured summary at `docs/sprints/sprint-{N}-summary.md` by reading the sprint's artifacts (spec, architecture, test results, sprint state). When a new sprint starts, the orchestrator loads prior summaries and injects them into each agent's context. All logic lives in a new `src/orchestrator/summary.ts` module.

## Components

### 1. Summary Generator: `src/orchestrator/summary.ts`

New module with two main functions:

```typescript
export function generateSprintSummary(
  projectPath: string,
  projectSlug: string,
  sprint: number,
  state: SprintState
): string

export function loadSprintSummaries(
  projectPath: string,
  maxChars?: number
): string
```

**`generateSprintSummary`**: Reads artifacts from the project directory and sprint state to produce a markdown summary following the template from the spec. Sources:

| Summary Section | Source |
|---|---|
| Sprint Goal | First item in sprint backlog section |
| Features Delivered | Completed backlog items |
| Key Technical Decisions | `docs/architecture/{slug}.md` — Technology Choices table |
| Patterns & Conventions | `docs/architecture/{slug}.md` — Constraints & Patterns section |
| Issues Encountered | Sprint state failure records (from agent-failure-recovery) + escalation history |
| Deferred Items | Backlog Ready/Inbox items that were added during the sprint |
| Context for Future Sprints | Synthesized from above — key decisions + patterns + unresolved issues |

The generator reads files, extracts relevant sections with simple regex/string matching, and templates the result. No LLM call needed — this is deterministic synthesis.

**`loadSprintSummaries`**: Reads all `docs/sprints/sprint-*-summary.md` files, sorts by sprint number, and concatenates. If total length exceeds `maxChars` (default 10,000), includes only the most recent summaries that fit, plus a note: "Note: {X} older sprint summaries exist at docs/sprints/ but are not included for brevity."

### 2. Integration Points

**In `runner.ts` — sprint completion**: After the final step completes (before marking status "complete"), call `generateSprintSummary`, write to `docs/sprints/sprint-{N}-summary.md`, and commit:

```typescript
// After all steps complete, before state.status = "complete"
const summary = generateSprintSummary(projectPath, projectSlug, sprint, state);
const summaryPath = path.join(projectPath, "docs", "sprints", `sprint-${sprint}-summary.md`);
fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, summary);
await git.add(summaryPath);
await git.commit(`[PO] add: sprint ${sprint} summary`);
```

**In `runner.ts` — sprint start**: When `runSprintFromStep` is called for step 1 of a new sprint, load prior summaries and store them in a variable that gets passed to `buildStepContext`.

**In `prompts.ts` — agent context enrichment**: Extend `buildStepContext` to accept an optional `crossSprintContext` parameter. When provided, it's appended to the context with a header:

```
--- Cross-Sprint Context (from previous sprints) ---
{summary content}
```

### 3. Template Module Update: `src/template.ts`

Add `"docs/sprints"` to the `SCAFFOLD_DIRS` array so new projects get the directory.

### 4. Status Extension: `tools.ts`

Add to `get_project_status` response:

```typescript
sprintSummaries: {
  count: number;         // how many summary files exist
  latestSprint: number;  // highest sprint number with a summary
}
```

Determined by listing `docs/sprints/sprint-*-summary.md` files.

## Data Model

**New file on disk**: `docs/sprints/sprint-{N}-summary.md` — generated markdown, committed to project repo.

**No state changes**: Sprint summaries are files in the project repo, not in `~/.raptor/` state. This means they travel with the repo and are version-controlled.

## Non-Functional Requirements

- **Generation latency**: Summary generation is file I/O + string processing — sub-100ms
- **Context size**: Default 10,000 char limit prevents context window bloat. At ~500 chars per summary, this allows ~20 sprints of history
- **Robustness**: Summary generation is best-effort. If a source file is missing, that section is marked "N/A". Failure to generate a summary does not block sprint completion

## Technology Choices

No new dependencies. File I/O uses `fs`, git uses `simple-git` (both already in use).

## Constraints & Patterns

- Summary generation is deterministic — no LLM calls, just file reading and templating
- Summaries are committed to the project repo (not `~/.raptor/`) so they're portable and version-controlled
- The `docs/sprints/` directory holds both summaries and retro docs (from agent-retrospective-improvements)
- `loadSprintSummaries` always returns a string (empty string if no summaries exist) — callers don't need null checks
