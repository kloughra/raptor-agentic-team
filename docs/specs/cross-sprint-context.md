---
slug: cross-sprint-context
status: ready
sprint: 4
---

# Cross-Sprint Context — Memory Between Sprints

## User Story

As a user running multiple sprints on a project, I want agents in later sprints to have context from previous sprints (key decisions, patterns established, lessons learned, unresolved issues) so that they don't repeat mistakes, contradict earlier decisions, or lose institutional knowledge.

## Overview

After each sprint completes, the orchestrator generates a structured sprint summary artifact at `docs/sprints/sprint-{N}-summary.md`. This summary captures what was built, key technical decisions, patterns established, gotchas encountered, and unresolved items. When a new sprint starts, the orchestrator feeds the relevant sprint summaries to each agent as additional context alongside their normal inputs.

The summaries are authored by the orchestrator (not a subagent) by synthesizing information from the sprint's artifacts: the spec, architecture doc, test results, and any escalation/failure history from the sprint state.

## Acceptance Criteria

- [ ] After a sprint completes (status = "complete"), the orchestrator generates `docs/sprints/sprint-{N}-summary.md` in the project repo
- [ ] The summary follows a structured template (see below) and includes: sprint goal, features delivered, key technical decisions, patterns/conventions established, issues encountered, and items deferred to future sprints
- [ ] The summary is committed to the project repo with `[PO] add: sprint {N} summary`
- [ ] When `run_sprint` starts a new sprint, the orchestrator loads all prior sprint summaries from `docs/sprints/`
- [ ] Prior sprint summaries are included in each agent's context (appended to the system prompt or step context)
- [ ] The context passed to agents is size-bounded — if total summary content exceeds a threshold (e.g., 10,000 chars), only the most recent N summaries are included, with a brief note that older summaries exist
- [ ] The sprint summary template includes a "Context for Future Sprints" section where key information that agents should carry forward is explicitly called out
- [ ] `get_project_status` includes a count of available sprint summaries and the latest summary date
- [ ] The `docs/sprints/` directory is added to the scaffold (template.ts) for new projects

## Sprint Summary Template

```markdown
# Sprint {N} Summary — {project}

## Sprint Goal
{One-line description of what this sprint aimed to deliver}

## Features Delivered
- {feature-slug}: {brief description of what was built}

## Key Technical Decisions
- {Decision}: {What was chosen and why}

## Patterns & Conventions Established
- {Pattern}: {Description — future engineers should follow this}

## Issues Encountered
- {Issue}: {What happened, how it was resolved or deferred}

## Deferred Items
- {Item}: {Why it was deferred, where it landed in the backlog}

## Context for Future Sprints
{Key information that agents in future sprints must know. This section is the primary input for cross-sprint context passing.}
```

## Edge Cases

- **First sprint (no prior summaries)**: Agents receive no cross-sprint context — this is the current behavior, no change needed
- **Many sprints (context too large)**: Truncate to most recent N summaries (e.g., last 5) and include a one-liner: "Note: {X} older sprint summaries exist at docs/sprints/ but are not included for brevity"
- **Sprint fails or is abandoned (never reaches "complete")**: No summary is generated — summaries are only for completed sprints
- **Summary generation fails**: Non-critical — log a warning but don't block sprint completion. The sprint is still "complete" even without a summary
- **Manually edited summaries**: The orchestrator reads whatever is in `docs/sprints/` — if a user manually edits or adds summaries, those are included too

## Out of Scope

- Semantic search or embedding-based retrieval of relevant context (just sequential summaries for now)
- Agent-authored summaries (the orchestrator synthesizes from artifacts, not a subagent)
- Cross-project context (summaries are per-project only)
- Summary versioning or conflict resolution

## Open Questions

None — all design decisions deferred to Architect.
