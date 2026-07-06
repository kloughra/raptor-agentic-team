---
slug: progress-aware-circuit-breaker
status: ready
sprint: 12
---
# Progress-Aware Circuit Breaker

## User Story

As a **Raptor user running a sprint**, I want the retry circuit breaker to distinguish *no progress* from *interrupted progress* — classifying errors, keeping still-working agents alive, and salvaging completed artifacts — so that transient infrastructure failures and premature kills stop burning retry slots and discarding good work, and genuinely stuck steps escalate faster.

**Live specimen:** Sprint 11 (`sprint-11-write-tests-escalation` post-mortem). Both features escalated at step 3 (Write tests) after 6 failures — 2× 15-min wall-clock timeout that SIGTERM'd a still-streaming agent mid-write, 4× `socket connection closed unexpectedly` transient API drops. Every failure recorded `hadPartialArtifacts: true`; both QA agents' completed, conventionally-named BDD files (203 + 122 lines) were discarded. Sprint 11 also lost feature-2's written-and-validated spec/arch docs the same way.

This spec covers five changes designed together (numbered CB-1 through CB-5 below).

### Verified code provenance

All references below validated against source 2026-07-06 (this branch):

| Claim | Verified location |
|---|---|
| `MAX_RETRY_ATTEMPTS = 3`, module export, no progress signal | `runner.ts:54` (backlog said :53; actual :54) |
| Retry loops that consume attempts | `runner.ts:756` (single-feature), `runner.ts:1381` (multi-feature), `runner.ts:1872` (merge) |
| Hard wall-clock `setTimeout` → `child.kill("SIGTERM")`, resolves `exitCode: 1` with output `agent timed out after {ms}ms` | `agents.ts:243-251` |
| Liveness signal already wired: `child.stdout?.on("data", ...)` | `agents.ts:253` |
| `hadPartialArtifacts` recorded on `FailureRecord` but never read by any retry/escalation decision | `state.ts:10`; written at `runner.ts:871,904,919,1482,1494,1509` via `validateStepOutputs` |
| `resolveStepTimeout(stepName, config?)` supports overrides but all 4 runner call sites omit the config argument | `runner.ts:831,855,1445,1467` |
| **Additional (found during spec authoring, not in backlog):** `loadConfig` never parses the `timeouts` key from `config.json` — the `RaptorConfig.timeouts` field is declared but dropped at load time | `src/config.ts` (`loadConfig` returns only `projectsBaseDir`, `teamTemplatePath`, `dinoNames`) |
| Sanctioned pre-work already landed: `STEP_TIMEOUT_DEFAULTS["Write tests"]` raised 15→30 min | `timeouts.ts:10`, commit `11bf7d4` (`write-tests-timeout-bump`) — **no remaining scope; do not re-do** |

## Acceptance Criteria

### CB-1: No-progress short-circuit

1. When a step fails and its failure signature is **identical** to the immediately preceding failure for the same step (same feature, in multi-feature mode), the runner stops retrying immediately and escalates — it does not consume the remaining attempt slots. The escalation message states that retries were short-circuited due to no progress and shows the repeated signature.
2. "Failure signature" is a deterministic derivation from the recorded failure (e.g. normalized `errorSummary`) — the exact derivation is an Architect decision, but it MUST treat the claude CLI's stdin-wait warning output as a signature class, so a stdin-warning-only failure repeated twice short-circuits (this absorbs the `early-exit-on-stdin-warning` Ready item as its special case).
3. Two failures with *different* signatures do NOT short-circuit — the existing 3-attempt behavior applies.
4. Short-circuited escalations are recorded in sprint state with a distinguishable marker (so post-mortems can tell "no progress" from "exhausted attempts").

### CB-2: Transient vs deterministic error classification

5. Failures are classified as `transient` or `deterministic` at the point the `FailureRecord` is written; the classification is persisted on the record.
6. Transient failures (at minimum: `socket connection closed unexpectedly`, and the classifier must be extensible for similar infra-level errors) do NOT consume a circuit-breaker attempt slot — the step is retried without incrementing the deterministic-attempt count.
7. Transient retries are bounded: a step cannot retry transiently forever. A separate transient cap exists (value is an Architect decision, suggested ceiling ≤ 5 per step) after which the step escalates with a message identifying the persistent infrastructure problem.
8. Deterministic failures behave exactly as today: consume a slot, max 3, then escalate.
9. Backward compatibility: `FailureRecord`s persisted by older sprints (no classification field) load without error and are treated as deterministic.

### CB-3: Idle-timeout instead of wall-clock kill

10. The agent deadline resets on every `stdout` data chunk (the liveness signal at `agents.ts:253`). An agent that is continuously streaming output is NOT killed at the resolved step timeout.
11. An agent that produces no output for the resolved step-timeout duration (the idle window) IS killed, with an error output that says it was idle-killed and for how long (distinguishable from the old wall-clock message).
12. A hard-ceiling backstop exists: regardless of streaming, no agent runs past an absolute ceiling (an Architect decision; must be ≥ `MAX_TIMEOUT_MS`, and `MAX_TIMEOUT_MS = 30min` itself is NOT raised). Hitting the ceiling kills the agent with a ceiling-specific error message.
13. An idle-kill or ceiling-kill of an agent classifies per CB-2 rules as defined by the Architect (an idle-kill where artifacts were produced pairs with CB-4 salvage).

### CB-4: Partial-artifact salvage

14. When a failed attempt left one or more expected output files on disk (`hadPartialArtifacts: true` today; per-file detail as needed), the next attempt's task description tells the agent which expected outputs already exist and instructs it not to recreate them from scratch — carrying completed work forward instead of restarting blind.
15. If ALL required expected outputs for the step exist on disk after a failed attempt (agent died after finishing its work — the Sprint 11 case), the orchestrator validates them via the existing `validateStepOutputs`/glob gate and, if they pass, marks the step complete WITHOUT another agent attempt. The step's state records that it completed via salvage.
16. Salvage never bypasses validation: files that fail the expected-outputs gate are not accepted; the step retries per CB-1/CB-2 rules.
17. `.gitkeep`-only directories do not count as partial artifacts for salvage decisions (do not fix `validateStepOutputs` globally — that's the `partial-artifacts-gitkeep-filter` Inbox item — but the salvage path must not be fooled by it).

### CB-5: Wire the timeout config plumbing

18. All 4 runner call sites (`runner.ts:831,855,1445,1467`) pass the user's timeout config into `resolveStepTimeout`, so `~/.raptor/config.json` `timeouts.default` / `timeouts.stepOverrides` actually take effect.
19. `loadConfig` parses the `timeouts` key from `config.json` (currently dropped — see provenance table). With no `timeouts` key present, behavior is byte-identical to today.
20. An integration test proves end-to-end: a `config.json` with a step override changes the timeout actually applied to that step.

### Cross-cutting

21. All existing tests pass; no change to sprint-state file compatibility beyond additive optional fields (per established convention: read with `??` defaults).
22. Every new decision path (short-circuit, transient retry, idle-kill, ceiling-kill, salvage-complete) is recorded in sprint state and visible in escalation/progress reporting — no silent branches.

## Edge Cases

- **Transient failure followed by identical transient failure**: CB-2 governs (transient cap), not CB-1 short-circuit — two socket drops in a row are expected during an outage and are not "no progress" evidence about the task. Architect to confirm interaction ordering.
- **Signature identical but attempt was narrowed**: progressive scope-narrowing (attempt 3) changes the task; a signature match across a narrowing boundary should not short-circuit blindly. Architect decision on whether narrowed attempts join the signature comparison.
- **Agent streams garbage/heartbeat forever**: the hard ceiling (AC 12) is the defense; a purely idle-based deadline alone would never fire.
- **Buffer-overflow kill** (`MAX_BUFFER_BYTES`, `agents.ts:255-258`): existing behavior unchanged; classify as deterministic (the agent is over-producing — retrying won't help without narrowing).
- **Salvage race with retry-loop artifact injection**: attempt N+1 must see the files attempt N wrote — expected outputs are on disk in the working tree, uncommitted. Verify the retry path doesn't clean the tree.
- **Multi-feature mode**: all five changes must behave identically in the single-feature (`runner.ts:756`) and multi-feature (`runner.ts:1381`) retry loops, and the merge-step retry (`runner.ts:1872`) must at minimum not regress (merge failures are deterministic; salvage doesn't apply).
- **Old state files**: sprints started before this feature resume without error (AC 9, AC 21).
- **Config with only `timeouts.default`** (no stepOverrides): applies to steps without built-in defaults; built-in `STEP_TIMEOUT_DEFAULTS` resolution order is already defined in `timeouts.ts:33-56` — do not change the order.

## Out of Scope

- Raising `MAX_TIMEOUT_MS` (30-min cap stays; idle-timeout is the fix — explicit backlog constraint).
- Re-doing the "Write tests" 15→30 min bump — already landed as commit `11bf7d4` (sanctioned `write-tests-timeout-bump`).
- Making `MAX_RETRY_ATTEMPTS` user-configurable (standing out-of-scope decision from Sprint 3).
- Global fix of `validateStepOutputs` `.gitkeep` noise (`partial-artifacts-gitkeep-filter`, Inbox) — only the salvage path guards against it here.
- Persisting directional feedback across retries (`persist-feedback-across-retries`, Ready — related but separate).
- LLM-based error classification or judge panels — classification is deterministic pattern matching (and multi-judge ensembles were refuted 0-3 in prior research).
- Resume/escalation targeting fixes (`orchestrator-recovery-after-mixed-completion`, Sprint 10 item).
- Any change to `spawnAgent`'s model/argv surface beyond the timeout mechanism (`adversarial-verifier-review-gate` owns that).

## Open Questions

*For the Architect (design decisions — do not block spec approval):*
1. Failure-signature derivation: exact normalization (truncated `errorSummary` prefix? hash? strip timestamps/paths?) — AC 2 sets the behavioral bar only.
2. Transient-error pattern registry: where does the pattern list live, and is it config-extensible or code-only for Sprint 12?
3. Transient cap value (AC 7) and the hard-ceiling value (AC 12).
4. Classification of idle-kills: transient, deterministic, or its own class feeding CB-4?
5. Interaction ordering when multiple rules fire on one failure (transient + identical signature + partial artifacts).

*For the user (needs answer before demo, not before design):*
6. AC 15 auto-accepts salvaged work that passes the file-existence/glob gate without a fresh agent attempt. Is file-gate validation sufficient for salvage-complete, or should a salvage-completed step force the next checkpoint to flag it for human review? (Spec currently requires the state marker — AC 15 — so it is auditable either way.)
