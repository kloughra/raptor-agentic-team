# Sprint 12 Retrospective — raptor-agentic-team

## Proposals

### 1. PO Proposal

**Section**: Failure Modes & Escalation (with a corresponding note in Sprint Workflow, step 7)
**Type**: addition
**Proposal**: Add an explicit routing rule for PR review rejections: "**PR review requests changes** → the increment returns to **step 5 (Implementation)** as a *revision task*, never to step 6 (Open PR). The Engineer's revision task prompt must contain the verbatim review feedback as a checklist of concrete code changes, and the Engineer may NOT hand off until (a) `git diff` shows source files modified addressing each item, and (b) the full test suite passes. Re-opening a PR, re-committing handoff markers, or any zero-code-change response to a request-changes review is an automatic failure counting toward the circuit breaker."
**Rationale**: This sprint, the Architect's first request-changes review (binding constraint violations in `runAgentStepCycle`) was routed back to step 6 (Open PR). Since step 6's primary task — "PR exists" — was already satisfied, the Engineer's first revision attempt produced a no-op: a duplicate handoff commit (30b80ec) with **zero code changes**. It took a second, much more forceful request-changes round with explicit grep/diff verification commands to get the actual fix (23db6ce). TEAM.md currently defines routing for "PO rejects the increment" (→ step 5) but is silent on PR review rejections, and that gap directly caused a wasted review cycle.
**Impact**: Eliminates wasted revision cycles where review feedback lands on a step whose exit condition is already met. Future request-changes reviews will re-engage the role and step that can actually act on the feedback (implementation), with a verifiable done-condition (diff shows code changes, tests green) — turning what took three review rounds this sprint into one.

### 2. ARCHITECT Proposal

**Section**: Sprint Workflow (step 7) and Failure Modes & Escalation
**Type**: modification
**Proposal**: Add an explicit PR-revision routing rule: when a PR review (step 7) results in `request-changes`, work returns to **step 5 (implementation)** as a *revision task* — not to step 6 (Open PR). Amend step 7 to read: "If changes are requested, the Engineer resumes at step 5 with the verbatim review feedback as the task input; the existing PR and branch are reused — do NOT re-open the PR or re-issue handoff commits. A revision is only complete when `git diff` shows code changes addressing each review comment, tests are green, and the branch is pushed." Add a matching row to the Failure Modes table: "**PR receives request-changes** → Engineer re-enters implementation (step 5) with the review feedback; a revision attempt that produces zero code changes counts as a failed attempt toward the circuit breaker."
**Rationale**: This sprint, my first PR review (`changes-requested`) routed back to step 6, whose primary task — "open a PR" — was already satisfied. The Engineer's revision attempt produced a no-op duplicate handoff commit (30b80ec) with zero code changes, burning a full review cycle and forcing an unusually prescriptive second review (explicit line numbers, grep-verifiable exit checks) to recover. This was captured in the sprint's own findings as `pr-review-feedback-routes-to-wrong-step`. TEAM.md currently defines return paths for PO rejection (→ step 5) and test failures, but is silent on where request-changes review feedback lands, so the workflow defaulted to the wrong step.
**Impact**: Review feedback will land on the step whose task is actually unsatisfied (the code), eliminating no-op revision cycles. Reviewers won't need to compensate with hyper-detailed remediation scripts, the circuit breaker gets a meaningful signal (zero-diff revisions count as failures), and PR turnaround per revision drops from two review rounds to one.

### 3. QA Proposal

**Section**: QA Engineer — Responsibilities / Boundaries
**Type**: addition
**Proposal**: Add a new QA responsibility and matching boundary: "Tests written to guard an architectural constraint or to assert parity between two code paths MUST exercise the production seam (the actual loop, orchestrator, or integration point where the constraint applies) — not only the underlying pure function. Before handing off, QA must verify each constraint-guarding test would FAIL against the pre-change (or deliberately-violated) code path; a test that passes both before and after the change it guards is inadequate coverage and must be rewritten." Add a corresponding boundary: "Do NOT satisfy a parity or constraint requirement solely with unit tests of shared helper functions."
**Rationale**: This sprint, my 7-test "single- vs multi-feature parity" suite exercised only the pure `decideAfterFailure` function. It passed identically before and after `runAgentStepCycle` was wired into the RetryDecision pipeline — meaning it could not catch the exact regression it existed to prevent. The Architect's PR review caught the multi-feature loop violating the "single decision mechanism" constraint by direct inspection, not by any test failing, and had to explicitly demand an integration test driving the multi-feature loop through a no-progress escalation and a salvage completion. The demo feedback filed this verbatim as `parity-tests-dont-discriminate`.
**Impact**: Future constraint- and parity-guarding tests will actually discriminate: they'll fail when the constraint is violated, catching architectural drift (like an unwired code path) automatically in step 7 test execution instead of relying on manual Architect inspection. This turns "suite is green" back into meaningful evidence for PR approval and the DoD, and reduces changes-requested review cycles caused by regressions the test suite was blind to.

### 4. ENGINEER Proposal

**Section**: Sprint Workflow (and Failure Modes & Escalation table)
**Type**: addition
**Proposal**: Add an explicit revision path for PR review feedback: "When Architect or QA requests changes on a PR (step 7), work returns to **step 5 (implementation)** on the existing feature branch — the Engineer edits code, commits, and pushes to the already-open PR. Do NOT re-execute step 6: the PR already exists, and no new PR, re-open, or handoff commit may substitute for code changes. Before handing off a revision, the Engineer MUST verify the revision commit actually modifies source files (e.g., `git diff HEAD~1 --stat` shows non-doc changes addressing the feedback); a revision containing zero code changes is invalid and counts as a failed attempt toward the circuit breaker." Add a matching row to the Failure Modes table: "**PR changes requested** → Return to step 5 on the existing branch; push commits to the open PR; never re-open the PR or hand off without code changes."
**Rationale**: This sprint, the pr-review `changes-requested` feedback was routed back to step 6 (Open PR). Since step 6's primary task (PR exists) was already satisfied, my first revision attempt produced only a duplicate `[HANDOFF]` commit (30b80ec) with zero code changes — burning a full review cycle and forcing the reviewer to issue a second, far more prescriptive changes-requested with explicit verification commands. The workflow as written has no defined target step for PR revisions, so feedback landed on a step with nothing left to do.
**Impact**: Future sprints get a deterministic revision loop: review feedback always re-engages implementation, revisions are self-verified to contain real code changes before handoff, and reviewers never spend a cycle rejecting a no-op. This directly eliminates the `pr-review-feedback-routes-to-wrong-step` failure class and reduces wasted circuit-breaker attempts.

## User Decision
- Proposal 1: Deferred
- Proposal 2: Adopted
- Proposal 3: Adopted
- Proposal 4: Deferred

## Applied Changes
(None yet)
