---
slug: user-actionable-failure-class
status: ready
sprint: 15
---
# User-Actionable Failure Classification

## User Story
As a Raptor user running a sprint, when an agent step fails for a reason that **no amount of retrying can fix until I take an action outside the sprint** — I've hit my monthly spend limit, or I've configured an invalid `--model` — I want the orchestrator to **escalate immediately after the first attempt** with a message that names the exact action I must take, so that Raptor never burns 2–3 doomed attempts (and my remaining budget/time) retrying a blocker that is outside the sprint entirely.

## Background

**The gap this closes.** `failure-classification.ts` (Sprint 12, `progress-aware-circuit-breaker`) has exactly two classes today:
- `transient` — retrying *helps* (infra flake); retries without consuming a deterministic slot, bounded by `TRANSIENT_RETRY_CAP` (5).
- `deterministic` — the task/output is wrong; consumes a slot, escalates at `MAX_RETRY_ATTEMPTS` (3), with a CB-1 no-progress short-circuit when two consecutive deterministic signatures match.

Neither fits a failure whose blocker is **outside the sprint**: retrying can *never* succeed until the user acts. Two real incidents motivate a third class:

- **Billing / spend-limit.** "You've hit your monthly spend limit" burned 2 attempts before the no-progress short-circuit fired — three separate times in Sprint 13 alone (feature-1 step 4, commit `908bf63`; feature-2 step 3, commit `9394bdd`; feature-2 step 7, commit `f9bc035`). Every extra attempt was pure waste — the spend limit does not lift by retrying. Action required: raise the limit at `claude.ai/settings/usage`.
- **Invalid model.** The `claude` CLI rejects an unknown `--model` at spawn. This surface was introduced by Sprint 14's `models` config plumbing (`adversarial-verifier-review-gate`, Part 2) — a typo'd `models.byRole`/`models.default` in `~/.raptor/config.json` today rides the generic `deterministic` path and burns the full 3-attempt circuit breaker. Action required: fix `models.byRole` / `models.default` in `~/.raptor/config.json`.

Both were filed as follow-ups (`billing-error-signature-class`, `invalid-model-signature-class`) and bundled here per the latter's "revisit together" note — they are the **same code change**: one new classification, one shared pipeline branch, an extensible pattern registry, and two seed signature patterns.

### Verified current behavior (2026-07-07, current `main`)
- `FailureClassification` (`src/orchestrator/failure-classification.ts:14`) is the union `"transient" | "deterministic"`. `classifyFailure` (`:45`) walks `TRANSIENT_ERROR_PATTERNS` and returns `"deterministic"` as the default.
- The retry pipeline `decideAfterFailure` (`src/orchestrator/runner.ts:391`) branches in a fixed order: **salvage-complete → transient → no-progress short-circuit → deterministic slot accounting**. `RetryDecision`'s `escalate` reason union (`runner.ts:381`) is currently `"no-progress" | "transient-cap" | "attempts-exhausted"`.
- Every failed attempt is recorded by `processFailureAndDecide` (`runner.ts:501`), which stamps `classification: classifyFailure(errorSummary)` and `signature: deriveFailureSignature(errorSummary)` onto the `FailureRecord` at record time (persisted, never re-derived).
- A billing error today matches none of `TRANSIENT_ERROR_PATTERNS`, so it classifies `deterministic` — it consumes slots and only stops early if the *identical signature* recurs (the observed 2-attempt burn). An invalid-model error likewise burns all 3.

## Acceptance Criteria

1. **New classification value.** `FailureClassification` gains a third member: `"user-actionable"`. The union becomes `"transient" | "deterministic" | "user-actionable"`. Backward-compat reads that default a missing classification to `"deterministic"` (the `?? "deterministic"` sites) are unchanged.

2. **Classifier detects user-actionable failures.** `classifyFailure` returns `"user-actionable"` when the error summary matches a user-actionable pattern. The precedence among the three classes is a technical decision for the Architect, but the observable contract is: a user-actionable failure MUST NOT be classified `transient` (it must not retry-loop up to the transient cap) and MUST NOT be classified `deterministic` (it must not burn the 3-attempt circuit breaker).

3. **Extensible pattern registry.** User-actionable patterns live in an exported, code-only registry mirroring `TRANSIENT_ERROR_PATTERNS` (enumerable by tests, NOT user-configurable via `config.json` — out of scope, same as the transient registry). Adding a future user-actionable signature is a one-line registry addition with no pipeline change.

4. **Ships with one seed pattern (revised post-review).** The registry ships with at least this signature:
   - **billing / spend-limit** — matches the spend-limit error (minimum specimen: "You've hit your monthly spend limit"; commits `908bf63`, `9394bdd`, `f9bc035`).

   > **Invalid-model deferred (post-review scope cut).** The originally-planned second seed (invalid `--model`) is **not shipped** this sprint. Empirical finding (2026-07-07): `claude --model bogus-xyz --print hi` emits its advisory — "There's an issue with the selected model (bogus-xyz). It may not exist or you may not have access to it. Run --model to pick a different model." — to **STDOUT** and **exits 0**. Because the process exits 0, `spawnAgent` returns success; the step then fails on **missing outputs**, and the string `classifyFailure` sees is "Agent completed (exit 0) but did not create required output files" — never the model advisory. No `failure-classification.ts` regex can ever fire on that path. Detecting invalid-model therefore requires inspection of the **exit-0 / agent-output path** (`agents.ts` or the exit-0 branch of `runAgentStepCycle`), a distinct design — tracked as Inbox item `invalid-model-user-actionable-detection`. A speculative "invalid model" regex here would be dead code that could only mis-escalate deterministic failures whose output merely mentions an unsupported model.

5. **Escalate after exactly one attempt.** When a step's failure classifies `user-actionable`, `decideAfterFailure` returns an `escalate` decision on the **first** attempt — before a second agent spawn. It does not wait for `MAX_RETRY_ATTEMPTS` (deterministic), the 2-attempt no-progress short-circuit, or `TRANSIENT_RETRY_CAP` (transient). Zero additional attempts are spent.

6. **New escalation reason.** The `RetryDecision` `escalate.reason` union gains a `"user-actionable"` member (or an equivalently distinct label the Architect chooses) so this escalation is distinguishable from `"no-progress"`, `"transient-cap"`, and `"attempts-exhausted"` in state, logs, and the escalation message.

7. **Actionable escalation message names the required action.** The escalation `detail` (and the message surfaced to the user) names the concrete action the user must take:
   - billing → raise the limit at `claude.ai/settings/usage`;
   - invalid-model → fix `models.byRole` / `models.default` in `~/.raptor/config.json`.
   A user reading the escalation can act without guessing.

8. **Wired into both retry loops.** Because both the single-feature and multi-feature retry loops route through the shared `decideAfterFailure` pipeline (architecture constraint 1), the new behavior applies identically to both without a forked implementation. No caller-side special-casing that would let the two paths diverge.

9. **Recorded on the FailureRecord like the other classes.** The `user-actionable` classification is stamped onto the `FailureRecord` at record time by `processFailureAndDecide` and persisted to `sprint-N.json`, exactly as `transient`/`deterministic` are today. No signature re-derivation at read time.

10. **Escalation is resumable, never a dead end.** A user-actionable escalation parks the step in the existing `escalated` (resumable) state — it does NOT introduce a new terminal/limbo status. After the user acts (raises the limit / fixes the config), the existing resume path re-engages the step. No new resume mechanism is introduced.

11. **Tests exercise the production seam.** Regression tests drive the real pipeline, not just the classifier helper:
    - `classifyFailure` returns `"user-actionable"` for each seed pattern and for realistic full error strings (unit).
    - Driving the real `decideAfterFailure` (and, where attempt accounting is asserted, the runner retry seam), a first-attempt user-actionable failure yields an `escalate` decision with `reason: "user-actionable"` and **no second attempt** — asserted against the actual attempt counter, not a mock.
    - A billing error and an invalid-model error each escalate after **1** attempt (contrast: today a billing error burns 2, an invalid-model error burns 3 — that contrast is the RED-verification baseline).
    Per TEAM.md QA rule 12, each constraint-guarding test carries a RED-verification note proving it FAILS against the pre-change pipeline (where these errors classify `deterministic` and burn multiple attempts).

12. **Default-off / no-regression parity.** An error summary matching **no** user-actionable pattern classifies exactly as it does today (`transient` if it matches the transient registry, else `deterministic`). The two existing classes' behavior — slot accounting, transient cap, no-progress short-circuit — is byte-for-byte unchanged when no user-actionable pattern matches. A default-parity test proves an ordinary deterministic failure still consumes slots and escalates at `MAX_RETRY_ATTEMPTS`.

13. **All operations remain pure / dependency-free.** Classification stays deterministic string/regex matching — no LLM calls, no new dependencies, no `/g`-flag stateful regexes (consistent with the Sprint 12 module constraints).

## Edge Cases
- **A user-actionable pattern also matches a transient pattern.** Precedence must be unambiguous (Architect to order the checks) so the failure classifies `user-actionable` (escalate-now) rather than transient (retry-loop) — retrying a spend-limit error as if it were a network flake is the exact waste this feature removes.
- **Billing error phrasing drift.** The spend-limit message wording may vary across CLI versions ("monthly spend limit", "usage limit", etc.). The seed pattern should be broad enough to catch the known specimen; over-fitting to one exact string is a known risk — bias the regex toward catching the real specimen (mirrors the transient registry's specimen-plus-generalization approach). New phrasings are a one-line registry addition (AC #3).
- **Invalid-model error at spawn vs. mid-run.** The unknown-`--model` rejection surfaces at process spawn. Confirm the error text the `claude` CLI emits reaches the same `errorSummary` that `classifyFailure` sees, so the pattern actually matches the real failure string (not an assumed one).
- **A user-actionable failure on attempt 2+.** If a step already had a deterministic failure and then hits a user-actionable one, it still escalates immediately on encountering the user-actionable failure (it does not "finish" the remaining deterministic budget). Escalate-now dominates remaining slot budget.
- **Old state files without the new class.** Historical `FailureRecord`s carry only `transient`/`deterministic` (or none). They load unchanged; the `?? "deterministic"` default applies. No migration.
- **Both seed patterns present in one output** (billing text and a model complaint in the same summary). Either match yields `user-actionable` — the message may name the first-matched action; a merged/either-action message is acceptable (Architect's call on wording).

## Out of Scope
- **Making the pattern registry user-configurable via `config.json`.** The transient registry is code-only; this one matches that decision. A configurable failure-signature surface is a separate future item.
- **`merge-failure-short-circuit`** (Inbox) — wiring *merge-step* deterministic failures into `decideAfterFailure`. Different failure surface, tracked separately; deferred by Architect ruling (merge retries cost seconds).
- **Changing `transient` or `deterministic` semantics** — `TRANSIENT_RETRY_CAP`, `MAX_RETRY_ATTEMPTS`, the no-progress short-circuit, and slot accounting are untouched. This spec only adds a third class and its pipeline branch.
- **`persist-feedback-across-retries`** (Ready) — the episodic reflection buffer is a separate concern; a user-actionable escalation simply parks the step.
- **Auto-remediation of the user action** (auto-raising the spend limit, auto-correcting the config). The class escalates to the user with the action named; it never performs the action.
- **New MCP tool surface or a new sprint status.** Reuses the existing `escalated`/resume machinery (AC #10).

## Open Questions
1. **Classification precedence ordering.** In what order should `classifyFailure` check user-actionable vs. transient vs. deterministic so an ambiguous string (matches both a user-actionable and a transient pattern) resolves to `user-actionable`? Technical decision — Architect to specify the check order in the classifier.
2. **Exact invalid-model error string.** What is the precise stderr/stdout text the `claude` CLI emits on an unknown `--model` at spawn, and does it reach `errorSummary` intact (via the spawn error path introduced by Sprint 14's model plumbing)? Architect/QA to confirm the real string so the seed regex matches production, not an assumption. (Ties to the invalid-model-at-spawn Edge Case.)
3. **Message merge for multi-match.** When both seed patterns match one summary, does the escalation name one action (first match) or both? PO's intent: naming at least the matched action(s) is sufficient — Architect to finalize wording.
4. **Signature interaction.** Should a user-actionable failure still receive a `deriveFailureSignature` value (for post-mortem readability) even though it escalates before any signature *comparison* happens? PO leans yes (keep records uniform); Architect to confirm no pipeline interaction.
