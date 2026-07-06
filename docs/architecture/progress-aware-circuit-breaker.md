---
slug: progress-aware-circuit-breaker
spec: docs/specs/progress-aware-circuit-breaker.md
---
# Progress-Aware Circuit Breaker — Architecture Design

> Source provenance re-verified against this branch 2026-07-06 by the Architect:
> `MAX_RETRY_ATTEMPTS = 3` at `runner.ts:54`; single-feature retry loop at
> `runner.ts:756`, shared multi-feature cycle `runAgentStepCycle` at
> `runner.ts:1381`, merge retry at `runner.ts:~700`/`~1872`; one-shot wall-clock
> `setTimeout` → `SIGTERM` at `agents.ts:243-251`; stdout liveness listener at
> `agents.ts:253`; `FailureRecord.hadPartialArtifacts` written but never read
> (`state.ts:10`, `runner.ts:871,904,919,1482,1494,1509`); all 4
> `resolveStepTimeout` call sites omit the config arg
> (`runner.ts:831,855,1445,1467`); `loadConfig` drops the `timeouts` key
> (`src/config.ts`). All match the spec's provenance table.

## Overview

Five coordinated changes to the retry/escalation machinery, designed as one
system with a single, explicit **decision ordering** evaluated after every
failed agent attempt:

```
agent attempt fails
  │
  1. [BLOCKER] marker?  ──────────────► escalate (existing, unchanged, highest priority)
  2. Record FailureRecord (now with classification + signature + killKind)
  3. Salvage-complete check (CB-4) ───► ALL expected outputs on disk & pass the
  │                                     glob gate (.gitkeep-guarded)? → step
  │                                     COMPLETE via salvage. No retry consumed.
  4. Transient? (CB-2) ───────────────► retry WITHOUT consuming a slot, after a
  │                                     fixed delay; if transient count ≥ cap →
  │                                     escalate ("transient-cap")
  5. No-progress short-circuit (CB-1) ► deterministic failure whose signature
  │                                     equals the previous deterministic
  │                                     failure's (same step/feature, same
  │                                     narrowed flag) → escalate ("no-progress")
  6. Deterministic accounting ────────► consume a slot; max 3 → escalate
                                        ("attempts-exhausted") — today's behavior
```

Rationale for the ordering (spec Open Question 5):

- **Salvage before everything** (after BLOCKER): the Sprint 11 case is an agent
  that *finished its work* and was then killed. Whatever killed it — idle
  timeout, ceiling, socket drop — if the validated deliverables are on disk,
  no classification question remains. This is also why salvage runs for
  transient failures.
- **Transient before short-circuit**: two consecutive `socket connection closed
  unexpectedly` failures are outage evidence, not no-progress evidence
  (spec edge case, confirmed). Transient failures never participate in the
  CB-1 signature comparison — the short-circuit compares against the most
  recent **deterministic** failure, skipping interleaved transient records
  (det(A) → transient → det(A) still short-circuits: the transient blip did
  not change the task).
- **Short-circuit before slot accounting**: CB-1 exists to escalate *faster*
  than the 3-attempt breaker; evaluating it last would defeat it.

CB-3 (idle timeout) changes *what kinds of failures occur* (fewer premature
kills of streaming agents); CB-5 makes the user's timeout config actually
reach the mechanism. Both feed the pipeline above but do not change its shape.

**Scope of loop changes**: the two agent retry loops (single-feature
`runner.ts:756`, `runAgentStepCycle` `runner.ts:1381`) adopt the full pipeline.
The **merge-step retry loops are unchanged** in Sprint 12 (spec: "must at
minimum not regress" — merge failures are deterministic, salvage doesn't
apply; leaving them untouched is the zero-regression option).

## Components

### 1. NEW: `src/orchestrator/failure-classification.ts`

Pure, dependency-free module. All logic is deterministic string matching —
no LLM calls (explicit spec constraint). Unit tests colocated at
`src/orchestrator/failure-classification.test.ts` per repo convention.

```ts
export type FailureClassification = "transient" | "deterministic";

export const TRANSIENT_RETRY_CAP = 5;            // per step (spec AC 7 ceiling)
export const TRANSIENT_RETRY_DELAY_MS = 15_000;  // fixed delay before transient retry

/** Code-only for Sprint 12 (Open Question 2 ruling — see Constraints). */
export const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /socket connection closed unexpectedly/i,   // the Sprint 11 specimen (AC 6 minimum)
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE/,
  /fetch failed/i,
  /overloaded_error|"type"\s*:\s*"overloaded/i,
  /\b(429|529)\b.*(rate|overload)|rate limit/i,
  /50[023]\s+(internal server error|bad gateway|service unavailable)/i,
];

export function classifyFailure(errorSummary: string): FailureClassification;

/** Deterministic signature for CB-1 comparison. See derivation below. */
export function deriveFailureSignature(errorSummary: string): string;
```

**Signature derivation (Open Question 1 ruling).** Two tiers:

1. **Named signature classes** — checked first, in order; the signature is the
   class name, so cosmetic differences (durations, paths) can't defeat the
   match:
   - `stdin-wait-warning` — matches the claude CLI's "Input must be provided
     either through stdin or as a prompt argument when using --print" text
     (case-insensitive substring). This makes AC 2's requirement structural:
     two stdin-warning failures short-circuit, absorbing
     `early-exit-on-stdin-warning`.
   - `idle-timeout` — matches the new idle-kill message (below).
   - `hard-ceiling` — matches the new ceiling-kill message.
   - `wall-clock-timeout` — matches the legacy `agent timed out after {ms}ms`
     (old records, mixed-version resumes).
   - `buffer-overflow` — matches `agent output exceeded 10MB buffer`.
   - `no-output` — matches `agent produced no output`
     (`truncateErrorSummary`'s empty-output sentinel).
   - `missing-outputs:<sorted patterns>` — matches the
     "did not create required output files" summary; the sorted pattern list is
     appended so "missing A" ≠ "missing B", but "missing A" twice matches.
   - `missing-artifacts:<sorted list>` — same treatment for the
     "Missing required artifacts" pre-spawn failure.
2. **Generic normalization** (fallback): lowercase → strip ISO-8601 timestamps
   → strip durations (`\d+ms`, `\d+ ?(min|minutes|s|seconds)`) → replace
   absolute paths under the project root and `$HOME` with placeholders →
   collapse whitespace → take the first 200 characters. Plain-text prefix, not
   a hash — post-mortems can read it in state files and escalation messages.

Signatures are computed at record time and **persisted** on the
`FailureRecord`, so comparison across a process restart / resume never
re-derives with drifted logic against old text.

### 2. `src/orchestrator/agents.ts` — idle timer + hard ceiling (CB-3)

- Replace the one-shot `setTimeout` (`agents.ts:243-251`) with:
  - **Idle timer**: armed at spawn with the resolved step timeout
    (`timeoutMs ?? AGENT_TIMEOUT_MS` — the existing value is *reinterpreted*
    as an idle window, no new parameter). Reset on every `stdout` data chunk
    (the `agents.ts:253` listener). **stdout only** — the spec names stdout as
    the liveness signal (AC 10), and stderr-only spew (repeated warnings) is
    not evidence of forward progress; the ceiling covers a stderr-chattering
    zombie.
  - **Hard ceiling**: one-shot `setTimeout(HARD_CEILING_MS)` armed at spawn,
    never reset. Fires regardless of streaming (spec edge case: heartbeat
    garbage forever).
- Kill messages (distinguishable, AC 11/12):
  - idle: `agent idle-killed after {idleMs}ms with no stdout output`
  - ceiling: `agent killed at hard ceiling {ceilingMs}ms (still streaming — absolute runtime limit)`
  Buffered stdout/stderr captured so far is still preferred as the failure
  output (existing behavior); the kill message is used when the buffer is
  empty **and** is appended as a suffix line when it is not, so the signature
  classes above always match.
- `AgentResult` gains an additive field:
  `killKind?: "idle" | "ceiling" | "buffer-overflow"` — set on the respective
  kill paths, `undefined` otherwise. This is a timeout-mechanism change only;
  `spawnAgent`'s model/argv surface is untouched (out-of-scope constraint).
- Both timers cleared on `close`/`error`/kill; the existing `settled` guard
  pattern is retained. `MAX_BUFFER_BYTES` handling unchanged.

### 3. `src/orchestrator/timeouts.ts` — ceiling constant

```ts
export const HARD_CEILING_MS = 60 * 60 * 1000; // 60 min absolute agent runtime ceiling
```

**Open Question 3 ruling**: ceiling = **60 min** (= 2 × `MAX_TIMEOUT_MS`,
satisfying "≥ MAX_TIMEOUT_MS"). `MAX_TIMEOUT_MS = 30 min` is NOT raised — it
still caps the *idle window* a user can configure; the ceiling bounds total
runtime of a continuously-streaming agent. Transient cap = **5 per step**
(spec's suggested ceiling). Everything else in `timeouts.ts` (including
`STEP_TIMEOUT_DEFAULTS` resolution order, `timeouts.ts:33-56`) is unchanged;
the sanctioned `Write tests` 30-min bump (commit `11bf7d4`) is not touched.

### 4. `src/orchestrator/runner.ts` — decision pipeline + salvage (CB-1/2/4)

- **Extract the retry decision as a pure function** (unit-testable, and the
  single mechanism both loops share so single- and multi-feature behavior
  cannot diverge — spec edge case):

  ```ts
  export type RetryDecision =
    | { kind: "salvage-complete"; artifacts: string[] }
    | { kind: "retry"; consumesSlot: boolean; delayMs: number }
    | { kind: "escalate"; reason: "no-progress" | "transient-cap" | "attempts-exhausted";
        detail: string };

  export function decideAfterFailure(
    stepState: StepState,
    newFailure: FailureRecord,       // already pushed, already classified/signed
    salvage: SalvageResult
  ): RetryDecision;
  ```

- **Loop restructure**: the `for (attempt = attempts+1; attempt <= MAX_RETRY_ATTEMPTS)`
  loops become `while (true)` loops driven by `decideAfterFailure`.
  `stepState.attempts` keeps its exact current meaning — **deterministic
  attempts consumed** — so resume math (`attempts + 1`) and old state files
  are untouched. Transient retries do not increment it (AC 6); the transient
  count is *derived*, not stored:
  `failures.filter(f => (f.classification ?? "deterministic") === "transient").length`
  (the `?? "deterministic"` read satisfies AC 9 backward compat).
- **Salvage check** — new helper, runs after every failure record:

  ```ts
  interface SalvageResult {
    complete: boolean;          // every expectedOutputs pattern satisfied
    satisfied: string[];        // patterns satisfied (and by which files)
    missing: string[];          // patterns not yet satisfied
  }
  function checkSalvage(step: WorkflowStep, featureSlug: string, projectPath: string): SalvageResult;
  ```

  Implemented as a wrapper over the existing `matchExpectedOutput` glob gate
  (`glob-match.ts`) with one added filter: **files named `.gitkeep` never
  satisfy a pattern for salvage purposes** (AC 17). `validateStepOutputs` /
  `validateRequiredOutputs` themselves are NOT modified — the global fix is
  the `partial-artifacts-gitkeep-filter` Inbox item.
  - `complete === true` → mark step complete, `completedVia: "salvage"`,
    artifacts recorded, normal handoff commit, **no new agent spawn** (AC 15).
    Salvage never bypasses validation — it *is* the validation gate (AC 16).
  - Partial → the satisfied/missing lists feed the next attempt's **task
    description** (AC 14 names the task description, not the context): a new
    optional `salvageSection` parameter on `buildTaskDescription`, rendered
    as: files that already exist and passed the gate (do NOT recreate them —
    verify and build on them) vs. patterns still missing (this attempt's
    actual job). `buildRetryContext`'s existing partial-artifact excerpts
    remain in the context as supporting content.
  - **Tree-preservation invariant** (spec edge case "salvage race"): the retry
    loops perform no `git checkout/clean/reset` between attempts today
    (verified — branch switching happens only in `ensureFeatureBranch` before
    a feature's steps, and merge checkout after them). This invariant is
    documented here and pinned by an integration test; any future cleanup step
    must run salvage first.
- **No-progress short-circuit (CB-1)**: fires when the new failure and the
  most recent *prior deterministic* failure (skipping transient records) have
  identical persisted `signature`s AND the same `narrowed` flag. **Open
  Question edge-case ruling**: failures recorded by a scope-narrowed attempt
  get `narrowed: true`; a signature match across the narrowed/un-narrowed
  boundary does NOT short-circuit (the task changed, so repetition is not
  yet no-progress evidence). Escalation message states the short-circuit and
  shows the repeated signature (AC 1); `escalationReason: "no-progress"`
  persisted (AC 4).
- **Kill-kind classification (Open Question 4 ruling)**: `idle` and `ceiling`
  kills classify **deterministic**. Rationale: silence or runaway streaming is
  not a known-transient infra pattern, and routing them transient would permit
  5 × 30-min idle waits (2.5 h) on a stuck step. Each is its own signature
  class, so two consecutive idle-kills short-circuit after 2 via CB-1 —
  *faster* than today's 3 — while the salvage check (which runs first) rescues
  the finished-then-killed case entirely. `buffer-overflow` is deterministic
  (spec edge case: over-production; narrowing, not retrying, is the fix).
- **Transient retry**: waits `TRANSIENT_RETRY_DELAY_MS` (fixed, no
  exponential backoff — the cap is 5, sophistication buys nothing), then
  re-enters the loop without touching `attempts`. On the 5th transient
  failure for a step: escalate with `escalationReason: "transient-cap"` and a
  message identifying the persistent infrastructure problem (AC 7).
- **Reporting (AC 22)**: escalation commit messages and `SprintResult.message`
  include the reason marker; `renderProgressTable` shows
  `complete (salvaged)` / `escalated (no progress)` /
  `escalated (transient cap)` variants. No silent branches: every decision
  lands in a `FailureRecord`, a `StepState` field, or both.

### 5. `src/config.ts` + plumbing (CB-5)

- `loadConfig` parses `timeouts` from `config.json`:
  `{ default?: number, stepOverrides?: Record<string, number> }`, with type
  guards (non-number values dropped field-wise; malformed `timeouts` ignored
  entirely). Absent key → field absent → **byte-identical behavior** (AC 19).
  Only `timeouts` is added in this feature; the other declared-but-dropped
  `RaptorConfig` keys (`testConfig`, `codebaseContext`, …) are out of scope
  here and flagged as standing tech debt (see Constraints).
- Thread: `index.ts` already calls `loadConfig` → add
  `timeouts?: TimeoutConfig` to `ToolContext` (`tools.ts`) → `run_sprint` /
  `resume_sprint` tool handlers pass it → `runSprintFromStep` / `resumeSprint`
  gain a **trailing optional** `timeoutConfig?: TimeoutConfig` parameter
  (backward-compatible; all existing tests keep passing unmodified) →
  `DispatchContext` gains `timeoutConfig` → all 4 `resolveStepTimeout` call
  sites (`runner.ts:831,855,1445,1467`) pass it. The same resolved value is
  the idle window handed to `spawnAgent`.
- Integration test (AC 20): a temp `config.json` with a `stepOverrides` entry
  provably changes the timeout applied to that step end-to-end
  (`tests/integration/progress-aware-circuit-breaker.integration.test.ts`).

## Data Model

All changes are **additive optional fields** read with `??` defaults
(established convention; AC 9, AC 21). No field is renamed or removed; old
state files load and resume unchanged.

```ts
// state.ts
export interface FailureRecord {
  attempt: number;
  errorSummary: string;
  timestamp: string;
  hadPartialArtifacts: boolean;                      // existing — now also read (CB-4 reporting)
  classification?: "transient" | "deterministic";    // NEW — absent ⇒ "deterministic" (AC 9)
  signature?: string;                                // NEW — persisted at record time (CB-1)
  killKind?: "idle" | "ceiling" | "buffer-overflow"; // NEW — from AgentResult (CB-3)
  narrowed?: boolean;                                // NEW — true if recorded by a narrowed attempt
  salvagedPatterns?: string[];                       // NEW — expectedOutputs already satisfied when recorded
}

export interface StepState {
  // ...existing fields unchanged; attempts KEEPS meaning "deterministic attempts"
  completedVia?: "agent" | "salvage";                // NEW — absent ⇒ "agent" (AC 15)
  escalationReason?: "attempts-exhausted" | "no-progress" | "transient-cap"; // NEW (AC 4/7)
}
```

`loadSprintState`'s backward-compat block does **not** need to default the new
fields (they are read with `??` at use sites), matching how
`hadPartialArtifacts`-era fields were handled.

State-derived quantities (never stored, so they can't drift):
- transient count = transient-classified entries in `failures`
- previous-deterministic-failure for CB-1 = last `failures` entry with
  `(classification ?? "deterministic") === "deterministic"` before the new one

## API Contracts

| Surface | Change | Compat |
|---|---|---|
| `spawnAgent(role, systemPrompt, context, taskDescription, cwd, timeoutMs?)` | signature unchanged; `timeoutMs` reinterpreted as idle window; ceiling internal | drop-in |
| `AgentResult` | `+ killKind?: "idle" \| "ceiling" \| "buffer-overflow"` | additive |
| `runSprintFromStep(projectPath, projectSlug, sprint, fromStep, feedback?, timeoutConfig?)` | trailing optional param | additive |
| `resumeSprint(projectPath, projectSlug, sprint, action, feedback?, feature?, timeoutConfig?)` | trailing optional param | additive |
| `loadConfig(configPath)` | now returns `timeouts` when present | additive |
| NEW `classifyFailure(errorSummary): FailureClassification` | pure | — |
| NEW `deriveFailureSignature(errorSummary): string` | pure, deterministic | — |
| NEW `decideAfterFailure(stepState, newFailure, salvage): RetryDecision` | pure | — |
| NEW `checkSalvage(step, featureSlug, projectPath): SalvageResult` | fs read-only | — |
| Exported constants | `TRANSIENT_RETRY_CAP`, `TRANSIENT_RETRY_DELAY_MS`, `TRANSIENT_ERROR_PATTERNS`, `HARD_CEILING_MS` | module-level exports, NOT user-configurable (mirrors the `MAX_RETRY_ATTEMPTS` precedent) |

Error-message contracts (load-bearing — signature classes match on them):

| Event | Message shape |
|---|---|
| idle kill | `agent idle-killed after {idleMs}ms with no stdout output` |
| ceiling kill | `agent killed at hard ceiling {ceilingMs}ms (still streaming — absolute runtime limit)` |
| transient-cap escalation | names the repeated infra error and the cap: `persistent infrastructure failure: {signature} × {TRANSIENT_RETRY_CAP}` |
| no-progress escalation | `retries short-circuited: identical failure signature "{signature}" on consecutive attempts` |

## Non-Functional Requirements

| NFR | Target | Mechanism |
|---|---|---|
| Classification/signature latency | < 1 ms per failure, pure sync string ops | fixed-size regex registry; no I/O, no LLM (spec constraint) |
| Salvage-check latency | < 100 ms per failure | bounded `readdir`/`stat` over expected-output dirs only (same cost class as existing `validateStepOutputs`) |
| Per-step worst-case wall time | bounded: ≤ 3 deterministic × `HARD_CEILING_MS` (60 min) + 5 transient × idle window (≤ 30 min) + 5 × 15 s delay ≈ **4.5 h hard bound** (today's bound: 3 × 30 min = 90 min, but it killed working agents; the common case *improves* — no-progress escalates after 2 identical failures instead of 3, and salvage completes with zero extra attempts) | idle window + ceiling + transient cap + short-circuit |
| Work preservation | 0 validated artifacts discarded when an agent dies after finishing (the Sprint 11 loss class) | salvage-complete gate runs before any retry decision |
| Streaming-agent survival | an agent emitting stdout at any interval < idle window is never killed before the 60-min ceiling | idle-timer reset on stdout data |
| Backward compatibility | 100% of pre-Sprint-12 state files load and resume; `config.json` without `timeouts` behaves byte-identically | additive optional fields + `??` reads; guarded config parse |
| Observability | every decision path (short-circuit, transient retry, idle-kill, ceiling-kill, salvage-complete) visible in sprint state AND escalation/progress output | persisted markers per Data Model; no silent branches (AC 22) |
| Determinism | same failure text ⇒ same signature ⇒ same decision, across process restarts | signatures persisted at record time; pure derivation |
| Security | no new attack surface | no new deps, no network, no shell; regexes run over already-truncated (≤ 500 char) error summaries — no ReDoS-relevant input growth |

## Technology Choices

**No new technologies, frameworks, or dependencies.** Everything is built on
what's already approved and in the tree:

| Concern | Choice | Status |
|---|---|---|
| Idle timer + hard ceiling | Node built-in `setTimeout`/`clearTimeout` | existing platform |
| Error classification & signatures | plain TypeScript regex/string ops | no dependency |
| Glob gate for salvage | existing `glob-match.ts` (`picomatch`) | already approved (Sprint 9) |
| State persistence | existing JSON sprint-state files | unchanged |
| Config | existing `~/.raptor/config.json` via `loadConfig` | unchanged |
| Git operations | `simple-git` | unchanged (standing rule) |
| Tests | jest / ts-jest, colocated unit + `tests/integration/` | unchanged |

> **⚠️ User approval requested (per process, before implementation begins):**
> this design intentionally introduces **zero new dependencies**. The only
> "technology" decisions of note are three constants — hard ceiling **60 min**,
> transient cap **5/step**, transient retry delay **15 s fixed** — and the
> ruling that idle/ceiling kills classify as **deterministic**. Please confirm
> the zero-new-dependency approach and these values, or flag adjustments.
> (Spec Open Question 6 — whether salvage-completed steps should force
> checkpoint review — is a PO/user call for the demo; the design already
> persists the auditable `completedVia: "salvage"` marker either way, so no
> rework results from either answer.)

No new ADR is required: the technology stack is unchanged (ADR-001 stands).
If the user later wants the transient-pattern registry config-extensible,
that change would warrant an ADR.

## Constraints & Patterns

For QA (test design) and Engineers (implementation) — binding:

1. **Single decision mechanism.** Both agent retry loops call the same pure
   `decideAfterFailure`. Do not fork the pipeline logic per loop — the spec
   requires identical behavior in single- and multi-feature modes, and a pure
   shared function is how that's proven (unit tests hit the function;
   integration tests hit each loop once).
2. **Merge loops untouched.** The merge-step retries (`runner.ts:~700`,
   `~1872`) keep today's exact behavior in Sprint 12. Regression tests only.
3. **`attempts` semantics frozen.** `StepState.attempts` = deterministic
   attempts consumed, exactly as today. Transient counts and CB-1 lookbacks
   are derived from `failures[]`, never stored as counters.
4. **Signatures are persisted, not re-derived.** Comparison for CB-1 uses
   `FailureRecord.signature` written at record time. An old record without a
   `signature` never matches anything (treat as no-match, not as re-derive).
5. **Classification default is deterministic.** Every read is
   `f.classification ?? "deterministic"` (AC 9). Same pattern for all new
   optional fields — extend the existing `??` convention, do not add
   `loadSprintState` defaulting for them.
6. **Salvage wraps, never modifies, the glob gate.** `checkSalvage` filters
   `.gitkeep` in its own wrapper; `validateStepOutputs` /
   `validateRequiredOutputs` / `glob-match.ts` are not changed (the global
   `.gitkeep` fix is the separate `partial-artifacts-gitkeep-filter` item).
7. **Tree preservation between attempts is an invariant.** No
   checkout/clean/reset may be introduced between attempts of one step.
   Pin with an integration test: attempt N writes a file → attempt N+1's
   salvage/retry context sees it.
8. **Message text is contract.** The idle/ceiling/no-progress/transient-cap
   message shapes in API Contracts are matched by signature classes and (for
   BDD) by tests — change them only with a matching change in
   `failure-classification.ts` and its tests.
9. **stdout is the only liveness signal.** stderr does not reset the idle
   timer. The hard ceiling is the sole defense against never-idle zombies.
10. **Constants are module exports, not config.** `TRANSIENT_RETRY_CAP`,
    `HARD_CEILING_MS`, `TRANSIENT_RETRY_DELAY_MS` follow the
    `MAX_RETRY_ATTEMPTS` precedent: exported for tests, not user-tunable.
    Only the *timeout* config (`timeouts.default` / `stepOverrides`) is
    user-facing, per CB-5.
11. **Transient pattern registry is code-only this sprint** (Open Question 2
    ruling). It lives in `failure-classification.ts` as an exported array so
    tests can enumerate it. Config extensibility is a possible future item —
    do not build it now.
12. **No LLM-based classification** — deterministic pattern matching only
    (explicit spec constraint; multi-judge ensembles previously refuted 0–3).
13. **Timeout plumbing is pass-through.** `resolveStepTimeout`'s resolution
    order (`timeouts.ts:33-56`) must not change; CB-5 only supplies the
    hitherto-omitted argument and parses the config key. `MAX_TIMEOUT_MS`
    stays 30 min; the `Write tests` 30-min default (commit `11bf7d4`) is not
    re-done.
14. **Tech-debt flag (Architect, non-blocking):** `loadConfig` also drops
    `testConfig`, `codebaseContext`, `artifactInjection`, and
    `scopeNarrowing` — declared on `RaptorConfig` but never parsed. Same bug
    class as the `timeouts` key fixed here. Recommend a backlog item
    (`config-keys-parsed-vs-declared`) rather than widening this feature.

### Test-surface map (for QA planning; not test design)

| Concern | Suggested surface |
|---|---|
| signature derivation, classification, decision pipeline, ordering (incl. det→transient→det short-circuit; narrowed-boundary non-match) | unit: `failure-classification.test.ts`, `runner.test.ts` |
| idle-reset vs ceiling vs legacy timeout in `spawnAgent` | unit with fake child process / fake timers: `agents.test.ts` |
| salvage-complete (Sprint 11 replay), partial-salvage task description, `.gitkeep` guard, tree preservation, config override end-to-end (AC 20), old-state-file resume, single- vs multi-feature parity | integration: `tests/integration/progress-aware-circuit-breaker.integration.test.ts` |
| Given/When/Then for CB-1..CB-5 behaviors | `tests/bdd/progress-aware-circuit-breaker.feature` |
