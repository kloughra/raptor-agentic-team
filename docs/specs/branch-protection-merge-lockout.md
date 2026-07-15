---
slug: branch-protection-merge-lockout
status: ready
sprint: 18
---
# Branch-Protection Merge Lockout — User-Actionable Merge Escalation

## User Story
As a Raptor user running a sprint, when the step-9 merge is **refused by GitHub
branch protection** — `main` has `lock_branch: true`, or the PR requires a
code-owner / approving review — I want the orchestrator to **classify the refusal
as user-actionable and escalate immediately after the first attempt**, naming the
PR and the exact action I must take (approve the PR / unlock `main` / merge
manually), instead of burning three identical merge retries on a failure that
**no retry can ever fix**, so that an autonomous driver's out-of-band
notification (notification-egress) carries an actionable next step rather than a
wall of three duplicate "merge failed" records.

## Background

**The gap this closes.** Sprint 15's `user-actionable-failure-class` added a third
failure classification — `user-actionable` (the blocker is *outside the sprint*;
retrying can never succeed until the user acts) — with an escalate-after-one-attempt
branch in the shared **agent-step** retry pipeline (`decideAfterFailure`). Branch
protection on `main` is exactly a user-actionable blocker, but it surfaces on the
**step-9 merge path**, which has its own inline retry loop and does **not** route
through `decideAfterFailure`. The result, observed live: PRs **#40, #42, and #43**
were each refused by the branch-protection lock and required a manual user merge —
and the merge loop treated the refusal as an ordinary failure eligible for the full
3-attempt circuit breaker.

**Verified current behavior (2026-07-15, current `main`).**
- `executeMerge` (`src/orchestrator/merge.ts`) returns a structured `MergeResult`
  (`{ success, method, error?, alreadyMerged? }`) — never throws. On the open-PR
  path it calls `gh pr merge --squash …`; a `gh` refusal surfaces as
  `MergeResult.error = stderr || error.message`.
- **Single-feature seam** (`runner.ts:1022-1080`): a bounded `do/while` loop that
  calls `executeMerge`, and on `!success` increments `attempts`, pushes a
  `FailureRecord` **already stamped** with `classification: classifyFailure(errorSummary)`
  and `signature: deriveFailureSignature(errorSummary)` (Sprint 13 C5), then
  retries until `attempts >= MAX_RETRY_ATTEMPTS` (3) before escalating.
- **Multi-feature seam** (`runMergeStepForFeature`, `runner.ts:2527-2557`): the same
  pattern — stamps `classifyFailure`, returns `"retry"` below the cap and
  `"escalated"` at the cap.
- **The classification is recorded but never consulted at either merge seam.** Both
  loops burn the full 3 attempts regardless of the stamped classification; only the
  *agent-step* loop honors `user-actionable` (via `decideAfterFailure`). So a
  branch-protection refusal today produces three identical, doomed `gh pr merge`
  invocations and three duplicate `FailureRecord`s before escalating.
- `USER_ACTIONABLE_ERROR_PATTERNS` (`failure-classification.ts`) currently ships one
  seed (billing/spend-limit). Precedence in `classifyFailure` is
  user-actionable → transient → deterministic.
- The escalation message built at the merge seam is `Merge failed after N attempts:
  {error}` — it does **not** name the PR number or a concrete human action.

**Why this is the right shape.** Reuse the Sprint-15 pipeline exactly: add a
branch-protection signature (with its paired remediation `action`) to the existing
code-only `USER_ACTIONABLE_ERROR_PATTERNS` registry, and make the two merge seams
**honor** the `user-actionable` classification they already stamp — escalating after
one attempt with a message that names the PR and the required human action. No new
classification value, no new registry, no new dependency.

## Acceptance Criteria

1. **Branch-protection signature(s) in the existing registry.** One or more
   branch-protection merge-refusal patterns are added to the code-only
   `USER_ACTIONABLE_ERROR_PATTERNS` registry (same registry Sprint 15 established —
   enumerable by tests, NOT user-configurable via `config.json`). Each entry carries
   its paired `action` string naming the human remediation. `classifyFailure` returns
   `"user-actionable"` for the branch-protection merge-refusal specimens.

2. **Specimens covered.** The pattern(s) match the realistic `gh pr merge` refusal
   strings for the observed lockout classes, at minimum:
   - base-branch policy / protected-branch refusal (e.g. "base branch policy
     prohibits the merge", "protected branch", "branch is protected");
   - required review (e.g. "review required", "at least 1 approving review is
     required", "changes must be approved by a code owner");
   - a locked base branch (`lock_branch: true`).
   The exact stderr specimens the current `gh` CLI emits for these cases must be
   confirmed empirically (see Open Question 1); the regex biases toward the confirmed
   specimen and does not over-fit one exact string (mirrors the Sprint-15
   specimen-plus-generalization convention).

3. **Escalate after exactly one merge attempt.** When a step-9 merge failure
   classifies `user-actionable`, the orchestrator escalates **on the first
   `executeMerge` invocation** — it does NOT run up to `MAX_RETRY_ATTEMPTS`. Exactly
   one merge attempt is spent and exactly one merge `FailureRecord` is appended before
   escalation. Contrast (the RED-verification baseline): today a branch-protection
   refusal appends three `FailureRecord`s and invokes `gh pr merge` three times.

4. **Applies identically at BOTH merge seams.** The escalate-after-one behavior is
   identical in the single-feature merge loop (`runner.ts` step-9 `do/while`) and the
   multi-feature `runMergeStepForFeature`, with no caller-side divergence — a
   branch-protection refusal escalates after one attempt in both paths.

5. **Escalation message names the PR and the required human action.** The escalation
   `detail`/message surfaced to the user (and persisted) names both **which PR** is
   blocked and the **concrete action** to take — approve the PR / unlock `main` /
   merge manually. A user (or an autonomous driver reading the notification) can act
   without inspecting the repo. If the PR number/URL is not currently available at the
   escalation site, the design must make it available (see Open Question 2).

6. **Actionable detail is persisted, not just printed.** Because notification-egress
   derives its payload exclusively from persisted state, the actionable next step must
   land in persisted state (e.g. the step/feature escalation reason + message), so the
   out-of-band notification carries the action. A notification fired for this
   escalation names the required human action.

7. **Distinct escalation reason.** The escalation is recorded with a reason
   distinguishable from `attempts-exhausted` (the generic 3-strikes merge escalation)
   — reusing the Sprint-15 `user-actionable` reason label or an equivalently distinct
   label the Architect chooses — so a lockout escalation is identifiable in state and
   logs versus a genuine repeated-failure merge escalation.

8. **Non-branch-protection merge failures are unchanged.** A merge failure that is NOT
   branch protection — a genuine push divergence (the `push-before-merge` failure), a
   transient network error, an unexpected `gh` error — classifies and retries exactly
   as it does today (transient/deterministic; the existing bounded do/while up to
   `MAX_RETRY_ATTEMPTS`). This feature only short-circuits the branch-protection
   (user-actionable) case; it does not alter the retry budget or accounting of any
   other merge-failure class. A parity test proves an ordinary merge failure still
   retries/escalates on the unchanged path.

9. **Reuses existing escalated/resume machinery.** A branch-protection escalation parks
   the step/feature in the existing `escalated` (resumable) status — no new terminal
   status, no new MCP tool, no new sprint status. After the user unlocks `main` /
   approves the PR / merges manually, the existing resume path re-engages the merge
   step (and the Sprint-13 already-merged-as-success rule handles the manually-merged
   case).

10. **Classification stamped on the FailureRecord as today.** The `user-actionable`
    classification (and signature) continue to be stamped on the merge `FailureRecord`
    at record time and persisted to `sprint-N.json`, exactly as the current C5 code
    does — no signature re-derivation at read time.

11. **Tests exercise the real merge seam(s), not just the classifier helper.** Per
    TEAM.md QA rule 12:
    - `classifyFailure` returns `"user-actionable"` for each branch-protection specimen
      (unit).
    - Driving the **real** merge path at BOTH seams (single-feature step-9 loop and
      multi-feature `runMergeStepForFeature`) with an `executeMerge` that returns a
      branch-protection refusal, the step escalates after **exactly one** attempt with
      the distinct user-actionable reason and a message naming the PR + action —
      asserted against the actual attempt counter and the real escalation output, not a
      reimplemented boundary.
    - Each constraint-guarding test carries a **RED-verification note** proving it FAILS
      against the pre-change code (where the branch-protection refusal burns three
      attempts and the message names neither the PR nor an action).
    - A parity test (AC 8) proves a non-branch-protection merge failure still retries on
      the unchanged path (and carries its own RED note that it would FAIL if the
      short-circuit leaked to all merge failures).

12. **Pure / deterministic / no new dependencies.** Classification stays deterministic
    string/regex matching — no LLM calls, no new dependencies, no `/g`-flag stateful
    regexes (consistent with the Sprint 12/15 module constraints).

## Edge Cases
- **"not mergeable" is ambiguous.** `gh pr merge` can emit a bare "Pull request is not
  mergeable" for a genuine merge *conflict / divergence* (which `push-before-merge`
  addresses) as well as for branch protection. Matching the bare "not mergeable" alone
  risks mis-escalating a resolvable conflict as "unlock main." The pattern should prefer
  the branch-protection-specific phrasing (policy / protected / review-required / lock)
  over the bare "not mergeable"; the remediation wording should not assert "unlock main"
  when the true cause is a conflict. Architect to tune (Open Question 1).
- **Local-merge fallback path.** Branch protection is a GitHub concept; the
  `mergeViaLocalGit` fallback (no `gh`/no remote) does not hit a `gh` refusal. Scope the
  observable behavior to the `gh`-refusal string, but the classifier stays surface-agnostic
  (it matches whatever `errorSummary` it is given).
- **Already-merged PR.** Unaffected — `executeMerge` returns
  `{ success: true, alreadyMerged: true }`; no failure, no classification. A user who
  merges manually after the escalation resumes cleanly via the already-merged-as-success
  rule (Sprint 13).
- **Escalation before push vs. at merge.** `push-before-merge` runs a pre-merge push at
  the head of `mergeViaGitHub`. A push refused by branch protection (rare — pushing the
  *feature* branch, not `main`) would surface as a push-named error, not a `gh pr merge`
  refusal; keep it on the existing push-failure path unless it clearly matches a
  branch-protection specimen. Confirm the real surface (Open Question 1).
- **Lockout on attempt 2+.** If a merge already failed once for an unrelated reason and
  the second attempt is refused by branch protection, it still escalates immediately on
  encountering the branch-protection refusal (escalate-now dominates the remaining merge
  budget) — consistent with the Sprint-15 escalate-now-dominates-slot-budget rule.
- **Message wording drift across `gh` versions.** The refusal text may vary by CLI
  version; new phrasings are a one-line registry addition (AC 1), same as the transient
  and billing registries.

## Out of Scope
- **Full `merge-failure-short-circuit`** (Inbox) — wiring *all* merge-step deterministic
  failures generically into `decideAfterFailure`. This spec targets only the
  branch-protection (user-actionable) case at the merge seam; a general merge→pipeline
  unification remains the separate, Architect-deferred item (merge retries otherwise cost
  seconds). If the Architect's chosen mechanism happens to route the merge seams through
  `decideAfterFailure`, that is an implementation choice — but the *committed scope* here
  is the branch-protection short-circuit and its actionable message, nothing broader.
- **Making the pattern registry user-configurable via `config.json`.** Code-only, same as
  the transient and Sprint-15 registries.
- **Changing `transient`/`deterministic` semantics** — `TRANSIENT_RETRY_CAP`,
  `MAX_RETRY_ATTEMPTS`, the no-progress short-circuit, slot accounting, and the agent-step
  pipeline are untouched.
- **Auto-remediation of the lockout** — the class escalates to the user with the action
  named; it never approves the PR, unlocks `main`, or merges on the user's behalf.
- **A new Slack/Discord notification driver** — the actionable detail rides the existing
  notification-egress sink; new drivers are a separate future item.
- **New MCP tool surface or a new sprint status** — reuses `escalated`/resume machinery.

## Open Questions
1. **Exact `gh pr merge` refusal specimens (Architect/QA to confirm empirically).** What
   precise stderr strings does the current `gh` CLI emit for (a) a locked base branch
   (`lock_branch: true`), (b) a required approving / code-owner review, and (c) a base-branch
   protection policy? The seed regex must match the real production strings (not assumed
   ones), and must disambiguate branch protection from a genuine "not mergeable" conflict
   (see Edge Case). This is the single external unknown — same posture as the Sprint-15
   invalid-model Open Question.
2. **Surfacing the PR number/URL at the escalation site (technical — Architect).** AC 5
   requires the escalation message to name the PR. `detectGitHubPR` already resolves the PR
   number inside `merge.ts`, but `MergeResult` does not currently carry it to the caller.
   How should the PR identifier reach the escalation message — extend `MergeResult`, re-query
   at the seam, or another mechanism? Architect to specify; PO intent is only that the
   message names the PR.
3. **Mechanism for honoring the classification at the merge seam (technical — Architect).**
   Should the two merge loops (a) add a targeted early-escalation check keyed on
   `classification === "user-actionable"`, or (b) route through `decideAfterFailure`? Either
   satisfies the observable ACs; the choice (and its overlap with the deferred
   `merge-failure-short-circuit` item) is the Architect's, provided both seams stay in
   parity (AC 4) and non-branch-protection failures are unchanged (AC 8).
4. **Reason label reuse.** Reuse the Sprint-15 `user-actionable` escalation-reason label at
   the merge seam, or introduce a merge-specific label? PO leans reuse (uniform records);
   Architect to confirm no conflict with the existing merge escalation path.
