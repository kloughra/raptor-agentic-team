---
slug: branch-protection-merge-lockout
spec: docs/specs/branch-protection-merge-lockout.md
---
# Branch-Protection Merge Lockout — Architecture Design

## Overview

Sprint 15 (`user-actionable-failure-class`) established a third failure
classification — `user-actionable` — meaning *the blocker is outside the sprint;
no retry can succeed until the user acts*. That escalate-after-one-attempt branch
lives only in the **agent-step** retry pipeline (`decideAfterFailure`). The
**step-9 merge path** has its own inline `do/while` retry loops that already
*stamp* `classifyFailure(errorSummary)` onto each merge `FailureRecord` (Sprint 13
C5) but **never consult it** — so a GitHub branch-protection refusal (locked
`main`, required review) burns the full `MAX_RETRY_ATTEMPTS` (3) identical, doomed
`gh pr merge` invocations before escalating with a message that names neither the
PR nor a human action. Observed live on PRs #40, #42, #43.

This feature closes that gap by **reusing the Sprint-15 pipeline exactly**:

1. Add branch-protection merge-refusal signatures (each with a paired remediation
   `action`) to the existing code-only `USER_ACTIONABLE_ERROR_PATTERNS` registry.
2. Make the two merge seams **honor** the `user-actionable` classification they
   already stamp — escalate on the **first** `executeMerge` failure with a message
   naming the PR and the required action.
3. Surface the PR number to the escalation site (`MergeResult.prNumber`) and
   persist the actionable detail (`StepState.escalationDetail`) so the
   notification-egress payload — derived exclusively from persisted state — carries
   the action.

**No new classification value, no new registry, no new sprint status, no new MCP
tool, no new dependency.** All changes are additive and back-compatible.

## Components

| Component | File | Change |
|-----------|------|--------|
| **Branch-protection patterns** | `src/orchestrator/failure-classification.ts` | Add branch-protection entries to `USER_ACTIONABLE_ERROR_PATTERNS` (regex + `action`). Pure/additive; `classifyFailure` & `resolveUserAction` already iterate the registry — no logic change. |
| **PR number surfacing** | `src/orchestrator/merge.ts` | Extend `MergeResult` with `prNumber?: number`; populate it on the open-PR failure path in `mergeViaGitHub` (thread the number `detectGitHubPR` already resolved). |
| **Shared lockout-message builder** | `src/orchestrator/runner.ts` | New pure exported `buildMergeLockoutEscalation(prNumber, action, lastError)` — single source of the actionable message so both merge seams stay byte-identical (AC 4). |
| **Single-feature merge seam** | `src/orchestrator/runner.ts` (`~1022–1080`) | After stamping the `FailureRecord`, add an early-escalation check: `classification === "user-actionable"` → escalate now (before the `attempts >= MAX_RETRY_ATTEMPTS` check). |
| **Multi-feature merge seam** | `src/orchestrator/runner.ts` `runMergeStepForFeature` (`~2527–2557`) | Same early-escalation check, returning `"escalated"` on the first user-actionable failure. |
| **Persisted actionable detail** | `src/orchestrator/state.ts` | Add optional `escalationDetail?: string` to `StepState` (additive; absent ⇒ prior behavior). Holds the PR-naming action for notification derivation. |
| **Notification reason enrichment** | `src/orchestrator/notifications.ts` | `deriveReason` (escalation branch) appends `step.escalationDetail` when present, so the emitted `reason` names the human action (AC 6). Back-compatible: absent ⇒ existing `step N (reason)` string. |

### Control flow (both seams, per merge failure)

```
executeMerge() → !success
  └─ stamp FailureRecord { classification: classifyFailure(err),
                           signature: deriveFailureSignature(err) }   ← unchanged (C5)
  └─ IF classification === "user-actionable":                          ← NEW (this feature)
        stepState.status        = "escalated"
        stepState.escalationReason = "user-actionable"
        stepState.escalationDetail = buildMergeLockoutEscalation(
                                       mergeResult.prNumber, action, err)
        (feature|sprint).status = "escalated"
        save; [ESCALATE] commit naming PR + action; return escalated
     ELSE:                                                             ← unchanged
        existing bounded do/while up to MAX_RETRY_ATTEMPTS
```

The check is placed **before** the `attempts >= MAX_RETRY_ATTEMPTS` branch, so a
branch-protection refusal escalates on attempt 1 with exactly one `FailureRecord`
appended (AC 3). Every non-user-actionable failure falls straight through to
today's exact retry accounting (AC 8).

## Data Model

### `MergeResult` (extended — `merge.ts`)
```ts
export interface MergeResult {
  success: boolean;
  method: "github" | "local";
  error?: string;
  alreadyMerged?: boolean;
  prNumber?: number;   // NEW: populated on the gh open-PR path (success or failure)
}
```
`detectGitHubPR` already resolves the open-PR number; `mergeViaGitHub` threads it
into the returned result. Absent (`local` fallback, no-PR) ⇒ the message omits the
PR reference and names the action only. Non-breaking optional field.

### `StepState` (extended — `state.ts`)
```ts
export interface StepState {
  // …existing fields…
  escalationReason?:
    | "attempts-exhausted"
    | "no-progress"
    | "transient-cap"
    | "user-actionable";       // REUSED — no new value (AC 7, OQ4)
  escalationDetail?: string;   // NEW: actionable, PR-naming message (AC 5/6)
}
```
`escalationDetail` is additive and optional; older `sprint-N.json` files without it
read as `undefined` and render exactly as before. It is the persistence home that
makes the actionable next step (including the PR number, which is otherwise not in
state) available to `notifications.deriveReason` (AC 6).

### `FailureRecord` — **unchanged**
Classification and signature continue to be stamped at record time and persisted,
exactly as C5 does today (AC 10). No re-derivation at read time.

## API Contracts

### Registry addition — `USER_ACTIONABLE_ERROR_PATTERNS` (code-only)
```ts
// Branch-protection merge-refusal signatures. Order matters — resolveUserAction
// returns the FIRST match. Specific (review-required) before general (protection).
{
  // required approving / code-owner review
  pattern: /at least \d+ approving review|review required|changes must be approved|code owner/i,
  action: "Approve the PR (an approving or code-owner review is required), then resume the sprint.",
},
{
  // protected / locked base branch (lock_branch: true, branch-protection policy)
  pattern: /protected branch|branch is protected|branch protection|base branch (?:policy|restrictions)|is not authorized|not allowed to (?:push|merge)|branch .*is locked|lock_branch/i,
  action: "Unlock `main` (branch protection / lock_branch is blocking the squash-merge) or merge the PR manually, then resume the sprint.",
},
```
*These regexes are the design seed. Exact `gh` stderr specimens must be confirmed
empirically (Open Question 1) — the pattern biases toward the confirmed specimen
and does not over-fit one exact string (Sprint-15 specimen-plus-generalization
convention). Deliberately does **not** match the bare "not mergeable" string (that
is the ambiguous conflict/divergence case owned by `push-before-merge`).*

`classifyFailure(specimen) === "user-actionable"` for every branch-protection
specimen; `resolveUserAction(specimen)` returns the paired action.

### Pure message builder — `buildMergeLockoutEscalation` (`runner.ts`, exported)
```ts
export function buildMergeLockoutEscalation(
  prNumber: number | null | undefined,
  action: string,
  lastError: string,
): string;
// → "PR #42 blocked at merge — branch protection prevents the automated squash-merge.
//    Action required: <action>
//    Last error: <lastError>"
// (When prNumber is absent: "This PR is blocked at merge — …")
```
Both merge seams call this single builder ⇒ byte-identical messages (AC 4). Exported
so the message seam is testable in isolation (mirrors
`buildSingleFeatureEscalationMessage` / `buildMultiFeatureEscalatedMessage`).

### Merge-seam decision (shared shape, both seams)
Rather than route the merge loops through `decideAfterFailure` (which carries
salvage/agent-step semantics irrelevant to a merge), each seam adds a **targeted
early-escalation check** keyed on the just-stamped `classification` (Open Question 3
ruling). Parity (AC 4) is enforced by the shared message builder and an identical
guard, not by sharing the whole (differently-shaped) control flow — the single-
feature seam returns an MCP result object; the multi-feature seam returns
`"complete" | "escalated" | "retry"`.

## Non-Functional Requirements

| # | NFR | Target / Constraint |
|---|-----|---------------------|
| **NFR-1 Determinism** | Classification is pure, deterministic string/regex matching. No LLM calls, no clock, no `/g`-flag stateful regexes (a stateful `lastIndex` breaks repeatability). | Byte-identical classification for identical input across calls & process restarts. |
| **NFR-2 Latency** | Branch-protection escalation spends **exactly one** `executeMerge` invocation (one `gh pr merge`) vs. today's 3. | ≥ 2 doomed `gh pr merge` round-trips (~seconds each, plus `GH_TIMEOUT_MS`=30s worst case per attempt) eliminated per lockout. Registry match is O(#patterns) regex tests — negligible (µs). |
| **NFR-3 Backward compatibility** | All schema changes additive & optional (`MergeResult.prNumber`, `StepState.escalationDetail`). Absent ⇒ pre-feature behavior byte-for-byte. Non-branch-protection merge failures retain the exact 3-attempt budget, accounting, and messages (AC 8). | A parity test proves an ordinary merge failure still retries/escalates unchanged. |
| **NFR-4 Crash safety (persist-before-yield)** | State is saved before the escalation returns — the escalated status, reason, and `escalationDetail` land in `sprint-N.json` before the tool yields. | A crash mid-escalation resumes with accurate `escalated` status + actionable detail. |
| **NFR-5 Recoverability** | Reuses the existing `escalated` (resumable) status and resume path (AC 9). After the user unlocks `main` / approves / merges manually, resume re-engages the merge step; the Sprint-13 already-merged-as-success rule handles the manual merge. | No new terminal status, no new tool. |
| **NFR-6 Observability / actionability** | The PR number and concrete action are **persisted** (`escalationDetail`) and surfaced in (a) the runner message, (b) the `[ESCALATE]` commit, (c) the notification-egress `reason`. | A user or autonomous driver can act from the out-of-band notification alone, without inspecting the repo (AC 5/6). |
| **NFR-7 Exception isolation** | Escalation-message building and the `[ESCALATE]` commit are best-effort/guarded; `executeMerge` never throws. | A commit/build failure never masks the escalation or crashes the sprint. |
| **NFR-8 No new dependencies** | Reuses `failure-classification.ts`, `simple-git`, `gh` CLI, Zod. | `package.json` unchanged. |

## Technology Choices

*(Presented for user approval — see "Decision Summary / Approval" below.)*

1. **Reuse `USER_ACTIONABLE_ERROR_PATTERNS`, not a new registry** — one more code-only
   entry-set with paired `action` strings, enumerable by tests, NOT
   `config.json`-configurable. Identical posture to the transient and Sprint-15
   registries. *(No new tech.)*
2. **Targeted early-escalation check at each merge seam (Open Question 3 = option a),
   NOT routing through `decideAfterFailure`.** The merge loops have different
   control flow and return conventions than the agent-step pipeline; routing them
   through `decideAfterFailure` would drag in salvage/transient-cap/slot semantics
   irrelevant to a merge and risk regressing AC 8. Parity is guaranteed by a shared
   pure message builder + identical guard. The broader merge→pipeline unification
   stays the deferred Inbox item `merge-failure-short-circuit`. *(No new tech.)*
3. **Extend `MergeResult` with `prNumber` (Open Question 2).** `detectGitHubPR`
   already resolves the number inside `merge.ts`; threading it onto the existing
   structured result is lower-risk and cheaper than re-querying `gh` at the
   escalation seam. Optional field ⇒ non-breaking. *(No new tech.)*
4. **Reuse the `user-actionable` escalation-reason label (Open Question 4).** Uniform
   records across the agent-step and merge seams; no conflict with the existing
   `attempts-exhausted` merge escalation, which stays distinct. The lockout is
   further distinguished from a generic 3-strikes escalation because it carries
   `escalationDetail` and escalates at attempt 1. *(No new tech.)*
5. **Persist actionability via `StepState.escalationDetail` + enrich
   `notifications.deriveReason`.** The PR number is not otherwise in persisted state;
   embedding the PR-naming action string in `escalationDetail` is the state-derived
   channel notification-egress needs (it reads only persisted state). *(No new tech.)*

**No new technology is being adopted.** Every choice reuses existing modules,
existing dependencies (`simple-git`, `gh`, Zod, `@modelcontextprotocol/sdk`), and
existing patterns. Per Architect boundaries, no new-tech approval is required — this
section is presented for the user's confirmation of the design decisions above,
especially the four Open Question rulings.

## Constraints & Patterns

- **C1 — Escalate-now dominates the merge budget.** The `user-actionable` check runs
  *before* the `attempts >= MAX_RETRY_ATTEMPTS` branch, keying off the **current
  failure's classification** (not the attempt counter). A lockout on attempt 2+
  still escalates immediately (Edge Case: lockout-on-attempt-2+), mirroring the
  Sprint-15 escalate-now-dominates-slot-budget rule.
- **C2 — Parity by shared builder, not shared control flow.** Both seams call
  `buildMergeLockoutEscalation` and apply an identical guard; their surrounding
  return conventions differ and are left intact. This is the AC-4 anti-drift
  mechanism.
- **C3 — Classification precedence unchanged:** user-actionable → transient →
  deterministic. Branch-protection specimens must be caught by user-actionable
  before any transient pattern (they won't overlap; documented for the reviewer).
- **C4 — Do not match bare "not mergeable."** A genuine conflict/divergence
  (`push-before-merge`'s domain) also emits "not mergeable"; matching it would
  mis-escalate a resolvable conflict as "unlock main." The regex requires
  protection/policy/review/lock phrasing.
- **C5 — Local-merge fallback is out of the observable surface.** Branch protection
  is a GitHub concept; `mergeViaLocalGit` never hits a `gh` refusal. The classifier
  stays surface-agnostic (matches whatever `errorSummary` it is handed) but the
  observed behavior is scoped to the `gh`-refusal string.
- **C6 — No `/g` flags; deterministic regex.** Consistent with the Sprint 12/15
  module constraint (a stateful `lastIndex` makes classification non-deterministic).
- **C7 — Additive schema only.** `MergeResult.prNumber` and
  `StepState.escalationDetail` are optional; no migration; absent ⇒ prior behavior.
- **C8 — Persist-before-yield.** Save state (status, reason, detail) before the
  escalation returns (NFR-4).
- **Testing pattern (TEAM.md QA rule 12) — production-seam + RED verification:**
  - Unit: `classifyFailure(specimen) === "user-actionable"` and
    `resolveUserAction(specimen)` returns the action, for every branch-protection
    specimen.
  - Seam (BOTH paths): drive the **real** merge loop (single-feature step-9
    `do/while`) and the **real** `runMergeStepForFeature` with an `executeMerge`
    stub returning a branch-protection refusal (and a `prNumber`); assert
    escalation after **exactly one** attempt, `escalationReason === "user-actionable"`,
    and a message/`escalationDetail` naming the PR + action — against the real
    attempt counter and real output, not a reimplemented boundary.
  - RED note per constraint-guarding test: proven to FAIL against pre-change code
    (three attempts, message naming neither PR nor action).
  - Parity test (AC 8): a non-branch-protection merge failure still retries to
    `MAX_RETRY_ATTEMPTS` on the unchanged path; carries its own RED note (would FAIL
    if the short-circuit leaked to all merge failures).
  - **Per-independent-seam mutation (Sprint 17):** disabling the check at only one
    seam must redden only that seam's test — each seam mutated independently.

## Open Questions — Architect Rulings

1. **Exact `gh pr merge` refusal specimens (empirical — QA to confirm).** The seed
   regexes in *API Contracts* bias toward the known phrasings for (a) locked base
   branch (`lock_branch`), (b) required approving/code-owner review, (c)
   branch-protection policy. **QA must capture the real current-`gh` stderr** for
   each class and confirm the regex matches without over-fitting — WITHOUT running a
   real destructive merge (capture via a scratch repo or a `--dry-run`/refused
   attempt on a throwaway branch). The single external unknown; same posture as the
   Sprint-15 invalid-model Open Question. If a specimen differs, it is a one-line
   registry edit.
2. **PR number at the escalation site → `MergeResult.prNumber` (RULED).** Extend the
   structured result; do not re-query `gh`.
3. **Honoring mechanism → targeted early check, not `decideAfterFailure` (RULED).**
   See Technology Choice #2.
4. **Reason label → reuse `user-actionable` (RULED).** No conflict with the
   `attempts-exhausted` merge escalation.

## Decision Summary / Approval

The design adopts **no new technology or dependencies**; it extends four existing
modules additively. The items presented for user confirmation are the four Open
Question rulings above (registry reuse, early-check mechanism, `MergeResult.prNumber`,
reason-label reuse) and the additive `StepState.escalationDetail` field. On approval,
this hands off to QA (tests-first) and the Engineer (TDD implementation).
