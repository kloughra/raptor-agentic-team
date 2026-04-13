# Feature Spec: progressive-retry-with-scope-narrowing

## Problem
The current circuit breaker retries failed steps with the same prompt and scope. If a step fails because the task is too complex (e.g., implement 3 acceptance criteria across 4 files), retrying the same oversized prompt just burns agent time and hits the same wall. The third failure triggers escalation, but the root cause — task scope — was never addressed.

## Solution
Implement progressive scope narrowing on retries. On the second retry (attempt 3 of 3), automatically decompose the failed task into smaller sub-tasks and attempt them sequentially. The narrowing strategy varies by role:
- **Engineer**: Split implementation into one sub-task per file or per acceptance criterion
- **QA**: Split test generation into one sub-task per scenario group
- **Architect**: Split design into component-level sub-designs

## User Stories
1. As a **user**, I want failed steps to adapt their approach rather than blindly retrying, so more steps succeed without escalation.
2. As an **Engineer agent**, I want my third attempt to focus on one file at a time so I can make progress on complex implementations.
3. As a **QA agent**, I want my retry to focus on one scenario group so I'm not overwhelmed by a large spec.
4. As a **user**, I want to see in the progress table that a step is running in "narrowed scope" mode.

## Acceptance Criteria
- [ ] Attempt 1-2: retry with full original scope (current behavior preserved)
- [ ] Attempt 3: automatically narrow scope before retrying
- [ ] Engineer narrowing: split by acceptance criteria from spec, each sub-task targets specific criteria
- [ ] QA narrowing: split by scenario groups (e.g., happy path vs error cases vs edge cases)
- [ ] Architect narrowing: split by component (e.g., data model, API layer, integration points)
- [ ] Sub-task results are aggregated into a single combined output
- [ ] If any sub-task fails, report partial progress and escalate with details of what succeeded vs failed
- [ ] Progress table shows "narrowed (2/4)" style indicators during scope-narrowed execution
- [ ] Narrowing is configurable — can be disabled per step or globally via config
- [ ] Works with existing circuit breaker — narrowed attempt counts as the third attempt, not a reset

## Out of Scope
- Automatic scope detection for attempt 1 (always start with full scope)
- User-defined custom narrowing strategies (future feature)
- Narrowing for PO or review steps (those are human-checkpoint-adjacent)
