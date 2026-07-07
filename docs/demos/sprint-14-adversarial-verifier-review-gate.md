# Sprint 14 Demo — adversarial-verifier-review-gate

**Presenter:** Brax (Team) 🦕
**Date:** 2026-07-07
**Feature:** adversarial-verifier-review-gate
**PR:** #32 · branch `sprint-14/adversarial-verifier-review-gate`

---

## 1. Sprint goals — what was planned

Harden Raptor's review gates so a sprint cannot report "all tests pass, PR
approved" when the tests secretly reimplement the system-under-test, were never
proven to fail, or were reward-hacked into passing. Filed as three parts;
Architect scoped them for this sprint:

| Part | Scope | This sprint |
|------|-------|-------------|
| **1 — Real-seam enforcement at the gate** | Orchestrator injects an adversarial-verifier instruction into the step-7 QA gate: hunt for test-local reimplementations, demand RED-verification notes on constraint-guarding tests, bias toward false-negative, never pass silently. | ✅ Shipped |
| **2 — Generator ≠ verifier (model plumbing)** | Optional `model` param on `spawnAgent` → `claude --model`; `models` config (`default` / `byRole`) parsed in `loadConfig`; `resolveRoleModel` threads it to every spawn site so QA can run on a different model than Engineer. | ✅ Shipped |
| **3 — Bias controls on any LLM-judge gate** | Order-swap + prompt-perturbation on any introduced scoring judge. | ✅ Vacuous — no judge gate introduced (recorded decision, AC 11) |

### Acceptance criteria (17 total)
- **Part 1 (AC 1–4):** adversarial gate instruction injected by orchestrator (not TEAM.md); enforcement is orchestrated; false-negative bias; no silent pass on a detected reimplementation.
- **Part 2 (AC 5–10):** `--model` plumbed; argv contract preserved (`--allowedTools` tail + `--` separator intact); idle/ceiling not regressed; per-role model config; config actually parsed (no dead plumbing); verifier ≠ generator when configured.
- **Part 3 (AC 11–14):** scope gate recorded as vacuous; no judge ensemble built (explicit refutation honored).
- **Cross-cutting (AC 15–17):** backward compatible; tests exercise the real production seam with RED-verification notes; no silent gate branch.

---

## 2. Feature demonstration

### Part 2 — `--model` plumbed, argv tail frozen (`agents.ts:207`, `:227`)
```ts
export function spawnAgent(role, systemPrompt, context, taskDescription, cwd, timeoutMs?, model?) {
  const args = [
    ...(model ? ["--model", model] : []),   // NEW — front of options block only
    "--print", "--permission-mode", "acceptEdits",
    "--allowedTools", AGENT_ALLOWED_TOOLS.join(","),
    "--system-prompt", systemPrompt,
    "--append-system-prompt", context,
    "--",                                     // load-bearing (PR #18) — untouched
    taskDescription,                          // terminal positional — untouched
  ];
```
`model` undefined ⇒ the spread contributes nothing ⇒ argv is **byte-identical to today**.

### Part 2 — config → resolved model, no dead plumbing (`config.ts` `parseModels`, `runner.ts:81`)
```ts
export function resolveRoleModel(role, config): string | undefined {
  return config.models?.byRole?.[role] ?? config.models?.default ?? undefined;
}
```
`parseModels` is type-guarded exactly like `parseTimeouts` — a malformed `models`
value is dropped field-wise, `loadConfig` never throws. This directly averts the
`config-keys-parsed-vs-declared` defect class (the `timeouts` dead-plumbing bug
that sat six sprints).

### Part 1 — adversarial gate injected at step 7 (`prompts.ts:126`, `runner.ts:99`)
```ts
function injectAdversarialGate(step, context): string {
  if (step.role === "qa" && step.name === "Run test suite")
    return `${context}\n\n${buildAdversarialGateSection()}`;
  return context;   // no-op for every other step
}
```
`buildAdversarialGateSection()` directs the QA gate agent to (a) hunt for tests
that reimplement/stub the system-under-test, (b) confirm constraint-guarding
tests carry a RED-verification note, bias toward the false-negative, and
**FLAG + FAIL** — never drop the finding.

---

## 3. Test execution (run live at demo)

```
$ npx jest
Test Suites: 44 passed, 44 total
Tests:       780 passed, 780 total
Time:        ~9.3 s

$ npx jest adversarial-verifier-review-gate
Test Suites: 2 passed, 2 total
Tests:       24 passed, 24 total
```

---

## 4. Test results summary

- **Full suite: 780/780 green, 44/44 suites** — no regressions across the Sprint 12/13 lineage (`progress-aware-circuit-breaker`, `sprint-completes-despite-failed-merge`, `retro-improvements-not-applied`, `orchestrator-recovery-after-mixed-completion`).
- **Feature-scoped: 24/24** across the unit (`adversarial-verifier-review-gate.test.ts`) and integration suites.
- **Real-seam coverage (AC 16):** Part-2 tests assert the **real** `spawnAgent` argv array; Part-1 tests assert the **real** step-7 prompt built by the runner — no test-local reimplementations. Each constraint-guarding test carries a RED-verification note.
- **Edge cases covered:** no config (byte-identical argv), partial config (verifier set / generator default), same model for both, malformed `models` dropped without crash.
- **Defects:** 0 filed — full suite green, so no defect specs.

---

## 5. Requesting feedback

Open items for the stakeholder:
1. **Scope (tech-approval #1):** ship Part 1 + Part 2 in this one PR; Part 3 vacuous. Approved as designed — confirm at demo.
2. **Verifier model default (Open Question #6):** Architect recommendation is **no built-in default** — ship the capability with `models` unset (zero behavior change), opt-in per user. Confirm, or specify a default verifier model for QA.
3. Any follow-ups to file (e.g. `invalid-model-signature-class` as a sibling to `billing-error-signature-class`; a deterministic AST reimplementation pre-pass was deliberately left out of scope).
