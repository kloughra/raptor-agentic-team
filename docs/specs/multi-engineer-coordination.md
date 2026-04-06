---
slug: multi-engineer-coordination
status: draft
sprint: 5
---
# Multi-Engineer Coordination

## User Story
As the Raptor orchestrator, I want to support multiple engineers working on separate features within a sprint, so that larger sprints with multiple backlog items can be executed concurrently.

## Acceptance Criteria
1. Sprint state tracks per-feature progress when multiple features are in the sprint backlog
2. Each feature gets its own branch: `sprint-{N}/{feature-slug}`
3. Engineers are assigned to features — the runner spawns one engineer agent per feature
4. Engineer steps (5, 6) run in parallel across features — each engineer works independently
5. Shared steps (1-4: spec, architecture, QA tests, PO review) still run sequentially per feature, but multiple features can be at different workflow positions
6. Each feature has its own PR, DoD tracking, and merge step
7. The progress table shows per-feature rows when multi-feature mode is active
8. Sprint is only complete when all features are done
9. A single feature failure/escalation does not block other features from continuing
10. Backward compatible: single-feature sprints work exactly as before

## Edge Cases
- Two features modify the same file → merge conflicts detected at PR review; second PR must rebase
- One feature escalates while others complete → sprint status is "partial" until resolved
- Feature count exceeds available engineer slots → features queue and run when a slot opens (for future; Sprint 5 assumes unlimited slots)

## Out of Scope
- Sub-branches for multiple engineers on the same feature (documented in TEAM.md but not automated in Sprint 5)
- Automatic merge conflict resolution
- Dynamic engineer assignment changes mid-sprint

## Open Questions
- None
