---
slug: agent-parallel-execution
status: draft
sprint: 5
---
# Agent Parallel Execution

## User Story
As the Raptor orchestrator, I want to execute workflow steps in parallel where the TEAM.md methodology allows it, so that sprints complete faster by avoiding unnecessary sequential waits.

## Acceptance Criteria
1. Steps that share the same dependency and are marked as parallel-eligible execute concurrently via `Promise.all`
2. The workflow definition includes a `parallelWith` field that groups co-runnable steps
3. Two parallelism opportunities are implemented:
   - **Step 3 partial**: QA can begin writing BDD scenarios from the spec (step 1) while waiting for architecture (step 2) — QA is spawned early with spec-only context, then re-spawned with full context after step 2 completes
   - **Step 7**: Architect review and QA test execution run simultaneously
4. Parallel step results are collected and all must succeed before advancing
5. If one parallel step fails, the other is allowed to complete (no cancellation), but both failures are recorded
6. The circuit breaker (3-retry) applies independently to each parallel step
7. Progress table shows parallel steps running simultaneously (both marked 🔄)
8. Sprint state tracks parallel step status independently

## Edge Cases
- One parallel step succeeds and the other fails after 3 retries → the sprint escalates, but the successful step's artifacts are preserved
- A parallel step raises a [BLOCKER] → immediate escalation for that step; the other step is allowed to finish
- Both parallel steps fail → both escalation messages are included in the result

## Out of Scope
- Dynamic parallelism detection (only statically declared parallel groups)
- More than 2 steps in a single parallel group
- Cancellation of in-flight parallel steps on failure

## Open Questions
- None
