---
slug: user-actionable-failure-class
spec: docs/specs/user-actionable-failure-class.md
---
# User-Actionable Failure Classification — Architecture Design

## Overview

This feature adds a **third failure classification** — `"user-actionable"` —
to the Sprint 12 circuit-breaker pipeline. It sits alongside the existing
`transient` (retry helps) and `deterministic` (task is wrong) classes and
captures a distinct third case: **the blocker is outside the sprint entirely**,
so retrying can never succeed until the user acts (raise a spend limit, fix a
typo'd `--model` in config). Such a failure must **escalate immediately after
the first attempt** with a message that names the concrete action, instead of
burning 2–3 doomed attempts.

The change is deliberately small and surgical. It reuses every existing
mechanism:

- the **one classifier** (`classifyFailure`, `failure-classification.ts`) —
  add a code-only pattern registry and a precedence-ordered check;
- the **one retry pipeline** (`decideAfterFailure`, `runner.ts`) — add one
  branch that both retry loops already route through (AC 8, no fork);
- the **one escalation/resume machinery** — reuse `escalated` (resumable)
  status; introduce no new terminal state, no new MCP tool, no new sprint
  status (AC 10).

No new dependencies, no LLM calls, no state-schema migration. All new behavior
is additive and inert when no user-actionable pattern matches (AC 12).

## Components

All changes land in two existing modules. No new files in `src/`.

### 1. `src/orchestrator/failure-classification.ts` (primary change)

- **Extend the union** (AC 1):
  `export type FailureClassification = "transient" | "deterministic" | "user-actionable";`
- **New exported registry** (AC 3, AC 4). Unlike `TRANSIENT_ERROR_PATTERNS`
  (a bare `RegExp[]`), user-actionable entries must carry the **action to name
  in the escalation message** (AC 7). So the registry is an array of
  `{ pattern: RegExp; action: string }`:

  ```ts
  export interface UserActionablePattern {
    /** Regex tested against the error summary. No /g flag (constraint 13). */
    pattern: RegExp;
    /** Concrete remediation named in the escalation detail (AC 7). */
    action: string;
  }

  export const USER_ACTIONABLE_ERROR_PATTERNS: UserActionablePattern[] = [
    {
      // billing / spend-limit — specimen "You've hit your monthly spend limit"
      // (commits 908bf63, 9394bdd, f9bc035). Generalized to tolerate phrasing
      // drift ("monthly spend limit" / "usage limit") per the Edge Case.
      pattern: /spend limit|monthly (?:spend|usage) limit|usage limit reached/i,
      action:
        "Raise your usage limit at https://claude.ai/settings/usage, then resume the sprint.",
    },
    {
      // invalid-model — the `claude` CLI rejects an unknown `--model` at spawn
      // (Sprint 14 models-plumbing surface). Broad enough to catch the real
      // specimen; QA confirms the exact string (Open Question 2).
      pattern: /(?:unknown|invalid|unrecognized|unsupported).{0,20}model|model[^\n]{0,40}(?:not found|not recognized|does not exist|is invalid)/i,
      action:
        "Fix models.byRole / models.default in ~/.raptor/config.json (invalid --model), then resume the sprint.",
    },
  ];
  ```

- **Extend `classifyFailure`** with a precedence-ordered check
  (Open Question 1 ruling — see §Constraints):
  user-actionable is checked **first**, then transient, then the deterministic
  default. Signature unchanged (`(errorSummary: string) => FailureClassification`).

  ```ts
  export function classifyFailure(errorSummary: string): FailureClassification {
    for (const { pattern } of USER_ACTIONABLE_ERROR_PATTERNS) {
      if (pattern.test(errorSummary)) return "user-actionable";
    }
    for (const pattern of TRANSIENT_ERROR_PATTERNS) {
      if (pattern.test(errorSummary)) return "transient";
    }
    return "deterministic";
  }
  ```

- **New exported helper** `resolveUserAction(errorSummary: string): string | null`
  — returns the `action` of the **first** matching user-actionable pattern (or
  `null` if none). Used by the pipeline to build the actionable escalation
  detail (AC 7). First-match-wins for multi-match summaries (Open Question 3).
- `deriveFailureSignature` is **unchanged** — a user-actionable failure still
  receives a signature at record time for uniform, readable post-mortem records
  (Open Question 4 ruling: yes, keep records uniform; no pipeline interaction
  since the user-actionable branch escalates before any signature *comparison*).

### 2. `src/orchestrator/runner.ts` (pipeline + message)

- **Extend the `RetryDecision.escalate.reason` union** (AC 6):
  `"no-progress" | "transient-cap" | "attempts-exhausted" | "user-actionable"`.
- **New branch in `decideAfterFailure`** — positioned **after** salvage-complete
  but **before** transient (see §Constraints for the ordering rationale):

  ```ts
  // (after the salvage.complete guard, before the transient branch)
  if (classification === "user-actionable") {
    return {
      kind: "escalate",
      reason: "user-actionable",
      detail:
        resolveUserAction(newFailure.errorSummary) ??
        "This failure requires action outside the sprint before it can succeed.",
    };
  }
  ```

  This escalates on the **first** attempt regardless of `attempts`,
  `TRANSIENT_RETRY_CAP`, or the no-progress short-circuit (AC 5). It dominates
  remaining slot budget: even a user-actionable failure on attempt 2+ escalates
  now (Edge Case), because the branch keys off the current failure's
  classification, not the attempt counter.
- **`processFailureAndDecide`** already stamps
  `classification: classifyFailure(errorSummary)` and
  `signature: deriveFailureSignature(errorSummary)` on the `FailureRecord` at
  record time and already writes `stepState.escalationReason = decision.reason`
  on escalation. With the union extensions above, `user-actionable` flows
  through **unchanged** (AC 9) — no edit needed to the recording body beyond the
  type widening it inherits.
- **Escalation-message construction** at the two escalate seams
  (single-feature `runner.ts:~1302` and the multi-feature message builder) must
  surface the user-actionable detail. Today the ternary handles
  `attempts-exhausted` vs. (`no-progress`/`transient-cap`). Add a
  `user-actionable` arm that prints the actionable `detail` verbatim, e.g.:

  ```
  Step 5 (Implement) escalated — action required before this can succeed:
  Raise your usage limit at https://claude.ai/settings/usage, then resume the sprint.
  ```

  The `[ESCALATE]` git commit path is unchanged (it already serializes the
  failure summaries).

### 3. `src/orchestrator/state.ts` (type only)

- **Extend `StepState.escalationReason`** union to include `"user-actionable"`:
  `"attempts-exhausted" | "no-progress" | "transient-cap" | "user-actionable"`.
  Additive, optional field — old state files load unchanged (AC 9, Edge Case:
  old files without the class). No `loadSprintState` defaulting change.

## Data Model

**No schema migration. No new persisted fields.** Two existing optional-string
unions gain a member; both are already tolerant of absent/legacy values via the
`?? "deterministic"` / `?? "attempts-exhausted"` read conventions.

| Type | Field | Before | After |
|------|-------|--------|-------|
| `FailureClassification` | (the union) | `"transient" \| "deterministic"` | `+ "user-actionable"` |
| `FailureRecord.classification` | persisted at record time | `"transient" \| "deterministic"` (optional) | `+ "user-actionable"` |
| `RetryDecision.escalate.reason` | in-memory decision | `no-progress \| transient-cap \| attempts-exhausted` | `+ user-actionable` |
| `StepState.escalationReason` | persisted on escalation | `attempts-exhausted \| no-progress \| transient-cap` | `+ user-actionable` |

`USER_ACTIONABLE_ERROR_PATTERNS` is a **code-only** module constant (like
`TRANSIENT_ERROR_PATTERNS`), enumerable by tests, **not** read from
`config.json` (AC 3 / Out of Scope). Registry entries are
`{ pattern: RegExp; action: string }`.

**Backward compatibility:** a `sprint-N.json` written before this feature carries
`FailureRecord`s with only `transient`/`deterministic` (or no classification).
They load byte-identically; the `?? "deterministic"` default still applies; no
record is rewritten (Edge Case: old state files).

## API Contracts

No MCP tool surface changes (AC — no new tool). Internal function contracts:

| Function | Signature | Contract change |
|----------|-----------|-----------------|
| `classifyFailure` | `(errorSummary: string) => FailureClassification` | may now return `"user-actionable"`; precedence user-actionable → transient → deterministic; **pure, deterministic, no /g** |
| `resolveUserAction` *(new)* | `(errorSummary: string) => string \| null` | returns first matching pattern's `action`, else `null` |
| `decideAfterFailure` | unchanged signature | may return `{ kind: "escalate", reason: "user-actionable", detail }` on the **first** attempt |
| `processFailureAndDecide` | unchanged signature | stamps `user-actionable` on the `FailureRecord` and `escalationReason` transparently via existing code |

**Observable contract (AC 2, 5):** an error summary matching a user-actionable
pattern MUST NOT classify `transient` (no retry-loop to the transient cap) and
MUST NOT classify `deterministic` (no 3-attempt burn); it escalates with
`reason: "user-actionable"` before a second agent spawn — **zero** additional
attempts spent.

## Non-Functional Requirements

| NFR | Requirement | How met |
|-----|-------------|---------|
| **Performance** | Classification stays a fast, blocking gate on the failure path (not the hot path). | Adds one bounded regex loop over a 2-element registry per failure — sub-millisecond, synchronous, no I/O. Escalate-now actually *reduces* wall-clock/cost by skipping 1–2 doomed spawns (~minutes + tokens each). |
| **Determinism** | Same error text ⇒ same classification across process restarts. | Pure string/regex matching; **no `/g`-flag stateful regexes** (a stateful `lastIndex` would make repeated calls non-deterministic — the Sprint 12 constraint). Classification persisted at record time, never re-derived at read (AC 9). |
| **Correctness / no false escalation** | An ordinary failure must never be mis-escalated as user-actionable. | Patterns bias toward the known specimens; precedence is deterministic and documented. Default-off parity test (AC 12) proves an unmatched error classifies exactly as today. |
| **Backward compatibility** | Pre-feature state files and the two existing classes are byte-for-byte unchanged when no pattern matches. | Additive union members; `?? "deterministic"` reads unchanged; slot accounting / transient cap / no-progress short-circuit untouched (AC 12, Out of Scope). |
| **Reliability / resumability** | A user-actionable escalation is never a dead end. | Reuses the existing `escalated` (resumable) status and resume path — after the user acts, the step re-engages (AC 10). No new status. |
| **Maintainability / extensibility** | A future user-actionable signature is a one-line addition. | New signature = one `{ pattern, action }` entry in the registry; no pipeline change (AC 3). |
| **Dependency footprint** | No new runtime dependencies. | Plain TypeScript regex; nothing added to `package.json` (AC 13). |
| **Testability** | Regressions caught at the production seam, not just the helper. | `decideAfterFailure` and the runner retry seam are directly drivable; attempt count asserted against the real counter (AC 11). |

## Technology Choices

**All existing — no new technology to adopt.** Presented for user approval:

1. **Classification engine:** plain TypeScript `RegExp.test` over a code-only
   registry — identical mechanism to Sprint 12's `TRANSIENT_ERROR_PATTERNS`.
   No LLM, no library, no config surface.
2. **Registry shape:** array of `{ pattern: RegExp; action: string }` objects
   (rather than the transient registry's bare `RegExp[]`), because
   user-actionable escalations must **name the remediation** (AC 7). The action
   string travels with the pattern so the message and the match cannot drift.
   *(This is the one shape decision worth your sign-off.)*
3. **Precedence ordering:** user-actionable checked **first**, then transient,
   then deterministic default (Open Question 1 — rationale in §Constraints).
4. **Pipeline placement:** the escalate-now branch sits **after** salvage-complete
   and **before** transient in `decideAfterFailure`.
5. **State/resume:** reuse existing `escalated` status + resume path; no new
   persisted state, no migration, no new MCP tool.
6. **Tests:** jest / ts-jest — colocated unit (`failure-classification.test.ts`),
   pipeline seam in `runner`-level tests, and `tests/integration/` +
   `tests/bdd/` per convention. Each constraint-guarding test carries a
   RED-verification note (TEAM.md QA rule 12).

No third-party additions. No changes to `npm run build` / `tsc` / jest config.

## Constraints & Patterns

- **Precedence: user-actionable → transient → deterministic (Open Question 1
  ruling).** A user-actionable pattern is checked **before** the transient
  registry so an ambiguous string (e.g. a rate/usage-limit phrasing that also
  brushes a transient pattern) resolves to **escalate-now**, not retry-loop.
  Retrying a spend-limit error as a network flake is the exact waste this
  feature removes (Edge Case). Precedence lives in the check order inside
  `classifyFailure` — no separate priority field.

- **Pipeline placement: after salvage-complete, before transient
  (Open Question / design ruling).** Salvage-complete still wins — if the
  validated deliverables are already on disk, the failure is moot regardless of
  its class (CB-4 semantics unchanged). Everything else yields to
  user-actionable: it must pre-empt the transient cap, the no-progress
  short-circuit, and deterministic slot accounting so **zero** extra attempts
  are spent (AC 5).

- **Escalate-now dominates slot budget (Edge Case).** The branch keys off the
  **current** failure's classification, not the attempt counter — a
  user-actionable failure on attempt 2+ (after a prior deterministic failure)
  still escalates immediately; it does not "finish" the remaining deterministic
  budget.

- **One classifier, one pipeline, two seams (AC 8).** Both the single-feature
  and multi-feature retry loops route through the shared `decideAfterFailure` /
  `processFailureAndDecide` pair. No caller-side special-casing — the new
  behavior is identical in both paths by construction, and QA must assert parity
  at **both** production seams (TEAM.md rule), not only on the pure classifier.

- **Signatures stay uniform (Open Question 4 ruling).** User-actionable
  `FailureRecord`s still get a `deriveFailureSignature` value for readable
  post-mortems. There is no pipeline interaction: the user-actionable branch
  escalates before any signature *comparison* (the no-progress short-circuit) is
  reached. `deriveFailureSignature` is untouched.

- **Registry is code-only (AC 3, Out of Scope).** Not user-configurable via
  `config.json` — mirrors the transient registry decision. A configurable
  failure-signature surface is a separate future item.

- **Purity & no /g (AC 13).** Deterministic string/regex matching only — no LLM
  calls, no new dependencies, no `/g`-flag stateful regexes.

- **Additive & backward-compatible (AC 9, 12).** Every change is a union
  extension or a new branch that is inert when no pattern matches. No state
  migration; old records load unchanged via the `??` defaults.

- **Invalid-model error reaches `errorSummary` (Open Question 2 / Edge Case —
  verified in code).** The `claude` binary spawns fine but exits non-zero when
  it rejects an unknown `--model`; `spawnAgent`'s `close` handler
  (`agents.ts:351`) resolves `output = stdout || stderr || "agent exited with
  code N"`, and the runner truncates that into `errorSummary` — the same string
  `classifyFailure` sees. **QA/Engineer must confirm the exact stderr specimen**
  the current `claude` CLI emits and tune the seed regex to it (the regex above
  is a deliberately broad first cut; over-fitting one exact string is the known
  risk, per the Edge Case). This is the single external unknown in the design.

- **Multi-match message (Open Question 3 ruling).** When both seed patterns
  match one summary, `resolveUserAction` names the **first-matched** action
  (registry order: billing before invalid-model). Naming at least the matched
  action satisfies PO intent; a merged both-actions message is an acceptable
  future refinement, not required.

- **No scope creep (Out of Scope).** No change to `transient`/`deterministic`
  semantics (`TRANSIENT_RETRY_CAP`, `MAX_RETRY_ATTEMPTS`, no-progress
  short-circuit, slot accounting all untouched); no merge-step failure wiring
  (`merge-failure-short-circuit`, separate item); no episodic reflection buffer
  (`persist-feedback-across-retries`, separate item); no auto-remediation of the
  user action; no new MCP tool or sprint status.

## Open Questions — Architect Rulings

1. **Precedence ordering.** RULED: user-actionable → transient → deterministic,
   enforced by check order in `classifyFailure`. Escalate-now beats retry-loop
   on any ambiguous string.
2. **Exact invalid-model error string.** OPEN for QA/Engineer confirmation — the
   design routes the real stderr into `errorSummary` (verified in `agents.ts`),
   but the precise specimen must be captured empirically and the seed regex
   tuned to it. Broad first-cut regex provided.
3. **Multi-match message.** RULED: name the first-matched action (registry
   order). Merged message optional.
4. **Signature interaction.** RULED: keep the signature uniform on
   user-actionable records; no pipeline interaction (`deriveFailureSignature`
   untouched).
