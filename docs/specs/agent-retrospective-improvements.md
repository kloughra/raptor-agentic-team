---
slug: agent-retrospective-improvements
status: ready
sprint: 4
---

# Agent Retrospective Improvements — Process Evolution Through Experience

## User Story

As a user managing an agentic dev team, I want each agent to propose improvements to TEAM.md based on their experience during the sprint, and I want to review and select the best ones for adoption, so that the team process evolves and improves over time.

## Overview

At the end of each sprint (after all steps complete but before the sprint is marked "complete"), every role that participated in the sprint proposes one improvement to TEAM.md based on their experience. The orchestrator collects all proposals into a structured retrospective document at `docs/sprints/sprint-{N}-retro.md`, then presents them to the user at a new checkpoint. The user selects which improvements to adopt. Selected improvements are applied to TEAM.md and committed.

This creates a feedback loop where the process document evolves based on actual agent experience — the team literally gets better at its job over time.

## Acceptance Criteria

- [ ] After step 10 (PO processes feedback) completes, the orchestrator spawns each role (PO, Architect, QA, Engineer) to propose one TEAM.md improvement
- [ ] Each role receives: the current TEAM.md, their role's section, and a summary of what happened during the sprint (from sprint state + artifacts)
- [ ] Each role produces a structured improvement proposal (see template below)
- [ ] All proposals are collected into `docs/sprints/sprint-{N}-retro.md` and committed to the repo
- [ ] A new user checkpoint ("retro-review") is presented after all proposals are collected
- [ ] The checkpoint displays all proposals and asks the user to select which ones to adopt (approve all, approve some, approve none)
- [ ] Selected improvements are applied to TEAM.md by the orchestrator and committed with `[PO] update: apply retrospective improvements from sprint {N}`
- [ ] The sprint is marked "complete" only after the retro checkpoint is resolved
- [ ] `resume_sprint` handles the new "retro-review" checkpoint type
- [ ] The retro document persists regardless of which improvements are adopted — it's the historical record

## Improvement Proposal Template

Each role's proposal follows this structure:

```markdown
### {Role} Proposal

**Section**: {Which section of TEAM.md this applies to}
**Type**: {addition | modification | removal}
**Proposal**: {What should change, in specific terms}
**Rationale**: {Why, based on what happened this sprint}
**Impact**: {What this would improve for future sprints}
```

## Retro Document Template

```markdown
# Sprint {N} Retrospective — {project}

## Proposals

{All role proposals collected here}

## User Decision
- Adopted: {list of adopted proposals}
- Deferred: {list of deferred proposals}
- Rejected: {list of rejected proposals with reason}

## Applied Changes
{Summary of what was actually changed in TEAM.md}
```

## Workflow Integration

The sprint workflow gains a new block after step 10:

```
10.  PO: Process feedback → update backlog
      (existing)

11.  Orchestrator: Collect retrospective proposals from all roles
      Depends on: step 10 (feedback processed)
      ⚡ PARALLEL: All 4 role proposals can be collected simultaneously

12.  User checkpoint: Review retro proposals → select improvements to adopt
      Depends on: step 11 (all proposals collected)
      Checkpoint type: "retro-review"

13.  Orchestrator: Apply selected improvements to TEAM.md
      Depends on: step 12 (user has selected improvements)

Sprint marked "complete" after step 13.
```

## Checkpoint Interaction

The retro-review checkpoint presents:
- All proposals in a numbered list
- Options: "Adopt all", "Adopt selected" (with selection mechanism), "Skip retro"
- For "Adopt selected": user provides a comma-separated list of proposal numbers to adopt
- "Skip retro" skips adoption but still saves the retro document

## Edge Cases

- **A role produces no proposal or an empty proposal**: Record "No proposal from {role}" in the retro document. Not an error.
- **Role agent fails to produce a valid proposal**: Use the circuit breaker from agent-failure-recovery. If it escalates, record the escalation in the retro doc and continue with other roles' proposals.
- **User selects "Skip retro"**: Retro doc is saved with all proposals marked "deferred". TEAM.md is not modified. Sprint completes.
- **User selects "Adopt all"**: All proposals are applied to TEAM.md.
- **Proposed change conflicts with another proposal**: Orchestrator applies them sequentially. If a later proposal's target section was modified by an earlier one, the orchestrator includes the updated TEAM.md content when applying it.
- **TEAM.md is very large and proposals reference specific lines**: Proposals reference section headers, not line numbers, for robustness.
- **Sprint was escalated and recovered**: Retro still happens — the recovery experience is valuable context for improvement proposals.

## Out of Scope

- Automated proposal quality scoring or ranking
- Multi-sprint trend analysis across retro documents
- Voting or consensus mechanism (user is the sole decision-maker)
- Proposals for files other than TEAM.md (e.g., CLAUDE.md, tooling config)

## Open Questions

None — all design decisions deferred to Architect.
