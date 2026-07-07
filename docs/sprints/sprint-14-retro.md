# Sprint 14 Retrospective — raptor-agentic-team

## Proposals

### 1. PO Proposal

**Section**: Roles & Responsibilities → Product Owner (Responsibilities); reinforced in Backlog Management → Rules
**Type**: addition
**Proposal**: Add a new PO responsibility (and a matching backlog rule): "**Capture deferred items before sprint close.** Any item explicitly deferred, spun off as a 'follow-up,' or recorded as a scoping/vacuous-by-design decision during the sprint — regardless of which role raised it or at which checkpoint — MUST be written by the PO into `docs/backlog.md` (Inbox for new work, Ready if already prioritized) with its source noted, before the demo/feedback step is marked complete. At the feedback-processing step the PO explicitly verifies each deferral surfaced in spec Open Questions, ADR decisions, or checkpoint feedback has a corresponding backlog entry; a deferral that exists only in checkpoint feedback text is not considered captured."
**Rationale**: This sprint, at least three forward-looking items lived only in checkpoint feedback prose — the invalid-model-classification follow-up (deferred at tech-approval), plus `billing-error-signature-class` and `push-before-merge` queued for Sprint 15. Their survival depended on the demo-feedback note manually reminding the PO (Petra) at step 10 to "confirm the follow-up is filed to Inbox" and "verify [items] are still queued in Ready." That safety net was ad hoc; without the reminder, these deferrals could have been silently lost when the checkpoint text scrolled out of working context.
**Impact**: Makes deferred-work capture a guaranteed, auditable step rather than relying on someone remembering to mention it in feedback. Deferrals become traceable backlog items with sources, preventing dropped follow-ups and giving future sprints a reliable, prioritized intake of work identified mid-sprint.

### 2. ARCHITECT Proposal

**Section**: Sprint Workflow (Step 7) and Architect Responsibilities (PR review)
**Type**: addition
**Proposal**: Add an explicit **adversarial verification pass** as a required sub-step of PR review (step 7), owned jointly by Architect and QA. Before approving any PR, the reviewer must: (a) hunt for tests that reimplement production logic or mock away the very seam the test claims to guard, flagging any found as blocking; (b) confirm every constraint-guarding or parity test carries a recorded RED-verification note; and (c) surface the outcome of this pass explicitly in the review report (e.g., "adversarial pass: 0 reimplementations found, all RED notes present"). A PR may not be approved until this pass is stated as run and clean. Wording for step 7: "Architect + QA review — Architect for architectural compliance, QA runs full test suite; **both apply the adversarial verification pass (reimplementation/mock-seam hunt + RED-note check) and record its outcome in the review**."
**Rationale**: This sprint shipped exactly this capability — the adversarial gate injected at both production seams (runner.ts:1053, 1815) — and the pr-review checkpoint explicitly directed the engineer to "apply it to this feature's own test suite (hunt reimplementations, check RED-verification notes) and surface the outcome explicitly." That instruction lived only in the checkpoint feedback, not in TEAM.md. The process now dogfoods a gate that the process document itself does not yet require, so the behavior depends on a reviewer remembering to ask for it.
**Impact**: Makes the just-shipped adversarial gate a standing, documented review obligation rather than an ad-hoc checkpoint note — closing the gap between the product's runtime behavior and the team's written process, and preventing reimplementation-style tests (which the QA seam rule already forbids in authoring) from slipping through review.

### 3. QA Proposal

**Section**: Roles & Responsibilities → QA Engineer → Responsibilities (add a new numbered item after item 12)
**Type**: addition
**Proposal**: Add: "When a feature ships new behavior gated behind optional configuration whose contract is 'absent config = prior behavior everywhere' (an inert-by-default capability), QA MUST author an explicit **default-off parity test** proving the new code path is byte-identical to pre-change behavior when the config is unset — e.g. asserting the spawned argv / output is byte-for-byte the same with no config present. This test carries its own RED-verification note (proven to FAIL if the new plumbing leaks a default when config is absent) and must exercise the production seam end-to-end (config → loader → resolver → spawn), not just the parsing helper."
**Rationale**: Sprint 14 shipped the verifier-model capability under the explicit ruling "ship with `models` unset (byte-identical out of the box)" and NO baked-in default (OQ6). The tech-approval feedback named "the byte-identical no-config argv assertion" and "seam 2 end-to-end" as the core test contract — but TEAM.md's current constraint-guarding guidance (item 12) only covers pinning invariants on all paths and RED-verifying failures; it never names the distinct risk of an opt-in feature silently changing default behavior. The parity-when-absent guarantee was the single most load-bearing correctness property this sprint, yet it lived only in checkpoint feedback, not in the standing test contract.
**Impact**: Future sprints that add config-gated or feature-flagged capabilities (already queued: billing-error-signature-class, invalid-model-classification for Sprint 15) will have a codified QA obligation to prove default-off inertness, catching accidental behavior drift for existing users before demo rather than relying on a reviewer to remember to ask for it.

### 4. ENGINEER Proposal

**Section**: Handoff Protocol (and Observability & Status Reporting)
**Type**: addition
**Proposal**: Add a "Marker Literals & False-Positive Safety" rule: When an agent's commit message, PR body, or status/report output *discusses* a control marker rather than *raising* one — e.g. describing the adversarial-gate outcome, referencing `[BLOCKER]`/`[ESCALATE]`/`[HANDOFF]` in prose, or documenting the protocol — it MUST NOT emit the literal bracketed token. Refer to it in an escaped or paraphrased form instead (e.g. "a blocker marker", `BLOCKER` in backticks, or `[ BLOCKER ]` with spaces). Only emit an unescaped `[MARKER]` when actually triggering that control path. Rationale to embed: `src/git-parser.ts` extracts these tokens by literal string match, so any incidental occurrence is indistinguishable from a real event.
**Rationale**: This sprint I (Engineer) was the first agent to run under the new adversarial-gate instruction and had to report its outcome on my own test suite. The PR-review checkpoint explicitly warned me: "do not write the literal bracketed blocker marker in your output." That warning had to be delivered ad hoc because TEAM.md has no standing rule — the gate instruction naturally pushes an agent toward writing `[BLOCKER]`, which git-parser would then scrape as a genuine blocker, corrupting `[STATUS]`/blocker tracking the user relies on via `git log`.
**Impact**: Removes reliance on per-sprint verbal reminders, prevents false-positive blocker/escalation detection in the observability pipeline, and lets future agents safely describe adversarial-gate findings and protocol details in reports and PRs without silently tripping machine-readable control paths.

## User Decision
- Proposal 1: Adopted
- Proposal 2: Adopted
- Proposal 3: Adopted
- Proposal 4: Adopted

## Applied Changes
- PO proposal → fallback ("Adopted Retro Improvements (Unplaced)"); target "Roles & Responsibilities → Product Owner (Responsibilities); reinforced in Backlog Management → Rules" not found
- ARCHITECT proposal → fallback ("Adopted Retro Improvements (Unplaced)"); target "Sprint Workflow (Step 7) and Architect Responsibilities (PR review)" not found
- QA proposal → fallback ("Adopted Retro Improvements (Unplaced)"); target "Roles & Responsibilities → QA Engineer → Responsibilities (add a new numbered item after item 12)" not found
- ENGINEER proposal → fallback ("Adopted Retro Improvements (Unplaced)"); target "Handoff Protocol (and Observability & Status Reporting)" not found
