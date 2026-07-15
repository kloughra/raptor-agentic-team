Feature: Branch-protection merge lockout — user-actionable merge escalation
  As a Raptor user running a sprint
  When the step-9 merge is refused by GitHub branch protection (locked `main`,
  required approving/code-owner review, or a base-branch policy)
  I want the orchestrator to classify the refusal as user-actionable and escalate
  immediately after the first `executeMerge` attempt, naming the PR and the exact
  human action, instead of burning three identical doomed `gh pr merge` retries
  So that an autonomous driver's out-of-band notification carries an actionable
  next step rather than three duplicate "merge failed" records

  # Spec:         docs/specs/branch-protection-merge-lockout.md (AC 1–12)
  # Architecture: docs/architecture/branch-protection-merge-lockout.md (C1–C8)
  #
  # Design invariant under test (the one-sentence contract):
  #   At BOTH step-9 merge seams (single-feature do/while and multi-feature
  #   runMergeStepForFeature), a merge failure whose errorSummary classifies
  #   `user-actionable` escalates on the FIRST executeMerge invocation — exactly
  #   one attempt spent, exactly one FailureRecord appended, escalationReason
  #   `user-actionable`, and an escalationDetail (persisted) naming the PR and the
  #   concrete human action. Every NON-branch-protection merge failure retains the
  #   exact pre-feature bounded-retry accounting up to MAX_RETRY_ATTEMPTS.
  #
  # Production specimens this feature kills at the root (observed live):
  #   PRs #40, #42, #43 — each refused by the branch-protection lock on `main`
  #   (lock_branch: true) and required a manual user merge, yet the merge loop
  #   burned the full 3-attempt circuit breaker on a failure no retry can fix.
  #
  # Empirical note (Open Question 1): the exact `gh pr merge` stderr specimens are
  # confirmed against a scratch/throwaway branch (NEVER a real destructive merge);
  # the seed regexes bias toward the confirmed phrasing and deliberately do NOT
  # match the bare "not mergeable" conflict string (owned by push-before-merge).
  #
  # Test-category note (TEAM.md QA rule): this is an orchestrator/back-end feature
  # with NO UI surface, so Playwright E2E is Not Applicable (recorded, not silently
  # skipped). The architecture defines no numeric latency threshold to pin
  # (NFR-2 is "spend exactly one gh pr merge vs. three" — a count assertion covered
  # by the integration suite, not a perf-threshold test).

  Background:
    Given the step-9 Merge PR step is orchestrator-managed via executeMerge
    And executeMerge returns a structured MergeResult and never throws
    And each merge failure is already stamped with classifyFailure + deriveFailureSignature (Sprint 13 C5)
    And the USER_ACTIONABLE_ERROR_PATTERNS registry is code-only and enumerable by tests

  # ───────────── AC 1, 2, 12 — the branch-protection signatures classify user-actionable ─────────────

  Scenario Outline: A branch-protection refusal string classifies as user-actionable
    Given a `gh pr merge` refusal string "<stderr>"
    When classifyFailure inspects the error summary
    Then it returns "user-actionable"
    And resolveUserAction returns a non-empty action naming "<action>"

    Examples:
      | stderr                                                                        | action  |
      | pull request is not mergeable: the base branch policy prohibits the merge     | unlock  |
      | protected branch update failed for refs/heads/main                            | unlock  |
      | refusing to update the branch: branch is protected                            | unlock  |
      | GraphQL: main is a protected branch and cannot be merged (lock_branch enabled)| unlock  |
      | GraphQL: At least 1 approving review is required by reviewers with write access| approve |
      | pull request is not mergeable: review required                                | approve |
      | GraphQL: Changes must be approved by a code owner                             | approve |

  Scenario: The bare "not mergeable" conflict string does NOT classify user-actionable (C4 — the ambiguity guard)
    Given a `gh pr merge` refusal string "Pull request is not mergeable"
    When classifyFailure inspects the error summary
    Then it does NOT return "user-actionable"
    And resolveUserAction returns null
    # A genuine conflict/divergence is push-before-merge's domain; mis-escalating it
    # as "unlock main" would be wrong.

  Scenario: The pre-existing billing seed still classifies user-actionable (no-regression)
    Given a `gh pr merge` refusal string "You've hit your monthly spend limit"
    When classifyFailure inspects the error summary
    Then it returns "user-actionable"

  Scenario: The registry stays deterministic — every entry is a non-/g RegExp with a paired action (AC 12)
    Given the USER_ACTIONABLE_ERROR_PATTERNS registry
    When a test enumerates every entry
    Then each entry carries a RegExp pattern with no /g flag
    And each entry carries a non-empty action string

  # ───────────── AC 3, 4, 5, 7, 10 — escalate after exactly one attempt at BOTH seams ─────────────

  Scenario: The single-feature merge seam escalates after exactly one branch-protection refusal (AC 3, 5, 7, 10)
    Given the runner reaches step 9 with an open PR #42 and a successful pre-merge push
    And the first `gh pr merge` is refused by branch protection
    When the runner executes the Merge PR step
    Then executeMerge is invoked exactly once
    And step 9 records exactly one failures[] entry
    And that failure record is stamped classification "user-actionable" with a signature
    And step 9 escalates with escalationReason "user-actionable"
    And the escalation does NOT wait for MAX_RETRY_ATTEMPTS
    And the escalation message names PR #42 and the concrete human action

  Scenario: The multi-feature merge seam escalates after exactly one branch-protection refusal (AC 4)
    Given a multi-feature sprint whose feature-under-test reaches step 9 with an open PR #42
    And the first `gh pr merge` for that feature is refused by branch protection
    When the runner dispatches the feature's Merge PR step
    Then executeMerge is invoked exactly once for that feature
    And the feature's step 9 records exactly one failures[] entry
    And the feature's step 9 escalates with escalationReason "user-actionable"
    And the feature's escalationDetail names PR #42 and the concrete human action

  # ───────────── AC 5, 6 — the actionable detail is persisted and rides the notification ─────────────

  Scenario: The actionable next step is persisted in state, not merely printed (AC 6)
    Given a branch-protection escalation has just been recorded at step 9
    When the sprint state is reloaded from sprint-N.json
    Then step 9 carries a persisted escalationDetail
    And the escalationDetail names both the PR and the required human action

  Scenario: A notification fired for the escalation names the required human action (AC 6)
    Given the persisted escalated state after a branch-protection lockout
    When deriveNotificationEvent derives the escalation event from that state alone
    Then the event reason names the concrete human action
    # notification-egress derives its payload EXCLUSIVELY from persisted state, so
    # the action must live in state (escalationDetail), never in agent stdout.

  # ───────────── AC 8 — non-branch-protection merge failures are unchanged (parity) ─────────────

  Scenario: An ordinary (non-branch-protection) merge failure still retries to the cap (AC 8)
    Given the runner reaches step 9 with an open PR and a successful pre-merge push
    And every `gh pr merge` fails with an ordinary deterministic error (not branch protection)
    When the runner executes the Merge PR step
    Then executeMerge is invoked MAX_RETRY_ATTEMPTS times
    And step 9 records MAX_RETRY_ATTEMPTS failures[] entries
    And step 9 escalates with a reason distinct from "user-actionable"
    And no escalationDetail is written
    # RED note: this would FAIL if the user-actionable short-circuit leaked to ALL
    # merge failures (it would escalate after one attempt).

  # ───────────── AC 9 — reuses the existing escalated/resume machinery ─────────────

  Scenario: A branch-protection escalation parks in the existing resumable escalated status (AC 9)
    Given a branch-protection escalation at step 9
    When the escalation is recorded
    Then the sprint status is the existing "escalated" status — no new terminal status
    And no new MCP tool or sprint status is introduced
    And the existing resume path can re-engage the merge step after the user acts

  # ───────────── Open Question 2 — the PR number reaches the escalation site ─────────────

  Scenario: MergeResult carries the PR number on the open-PR failure path (OQ2)
    Given an open PR #42 is detected and `gh pr merge` is refused
    When executeMerge returns its structured MergeResult
    Then the result carries prNumber 42
    And that PR number is available to the escalation message builder without re-querying gh

  # ───────────── Edge case — lockout on attempt 2+ still escalates immediately (C1) ─────────────

  Scenario: A branch-protection refusal on a later attempt still escalates immediately (Edge Case)
    Given step 9 already failed once for an unrelated deterministic reason
    And the next `gh pr merge` attempt is refused by branch protection
    When the runner accounts the branch-protection failure
    Then it escalates immediately on that failure, not after the remaining retry budget
    And escalate-now dominates the remaining merge attempts (Sprint-15 escalate-now-dominates rule)
