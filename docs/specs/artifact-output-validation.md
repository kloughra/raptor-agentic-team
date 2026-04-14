---
slug: artifact-output-validation
status: ready
sprint: hotfix
---

# Artifact Output Validation

## Problem Statement

Subagents mark sprint steps as complete (exit code 0) without actually creating
the required output files. The orchestrator trusts the exit code unconditionally,
so the next step's agent receives a handoff without the artifact it depends on.
This causes a cascade of escalations — each subsequent agent fails because the
previous agent's output artifact is missing.

Real-world example (session 78358def): OpenStory Sprint 1 had rich detail in the
backlog. Petra (PO) read the backlog, concluded the spec was "already described",
and exited 0 without writing `docs/specs/{slug}.md`. Anky (Architect) then
escalated 3 times because the spec file didn't exist. The user had to manually
create each artifact to unblock the pipeline.

## Root Cause

Three gaps in the orchestrator→agent contract:

1. **No output validation gate**: `runner.ts` checks `exitCode === 0` and marks
   the step complete without verifying that `expectedOutputs` files exist on disk.
2. **Agents don't see TEAM.md**: The canonical process definition (which specifies
   what each role must produce) is never injected into the agent's context. Agents
   fly on a hardcoded summary in `prompts.ts`, not the source of truth.
3. **Weak output instructions**: `buildTaskDescription()` says
   `"Expected outputs: docs/specs/*.md"` but doesn't mandate file creation or
   warn that the step will fail without it.

## Solution — Three Layers

### Layer 1: TEAM.md Injection

Inject the project's `TEAM.md` into the agent's system prompt context. Each agent
should see the full process definition so it understands its obligations, including
the requirement to produce specific artifact files.

- In `buildStepContext()` or at the runner level, read the project's `TEAM.md`
  and prepend it to the context
- If TEAM.md is large, inject only the relevant role section + artifact directory
  map + workflow steps
- Cap at a reasonable size (e.g. 8KB) to avoid context bloat

### Layer 2: Explicit File-Write Mandate in Task Description

Update `buildTaskDescription()` to replace the soft "Expected outputs" line with
a hard mandate:

- Resolve `expectedOutputs` glob patterns to concrete file paths using the
  feature slug (e.g. `docs/specs/*.md` → `docs/specs/{slug}.md`)
- Add explicit language: "You MUST create the following file(s): {list}. This
  step will FAIL validation if these files do not exist on disk after you
  complete."
- For steps with no expectedOutputs, no change needed

### Layer 3: Post-Completion Output Validation Gate

After a subagent exits 0, validate that expected output files actually exist
before marking the step complete:

- In `runner.ts`, after `exitCode === 0` and before `succeeded = true`:
  1. Resolve `expectedOutputs` patterns to concrete paths using the feature slug
  2. Check each required output file exists on disk
  3. If any are missing, treat as a failure: record in `stepState.failures` with
     a clear message ("Agent completed but did not produce: {missing files}")
     and continue to the next retry attempt
- The existing `validateStepOutputs()` function needs to be enhanced to do
  slug-aware matching and return missing files, not just found files

## Acceptance Criteria

- [ ] AC1: TEAM.md content is injected into agent context for every step
- [ ] AC2: Task descriptions include explicit file-write mandates with resolved
      paths (not glob patterns)
- [ ] AC3: After exit 0, runner validates expected output files exist on disk
- [ ] AC4: Missing outputs are treated as step failure with descriptive error
- [ ] AC5: Retry loop works correctly — agent gets told what files it failed to
      create on the previous attempt
- [ ] AC6: Steps with no expectedOutputs (e.g. "Open PR", "Demo") are unaffected
- [ ] AC7: Existing tests continue to pass

## Edge Cases

- TEAM.md doesn't exist in the project (use bundled template as fallback)
- TEAM.md is very large (cap injection size)
- expectedOutputs use glob patterns that could match multiple files — need at
  least one match, not an exact filename
- Agent creates the file but it's empty (future: validate non-empty, but not in
  this hotfix)

## Out of Scope

- Structured JSON result protocol (future enhancement — would replace exit code
  with a machine-readable report of what the agent did)
- Content validation of artifacts (checking that a spec actually has acceptance
  criteria, etc.)
- Empty file detection
