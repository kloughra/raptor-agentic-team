---
slug: dod-checklist-tracking
status: ready
sprint: 4
---

# DoD Checklist Tracking — Accurate Completion Status on Merge

## User Story

As a user reviewing merged sprint PRs, I want the Definition of Done checklist to accurately reflect that all items are satisfied (tests pass, peer review approved, PO accepted) so that the merged branch is a trustworthy record of the sprint's completion.

## Overview

Currently the PR description includes a DoD checklist with some items unchecked even after all approvals are in. This is because the checklist is static text written at PR creation time and never updated. This feature adds DoD tracking to the sprint state and updates the PR description (via `gh`) before the merge step executes, so the merged PR accurately shows all boxes checked.

## Acceptance Criteria

- [ ] Sprint state tracks a DoD object with boolean fields: `testsPass`, `prReviewApproved`, `poAccepted`, `codeCommitted`, `demoCompleted`
- [ ] The orchestrator updates each DoD field as the corresponding step/checkpoint completes:
  - `codeCommitted` → true when step 6 (Open PR) completes
  - `prReviewApproved` → true when the "pr-review" checkpoint is approved
  - `testsPass` → true when step 7 (Run test suite) completes
  - `demoCompleted` → true when step 8 (Demo) completes
  - `poAccepted` → true when the "demo-feedback" checkpoint is approved
- [ ] Before executing the merge (step 9), the orchestrator updates the PR description to reflect the completed DoD checklist (all items checked)
- [ ] PR description update uses `gh pr edit --body` if `gh` is available; if not, a DoD summary is included in the merge commit message instead
- [ ] `get_project_status` includes the DoD checklist status in the orchestrator section
- [ ] The progress table includes a DoD summary line when all items are satisfied (e.g., "Definition of Done: ✅ all items satisfied")

## Edge Cases

- **`gh` CLI not available**: Skip PR description update, include DoD summary in merge commit message as fallback
- **PR was created manually (not by orchestrator)**: Still attempt to update via `gh pr edit`; if it fails, log and continue
- **Not all DoD items are satisfied at merge time**: This shouldn't happen (merge only runs after demo approval), but if it does, log a warning and include the partial DoD in the merge commit

## Out of Scope

- Custom DoD items per project (use the standard set for now)
- DoD enforcement (blocking merge if items are unchecked) — the workflow already ensures this through step ordering

## Open Questions

None — all design decisions deferred to Architect.
