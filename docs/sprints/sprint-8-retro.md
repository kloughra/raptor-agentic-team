# Sprint 8 Retrospective — raptor-agentic-team

## Proposals

### 1. PO Proposal

**Section**: User Checkpoints
**Type**: addition
**Proposal**: Add a fifth checkpoint row and accompanying guidance: "**Checkpoint 3a — Request-Changes Feedback Verification**: When the user (or PO) selects `request-changes` at any checkpoint, the orchestrator MUST surface the verbatim feedback in the next agent invocation's prompt. If the next agent's output does not reference or address the feedback, the PO must immediately escalate with `[ESCALATE] PO: feedback-injection appears broken — manual intervention required` rather than allowing silent loss of feedback. PO is responsible for verifying — at every checkpoint resolution — that prior `request-changes` feedback was actually incorporated before approving the next iteration."
**Rationale**: This sprint's `request-changes-feedback-injection` bug caused the PO's first round of spec-review comments and the first round of pr-review comments to silently fail to reach the next agent invocation. The PO and user only discovered this by noticing the agent's output was identical to the prior attempt — there was no defined protocol for catching feedback-loss, and the user had to drive the fix manually. The team currently has no explicit guard requiring verification that `request-changes` feedback was actually consumed.
**Impact**: Future sprints will detect feedback-injection failures (whether from bugs, prompt-construction errors, or agent context-window issues) within one checkpoint cycle instead of after multiple wasted iterations. It also gives the PO an explicit mandate and escalation path, reducing the chance of silent regression on this class of bug and shortening the time-to-manual-intervention from "user notices something is off" to "PO escalates on the first unaddressed comment."

### 2. ARCHITECT Proposal

**Section**: User Checkpoints / Failure Modes & Escalation
**Type**: addition
**Proposal**: Add a new failure mode row and a checkpoint-resilience clause: "**Checkpoint feedback delivery failure** — If a role detects that prior checkpoint feedback (request-changes, tech-approval directives, PR-review blockers) was not incorporated into a downstream artifact despite being recorded in sprint state, the role MUST (a) treat this as a runner/infrastructure defect and file a hotfix-priority inbox item, (b) re-deliver the feedback verbatim via direct commit message or manual artifact edit, and (c) annotate the next handoff commit with `[FEEDBACK-REDELIVERED] {checkpoint}: {reason}`. Do NOT silently retry the agent step expecting different behavior — the circuit breaker applies (3 attempts max) before escalation."
**Rationale**: This sprint exhibited the `request-changes-feedback-injection` bug twice — first at spec-review (PO agent did not receive the user's request-changes feedback, requiring a manual spec revision) and again at pr-review (Engineer agent did not receive the blocker feedback, requiring the user to drive the fix manually). Both times the team had no documented protocol for detecting or recovering from feedback-delivery failures, so resolution was ad-hoc and the meta-bug nearly prevented its own fix from landing.
**Impact**: Future sprints will have an explicit, documented recovery path when checkpoint feedback fails to propagate to the next agent invocation, preventing silent loss of user directives, avoiding wasted agent attempts on stale context, and ensuring infrastructure defects in the orchestrator are surfaced as inbox items rather than absorbed as one-off manual interventions.

### 3. QA Proposal

**Section**: Sprint Workflow (Step 7) and Cross-Review Expectations
**Type**: modification
**Proposal**: Add an explicit QA verification step that runs **before** PR review (between steps 6 and 7): "QA verifies all upstream feedback items (from spec-review and tech-approval checkpoints) are addressed in the implementation by cross-referencing each feedback bullet against a diff of the sprint branch. QA produces a `[STATUS] QA: feedback-trace — N/N items verified` commit before the PR enters Architect+QA parallel review." Additionally, require the PR Description Template to include a new section "## Upstream Feedback Trace" listing every checkpoint feedback item with a code/doc reference proving it was addressed.
**Rationale**: This sprint, the PR initially shipped without (a) the single-feature `request-changes` fix that tech-approval explicitly mandated at `runner.ts:904-924`, (b) the backlog cleanup mandated by architecture Implementation Order step 9, and (c) the literal `(per-feature)` annotation assertion the PO had requested during test review. All three were caught only at PR review, requiring a full request-changes round-trip. As QA, I had access to all the upstream artifacts (specs, architecture, prior PO feedback) but my role kicked in only after PR open — by which point the gaps had already been baked in. A pre-PR feedback-trace pass by QA would have caught all three before the Architect's review cycle.
**Impact**: Reduces request-changes iterations on PR review, shortens sprint cycle time, prevents the exact class of "explicit upstream requirement silently dropped" defect we hit twice this sprint, and creates a machine-checkable artifact (the feedback trace) that future retros can audit. Especially valuable when feedback-injection bugs (like the one we just fixed) prevent agents from seeing prior comments — a forced human-readable trace makes the gap visible immediately.

### 4. ENGINEER Proposal

**Section**: Software Engineer(s) → Responsibilities (execute in order)
**Type**: addition
**Proposal**: Add a new responsibility between current steps 5 and 6: "Before opening the PR, produce a written **Implementation Compliance Checklist** that maps every explicit requirement from the architecture document (including its 'Implementation Order' steps) and every actionable item in checkpoint feedback (spec-review, tech-approval) to a specific commit, file, and line range. Attach this checklist to the PR description. If any item cannot be mapped, raise a `[BLOCKER]` rather than opening the PR."
**Rationale**: This sprint's pr-review was rejected with two BLOCKERS that were both verbatim, unambiguous instructions from upstream artifacts: (1) the tech-approval explicitly required the single-feature `request-changes` branch in `runner.ts:904-924` to also reset `attempts` and `failures` — only the multi-feature path got the fix; (2) the architecture's Implementation Order step 9 explicitly required removing two items from `docs/backlog.md` Inbox and adding them to Done — neither was done. Both misses were detectable by simple checklist scanning before opening the PR, not by additional review effort.
**Impact**: Forces the engineer to systematically reconcile the implementation against the explicit upstream instructions before review begins, instead of relying on reviewers to catch verbatim-mandated items the engineer overlooked. Reduces request-changes round-trips, eliminates wasted reviewer cycles on "did you do what you were told?" findings, and makes blockers (e.g., a tech-approval mandate that the engineer disagrees with) surface before PR rather than during review.

## User Decision
- Proposal 1: Adopted
- Proposal 2: Adopted
- Proposal 3: Adopted
- Proposal 4: Adopted

## Applied Changes
(None yet)
