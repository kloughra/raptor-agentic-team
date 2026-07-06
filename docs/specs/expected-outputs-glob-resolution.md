---
slug: expected-outputs-glob-resolution
status: ready
sprint: 11
---
# Expected-Outputs Glob Resolution

## User Story
As a **Raptor orchestrator running a sprint**, I want step output validation to
match the real files an agent writes (following repo naming conventions) against
the step's `expectedOutputs` glob patterns, so that an agent who produces a
correctly-named artifact passes validation on the first attempt — instead of
being rejected, burning retries, and resorting to creating a bogus directory at
the literal substituted path just to satisfy the validator.

### Background
`resolveExpectedOutputPaths` (`src/orchestrator/runner.ts:168`) currently turns a
pattern into a single literal path via `pattern.replace("*", featureSlug)`:

- `tests/integration/*` → `tests/integration/{slug}` — a literal path with **no
  extension**. QA, following the repo convention, writes
  `tests/integration/{slug}.integration.test.ts`, which does not equal the
  literal path, so validation reports the artifact missing.
- `src/**/*.ts` is dropped entirely by the `**` filter and falls back to a flat
  "does the base dir contain any file" check in `validateRequiredOutputs`
  (`runner.ts:131-155`), which is both too loose (any file passes) and unable to
  see files in subdirectories.

This same literal-substitution logic also drives the **"REQUIRED OUTPUT FILES"**
list injected into the agent's task description (`buildTaskDescription`,
`runner.ts:192-198`), so agents are actively *instructed* to create the wrong
path. Observed live in Sprint 8: the QA agent wrote the conventional
`tests/integration/{slug}.integration.test.ts` twice, got rejected both times,
and on attempt 3 created a **directory** at `tests/integration/{slug}` to pass
the validator. That stray directory then caused the `EISDIR` crash tracked
separately as `artifact-injection-directory-handling`.

## Acceptance Criteria

1. **Single-star pattern matches conventional filenames.** Given a step with
   `expectedOutputs: ["tests/integration/*"]` and a feature slug `S`, when the
   agent has written `tests/integration/{S}.integration.test.ts`, validation
   reports **no missing outputs** for that pattern. (Today it reports the
   pattern as missing.)

2. **Double-star pattern matches files at any depth.** Given a step with
   `expectedOutputs: ["src/**/*.ts"]`, when the agent has written a matching
   file in any subdirectory (e.g. `src/orchestrator/foo.ts`), validation reports
   no missing outputs. A `**` pattern that matches at least one real `.ts` file
   passes; one that matches none fails and is reported.

3. **No-match still fails clearly.** When **no** real file matches a pattern,
   validation reports that pattern (or its human-readable form) in the missing
   list, exactly as today. A truly empty step output must not pass.

4. **A directory at the literal path does NOT satisfy a file pattern.** Given
   `expectedOutputs: ["tests/integration/*"]`, if only a *directory* named
   `tests/integration/{S}` exists (no matching file inside it), the pattern is
   reported missing. The Sprint-8 workaround must no longer be a way to pass
   validation.

5. **Agent guidance matches what validation accepts.** The "REQUIRED OUTPUT
   FILES" section injected into the agent task description must describe outputs
   the agent can actually create and that will then pass validation — it must
   not instruct the agent to create an extensionless literal path
   (`tests/integration/{S}`) that contradicts the repo convention. (Phrasing /
   format is the Architect's call; the requirement is consistency between the
   instruction and the validator.)

6. **Slug scoping is preserved for single-feature isolation.** A pattern resolves
   against the **current feature's** artifacts. A file belonging to a *different*
   feature must not, on its own, satisfy the current feature's pattern. (See Open
   Question 1 for the exact matching rule — default: the matched file's name or a
   path segment must contain the feature slug for single-star patterns.)

7. **Exact (wildcard-free) patterns still work.** Patterns with no wildcard
   (`docs/backlog.md`, `TEAM.md`) continue to validate by exact-path existence,
   unchanged.

8. **Input-artifact resolution stays consistent.** `buildStepContext`
   (`src/orchestrator/prompts.ts:167`) uses the same `pattern.replace("*",
   featureSlug)` substitution to locate input artifacts to feed the next agent.
   Whatever resolution approach is adopted, reading input artifacts must continue
   to find the conventional files (it currently has a directory-scan fallback, so
   this is mostly a no-regression criterion — input context must not get worse).

9. **No regression across the existing workflow.** All 13 workflow steps'
   `expectedOutputs` (spec `docs/specs/*.md`, architecture `docs/architecture/*.md`,
   tests `tests/bdd/*.feature` + `tests/integration/*`, implementation
   `src/**/*.ts`, backlog `docs/backlog.md`, retro `docs/sprints/*.md`,
   `TEAM.md`) validate correctly with real, conventionally-named artifacts. The
   full existing test suite passes.

## Edge Cases
- **Multiple matching files for one pattern** (e.g. several files under
  `tests/integration/` or multiple `src/**/*.ts`): the pattern is satisfied if
  **at least one** real file matches (scoped per AC #6). Validation does not
  require a 1:1 file count.
- **`.gitkeep`-only directory**: a directory containing only `.gitkeep` must not
  count as a satisfied file pattern (a `.gitkeep` is not a feature artifact).
  *(Note: the broader `hadPartialArtifacts` masking is tracked separately as
  `partial-artifacts-gitkeep-filter` — this spec only requires that `.gitkeep`
  alone never passes an `expectedOutputs` glob.)*
- **Slug with hyphens** (the only special character allowed by
  `^[a-z][a-z0-9-]*$`, e.g. `expected-outputs-glob-resolution`): must match
  correctly; no glob/regex metacharacter mis-parsing.
- **Pattern base directory does not exist** (step skipped / agent wrote nothing):
  reported as missing, not a crash.
- **Mixed single-star and double-star patterns on the same step** (e.g. step 3:
  `tests/bdd/*.feature` + `tests/integration/*`): each pattern is evaluated
  independently; one matching does not excuse another that is missing.

## Out of Scope
- Changing the `expectedOutputs` pattern strings in `workflow.ts` — the patterns
  stay as-is; only their *resolution/matching* changes.
- `artifact-injection-directory-handling` (the `EISDIR` read crash) — separate
  Sprint 11 backlog item, fixed independently.
- `partial-artifacts-gitkeep-filter` (the `hadPartialArtifacts` signal) —
  separate Inbox item.
- The choice of glob library / matching implementation (`picomatch`,
  `fast-glob`, hand-rolled, etc.) — **Architect's decision**; the backlog's
  mention of `picomatch`/`fast-glob` is illustrative, not a mandate.
- Adding new dependencies vs. implementing matching in-house — Architect decides;
  any new dependency requires user approval per TEAM.md.

## Open Questions
1. **Slug-scoping strictness (recommend Architect + QA settle before tests).**
   The current code's intent behind `replace("*", slug)` was to scope a pattern
   to *this* feature. For a glob like `tests/integration/*`, should a match
   require the matched file to reference the slug
   (`{slug}.integration.test.ts`), or is *any* file matching the glob
   acceptable? **PO recommendation:** require slug association for single-star
   patterns (preserve isolation, matches the convention and AC #6); allow
   broad glob matching for `src/**/*.ts` where filenames are not slug-named.
   Confirm this split with Architect.
2. Should validation report the **human-readable original pattern** (e.g.
   `tests/integration/*`) or a **resolved example** in the missing-outputs list?
   PO preference: report the original pattern so the message is stable and not
   misleading — but defer final wording to Architect/QA.
