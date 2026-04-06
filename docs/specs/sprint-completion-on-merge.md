---
slug: sprint-completion-on-merge
status: ready
sprint: 3
---

# Sprint Completion on Merge — PR Merge as Sprint Exit Gate

## User Story

As a user running sprints through Raptor, I want the sprint to end by merging the PR branch after all approvals are in (QA tests pass, Architect approves, user approves at demo) so that the sprint has a clean, concrete endpoint tied to a real merge event.

## Overview

Currently the sprint workflow ends at step 9 (PO processes feedback), with the PR left open. This feature restructures the end-of-sprint flow so that after the demo checkpoint (step 8) is approved, the orchestrator automatically merges the PR and marks the sprint complete. The merge is the authoritative signal that the sprint is done.

The merge happens without additional user intervention — by the time the demo checkpoint is approved, all required approvals are already in place (QA ran tests at step 7, Architect reviewed at step 7, user approved at demo step 8).

## Acceptance Criteria

- [ ] After the demo checkpoint (step 8) is approved by the user, the orchestrator proceeds to merge the sprint PR automatically
- [ ] The merge uses squash-merge to keep history clean, per TEAM.md merge policy
- [ ] The merge commit message references the feature slug and sprint number
- [ ] After successful merge, the PO processes feedback and updates the backlog (step 9) — this still happens, but on the main branch post-merge
- [ ] After step 9 completes, the sprint status is set to `"complete"`
- [ ] If the merge fails (e.g., merge conflicts, branch protection rules), the orchestrator surfaces the error to the user as an escalation rather than silently failing
- [ ] `get_project_status` reflects merge state: whether the sprint PR has been merged
- [ ] The progress table includes a "Merge PR" step that shows merge status
- [ ] The Definition of Done checklist in sprint state is validated before merge is attempted: all tests pass, PR review approved, PO accepted
- [ ] The TEAM.md Sprint Workflow is updated to reflect the new step ordering (merge before final backlog update)

## Edge Cases

- **PR has merge conflicts**: Orchestrator escalates to the user with conflict details; does not attempt auto-resolution
- **PR branch was already merged manually by the user**: Orchestrator detects this (branch no longer exists or PR is in merged state) and skips the merge step, proceeding to backlog update
- **PR was closed without merging**: Orchestrator escalates — this is unexpected after demo approval
- **GitHub API / `gh` CLI not available**: Orchestrator falls back to `git merge --squash` locally if the PR was created locally; if it's a GitHub PR, escalate that `gh` is required
- **Demo checkpoint rejected (request-changes)**: No merge attempted — sprint loops back to re-work as today
- **Multiple PRs for the sprint** (future multi-engineer): Out of scope for this sprint; assume one PR per sprint

## Out of Scope

- Multi-PR merge coordination (deferred to `multi-engineer-coordination`)
- Branch cleanup after merge (deleting the feature branch remotely)
- CI/CD integration (waiting for CI checks to pass before merge)
- Configurable merge strategy (always squash-merge for now)

## Open Questions

None — all design decisions deferred to Architect.
