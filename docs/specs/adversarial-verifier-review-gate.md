---
slug: adversarial-verifier-review-gate
status: draft
sprint: 14
---
# Adversarial Verifier Review Gate

## User Story

As a **Raptor user running a sprint**, I want the QA/PR review gates to behave as *out-of-loop adversarial verifiers* — actively hunting for false-green work, running on a verifier that is not the same agent that produced the work, and (where any LLM scores or judges) guarded against ordering/prompt bias — so that a sprint cannot report "all tests pass, PR approved" when the tests secretly reimplement the system-under-test, were never proven to fail, or were reward-hacked into passing.

**Why now.** Research on in-context reward hacking shows a single model that both *generates* and *judges* its own work inflates its evaluation scores while real quality stagnates, and that stronger models cheat *more* when the reward is "make the tests green." Raptor's review gates today are structurally exposed to exactly this: every role-agent — Engineer, QA, reviewer alike — runs the same default `claude` binary with no verifier/generator separation and no anti-gaming instruction at the gate.

**Evidence cited in the backlog item (for context, not acceptance):**
- arXiv 2407.04549 — spontaneous in-context reward hacking (evaluator scores rise while quality stalls).
- ImpossibleBench 2510.20270 — agents delete/rewrite tests to go false-green; stronger models cheat *more* (GPT-5 76%).
- arXiv 2604.16790 — LLM judges are prompt-fragile (~15pt swing from a distraction).
- **Refuted (do NOT build):** a multi-judge *ensemble* was NOT supported (0-3 in prior research). This spec must not introduce a judge panel.

## Background

This feature has **three parts**, filed together in the backlog. They are related (all harden the review gates) but technically independent; whether they ship as one sprint feature or split is an Open Question for the Architect and user (see Open Questions #1).

### Part 1 — Assert against real production seams (enforcement)

The false-green failure mode the PO gate caught in Sprint 10 (a test that reimplemented the system-under-test and passed both before and after the change) is now **partially** addressed by *process text*: TEAM.md QA rule 12 (added Sprint 12/13 retros) requires constraint-guarding tests to exercise the production seam and carry a recorded **RED-verification note** proving the test fails pre-change. The backlog addendum is explicit: Part 1's *remaining* scope is **ENFORCEMENT in the orchestrator**, not more process text — e.g. review-gate prompts that instruct the verifier to actively check for test-local reimplementations and for the presence of RED-verification notes, and/or a validation pass that surfaces their absence.

### Part 2 — Generator ≠ verifier (model plumbing)

`spawnAgent` (verified `src/orchestrator/agents.ts:200`, backlog cited `:194`) takes **no model parameter** today — every role-agent runs the same default `claude`, so the QA/reviewer verifying the Engineer's work is (potentially) the same model that produced it. This part adds `--model` plumbing and a per-role model configuration surface so the verifying roles (QA, and any reviewer gate) can run on a different model and/or a context-isolated prompt from the generating role (Engineer).

**Load-bearing constraint (verified against current `main`):** the `spawnAgent` argv is fragile and was hardened in PR #18. The `--` end-of-options separator before `taskDescription` (`agents.ts:229`) and the `--allowedTools` ordering (`agents.ts:223-224`) are load-bearing — the `--allowedTools` variadic silently absorbs the prompt positional without the `--`. Any `--model` insertion MUST preserve this contract and MUST NOT regress the Sprint 12 idle-timeout / hard-ceiling behavior in the same function (`agents.ts:249-321`).

### Part 3 — Bias controls on any LLM-judge gate

Where an LLM *scores or judges* on a gate (A/B, pass/fail, or numeric), bias controls are required: A/B order-swap and prompt-perturbation checks so a verdict that flips under reordering or a benign distractor is flagged as unreliable. **Note:** Raptor's review gates today are (a) the QA test-execution agent step and (b) user checkpoints — there is no numeric LLM-judge scoring gate in the orchestrator today. Part 3 therefore applies **conditionally**: it constrains any LLM-judge gate this feature *introduces*, and does nothing if no such gate is introduced (see Open Questions #4).

### Verified code provenance (2026-07-07, current `main`)

The backlog item warns its line references are stale (Sprints 12–13 shifted `agents.ts` / `runner.ts`). Verified locations:

| Claim | Verified location | Notes |
|---|---|---|
| `spawnAgent` takes no model param | `src/orchestrator/agents.ts:200-207` | Signature: `(role, systemPrompt, context, taskDescription, cwd, timeoutMs?)`. Backlog said `:194`. |
| Single default model for all roles | `agents.ts:236` (`spawn("claude", args, …)`) | No `--model` flag anywhere in argv. |
| `--` separator + allowedTools ordering (load-bearing) | `agents.ts:219-231` | `--allowedTools` at 223-224; `--` at 229. PR #18 fix. |
| Idle-timeout / hard-ceiling machinery (must not regress) | `agents.ts:249-321` | Sprint 12 CB-3. |
| Role system prompts (single source, no verifier separation) | `src/orchestrator/prompts.ts:13-107` (`ROLE_PROMPTS`) | QA/Engineer/etc. all built by `buildRolePrompt`. |
| Review gate = QA test-execution agent step | `SPRINT_WORKFLOW` step 7 "Run test suite", `workflow.ts:96-102` | Spawned agent (a seam we can instrument). |
| Review gate = PR review (user checkpoint) | `pr-review` checkpoint, `checkpoints.ts:33-38` | User-driven, not an agent today. |
| `spawnAgent` call sites (all must stay compatible) | `runner.ts:799, 1133, 1877, 2463`; `scope-narrowing.ts:260` | Any signature change is additive/optional. |
| Config surface has no model key | `src/config.ts` `RaptorConfig` / `loadConfig` | Declares `dinoNames`, `timeouts`, `testConfig`, `codebaseContext`, `artifactInjection`, `scopeNarrowing`; **no model config**. |

**Cross-item constraint:** `config-keys-parsed-vs-declared` (Ready) documents that `loadConfig` silently drops declared-but-unparsed config keys (the `timeouts` dead-plumbing defect that sat unnoticed six sprints). Any new model-config key introduced by Part 2 MUST be parsed in `loadConfig` (not merely declared on the interface) and covered by a test — do not repeat that defect class.

## Acceptance Criteria

### Part 1 — Real-seam enforcement at the gate

1. **Adversarial gate instruction.** The QA/review gate agent(s) receive an explicit instruction, injected by the orchestrator (not merely present in TEAM.md), to act as an adversarial verifier: specifically to (a) hunt for tests that reimplement or stub the system-under-test instead of exercising the real production seam, and (b) confirm that constraint-guarding tests carry a RED-verification note (per TEAM.md QA rule 12). The instruction directs the gate to FAIL/flag the review when either check fails, rather than passing silently.

2. **Enforcement is orchestrated, not just documented.** The Part-1 behavior is realized in orchestrator code/prompt-construction (the gate seam), so it takes effect for every sprint without relying on a human having read TEAM.md. A test proves the adversarial instruction is present in the gate agent's prompt/context.

3. **Verifier bias toward false-negative.** At the review/acceptance gate, the injected guidance biases the verifier toward rejecting suspicious-but-plausible work over accepting it (false-negative preferred to false-positive), consistent with the standing team principle "an agent can self-reflect on a failing test but cannot recover from a falsely-passing one."

4. **No silent pass on a detected reimplementation.** When the gate identifies a test-local reimplementation or a missing RED-verification note on a constraint-guarding test, that outcome is surfaced in the gate's reported result (and, where the gate is an agent step, is a flagged/failed outcome) — it is never dropped.

### Part 2 — Generator ≠ verifier (model plumbing)

5. **Model parameter plumbed to `spawnAgent`.** `spawnAgent` accepts an optional model selector and passes it to the `claude` CLI (e.g. via `--model`). When no model is provided, behavior is byte-identical to today (default model, no `--model` flag) — full backward compatibility with all existing call sites.

6. **argv contract preserved.** The `--` end-of-options separator before `taskDescription` and the `--allowedTools` ordering are preserved exactly. A test asserts that with a model set, `taskDescription` is still passed as a terminal positional after `--`, and `--allowedTools` still receives only the tool list (the live-claude-smoke-test regression from PR #18 does not reopen).

7. **Idle-timeout / ceiling not regressed.** The Sprint 12 idle-timer, hard-ceiling, buffer-overflow, and `killKind` behaviors in `spawnAgent` are unchanged when a model is set. Existing `agents.test.ts` cases pass unmodified.

8. **Per-role model configuration.** A configuration surface (Architect to design; likely a `~/.raptor/config.json` key) lets the user assign models per role — at minimum, a distinct model for the verifying roles (QA / reviewer) versus the generating role (Engineer). Absent configuration, every role uses the current default (no behavior change).

9. **Config actually parsed (no dead plumbing).** The new model-config key is parsed in `loadConfig` and reaches the runner's `spawnAgent` call sites — proven end-to-end by a test that sets a role model in config and asserts the resolved model reaches the spawn argv for that role. (Directly averts the `config-keys-parsed-vs-declared` defect class.)

10. **Verifier ≠ generator when configured.** When a distinct verifier model is configured, the QA/review gate agent runs under that model while the Engineer step runs under its own — the two are demonstrably not forced to the same model. Context isolation (the verifier is not handed the generator's private chain-of-thought) is preserved by the existing per-step prompt construction; this AC only requires the model separation to be real and observable.

### Part 3 — Bias controls (conditional)

11. **Scope gate.** If this feature introduces an LLM gate that *scores or judges* (A/B, pass/fail verdict, or numeric), then ACs 12–13 apply to it. If no such judge gate is introduced (the gates remain test-execution + user checkpoints), Part 3 is satisfied vacuously and this is recorded as a deliberate decision in the architecture doc — not silently skipped.

12. **Order-swap check.** Any introduced LLM-judge comparison is run in both A/B and B/A orderings; a verdict that flips under swap is flagged as unreliable (not silently taken at face value).

13. **Prompt-perturbation check.** Any introduced LLM-judge verdict is re-checked under a benign prompt perturbation (e.g. an added neutral distractor); a verdict that flips is flagged as unreliable.

14. **No judge ensemble.** No multi-judge/voting-ensemble gate is built (explicit refutation in the backlog research). Bias controls are order-swap + perturbation on a single judge, not N judges voting.

### Cross-cutting

15. **Backward compatibility.** All existing tests pass. Sprint-state files, config files without the new key, and all five `spawnAgent` call sites work unchanged. No change to state-file schema beyond additive optional fields (read with `??` defaults per convention).

16. **Tests exercise the production seam.** Per TEAM.md QA rule 12, tests for this feature drive the real seams: the actual `spawnAgent` argv construction (Part 2) and the actual gate prompt/context construction in the runner (Part 1) — not test-local reimplementations. Each constraint-guarding test carries a RED-verification note proving it fails against the pre-change code (e.g. a Part-2 argv test proven to fail when `--model` is absent/misordered).

17. **No new gate is a silent branch.** Every new decision the gate can make (flag reimplementation, flag missing RED note, flag unreliable judge verdict, select verifier model) is observable in the gate's output and/or sprint state — no silent acceptance path.

## Edge Cases

- **No config set.** No per-role models, no judge gate configured → the sprint behaves exactly as today (default `claude` everywhere, no `--model`, no new instructions changing outcomes beyond the additive gate guidance). This is the dominant path and must be byte-compatible for argv.
- **Configured model name is invalid / unavailable.** The `claude` CLI will reject an unknown `--model`; the failure must surface through the existing failure-classification / retry path, not crash the orchestrator. (Whether an invalid model short-circuits as user-actionable is an Architect decision — see `billing-error-signature-class` precedent.)
- **Verifier model configured but generator model not (or vice-versa).** Partial configuration is valid — the unconfigured role falls back to default. Generator = default and verifier = distinct still satisfies "generator ≠ verifier."
- **Same model configured for both roles.** Allowed (user's choice); the feature does not *force* distinct models, it *enables* them. AC 10 is conditional on distinct models being configured.
- **RED-verification note absent because the test is not constraint-guarding.** Not every test guards an architectural constraint; the Part-1 gate must not demand a RED note on ordinary happy-path tests (avoid false alarms). The distinction (which tests require a RED note) follows TEAM.md QA rule 12's wording — Architect/QA to operationalize the detection heuristic.
- **Gate flags a false positive** (a legitimate test mistaken for a reimplementation). The gate flags for human/PO attention rather than hard-blocking irreversibly; the PO acceptance checkpoint remains the human backstop.
- **`pr-review` is a user checkpoint, not an agent.** If Part 1 enforcement is to touch the PR-review gate specifically, note that today that gate is user-driven (`checkpoints.ts`); the agent-instrumentable review seam today is the QA test-execution step (step 7). Where Part 1 lands is an Architect decision (Open Question #3).

## Out of Scope

- **Building a multi-judge ensemble / voting panel.** Explicitly refuted by the cited research (0-3). Do not build.
- **Rewriting TEAM.md process text for Part 1.** The remaining Part-1 scope is orchestrator *enforcement*; QA rule 12 + RED-verification text already exist (Sprint 12/13 retros). Retro-driven TEAM.md edits, if any, go through the normal step-11/12/13 retro flow, not this feature.
- **Changing `spawnAgent`'s timeout/idle/ceiling mechanics** beyond adding the model flag (Sprint 12 owns that; this feature must not regress it).
- **Reworking the checkpoint/resume state machine** (`orchestrator-recovery-after-mixed-completion`, `pr-review-feedback-routes-to-wrong-step-code` are separate items).
- **A general per-step prompt-isolation / private-scratchpad redesign.** AC 10 requires only that the verifier model be distinct and observable; deeper context-isolation architecture is not in scope unless the Architect deems a minimal change necessary to satisfy AC 10.
- **Model-cost accounting / budget controls.** Choosing a cheaper or pricier verifier model has cost implications, but cost tracking is not part of this feature.
- **Fixing `config-keys-parsed-vs-declared` globally.** This feature must not *add* a new dead key (AC 9), but the broader parsed-vs-declared conformance test is that separate Ready item's job.

## Open Questions

*For the Architect (design decisions — do not block spec approval):*
1. **Split or single feature?** Parts 1, 2, 3 are independent. Is this one sprint feature, or should Part 2 (model plumbing) and Part 1 (gate enforcement) split into separate PRs? PO leans: Part 2 is a self-contained, testable plumbing change; Part 1 is prompt/enforcement; Part 3 is conditional on Part 1's shape. Architect to recommend sequencing.
2. **Model-config shape.** Where does per-role model config live and what is its schema (`config.json` `models.byRole`? a `modelOverrides` map keyed by role?) — and how does it interact with the existing `dinoNames` per-role pattern? Must be parsed in `loadConfig` (AC 9).
3. **Which gate does Part 1 instrument?** The agent-instrumentable seam today is step 7 (QA run-suite). The `pr-review` gate is a user checkpoint. Does Part 1 inject adversarial instructions into step 7, into a new/expanded review agent step, or into the checkpoint context shown to the user — or all of the above?
4. **Does this feature introduce any LLM-judge gate at all?** If Part 1's enforcement is realized purely as an instruction to the existing QA agent (which then reports flags), there may be no *scoring* judge — making Part 3 vacuous (AC 11). If the Architect proposes an explicit judge/scoring gate, Part 3's bias controls become mandatory. Architect to decide and record.
5. **Detection heuristic for "test-local reimplementation" and "missing RED note."** Is this purely an instruction the verifier agent acts on (LLM judgment), or is there a deterministic pre-pass (e.g. scanning test files for imports of the production module vs. local mock definitions)? AC 1/AC 4 set the behavioral bar; the mechanism is the Architect's call.

*For the user (needs answer before demo, not before design):*
6. **Verifier model choice.** Which model should the verifying roles default to when a user opts in — a stronger model than the Engineer, a same-tier-different-instance, or left entirely to per-user config with no default? (Research motivates *different*, not necessarily *stronger*.)
