Feature: Push feature branch before merge — pre-merge push kills the branch-divergence merge failure
  As a Raptor user running a sprint
  When the orchestrator reaches the Merge PR step (step 9) and an open GitHub PR is detected
  I want it to push the feature branch to its remote before invoking `gh pr merge`
  And to fail the merge attempt cleanly if that push fails
  So that a merge can never fail on divergence caused by local-only commits that were never pushed

  # Spec:         docs/specs/push-before-merge.md
  # Architecture: docs/architecture/push-before-merge.md
  #
  # Design invariant under test (the one-sentence contract):
  #   On the open-PR merge path, `gh pr merge` runs ONLY after the feature
  #   branch's local commits have been successfully pushed to its remote
  #   counterpart with a safe (non-forced), single-refspec push; a push failure
  #   fails the merge attempt cleanly (success: false, never throws) and never
  #   proceeds to `gh pr merge`.
  #
  # Production specimen this feature kills at the root:
  #   Sprint 12 (2026-07-06): PR #27 — demo/retro commits made locally but never
  #   pushed, so the remote PR branch was behind HEAD; `gh pr merge` merged the
  #   stale remote state and failed on divergence. Required a manual merge.
  #
  # Note on test categories (TEAM.md QA rule): this is an orchestrator/back-end
  # feature with NO UI surface, so Playwright E2E is Not Applicable (recorded,
  # not silently skipped). The architecture NFRs define no numeric latency
  # threshold (NFR3: "one git push before each open-PR merge, no new timeout
  # surface"), so there is no performance-threshold test to author; the
  # correctness/safety NFRs (1, 2, 4) are covered by the integration suite.

  Background:
    Given a sprint feature branch tracked in sprint state as state.branchName
    And the Merge PR step (step 9) is orchestrator-managed via executeMerge
    And executeMerge is documented to never throw and to return a structured MergeResult
    And all git operations use simple-git while `gh` is used only for the PR merge itself

  # ───────────────────────── AC #1 — push precedes the GitHub merge ─────────────────────────

  Scenario: Local-only commits are pushed before the squash-merge (AC #1 — the Sprint 12 regression)
    Given an open GitHub PR is detected for the feature branch
    And the feature branch has local-only commits ahead of its remote counterpart
    When executeMerge runs the Merge PR step
    Then the feature branch is pushed to its remote before `gh pr merge` is invoked
    And after step 9 the remote branch contains the previously-unpushed local commits
    And the merge is invoked exactly once, after the push
    And executeMerge returns success with method "github"

  Scenario: A branch already in sync with its remote pushes as a no-op and merges normally (edge case)
    Given an open GitHub PR is detected for the feature branch
    And the feature branch is already fully pushed to its remote
    When executeMerge runs the Merge PR step
    Then the pre-merge push is a no-op and succeeds
    And `gh pr merge` is invoked exactly once
    And the remote branch is unchanged by the no-op push

  # ───────────────────────── AC #2, #8, #9 — push failure fails the attempt cleanly ─────────────────────────

  Scenario: A failing push fails the attempt cleanly and never invokes the merge (AC #2, AC #9)
    Given an open GitHub PR is detected for the feature branch
    And the pre-merge push will fail (rejected, network error, or auth failure)
    When executeMerge runs the Merge PR step
    Then executeMerge returns success false with a descriptive error
    And `gh pr merge` is never invoked
    And executeMerge does not throw

  Scenario: A push-failure error is distinguishable from a merge-failure error (AC #8)
    Given the pre-merge push fails for the feature branch
    When executeMerge returns its structured result
    Then the error string names the failure as a push failure
    And the error string names the offending branch
    And a reader can tell it apart from a `gh pr merge` rejection

  # ───────────────────────── AC #3 — push failure feeds the existing retry/escalation loop ─────────────────────────

  Scenario: A push failure is accounted by the existing step-9 retry loop and escalates at the cap (AC #3)
    Given the runner reaches step 9 with an open PR and a permanently-failing pre-merge push
    When the runner executes the Merge PR step
    Then each push failure increments step 9 attempts and appends one failures[] record
    And `gh pr merge` is never invoked
    And step 9 escalates after exactly MAX_RETRY_ATTEMPTS attempts
    And an "[ESCALATE]" commit is created
    And no new escalation path is introduced — the existing loop is reused unchanged
    And no shared step (10 through 13) begins

  # ───────────────────────── AC #5 — safe push only, never force ─────────────────────────

  Scenario: A genuine divergence fails the push without rewriting remote history (AC #5)
    Given an open GitHub PR is detected for the feature branch
    And the remote branch is ahead of the local branch (a genuine divergence the push cannot fast-forward)
    When executeMerge runs the Merge PR step
    Then the push fails because it is non-forced (no --force, no --force-with-lease)
    And executeMerge returns success false naming the push failure
    And `gh pr merge` is never invoked
    And the remote branch history is left untouched — nothing is force-updated

  # ───────────────────────── AC #4, #6, #7 — non-open-PR paths never push ─────────────────────────

  Scenario: The no-remote / local-git fallback path attempts no push (AC #4)
    Given no GitHub PR is detected for the feature branch
    When executeMerge falls back to the local squash-merge
    Then no push is attempted
    And executeMerge returns success with method "local"
    And this path is byte-for-byte unchanged from before the feature

  Scenario: An already-merged PR short-circuits without pushing (AC #6)
    Given detectGitHubPR reports the PR is already MERGED
    When executeMerge runs the Merge PR step
    Then executeMerge returns alreadyMerged true success
    And no push is attempted
    And `gh pr merge` is never invoked

  Scenario: A PR closed without merge returns the existing failure without pushing (AC #7)
    Given detectGitHubPR reports the PR was closed without merging
    When executeMerge runs the Merge PR step
    Then executeMerge returns the existing structured failure
    And no push is attempted
    And `gh pr merge` is never invoked

  # ───────────────────────── AC #10 — push uses simple-git ─────────────────────────

  Scenario: The pre-merge push is performed via simple-git, not a raw git shell-out (AC #10)
    Given an open GitHub PR is detected for the feature branch
    When executeMerge performs the pre-merge push
    Then the push is issued through simple-git with an explicit single refspec (origin <branch>)
    And no raw `git` subprocess is shelled out for the push
    And `gh` is used only for the PR merge itself
