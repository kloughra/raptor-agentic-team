---
slug: adversarial-verifier-review-gate
spec: docs/specs/adversarial-verifier-review-gate.md
---
# Adversarial Verifier Review Gate — Architecture Design

## Overview

This feature hardens Raptor's review gates against **false-green** work — tests
that reimplement the system-under-test, were never proven to fail, or were
reward-hacked into passing. It has three parts (spec §Background), which the
Architect has scoped as follows:

- **Part 1 — Real-seam enforcement at the gate.** Inject an orchestrator-built
  *adversarial verifier* instruction into the QA test-execution agent step
  (step 7) so every sprint's review gate actively hunts for test-local
  reimplementations and missing RED-verification notes, and flags rather than
  silently passing. **In scope this sprint.**
- **Part 2 — Generator ≠ verifier (model plumbing).** Add an optional `model`
  parameter to `spawnAgent`, plumb it to `claude --model`, and add a
  `models` config surface (parsed in `loadConfig`) so verifying roles (QA) can
  run on a different model than the generating role (Engineer). **In scope this
  sprint.**
- **Part 3 — Bias controls on any LLM-judge gate.** **Satisfied vacuously.**
  This feature introduces **no** numeric/A-B LLM-judge scoring gate (Open
  Question #4 resolved below), so ACs 12–14 apply to nothing. This is a
  deliberate, recorded decision (AC 11), not a silent skip.

**Design north star.** Every change is *additive and backward-compatible*.
With no config set and no new instructions changing outcomes beyond the additive
gate guidance, a sprint behaves byte-for-byte as today (the dominant edge case).
The `spawnAgent` argv contract (PR #18) and the Sprint 12 idle-timeout/ceiling
machinery are load-bearing and must not regress.

### Open Question resolutions (Architect rulings)

1. **Split or single feature?** Ship **Part 1 + Part 2 together** in this sprint
   (one PR); Part 3 is vacuous. Rationale: Part 2 is a self-contained ~15-line
   plumbing change with a clean test surface; Part 1 is a prompt-construction
   change in the same runner region. Both are small, independent, and share the
   test file. No sequencing risk. If the user prefers, Part 2 can land first as a
   standalone PR — but the default recommendation is one PR.
2. **Model-config shape:** a top-level `models` key —
   `{ default?: string; byRole?: Partial<Record<Role, string>> }` — parsed in
   `loadConfig` exactly like `timeouts` (type-guarded, field-wise drop of junk).
   See Data Model.
3. **Which gate does Part 1 instrument?** The **step-7 QA test-execution agent**
   (the only agent-instrumentable review seam today). The `pr-review` gate is a
   *user* checkpoint (`checkpoints.ts`); Part 1 **additionally** enriches that
   checkpoint's context text with a one-line adversarial-review reminder
   (best-effort, no behavior change), but the enforceable instruction lands in
   the step-7 agent prompt.
4. **Does this feature introduce an LLM-judge gate?** **No.** Part 1 is realized
   as an *instruction to the existing QA agent*, which then reports flags in its
   output. There is no new scoring/ranking/A-B judge. Therefore Part 3 is
   vacuous (AC 11). Recorded here as the deliberate decision.
5. **Detection heuristic for "reimplementation" / "missing RED note":** **LLM
   judgment**, driven by the injected instruction — *not* a deterministic AST
   pre-pass. Rationale: import-graph/mock-scanning is brittle, language-specific,
   and explicitly beyond the behavioral bar the spec sets (AC 1/AC 4 specify
   *behavior*, "mechanism is the Architect's call"). A deterministic pre-pass is
   **out of scope**; if a future item wants one, it is a separate feature.

## Components

All changes are confined to the orchestrator; no new modules are strictly
required, though Part 1's instruction text is centralized for testability.

| Component | File | Change |
|---|---|---|
| **`spawnAgent` model param** | `src/orchestrator/agents.ts` | Add optional `model?: string` param (appended to signature, after `timeoutMs?`). When set, insert `--model <value>` into argv **before** `--print`/options and **without disturbing** the `--allowedTools`…`--`…`taskDescription` tail. |
| **Adversarial gate instruction** | `src/orchestrator/prompts.ts` (new export) | New `buildAdversarialGateSection(): string` returning the injected verifier instruction. Centralized so a test can assert its presence in the step-7 prompt (AC 2). |
| **Gate injection** | `src/orchestrator/runner.ts` (both single- and multi-feature paths) | For step 7 (`role === "qa"` && `step.name === "Run test suite"`), append `buildAdversarialGateSection()` to the agent's `taskDesc`/context. |
| **Per-role model resolution** | `src/orchestrator/runner.ts` | New helper `resolveRoleModel(role, config)` → `string | undefined`; result passed to every `spawnAgent` call. Resolution: `config.models.byRole[role] ?? config.models.default ?? undefined`. |
| **Config parse** | `src/config.ts` (`loadConfig`) | Parse the new `models` key (type-guarded), mirroring `parseTimeouts`. **Must be parsed, not merely declared** (AC 9; averts `config-keys-parsed-vs-declared`). |
| **Checkpoint context reminder** | `src/orchestrator/checkpoints.ts` (`pr-review` only) | Append a one-line adversarial-review reminder to the `pr-review` checkpoint context (best-effort, human-facing; no logic change). |

**Untouched (Out of Scope / frozen):** `workflow.ts` step definitions,
`SPRINT_WORKFLOW` shape, the checkpoint/resume state machine, the idle-timer /
hard-ceiling / buffer-overflow / `killKind` machinery in `spawnAgent`
(`agents.ts:249-321`), TEAM.md process text, `parseRetroProposal`, and the state
file schema (beyond additive optional reads).

## Data Model

### Config (`RaptorConfig` in `src/config.ts`) — additive

```ts
export interface RaptorConfig {
  // ... existing keys ...
  models?: {
    default?: string;                        // default model for all roles
    byRole?: Partial<Record<Role, string>>;  // per-role override (po/architect/qa/engineer/team)
  };
}
```

`loadConfig` gains a `parseModels(raw)` helper structured exactly like the
existing `parseTimeouts`:
- Non-object / array / null `models` → key absent (ignored).
- `default`: kept only if a non-empty `string`.
- `byRole`: object; each entry kept only if the key is a valid `Role` and the
  value is a non-empty `string`. Unknown keys and non-string values are dropped
  field-wise. (Role validation reuses the `Role` union; an unknown role key is
  silently dropped — a bad config never crashes the orchestrator.)

**Backward compatibility:** absent `models` key → `config.models === undefined`
→ `resolveRoleModel` returns `undefined` → `spawnAgent` called without a model →
argv byte-identical to today.

### Sprint state (`SprintState` in `state.ts`) — no schema change required

Part 1's gate outcome is surfaced through the **agent's reported output** (which
already flows into `FailureRecord`/step result on a flagged/failed gate) — no new
persisted field is mandated by the ACs. *Optional (additive, if QA/Engineer find
it useful for observability):* a `resolvedModel?: string` on `StepState` recording
which model ran the step. This is **not required** by any AC; if added it must be
read with `?? undefined` per the backward-compat convention. Decision: **do not
add** unless a test needs it — keep the state surface minimal.

## API Contracts

### `spawnAgent` (extended — additive, backward-compatible)

```ts
export function spawnAgent(
  role: Role,
  systemPrompt: string,
  context: string,
  taskDescription: string,
  cwd: string,
  timeoutMs?: number,
  model?: string          // NEW — optional; undefined ⇒ no --model flag (today's behavior)
): Promise<AgentResult>;
```

**argv construction (the load-bearing contract — AC 6).** When `model` is
provided, `--model <value>` is inserted at the **front** of the options block,
leaving the load-bearing tail untouched:

```
[ "--model", model,          // NEW, only when model !== undefined
  "--print",
  "--permission-mode", "acceptEdits",
  "--allowedTools", AGENT_ALLOWED_TOOLS.join(","),
  "--system-prompt", systemPrompt,
  "--append-system-prompt", context,
  "--",                       // end-of-options separator — MUST remain
  taskDescription ]           // terminal positional — MUST remain last
```

Invariants a test must pin (AC 6, with RED-verification notes):
- `--allowedTools` is immediately followed **only** by the tool list (never by
  the model value or the prompt).
- `--` is present and `taskDescription` is the **last** argv element.
- With `model === undefined`, the argv is **exactly** today's array (no `--model`
  token anywhere) — the byte-identical guarantee (AC 5, Edge Case "No config set").

### `resolveRoleModel(role, config)` (new, pure)

```ts
function resolveRoleModel(role: Role, config: RaptorConfig): string | undefined;
// returns config.models?.byRole?.[role] ?? config.models?.default ?? undefined
```

Called at every `spawnAgent` call site (`runner.ts:799, 1133, 1877, 2463`;
`scope-narrowing.ts:260` via passthrough). The resolved value is threaded to
`spawnAgent`'s new `model` param.

### `buildAdversarialGateSection()` (new, pure) — Part 1

Returns a constant instruction block appended to the step-7 QA agent's task.
Content contract (asserted by AC-2 test):
- Directs the agent to act as an **out-of-loop adversarial verifier**.
- (a) Hunt for tests that **reimplement or stub** the system-under-test instead
  of exercising the real production seam.
- (b) Confirm constraint-guarding tests carry a **RED-verification note** (TEAM.md
  QA rule 12).
- **Bias toward false-negative** (AC 3): reject suspicious-but-plausible over
  accepting — "an agent can self-reflect on a failing test but cannot recover
  from a falsely-passing one."
- On detecting either failure: **flag/fail the review and surface it in the
  reported result** — never pass silently (AC 4, AC 17).

## Non-Functional Requirements

| NFR | Target | Rationale |
|---|---|---|
| **Backward-compatibility (argv)** | With no `models` config, `spawnAgent` argv is **byte-identical** to current `main`; all existing `agents.test.ts` cases pass unmodified. | AC 5, 7, 15; dominant edge case. |
| **Latency overhead** | Part 1 adds a static string to one prompt: **O(1)**, < 1 KB, negligible. Part 2 adds one array element: **O(1)**. No new subprocess, no I/O, no network. | Gate must not slow the sprint. |
| **Config parse safety** | Malformed `models` (wrong type, unknown role, non-string) is dropped field-wise; `loadConfig` **never throws** on bad config. | Matches `parseTimeouts` contract; "Config has sensible defaults" pattern. |
| **No dead plumbing** | The `models` key is parsed in `loadConfig` **and** reaches the spawn argv, proven end-to-end by a test (config → resolved model → argv). | AC 9; averts `config-keys-parsed-vs-declared` defect class. |
| **Idle/ceiling non-regression** | Idle timer, hard ceiling, buffer-overflow, and `killKind` behave identically with a model set. | AC 7; Sprint 12 CB-3 must not regress. |
| **Invalid model resilience** | An unknown `--model` value is rejected by the `claude` CLI; the non-zero exit flows through the **existing failure-classification / retry** path — the orchestrator does not crash. | Edge Case "invalid/unavailable model". See Constraints for classification note. |
| **Observability** | Every new gate decision (flag reimplementation, flag missing RED note, resolved verifier model) is observable in agent output and/or the step result — no silent branch. | AC 17. |
| **Security** | `--model` value is passed as a **discrete argv element** (never shell-interpolated); `spawn` is already argv-array based, so no injection surface is added. Model values are user-supplied config, not remote input. | Existing `spawn` safety preserved. |

## Technology Choices

**No new technology, framework, library, or database is introduced.** Every
change reuses the existing stack — so there is **no new-technology approval gate**
under TEAM.md Architect rule 4. The user approval this step requests is limited
to the two *design decisions* below.

| Concern | Choice | Notes |
|---|---|---|
| Subprocess / `--model` | `child_process.spawn` (existing) | One extra argv element; no new dep. |
| Config surface | `~/.raptor/config.json` `models` key (existing JSON store) | Parsed like `timeouts`. |
| Per-role resolution | Plain TS (`??` fallback chain) | Mirrors `resolveStepTimeout` / `dinoNames` per-role pattern. |
| Gate instruction | Static string in `prompts.ts` | Centralized for AC-2 testability. |
| Tests | jest / ts-jest, colocated unit + `tests/integration/` | Drive real seams (AC 16). |

**Decisions requiring user approval at this checkpoint (tech-approval):**
1. **Scope:** ship Part 1 + Part 2 in **one** PR this sprint; Part 3 vacuous
   (no judge gate). Approve, or request Part 2 split into its own PR.
2. **Verifier model default (Open Question #6):** when a user opts in, what should
   the verifying roles (QA) default to — a *stronger* model than the Engineer, a
   *same-tier different instance*, or **no built-in default** (per-user config
   only, `models` empty by default)? **Architect recommendation: no built-in
   default** — ship the *capability* with `models` unset out of the box (zero
   behavior change), and document the opt-in. Research motivates *different*, not
   necessarily *stronger*; forcing a default model would break the byte-identical
   guarantee. **User to confirm.**

## Constraints & Patterns

- **Additive & backward-compatible everywhere.** `model` param optional;
  `models` config optional; no state-schema change. Absent config ⇒ today's
  behavior, byte-for-byte (AC 5, 15; dominant edge case).
- **argv tail is frozen (PR #18).** `--allowedTools <list>` → `--system-prompt`
  → `--append-system-prompt` → `--` → `taskDescription` ordering is load-bearing.
  `--model` inserts at the **front**, never between `--allowedTools` and the
  prompt. A test proves the tail is intact with a model set (AC 6).
- **Idle/ceiling machinery untouched** (`agents.ts:249-321`). The model param only
  affects argv assembly (`agents.ts:219-231`); timers, `killKind`, buffer caps
  are not in the change surface (AC 7).
- **Parse every declared key** (AC 9). The `models` key MUST be parsed in
  `loadConfig` and covered by a parity test — do not repeat the `timeouts`
  dead-plumbing defect that sat six sprints.
- **Part 1 enforcement is orchestrated, not documented** (AC 2). The instruction
  is built in code and injected at the step-7 seam; it takes effect without a
  human reading TEAM.md. Do **not** satisfy Part 1 with a TEAM.md edit (that is
  explicitly out of scope; retro flow owns TEAM.md).
- **False-negative bias** (AC 3): the injected guidance prefers rejecting
  suspicious work over accepting it. The `pr-review` **user checkpoint remains the
  human backstop** for false positives (Edge Case).
- **No silent pass** (AC 4, 17): a detected reimplementation or missing RED note
  is surfaced in the gate's reported result; where the gate is the step-7 agent,
  it is a flagged/failed outcome, never dropped.
- **No RED-note demand on ordinary tests** (Edge Case): the instruction scopes
  the RED-note check to **constraint-guarding** tests (per TEAM.md QA rule 12's
  wording) so happy-path tests are not falsely flagged.
- **No judge ensemble** (AC 14, Out of Scope): a single verifier agent with an
  adversarial instruction — never N judges voting.
- **Invalid-model classification:** by default the unknown-`--model` failure rides
  the existing retry/classification path. If the user wants it to short-circuit
  as user-actionable (like `billing-error-signature-class`), that is a **separate,
  follow-up** classification item — not built here (keeps this feature's blast
  radius minimal).
- **Tests exercise the production seam** (AC 16): Part-2 tests assert the **real**
  `spawnAgent` argv array; Part-1 tests assert the **real** step-7 prompt/context
  built by the runner — no test-local reimplementations. Each constraint-guarding
  test carries a RED-verification note (e.g. the argv test proven to fail when
  `--model` is absent or misordered; the AC-2 test proven to fail when the gate
  section is not injected).
- **All git operations remain `simple-git`**; no shelling out. Commit format
  `[ARCHITECT] {action}: {description}`.

## Handoff to QA

Test the two live seams and record RED-verification notes:
1. **Part 2 argv (`agents.test.ts`):** with a model set, argv contains
   `--model <v>`, `--allowedTools` is followed only by the tool list, `--` is
   present, and `taskDescription` is last. With no model, argv equals today's
   array exactly (RED: fails if `--model` leaks in or the tail reorders).
2. **Part 2 end-to-end (`tests/integration/`):** a `models.byRole.qa` config value
   flows through `loadConfig` → `resolveRoleModel` → the resolved model in the
   step-7 spawn argv (RED: fails if `loadConfig` drops the key — the dead-plumbing
   guard).
3. **Part 1 gate (runner):** the step-7 QA agent's prompt/context contains the
   adversarial-verifier instruction (reimplementation hunt + RED-note check +
   false-negative bias) (RED: fails against pre-change runner that never injected
   it).
4. **Backward-compat:** all existing `agents.test.ts` and runner tests pass
   unmodified; config without `models` yields today's argv.
