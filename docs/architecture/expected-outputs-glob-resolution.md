---
slug: expected-outputs-glob-resolution
spec: docs/specs/expected-outputs-glob-resolution.md
---
# Expected-Outputs Glob Resolution — Architecture Design

## Overview

Today, step output validation collapses each `expectedOutputs` glob into a single
literal path via `pattern.replace("*", featureSlug)`. This is wrong in two ways:

- **Single-star patterns lose the file's real name/extension.** `tests/integration/*`
  becomes the extensionless literal `tests/integration/{slug}`, which never equals the
  conventional `tests/integration/{slug}.integration.test.ts` an agent actually writes.
- **Double-star patterns are dropped** by the `**` filter and fall back to a flat
  "does the base dir contain *any* file" check — too loose (any file passes) and blind
  to subdirectories.

The same substitution also generates the **"REQUIRED OUTPUT FILES"** list injected into
the agent task description, so agents are *instructed* to create the wrong path. The
live failure mode (Sprint 8): the QA agent wrote the correct file twice, was rejected,
then created a stray **directory** to satisfy the validator — which later caused an
`EISDIR` crash (tracked separately).

This design replaces literal substitution with **real glob matching against the
filesystem**: enumerate the files an agent actually wrote under each pattern's base
directory, then test those real paths against the (slug-scoped) glob. A pattern is
satisfied when **at least one real file** matches; otherwise it is reported missing
using its original, human-readable pattern string.

The change is **localized to two functions** in `src/orchestrator/runner.ts`
(`resolveExpectedOutputPaths` / `validateRequiredOutputs`) plus the task-description
generation that consumes them, with a no-regression touch to `buildStepContext` in
`prompts.ts`. The 13 `expectedOutputs` pattern strings in `workflow.ts` are **unchanged**
(per Out of Scope) — only their *resolution* changes.

## Components

### 1. `glob-match.ts` (new) — `src/orchestrator/glob-match.ts`
A small, dependency-light matching module. Single responsibility: given a project root,
a glob pattern, and the feature slug, return the list of **real files** that satisfy the
pattern (file-only, slug-scoped where applicable). Pure/synchronous; no orchestration
state. Public surface:

- `matchExpectedOutput(pattern: string, projectPath: string, featureSlug: string): MatchResult`
  — returns `{ pattern, matchedFiles: string[], satisfied: boolean }`.
- `classifyPattern(pattern): "exact" | "single-star" | "double-star"` — internal helper,
  exported for unit testing.
- `describeRequiredOutput(pattern, featureSlug): string` — produces the human-facing
  "what the agent should create" string for the task description (AC #5), e.g.
  `tests/integration/<slug>.<something> (a file matching tests/integration/*)`.

Keeping this in its own module (rather than inline in `runner.ts`) follows the
established convention that orchestration helpers are small, individually unit-tested
files under `src/orchestrator/`.

### 2. `runner.ts` (modified)
- `validateRequiredOutputs(step, featureSlug, projectPath)` — rewritten to iterate each
  pattern, call `matchExpectedOutput`, and collect **original pattern strings** for any
  unsatisfied pattern (AC #2 Open Question → report the original pattern, not a resolved
  literal). The separate `**` fallback block (`runner.ts:131-155`) is **deleted** —
  double-star is now handled uniformly by the matcher.
- `resolveExpectedOutputPaths` — repurposed (or replaced by a thin wrapper) so the only
  consumer left is the task-description builder, which now calls `describeRequiredOutput`
  per pattern instead of emitting extensionless literals (AC #5). The exported symbol is
  retained to avoid breaking importers, but its semantics change from "literal paths" to
  "human-readable required-output descriptions."
- `buildTaskDescription` — the "REQUIRED OUTPUT FILES" loop now lists
  `describeRequiredOutput(pattern, slug)` entries, guaranteeing the instruction the agent
  reads matches what the validator will accept.

### 3. `prompts.ts` (modified, no-regression)
`buildStepContext` (`prompts.ts:154-201`) reads **input** artifacts using the same
`replace("*", slug)` substitution plus a directory-scan fallback. To keep one matching
implementation, it is refactored to use `matchExpectedOutput` (or a shared internal
walker) so input resolution can only *improve or stay equal* (AC #8). The existing
directory-scan fallback already finds conventional files, so this is a no-regression
consolidation, not a behavior change.

## Data Model

No persisted-state changes. `SprintState`, `StepState`, and `workflow.ts` pattern strings
are untouched. The only new in-memory type is the matcher's return value:

```ts
interface MatchResult {
  pattern: string;          // original pattern, verbatim (used for missing-output reporting)
  matchedFiles: string[];   // project-relative paths of real files that matched (file-only)
  satisfied: boolean;       // matchedFiles.length > 0
}

type PatternClass = "exact" | "single-star" | "double-star";
```

## API Contracts

```ts
// src/orchestrator/glob-match.ts
export function matchExpectedOutput(
  pattern: string,
  projectPath: string,
  featureSlug: string
): MatchResult;

export function describeRequiredOutput(
  pattern: string,
  featureSlug: string
): string;

// src/orchestrator/runner.ts (signatures preserved — internals changed)
export function validateRequiredOutputs(
  step: WorkflowStep,
  featureSlug: string,
  projectPath: string
): string[];               // returns ORIGINAL pattern strings for unsatisfied patterns
```

### Matching rules (the contract that drives QA's tests)

| Pattern class | Example | Resolution rule |
|---|---|---|
| **Exact** (no `*`) | `docs/backlog.md`, `TEAM.md` | Exact-path `existsSync` **and** `isFile()`. Unchanged behavior (AC #7). |
| **Single-star** (`*`, no `**`) | `tests/integration/*`, `docs/specs/*.md` | Recursively/locally enumerate **files** under the pattern's base dir; a file matches if it satisfies the glob **and** its filename or a path segment **contains the feature slug** (AC #6 slug-scoping). At least one match ⇒ satisfied. |
| **Double-star** (`**`) | `src/**/*.ts` | Recursively enumerate **files** under the base dir at any depth; a file matches if it satisfies the glob. **No slug requirement** (source files aren't slug-named — Open Question 1 split). At least one match ⇒ satisfied. |

**Slug-scoping resolution (Open Question 1).** Per the PO recommendation, confirmed by
Architect: **single-star patterns require slug association** (the matched file's name or
one of its path segments must contain `featureSlug`), preserving per-feature isolation
(AC #6); **double-star patterns do not** (they match by extension/shape only). This split
is the authoritative matching rule for QA's tests.

**Missing-output reporting (Open Question 2).** Per PO preference, confirmed: the missing
list contains the **original pattern string** (e.g. `tests/integration/*`), not a
resolved literal — stable and non-misleading (AC #3).

### Invariants enforced by the matcher
- **Files only.** A directory whose name matches the glob never satisfies a file pattern
  (AC #4 — kills the Sprint-8 directory workaround). Every candidate passes `isFile()`.
- **`.gitkeep` never counts.** Filenames equal to `.gitkeep` are excluded from candidates
  (Edge Case: a `.gitkeep`-only directory must not satisfy a file pattern).
- **Literal-safe slug.** The feature slug and pattern literals are regex-escaped before
  building the matcher so hyphens (the only special char allowed by `^[a-z][a-z0-9-]*$`)
  and dots are treated literally, not as regex metacharacters (Edge Case: hyphenated slug).
- **No crash on missing base dir.** A non-existent base directory yields zero matches →
  pattern reported missing, never an exception (Edge Case: skipped step / empty output).
- **Independent evaluation.** Each pattern on a step is matched on its own; one satisfied
  pattern never excuses another (Edge Case: mixed `*` + `**` on step 3).

## Non-Functional Requirements

- **NFR-1 Correctness (primary).** All 9 acceptance criteria and all 6 edge cases hold.
  The matcher is the validation gate for every sprint step, so false negatives burn
  retries and false positives let empty work through — correctness dominates.
- **NFR-2 Performance.** Validation runs once per step (≤13 times per feature). File
  enumeration is bounded to a pattern's base directory subtree. Target: **< 50 ms per
  pattern** on a typical repo subtree; **< 250 ms** total per step. Recursive walks must
  prune heavy/irrelevant directories (`node_modules`, `.git`, `dist`) to avoid pathological
  traversal under `src/**` or `tests/**`.
- **NFR-3 Zero new persisted state / backward compatibility.** No state schema change; no
  change to `workflow.ts` patterns. Existing sprint state files load and validate
  unchanged (AC #9). Public function signatures in `runner.ts` are preserved.
- **NFR-4 Determinism.** Matching is a pure function of (pattern, slug, filesystem
  contents) — no time, randomness, or ordering dependence. Results are stable across runs.
- **NFR-5 Security / safety.** Path traversal is confined under `projectPath`; resolved
  candidate paths are validated to stay within the project root. No following of symlinks
  out of the tree. No shelling out — matching is in-process.
- **NFR-6 Observability.** When a pattern is reported missing, the message uses the
  original pattern so logs/escalations are stable and diagnosable.
- **NFR-7 Testability.** The matcher is a standalone, synchronous, fs-only module unit-
  testable with temp dirs — no orchestrator or agent wiring required.

## Technology Choices

> **⚠️ REQUIRES USER APPROVAL at the `tech-approval` checkpoint (Step 2 gate).**
> Per TEAM.md, any new dependency must be approved before implementation (Step 3) begins.

**Recommended: `picomatch` + an in-house recursive file walker.**

- `picomatch` is a zero-runtime-dependency glob-to-regex matcher (the engine behind
  micromatch, chokidar, fast-glob). We use it only to compile a pattern and test
  candidate path strings — **it does not touch the filesystem**, so we retain full
  control over `isFile()` checks, `.gitkeep` filtering, slug-scoping, and base-dir
  pruning in our own ~20-line recursive walker.
- This pairing gives battle-tested glob correctness (the risky part — anchoring, `**`
  semantics, escaping) while keeping fs behavior explicit and auditable.

**Fallback if the user declines a new dependency: in-house only.** The two pattern shapes
in use (`*`, `**`) are narrow enough to hand-roll a glob→regex with the same walker. This
adds zero dependencies at the cost of owning all glob edge-case correctness ourselves.
The module boundary (`glob-match.ts`) is identical either way, so the implementation can
swap without touching callers.

**Rejected: `fast-glob`.** It bundles a heavier transitive tree (micromatch, glob-parent,
merge2, fastq, …) and performs its own fs traversal, giving us less control over the
file-only / `.gitkeep` / slug-scoping invariants this spec demands. The marginal code we'd
save in the walker isn't worth the loss of control or the dependency weight.

| Aspect | Decision |
|---|---|
| Language / runtime | TypeScript on Node.js (existing) |
| Matching engine | `picomatch` (recommended) **or** hand-rolled glob→regex (fallback) |
| FS traversal | In-house synchronous recursive walker (`fs.readdirSync` + `statSync`), with prune list |
| Async model | Synchronous (validation is a fast, blocking gate; matches existing `validateRequiredOutputs`) |
| New persisted state | None |
| Module location | `src/orchestrator/glob-match.ts` |

## Constraints & Patterns

- **`workflow.ts` patterns are frozen.** Only resolution/matching changes (Out of Scope).
- **Single matching implementation.** Both output validation (`runner.ts`) and input
  context (`prompts.ts`) route through `glob-match.ts` — no second, divergent resolver.
- **Instruction/validator parity (AC #5).** The string the agent is told to create and the
  rule the validator applies are generated from the **same** module, so they cannot drift.
- **Files-only, slug-scoped-where-stated.** The two invariants that fix the live bug:
  directories never satisfy file patterns; single-star patterns require slug association.
- **At-least-one-match semantics.** A pattern is satisfied by ≥1 real matching file; no
  1:1 file-count requirement (Edge Case: multiple matches).
- **Best-effort, no-crash traversal.** Unreadable dirs / missing base dirs degrade to "no
  match" (reported missing), never to an exception — consistent with the codebase's
  best-effort parsing convention.
- **Out of scope (handled elsewhere):** `artifact-injection-directory-handling` (EISDIR
  read crash) and `partial-artifacts-gitkeep-filter` (`hadPartialArtifacts` masking) are
  separate Sprint 11 items; this design only guarantees `.gitkeep`-alone never passes a glob.
- **Pre-existing pattern compliance.** All git operations remain `simple-git`; no shelling
  out; new code stays under `src/orchestrator/` and does not modify existing tool modules
  beyond the two functions named above.
