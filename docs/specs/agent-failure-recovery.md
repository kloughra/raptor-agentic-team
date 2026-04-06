---
slug: agent-failure-recovery
status: ready
sprint: 3
---

# Agent Failure Recovery — Circuit Breaker & Resilient Retry

## User Story

As a user running sprints through Raptor, I want the orchestrator to handle agent failures gracefully — retrying with context, escalating after repeated failures, and allowing me to resume from a failed state — so that a single agent hiccup doesn't kill an entire sprint.

## Overview

Currently the orchestrator retries a failed step once with a generic "try again" message, then marks the sprint as failed. This feature implements the full circuit breaker pattern defined in TEAM.md (3 attempts before escalation), adds structured retry logic with progressive context enrichment, and enables `resume_sprint` to recover from failed states — not just paused checkpoints.

## Acceptance Criteria

- [ ] The orchestrator retries a failed step up to 3 times (configurable) before escalating
- [ ] Each retry includes progressively more context: attempt number, previous error output, and specific guidance on what went wrong
- [ ] After 3 failures on the same step, the orchestrator creates an `[ESCALATE]` commit in the project repo with a summary of what was tried and why it failed
- [ ] After escalation, the sprint status is set to `"escalated"` (new status, distinct from `"failed"`)
- [ ] `resume_sprint` accepts a sprint in `"escalated"` or `"failed"` status and re-runs from the failed step, optionally with user-provided guidance
- [ ] The sprint state persists the failure history: for each step, the number of attempts, error summaries, and timestamps
- [ ] `get_project_status` displays escalation details when a sprint is in `"escalated"` state
- [ ] The progress table shows retry count and escalation status for failed steps (e.g., "⚠ attempt 2/3", "🚨 escalated")
- [ ] If a step fails on retry but a previous retry produced partial artifacts (e.g., a partial spec file), the next retry receives those artifacts as context so work is not lost

## Edge Cases

- **Step fails with no output at all** (agent crashes): Retry with a simplified prompt; if still no output after 3 attempts, escalate with "agent produced no output"
- **Step fails with a `[BLOCKER]` in the output**: Treat as an immediate escalation (skip remaining retries) — the agent identified the problem
- **User resumes from `"escalated"` with guidance**: The guidance is passed to the agent as additional context, and the retry counter resets
- **User resumes from `"failed"` without guidance**: Re-run from the failed step with original context (no reset of attempt counter unless the user explicitly provides new guidance)
- **Multiple steps fail in sequence**: Each step maintains its own independent retry counter
- **Sprint state file is corrupted or missing**: Return a clear error suggesting the user re-run the sprint from step 1

## Out of Scope

- Automatic remediation (e.g., orchestrator fixing the agent's output) — the orchestrator only retries and escalates
- Parallel retry strategies (e.g., spawning multiple agents simultaneously)
- Retry configuration UI — the max retry count is a code constant for now
- Cross-step failure correlation (e.g., detecting that step 3 keeps failing because step 2 produced bad output)

## Open Questions

None — all design decisions deferred to Architect.
