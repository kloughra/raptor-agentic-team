---
slug: adversarial-verifier-review-gate
artifact: po-test-review
status: changes-requested
sprint: 14
reviewer: Petra (PO)
---

# PO Test Review — adversarial-verifier-review-gate

**Decision: CHANGES REQUESTED — narrowly. The BDD feature file is approved as-is. The colocated unit suite (`src/orchestrator/adversarial-verifier-review-gate.test.ts`, Part-2 argv/idle) is approved in full. The integration suite is structurally sound (real production seams, RED-until-implemented) and ~90% approved; ONE load-bearing gap must close before it can serve as the acceptance gate. Engineer should NOT begin implementation until QA lands Required Change 1 and hands back for re-review.**

## Scope of Review

- Spec: `docs/specs/adversarial-verifier-review-gate.md` (AC 1–17)
- Architecture: `docs/architecture/adversarial-verifier-review-gate.md` (Open-Question rulings verified — see below)
- BDD: `tests/bdd/adversarial-verifier-review-gate.feature` (22 scenarios across Parts 1–3 + cross-cutting)
- Integration: `tests/integration/adversarial-verifier-review-gate.integration.test.ts`
- Unit (colocated, Part-2 argv seam): `src/orchestrator/adversarial-verifier-review-gate.test.ts`

## Headline

This is strong work. Every assertion drives a real production surface — the real `loadConfig` against a written config file, the real `resolveRoleModel` export, the real `spawnAgent` argv against a fake child process, and the real `runSprintFromStep` step-7 loop for Part-1 gate injection. The sanctioned mock (`spawnAgent` only) is correctly scoped and carries an explicit "do NOT widen" warning against the Sprint 10 false-green anti-pattern. The `--model` byte-identical no-model argv assertion matches current `main` exactly (verified against `agents.ts:219–231`: positions 0–10, length 11). RED-verification notes are recorded per constraint-guarding test. Part 3's vacuity is proven by an export-surface scan, not asserted in prose — good.

**One gap is load-bearing and it is the same defect class this very feature exists to eliminate.** AC 9 requires the resolved model to be proven — *end-to-end* — to reach the spawn argv at the gate. The suite proves the three links **in isolation** (config→parsed, parsed→resolved, model→`--model`) but never proves the runner **wires them together**. A runner that parses `models`, never calls `resolveRoleModel`, and passes `undefined` to `spawnAgent` would leave all three seams green while the feature is dead plumbing at the integration point — which is precisely the `config-keys-parsed-vs-declared` defect AC 9 is written to prevent. This is the identical finding the Sprint 12 review raised at AC 20 (`progress-aware-circuit-breaker-test-review.md`, Required Change 1: "stops at `resolveStepTimeout`; runner→spawnAgent leg asserted only in a comment"). It cannot recur in the sprint whose whole purpose is catching false-green wiring.

## Architect-ruling provenance check (scoped surface is real, not invented)

Every seam QA pinned traces to an explicit ruling in the architecture doc:

| QA pin | Architecture source |
|---|---|
| Part 1 realized as step-7 QA-agent instruction (`buildAdversarialGateSection`) | §Components; OQ #3 ruling |
| Part 2 `models: { default?, byRole? }`, parsed like `timeouts` | §Data Model; OQ #2 ruling |
| `resolveRoleModel(role, config)` = `byRole[role] ?? default ?? undefined` | §API Contracts |
| `--model` inserts at front of options block; tail frozen | §API Contracts argv block; OQ ruling / Constraints |
| Part 3 vacuous — no LLM-judge scoring gate introduced | OQ #4 ruling (recorded, AC 11) |
| Detection = LLM judgment, no deterministic AST pre-pass | OQ #5 ruling |

⚠️ Note: the architecture's two design decisions (one-PR scope; **no built-in verifier-model default**) are pending **user approval** at the tech-approval checkpoint. Neither changes test *shape* — if the user requests a Part-2 PR split or a built-in default, the pinned assertions move values, not structure. Does not block QA's re-work.

## Acceptance Criteria → Test Coverage

| AC | BDD | Test | Verdict |
|----|-----|------|---------|
| 1 — adversarial gate instruction (reimpl hunt + RED-note check) | ✅ | ✅ real `buildAdversarialGateSection` content (adversarial/verif/reimplement/stub/production seam/RED) | Accept |
| 2 — orchestrated not documented; present in gate prompt | ✅ | ✅ real `runSprintFromStep` step-7 → asserts section in actual QA task prompt | Accept |
| 3 — bias toward false-negative | ✅ | ✅ content: reject / falsely-passing / cannot recover | Accept |
| 4 — no silent pass on detected reimplementation | ✅ | ✅ content: flag/fail + surface/report | Accept |
| 5 — `--model` plumbed; no-model byte-identical | ✅ | ✅ unit: inserts `--model <v>`; omits when absent; length-11 argv pinned | Accept |
| 6 — argv contract preserved (`--allowedTools`, `--`, terminal positional) | ✅ | ✅ unit: tail intact, `modelIdx < allowIdx`, task last | Accept |
| 7 — idle/ceiling not regressed with model set | ✅ | ✅ unit: fake-timer idle-kill + streaming-survives, `killKind`/exit pinned | Accept |
| 8 — per-role model config | ✅ | ✅ `resolveRoleModel`: override / default / override-beats-default | Accept |
| 9 — config parsed AND reaches spawn argv (no dead plumbing) | ✅ (scenario "reaches the spawn argv end-to-end at the step-7 gate") | ⚠️ `loadConfig` parse ✅ + `resolveRoleModel` ✅ + `spawnAgent`→`--model` ✅, but the **runner→spawnAgent model-arg leg is never asserted** | **Reject — Required Change 1** |
| 10 — verifier ≠ generator when configured, observable at the gate | ✅ | ⚠️ proven only at `resolveRoleModel`; not observed at the two real spawn calls | **Reject — folds into Required Change 1** |
| 11 — Part 3 scope gate, vacuous, recorded | ✅ | ✅ export-scan + architecture record | Accept |
| 12–13 — order-swap / perturbation (conditional) | ✅ (vacuous) | ➖ N/A — no judge gate introduced | Accept (vacuous) |
| 14 — no judge ensemble | ✅ | ✅ export-surface scan (`judge|ensemble|voting|…`) | Accept |
| 15 — backward compat; malformed dropped field-wise | ✅ | ✅ no-`models` undefined; array/number/unknown-role drops; no-model argv | Accept |
| 16 — tests exercise the production seam | ✅ | ✅ everywhere **except** the AC-9 runner leg (the one seam not driven) | Accept once RC 1 lands |
| 17 — no silent branch; every decision observable | ✅ | ⚠️ gate-flag observability ✅; "selected verifier model observable" leans on the same missing runner-leg assertion | Accept once RC 1 lands |
| Edge — no config ⇒ byte-identical | ✅ | ✅ | Accept |
| Edge — invalid/unavailable model → existing failure path | ✅ | ➖ **no executable test** (see Note, non-blocking) | Accept (deferred) |
| Edge — partial config falls back | ✅ | ✅ `resolveRoleModel` partial-config test | Accept |
| Edge — same model both roles allowed | ✅ | ➖ implied by resolver tests | Accept |
| Edge — RED-note not demanded on ordinary tests | ✅ | ✅ content: scoped to "constraint-guarding" | Accept |

## Required Change (QA owns test design; this is the binding gap)

1. **AC 9 / AC 10 — the end-to-end test must be able to FAIL when the runner leaves the model unwired.** Today the suite proves `config.json → loadConfig` (✅), `loadConfig → resolveRoleModel` (✅), and `model → spawnAgent --model` (✅) as three disjoint tests, and the file header explicitly claims they "prove the AC-9 end-to-end chain without a single monolithic call." They do not. The middle leg — *the runner actually calls `resolveRoleModel` and passes its result into the `spawnAgent` call at the step-7 gate* — has **zero** executable coverage, and that leg is exactly where the `config-keys-parsed-vs-declared` defect (dead plumbing) lives. The BDD scenario **"The verifier model reaches the spawn argv end-to-end at the step-7 gate (AC 9, AC 10)"** is written but unimplemented.

   Bind it using the harness this file already has. The Part-1 test already drives the real `runSprintFromStep` at step 7 with `spawnAgent` mocked. Extend that pattern:
   - Write a `models.byRole.qa` (and a distinct `models.byRole.engineer`) config **into the location the runner actually reads** — `~/.raptor/config.json` under the sandboxed `fakeHome`, not `tmpDir/config.json` (the current `writeConfig` helper writes somewhere `runSprintFromStep` never loads). Confirm the runner's real config-load path picks it up.
   - Drive the real step-7 gate and assert the QA `spawnAgent` mock was called with the resolved qa model as its `model` argument (arg index 6).
   - For AC 10, assert the engineer-step spawn (or a second driven step) received the *distinct* engineer model — demonstrating the two are not forced to the same model **at the real spawn seam**, not merely at the resolver.
   - Record a RED-verification note: the assertion must be proven to FAIL against a runner that resolves the model but forgets to thread it to `spawnAgent` (hand-stub the unwired call, confirm RED).

   Per TEAM.md QA rule 12 / AC 16, a constraint-guarding test must exercise the production seam where the constraint applies — here the runner's spawn call site. Three green unit seams that don't touch that site are inadequate coverage for AC 9, whose entire reason for existing is to catch this defect class. This is the same binding gap the Sprint 12 review caught at AC 20; it must not reopen in *this* feature.

## Note (non-blocking, tracked to Step 8 — not a change to QA's step-3 artifacts)

- **Invalid-model edge case has no executable test.** The BDD scenario "An invalid configured model surfaces through the existing failure path" is genuinely hard to drive headless (it needs a real `claude` rejecting `--model`). The architecture rules this rides the *existing* failure-classification/retry path — i.e. no new behavior to pin. Acceptable to leave uncovered, but QA should call it out in the PR test report as a deliberate deferral (skip-gracefully-against-real-code per the `dev-loop-rebuild-friction` / `live-claude-smoke-test` precedent if a cheap harness exists). Not a blocker.
- **AC 7 "existing `agents.test.ts` cases pass unmodified"** is satisfied by the full suite running green post-change, not by a new assertion. Correct — the new Part-2 unit file is deliberately a separate slug-named file so the signature change does not knock the frozen `agents.test.ts` out at compile time. Good call; noted for the step-8 test report.

## Out-of-Scope Items Correctly Excluded

- No multi-judge / voting ensemble anywhere — pinned by the export-surface scan (refuted research honored). ✅
- No TEAM.md process-text edit for Part 1 — enforcement is orchestrated at the step-7 seam. ✅
- No deterministic AST reimplementation-detector — LLM judgment per OQ #5. ✅
- No `spawnAgent` timeout/idle/ceiling rework — only the additive `--model` arg; idle/ceiling non-regression pinned. ✅
- No state-schema change — `resolvedModel` on `StepState` deliberately NOT added (architecture). ✅
- No global `config-keys-parsed-vs-declared` conformance fix — this feature only guards against *adding* a new dead key (AC 9). ✅

## Open Questions status (do not block this review)

- Architecture design decisions (one-PR scope; no built-in verifier default) go to the **user** at the tech-approval checkpoint. Value-only impact on tests if changed.
- Spec Open Question #6 (verifier model default choice) is a user call before demo — the suite is default-agnostic (`models` unset ⇒ byte-identical), so either answer is rework-free.

## Decision

**Changes requested — narrow.** BDD approved as-is. Part-2 unit suite approved in full. Integration suite approved except **Required Change 1** (the AC 9 / AC 10 runner→`spawnAgent` model-arg leg, driven through the real step-7 seam and proven RED against an unwired runner). Once QA lands it and the suite is RED against current `main` for the right reasons, hand back to PO for re-review, then to Engineer for implementation.
