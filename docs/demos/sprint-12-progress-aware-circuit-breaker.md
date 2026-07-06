# Sprint 12 Demo — progress-aware-circuit-breaker

**Date:** 2026-07-06
**Presenter:** Brax (Team) — Step 8
**Branch:** `sprint-12/progress-aware-circuit-breaker` · **PR:** #27 (open)

## Sprint Goal

Make the retry circuit breaker distinguish *no progress* from *interrupted
progress*: classify errors (transient vs deterministic), keep still-working
agents alive (idle timeout instead of wall-clock kill), salvage completed
artifacts, short-circuit repeated identical failures, and wire the
long-dropped `timeouts` config key end-to-end.

**Motivating specimen:** Sprint 11 post-mortem — both features escalated at
step 3 after 6 failures (2× wall-clock SIGTERM of still-streaming agents,
4× transient socket drops); completed, validated BDD files (203 + 122 lines)
were discarded.

## Delivered (CB-1 … CB-5)

| # | Change | Where |
|---|--------|-------|
| CB-1 | No-progress short-circuit: identical persisted failure signature twice in a row (same narrowed flag, transients skipped) → escalate immediately with `escalationReason: "no-progress"` | `failure-classification.ts` (signatures), `runner.ts` `decideAfterFailure` |
| CB-2 | Transient vs deterministic classification, persisted on every `FailureRecord`; transient retries don't consume slots, capped at 5/step with 15 s fixed delay | `failure-classification.ts`, `runner.ts` |
| CB-3 | Idle timer (resets on stdout) replaces one-shot wall-clock kill; 60-min hard ceiling backstop; distinguishable kill messages + `killKind` on `AgentResult` | `agents.ts:249-283`, `timeouts.ts` (`HARD_CEILING_MS`) |
| CB-4 | Partial-artifact salvage: all expected outputs on disk & glob-gate-valid → step completes via salvage (`completedVia: "salvage"`), zero extra attempts; partial → next attempt's task description lists existing files; `.gitkeep` guarded | `runner.ts` `checkSalvage`/`decideAfterFailure` |
| CB-5 | `loadConfig` now parses `timeouts` (`default`/`stepOverrides`); all 4 `resolveStepTimeout` call sites receive it; end-to-end integration test | `config.ts`, `runner.ts`, `tools.ts`, `index.ts` |

Decision ordering (single pure function, shared by both retry loops):
**BLOCKER → salvage-complete → transient → no-progress short-circuit → slot accounting.**
Merge-step retry loops intentionally untouched (zero-regression ruling).

## Live Test Execution (this demo)

```
Test Suites: 37 passed, 37 total
Tests:       681 passed, 681 total
Time:        11.177 s
```

Feature-scoped: `progress-aware-circuit-breaker` + `failure-classification`
→ **2 suites, 100 tests, all passing**. BDD: 36 scenarios in
`tests/bdd/progress-aware-circuit-breaker.feature`.

## Defects / Friction During Sprint

- **PO test review requested changes once** (commit `5f7fbea`) — binding
  coverage gaps fixed by QA before implementation began; approved in `d779363`.
- **Step 5 escalated twice on infrastructure, not code**: 3× 10-min agent
  timeouts (`1cc87b3`) and 3× monthly-spend-limit errors (`eb1d193`) *after*
  the implementation had already landed green in `e5873b2`. Both are exactly
  the failure classes this feature addresses (wall-clock kills → CB-3 idle
  timeout; infra errors burning slots → CB-2 transient classification) —
  the sprint dogfooded its own justification.
- No open defect specs; suite fully green.

## Open Items for Stakeholder

1. **Spec Open Question 6 (flagged "needs answer before demo"):** salvage-completed
   steps pass the file-existence/glob gate without a fresh agent attempt. Is
   that sufficient, or should `completedVia: "salvage"` force the next
   checkpoint to flag the step for human review? (State marker is persisted
   either way — auditable regardless.)
2. **Architect constants confirmation:** hard ceiling **60 min**, transient cap
   **5/step**, transient delay **15 s fixed**, idle/ceiling kills classified
   **deterministic**, zero new dependencies.
3. **Tech-debt flag:** `loadConfig` still drops `testConfig`,
   `codebaseContext`, `artifactInjection`, `scopeNarrowing` — proposed backlog
   item `config-keys-parsed-vs-declared`.

## Feedback

_(recorded after demo — summarized; the literal blocker-marker string is
deliberately not reproduced here, see finding 3)_

**Stakeholder verdict:** Demo excellent; content accepted as committed in
`0173ceb`. The post-demo escalation was a **FALSE POSITIVE**: the presentation
quoted the decision-pipeline diagram, which contains the literal bracketed
blocker marker, and `hasBlockerMarker` (`runner.ts:259`) does a naive regex
match anywhere in agent output — so the demo escalated for *describing* the
escalation feature. Demo work stands; no redo required.

### Findings queued for Step 10 (PO triage — Petra)

1. `salvage-checkpoint-review-flag` — Open Question 6: should
   `completedVia: "salvage"` force human review at the next checkpoint?
   (already queued)
2. `config-keys-parsed-vs-declared` — `loadConfig` drops `testConfig`,
   `codebaseContext`, `artifactInjection`, `scopeNarrowing` (already queued)
3. `blocker-marker-false-positive-in-agent-output` — **new, from this demo's
   own escalation**: `hasBlockerMarker` (`runner.ts:259`) matches the blocker
   marker anywhere in agent output, including quoted/discussed occurrences.
   Should require the marker at line start or in a committed message, or
   strip fenced code blocks before matching.

### Re-presentation test run (2026-07-06)

```
Test Suites: 37 passed, 37 total
Tests:       681 passed, 681 total
Time:        8.058 s
```
