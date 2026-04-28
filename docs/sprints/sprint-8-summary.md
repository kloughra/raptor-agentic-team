# Sprint 8 Summary — raptor-agentic-team

## Sprint Goal
multi-feature-sprint-dispatch: complete — see Done section. PR #15 merged 2026-04-27.

## Features Delivered
- multi-feature-sprint-dispatch: Wire `multi-runner.ts` helpers into `runSprintFromStep` so every backlog item in a sprint section gets dispatched. Per-feature branches, streaming checkpoints, failure isolation. Bundled `sprint-branch-auto-create` and `request-changes-feedback-injection` (Sprint 8)
- sprint-branch-auto-create: Bundled into `multi-feature-sprint-dispatch` — `ensureFeatureBranch()` in `src/orchestrator/multi-runner.ts` is called from both single- and multi-feature paths, replacing the previous "record whatever HEAD points to" logic at `runner.ts:282-306` (Sprint 8)
- request-changes-feedback-injection: Single-feature and multi-feature `request-changes` branches in `resumeSprint` both reset `attempts = 0` and `failures = []` so the retry loop re-enters at attempt 1 and the feedback-injection condition fires (Sprint 8)

## Key Technical Decisions
- File detection: `fs.existsSync`
- Tech stack detection: Package manifest reading
- Context size: 50KB cap
- Retry mechanism: In-process loop in runner.ts
- Escalation commit: simple-git (already used)
- Concurrency: `Promise.allSettled`
- State: Existing `steps[]`
- Config: Existing `config.json`
- Cap: 30 minutes
- Storage: Config JSON
- Resolution: Defaults + merge
- Language: TypeScript
- Runtime: Node.js
- MCP SDK: `@modelcontextprotocol/sdk`
- Git operations: `simple-git`
- Package manager: npm
- Transport: stdio
- Storage: JSON files
- Feature concurrency: `Promise.allSettled`
- State storage: Extended `SprintState`
- Branch strategy: One branch per feature
- Branch create/checkout: `simple-git` (`git.checkoutLocalBranch`, `git.checkout`, `git.branchLocal`)
- Per-feature dispatch: Sequential `for`-loop over `state.features`
- Checkpoint streaming: Reuse existing `state.status = "paused"` + `state.checkpoints[]` + early `return`
- State extension: Additive optional fields with backward-compat defaults
- Branch-creation strategy resolution: **Bundle** `sprint-branch-auto-create` into this PR
- Detection: Package manifest existence
- Scoping: Task description injection
- Config: Existing `config.json`
- GitHub merge: `gh` CLI (already available in dev environment)
- Local merge fallback: `simple-git` (already used)

## Patterns & Conventions Established
- Additive-only: check existence before every write
- Context discovery is best-effort: failures don't block adoption
- Registry dedup by both name AND path
- The retry loop must NOT catch errors silently — every failure is recorded in state
- `[BLOCKER]` detection uses simple string matching on agent output (case-insensitive)
- Error summaries are truncated to prevent state file bloat
- The `MAX_RETRY_ATTEMPTS` constant is a module-level export, not user-configurable via config.json (out of scope)
- Backward compatibility: always use `stepState.attempts ?? 0` and `stepState.failures ?? []` when reading state
- Parallel groups are always pairs (no 3+ parallel steps in Sprint 5)
- The sequential-then-parallel-then-sequential pattern keeps the runner loop simple
- Partial parallelism (step 3) is a special case with two agent spawns, not true concurrency
- Retro proposals are collected sequentially (not parallel) in this sprint — parallel collection is deferred to `agent-parallel-execution`
- `applyImprovements` uses section header matching, not line numbers, for robustness
- The retro document is always saved, regardless of which improvements are adopted — it's the historical record
- Step 13 is orchestrator-managed (no subagent) — it applies text changes directly
- If "skip retro" is selected, TEAM.md is not modified but the sprint still completes
- Backward compatible: existing behavior unchanged if no config is set
- AGENT_TIMEOUT_MS constant remains for code that doesn't use the new parameter
- The 30-minute cap is a safety net, not a recommendation
- Summary generation is deterministic — no LLM calls, just file reading and templating
- Summaries are committed to the project repo (not `~/.raptor/`) so they're portable and version-controlled
- The `docs/sprints/` directory holds both summaries and retro docs (from agent-retrospective-improvements)
- `loadSprintSummaries` always returns a string (empty string if no summaries exist) — callers don't need null checks
- Role keys (`po`, `architect`, etc.) remain canonical everywhere in code and state
- Dino names are display-only — never used as identifiers in state or logic
- Emoji selection avoids actual dinosaur emoji (🦕🦖) for most roles to maintain visual distinction in the progress table
- DoD flags are set individually at the exact moment each condition is met — not batch-computed
- PR description update is best-effort — failure doesn't block the merge
- The DoD regex replacement in `updatePrDodChecklist` matches the standard PR template markers (e.g., `- [ ] All tests pass` → `- [x] All tests pass`)
- All new orchestrator code goes in `src/orchestrator/` — kept separate from existing tool modules
- The orchestrator imports existing modules (`registry`, `config`, `backlog-parser`, `git-parser`) but does not modify them
- Sprint state is stored under `~/.raptor/{project-slug}/` alongside the existing project registry
- Subagent output is treated as untrusted — the orchestrator validates expected artifacts exist on disk after each step before proceeding
- Git operations continue to use `simple-git` — the orchestrator commits handoff and status messages, subagents commit their own work artifacts
- **All git operations go through `simple-git`** — no shelling out to git directly
- **Registry is the source of truth** for what projects Raptor knows about. If a project is deleted from disk but still in the registry, `get_project_status` should report it as missing rather than crashing
- **TEAM.md is immutable after bootstrap** — Raptor stamps it and never touches it again. The project team owns it from that point forward
- **Backlog parsing is best-effort** — the backlog format is defined in TEAM.md but could be manually edited. Parse what you can, return partial results rather than failing if the format is unexpected
- **Config has sensible defaults** — if `~/.raptor/config.json` doesn't exist, use defaults (`projectsBaseDir: ~/projects`). Don't require manual setup
- **.gitkeep files** in empty directories to ensure git tracks the scaffold structure
- Shared steps (spec, architecture) must complete for a feature before its engineer step starts
- Cross-feature dependencies are not supported in Sprint 5 (each feature is independent)
- The existing single-feature `runSprintFromStep` is not modified — `runMultiFeatureSprint` wraps it
- Retro and feedback steps run once per sprint, not per feature
- **Single dispatcher entry point.** All execution flows through `runSprintFromStep`. The single- vs multi-feature branching happens once, at the top, based on `state.features`. No parallel implementation forks (e.g. no separate `runMultiFeatureSprint` exported from `multi-runner.ts` — the prior `multi-engineer-coordination` design floated that, but it would duplicate the runner. We keep one entry, with shared inner helpers).
- **Inner helpers don't persist state.** `runStepForFeature` mutates the passed-in `stepState` and `dod` references but never calls `saveSprintState`. Persistence is owned by callers so they can decide *when* to flush (e.g. between features).
- **Branch ownership.** `ensureFeatureBranch` is the only code that calls `git.checkout` / `git.checkoutLocalBranch`. The existing `executeMerge` path already handles checkout-to-default-branch for merging — unchanged.
- **Handoff commits per feature.** When in multi-feature mode, the handoff commit message format becomes `[HANDOFF] <From> -> <To>: <artifact> for {featureSlug} (sprint {N})` — feature slug already on every handoff per existing code, no change.
- **Frozen feature set.** Once `state.features` is populated, the runner never re-reads the backlog to add/remove features (Edge Case: mid-sprint added item, single-feature → multi restart).
- **Already-checked items.** When `detectSprintFeatures` returns a slug for an item that is already `[x]` in the backlog, `createFeatureStates` still seeds it. The dispatcher detects pre-completed features by checking whether **all** per-feature workflow steps are absent from on-disk artifacts — but a simpler rule satisfies the spec: on initial seeding, set `feature.status = "complete"` and all per-feature `steps[*].status = "complete"` for any feature whose backlog item is `[x]`. This is detected by extending `detectSprintFeatures` to return `{ slug, checked }` pairs, OR (simpler, no signature change per Out of Scope) by re-reading the backlog inside `createFeatureStates`'s caller and post-processing. **Decision:** post-process inside `runSprintFromStep` after `createFeatureStates` returns — matches the spec's Out of Scope constraint that we "do not update `multi-runner.ts` helper signatures."
- **`extractFeatureSlug` retained.** Used for the single-feature path. Its removal is explicitly out of scope.
- Test scoping is advisory — the agent sees it in the task description but isn't forced
- The shared config warning is only injected during multi-feature sprints (when `state.features` is present)
- Framework detection runs once per sprint, cached in the runner
- Custom `testCommand` with `{slug}` placeholder takes full precedence over auto-detection
- The merge step does NOT spawn a subagent — it's orchestrator-managed logic
- The merge step participates in the retry/escalation circuit breaker (from agent-failure-recovery)
- Squash-merge is always used — no configurable merge strategy
- After merge, the PO feedback step runs on `main` (the orchestrator's working directory is the project root, and after merge the active branch is `main`)
- Branch cleanup (remote delete) is explicitly out of scope

## Issues Encountered
- Step 3 (Write tests): failed 2 time(s) before succeeding
- Step 5 (Implement (TDD)): failed 1 time(s) before succeeding

## Deferred Items
- expected-outputs-glob-resolution: `resolveExpectedOutputPaths` (`runner.ts:156`) does `.replace("*", featureSlug)` on patterns like `tests/integration/*`, producing literal paths instead of matching real files via glob. The QA agent for Sprint 8 wrote `tests/integration/{slug}.integration.test.ts` per repo convention twice and got rejected; on attempt 3 it pivoted to creating a directory at the literal path to satisfy the validator. Replace string substitution with proper glob matching (e.g. `picomatch` or `fast-glob`) — promoted from Inbox per Sprint 8 demo feedback (PO triage 2026-04-27)
- artifact-injection-directory-handling: `artifact-injection.ts:84` calls `fs.readFileSync(fullPath, "utf-8")` without checking whether the path is a file. When QA's expected-output workaround left a directory at `tests/integration/{slug}`, step 4 (PO Review tests) threw EISDIR before the agent spawned, killing the sprint mid-flight. Fix: `statSync(fullPath).isFile()` gate before read; for directories, either recurse or skip with a warning entry — promoted from Inbox per Sprint 8 demo feedback (PO triage 2026-04-27)
- backlog-format-error-with-example: When `run_sprint` rejects a backlog with "No backlog items found for sprint N" (tools.ts:687), include the expected format inline (`## Sprint N` / `- [ ] slug: description`) and a doc link. dora-metrics user spent ~3min in an edit→run→error loop reverse-engineering the parser — source: session ea5bc6fd 2026-04-26
- adopt-project-git-init: `adopt_project` should detect non-git directories and either auto-init (with prompt) or fail with a clear "run `git init` first" message. Today the failure surfaces as an opaque simple-git error — source: session ea5bc6fd 2026-04-26
- reset-sprint-tool: First-class `reset_sprint` MCP tool to clear escalated/failed state. Today users must `rm ~/.raptor/{project}/sprint-N.json` by hand to escape circuit-breaker escalation — source: session ea5bc6fd 2026-04-26
- early-exit-on-stdin-warning: Defense-in-depth on top of the stdin hotfix — short-circuit the retry loop when agent output is just the claude CLI's stdin-wait warning. Avoids the ~14min the dora-metrics user spent watching the 3-attempt circuit breaker — source: session ea5bc6fd 2026-04-26
- surface-tool-errors-to-openstory: Raptor tools return failures as `{status: "error"}` strings, not exceptions, so OpenStory's error detector reports `[]` for sessions that clearly failed. Either throw on failure or emit a structured error event — source: session ea5bc6fd 2026-04-26
- hotfix-workflow-tool: Add a `run_hotfix` MCP tool that enforces a lightweight SDLC: create hotfix branch → implement + test → PR → user approval → merge. Tracked in sprint state like a mini-sprint. Prevents untracked code changes.
- pre-flight-branch-check: Before any agent writes code, verify it's on a tracked branch (sprint or hotfix). If on main, refuse to proceed and prompt for branch creation. Enforced in `spawnAgent` and runner loop.
- change-proposal-tool: Add a `propose_change` MCP tool that creates a backlog entry and routes to the correct workflow (sprint vs hotfix) based on scope. Forces all changes through tracking before any code is written.
- resource-aware-agent-scheduling: Add concurrency limits to parallel agent execution. Cap parallelism (e.g., max 2 agents) or detect CPU contention and queue excess agents
- checkpoint-resume-for-subagents: Pre-summarize completed discovery work so retries skip re-reading all specs and jump straight to generation

## Context for Future Sprints
File detection: `fs.existsSync`
Tech stack detection: Package manifest reading
Context size: 50KB cap
Retry mechanism: In-process loop in runner.ts
Escalation commit: simple-git (already used)
Concurrency: `Promise.allSettled`
State: Existing `steps[]`
Config: Existing `config.json`
Cap: 30 minutes
Storage: Config JSON
Resolution: Defaults + merge
Language: TypeScript
Runtime: Node.js
MCP SDK: `@modelcontextprotocol/sdk`
Git operations: `simple-git`
Package manager: npm
Transport: stdio
Storage: JSON files
Feature concurrency: `Promise.allSettled`
State storage: Extended `SprintState`
Branch strategy: One branch per feature
Branch create/checkout: `simple-git` (`git.checkoutLocalBranch`, `git.checkout`, `git.branchLocal`)
Per-feature dispatch: Sequential `for`-loop over `state.features`
Checkpoint streaming: Reuse existing `state.status = "paused"` + `state.checkpoints[]` + early `return`
State extension: Additive optional fields with backward-compat defaults
Branch-creation strategy resolution: **Bundle** `sprint-branch-auto-create` into this PR
Detection: Package manifest existence
Scoping: Task description injection
Config: Existing `config.json`
GitHub merge: `gh` CLI (already available in dev environment)
Local merge fallback: `simple-git` (already used)
Additive-only: check existence before every write
Context discovery is best-effort: failures don't block adoption
Registry dedup by both name AND path
The retry loop must NOT catch errors silently — every failure is recorded in state
`[BLOCKER]` detection uses simple string matching on agent output (case-insensitive)
Error summaries are truncated to prevent state file bloat
The `MAX_RETRY_ATTEMPTS` constant is a module-level export, not user-configurable via config.json (out of scope)
Backward compatibility: always use `stepState.attempts ?? 0` and `stepState.failures ?? []` when reading state
Parallel groups are always pairs (no 3+ parallel steps in Sprint 5)
The sequential-then-parallel-then-sequential pattern keeps the runner loop simple
Partial parallelism (step 3) is a special case with two agent spawns, not true concurrency
Retro proposals are collected sequentially (not parallel) in this sprint — parallel collection is deferred to `agent-parallel-execution`
`applyImprovements` uses section header matching, not line numbers, for robustness
The retro document is always saved, regardless of which improvements are adopted — it's the historical record
Step 13 is orchestrator-managed (no subagent) — it applies text changes directly
If "skip retro" is selected, TEAM.md is not modified but the sprint still completes
Backward compatible: existing behavior unchanged if no config is set
AGENT_TIMEOUT_MS constant remains for code that doesn't use the new parameter
The 30-minute cap is a safety net, not a recommendation
Summary generation is deterministic — no LLM calls, just file reading and templating
Summaries are committed to the project repo (not `~/.raptor/`) so they're portable and version-controlled
The `docs/sprints/` directory holds both summaries and retro docs (from agent-retrospective-improvements)
`loadSprintSummaries` always returns a string (empty string if no summaries exist) — callers don't need null checks
Role keys (`po`, `architect`, etc.) remain canonical everywhere in code and state
Dino names are display-only — never used as identifiers in state or logic
Emoji selection avoids actual dinosaur emoji (🦕🦖) for most roles to maintain visual distinction in the progress table
DoD flags are set individually at the exact moment each condition is met — not batch-computed
PR description update is best-effort — failure doesn't block the merge
The DoD regex replacement in `updatePrDodChecklist` matches the standard PR template markers (e.g., `- [ ] All tests pass` → `- [x] All tests pass`)
All new orchestrator code goes in `src/orchestrator/` — kept separate from existing tool modules
The orchestrator imports existing modules (`registry`, `config`, `backlog-parser`, `git-parser`) but does not modify them
Sprint state is stored under `~/.raptor/{project-slug}/` alongside the existing project registry
Subagent output is treated as untrusted — the orchestrator validates expected artifacts exist on disk after each step before proceeding
Git operations continue to use `simple-git` — the orchestrator commits handoff and status messages, subagents commit their own work artifacts
**All git operations go through `simple-git`** — no shelling out to git directly
**Registry is the source of truth** for what projects Raptor knows about. If a project is deleted from disk but still in the registry, `get_project_status` should report it as missing rather than crashing
**TEAM.md is immutable after bootstrap** — Raptor stamps it and never touches it again. The project team owns it from that point forward
**Backlog parsing is best-effort** — the backlog format is defined in TEAM.md but could be manually edited. Parse what you can, return partial results rather than failing if the format is unexpected
**Config has sensible defaults** — if `~/.raptor/config.json` doesn't exist, use defaults (`projectsBaseDir: ~/projects`). Don't require manual setup
**.gitkeep files** in empty directories to ensure git tracks the scaffold structure
Shared steps (spec, architecture) must complete for a feature before its engineer step starts
Cross-feature dependencies are not supported in Sprint 5 (each feature is independent)
The existing single-feature `runSprintFromStep` is not modified — `runMultiFeatureSprint` wraps it
Retro and feedback steps run once per sprint, not per feature
**Single dispatcher entry point.** All execution flows through `runSprintFromStep`. The single- vs multi-feature branching happens once, at the top, based on `state.features`. No parallel implementation forks (e.g. no separate `runMultiFeatureSprint` exported from `multi-runner.ts` — the prior `multi-engineer-coordination` design floated that, but it would duplicate the runner. We keep one entry, with shared inner helpers).
**Inner helpers don't persist state.** `runStepForFeature` mutates the passed-in `stepState` and `dod` references but never calls `saveSprintState`. Persistence is owned by callers so they can decide *when* to flush (e.g. between features).
**Branch ownership.** `ensureFeatureBranch` is the only code that calls `git.checkout` / `git.checkoutLocalBranch`. The existing `executeMerge` path already handles checkout-to-default-branch for merging — unchanged.
**Handoff commits per feature.** When in multi-feature mode, the handoff commit message format becomes `[HANDOFF] <From> -> <To>: <artifact> for {featureSlug} (sprint {N})` — feature slug already on every handoff per existing code, no change.
**Frozen feature set.** Once `state.features` is populated, the runner never re-reads the backlog to add/remove features (Edge Case: mid-sprint added item, single-feature → multi restart).
**Already-checked items.** When `detectSprintFeatures` returns a slug for an item that is already `[x]` in the backlog, `createFeatureStates` still seeds it. The dispatcher detects pre-completed features by checking whether **all** per-feature workflow steps are absent from on-disk artifacts — but a simpler rule satisfies the spec: on initial seeding, set `feature.status = "complete"` and all per-feature `steps[*].status = "complete"` for any feature whose backlog item is `[x]`. This is detected by extending `detectSprintFeatures` to return `{ slug, checked }` pairs, OR (simpler, no signature change per Out of Scope) by re-reading the backlog inside `createFeatureStates`'s caller and post-processing. **Decision:** post-process inside `runSprintFromStep` after `createFeatureStates` returns — matches the spec's Out of Scope constraint that we "do not update `multi-runner.ts` helper signatures."
**`extractFeatureSlug` retained.** Used for the single-feature path. Its removal is explicitly out of scope.
Test scoping is advisory — the agent sees it in the task description but isn't forced
The shared config warning is only injected during multi-feature sprints (when `state.features` is present)
Framework detection runs once per sprint, cached in the runner
Custom `testCommand` with `{slug}` placeholder takes full precedence over auto-detection
The merge step does NOT spawn a subagent — it's orchestrator-managed logic
The merge step participates in the retry/escalation circuit breaker (from agent-failure-recovery)
Squash-merge is always used — no configurable merge strategy
After merge, the PO feedback step runs on `main` (the orchestrator's working directory is the project root, and after merge the active branch is `main`)
Branch cleanup (remote delete) is explicitly out of scope
Issue: Step 3 (Write tests): failed 2 time(s) before succeeding
Issue: Step 5 (Implement (TDD)): failed 1 time(s) before succeeding
