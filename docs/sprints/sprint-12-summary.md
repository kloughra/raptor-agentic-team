# Sprint 12 Summary — raptor-agentic-team

## Sprint Goal
progress-aware-circuit-breaker: The 3-attempt circuit breaker (`MAX_RETRY_ATTEMPTS=3`, `runner.ts:53`) counts attempts but has no progress signal, no error classification, and a hard wall-clock agent kill — the Sprint 11 escalation (see `sprint-11-write-tests-escalation` in Ready) is the live specimen: 6 step-3 failures (2× 15-min timeout mid-write, 4× transient socket drops), every one with `hadPartialArtifacts: true`, and both QA agents' completed BDD files discarded. Five changes, designed together: (1) **no-progress short-circuit** — detect identical failure signature across attempts and stop retrying instead of burning slots (LangChain #36139 pattern; absorbs `early-exit-on-stdin-warning` as its narrow special case); (2) **transient vs deterministic error classification** — transient infra errors (e.g. `socket connection closed unexpectedly`) must not consume a circuit-breaker slot like a real task failure (today there is zero classification in the codebase); (3) **idle-timeout instead of wall-clock cap** — the agent deadline (`agents.ts:243-251`) is a fixed `setTimeout` that SIGTERMs a still-streaming child; reset the deadline on every `stdout.on("data")` chunk (liveness signal already wired at `agents.ts:253`) with a hard ceiling backstop so only a genuinely silent agent is reaped; (4) **partial-artifact salvage** — `hadPartialArtifacts` (`state.ts:10`) is recorded but never acted on; when an agent produced expected artifacts before dying on timeout/transient error, carry the completed work into the next attempt (or validate + accept it) instead of starting from scratch — Sprint 11 also lost feature-2's written-and-validated spec/arch docs this way; (5) **wire the dead timeout config plumbing** — `resolveStepTimeout(stepName, config?)` supports `~/.raptor/config.json` `timeouts.stepOverrides`, but all 4 runner call sites (`runner.ts:831,855,1445,1467`) omit the config argument, so user overrides are silently ignored (found during Sprint 12 pre-flight 2026-07-06). First commit of the sprint (sanctioned by `write-tests-timeout-bump` in Ready): raise `STEP_TIMEOUT_DEFAULTS["Write tests"]` 15→30 min so this sprint's own step 3 doesn't repeat Sprint 11's death; do NOT raise `MAX_TIMEOUT_MS` — idle-timeout is the real fix. Empirical durations (sprint-8/9/10): Write tests 13–19 min, Run suite ≤29 min, Implement 10–13 min. — source: loop-engineering research 2026-06-19 + Sprint 11 diagnostic 2026-07-06

## Features Delivered
- N/A

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
- Tool: Role
- TypeScript / `tsc`: Production build
- `@modelcontextprotocol/sdk`: MCP transport
- `simple-git`: Git operations
- `jest` + `ts-jest`: Test runner
- `npm`: Package manager
- Node.js: Runtime
- Storage: Config JSON
- Resolution: Defaults + merge
- Aspect: Decision
- Language / runtime: TypeScript on Node.js (existing)
- Matching engine: `picomatch` (recommended) **or** hand-rolled glob→regex (fallback)
- FS traversal: In-house synchronous recursive walker (`fs.readdirSync` + `statSync`), with prune list
- Async model: Synchronous (validation is a fast, blocking gate; matches existing `validateRequiredOutputs`)
- New persisted state: None
- Module location: `src/orchestrator/glob-match.ts`
- Subprocess spawn: `child_process.spawn` (Node built-in)
- Pre-flight `claude` PATH check: `child_process.spawnSync("claude", ["--version"])` + `ENOENT` detection
- Test runner: Jest (`it.skip`, `(condition ? it.skip : it)(...)`)
- Constant import: `import { AGENT_ALLOWED_TOOLS } from "../../src/orchestrator/agents"`
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
- Language / runtime: TypeScript / Node.js
- State storage: JSON files under `~/.raptor/{slug}/sprint-N.json` via `loadSprintState`/`saveSprintState`
- Git operations: `simple-git` (escalate/handoff commits)
- Tool input validation: Zod (`z.string().optional()` for `feature`)
- Status reduction: `deriveSprintStatus` in `multi-runner.ts` (kept pure)
- Feedback injection: Existing attempt-1 feedback mechanism in `runAgentStepCycle`
- Idle timer + hard ceiling: Node built-in `setTimeout`/`clearTimeout`
- Error classification & signatures: plain TypeScript regex/string ops
- Glob gate for salvage: existing `glob-match.ts` (`picomatch`)
- State persistence: existing JSON sprint-state files
- Config: existing `~/.raptor/config.json` via `loadConfig`
- Git operations: `simple-git`
- Tests: jest / ts-jest, colocated unit + `tests/integration/`
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
- `template/` contains only `TEAM.md`.
- `SCAFFOLD_DIRS` creates empty docs/tests/src directories.
- `generateReadme()` emits a minimal README; `generateBacklog()` emits an empty backlog.
- **Neither `bootstrap_project` nor `adopt_project` writes a `package.json` or `.mcp.json` for new projects today.**
- Replacing `tsc` for production. **Don't touch `npm run build` semantics.**
- Watch-mode tests. **Don't touch jest config.**
- Hot-reload without `/mcp` reconnect. **Not a goal.**
- Scaffolding `package.json` / `.mcp.json` into bootstrapped projects. **No-op per template-handling pattern above.**
- Removing or restructuring `bin`. **Untouched.**
- Live-claude smoke test. **Separate backlog item.**
- Role keys (`po`, `architect`, etc.) remain canonical everywhere in code and state
- Dino names are display-only — never used as identifiers in state or logic
- Emoji selection avoids actual dinosaur emoji (🦕🦖) for most roles to maintain visual distinction in the progress table
- DoD flags are set individually at the exact moment each condition is met — not batch-computed
- PR description update is best-effort — failure doesn't block the merge
- The DoD regex replacement in `updatePrDodChecklist` matches the standard PR template markers (e.g., `- [ ] All tests pass` → `- [x] All tests pass`)
- **`workflow.ts` patterns are frozen.** Only resolution/matching changes (Out of Scope).
- **Single matching implementation.** Both output validation (`runner.ts`) and input
- **Instruction/validator parity (AC #5).** The string the agent is told to create and the
- **Files-only, slug-scoped-where-stated.** The two invariants that fix the live bug:
- **At-least-one-match semantics.** A pattern is satisfied by ≥1 real matching file; no
- **Best-effort, no-crash traversal.** Unreadable dirs / missing base dirs degrade to "no
- **Out of scope (handled elsewhere):** `artifact-injection-directory-handling` (EISDIR
- **Pre-existing pattern compliance.** All git operations remain `simple-git`; no shelling
- **No mocking of `child_process` in this file.** AC #3 is the entire point of the feature. A future `jest.mock("child_process", ...)` in this file silently neuters the regression coverage — the top-of-file comment must call this out (AC #10).
- **Import the constant; do not duplicate.** AC #2 explicitly requires sourcing `AGENT_ALLOWED_TOOLS` from `agents.ts`. Copying the array as a string literal is a violation, even if "easier."
- **Skip, don't fail, on missing prerequisites.** A test environment without `claude` installed is not a regression — it's a CI environment we deliberately don't gate on. AC #7 requires `it.skip` (with reason), never `expect(false).toBe(true)`.
- **Stdin must be `"ignore"`.** This is the PR #13 fix. Any deviation (e.g. `"pipe"` or `"inherit"`) re-opens the regression the test is trying to detect.
- **Exit-on-success is `code === 0`.** Don't be clever with `code !== null` or signal handling — claude exits cleanly on a successful `--print` and that's what the test asserts.
- **Assertion order matters for diagnosability.** Check exit code first (the broadest signal), then stdout shape, then regex markers. The first failed assertion's message determines what a CI log reader sees first.
- **Permission-denied regex is intentionally broad.** Open Question 3 resolved in favor of false-positive resistance over false-negative resistance — a too-tight regex that misses a regression is the worse outcome. The `say ok` prompt's response should contain none of the alternation's tokens, so false positives in practice are rare.
- **No content assertions on model output.** AC out-of-scope. Asserting `stdout.includes("ok")` would be flaky and adds no regression coverage beyond what the non-empty check already provides.
- **Test file lives in `tests/integration/`**, not `src/`, matching the convention from `tests/integration/*.integration.test.ts`. Runs in both `npm test` and `npm run test:integration` per AC #9.
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
- **Additive-only, backward-compatible** — every change degrades gracefully for
- **No `multi-runner.ts` signature changes** — honoring the Sprint 8 Out-of-Scope
- **`deriveSprintStatus` stays a pure reducer** — finalization side effects live
- **Single dispatcher entry point** — all execution still flows through
- **Persist before yield** — `saveSprintState` is called before every park,
- **Per-feature isolation** — re-engaging one feature never mutates a sibling's
- **No silent advancement** — the dispatcher must not proceed to shared steps
- **Circuit breaker unchanged** — `MAX_RETRY_ATTEMPTS` (3) is not touched; re-
- **No migration** — Sprint 9 incident state files are not auto-fixed; this
- **Errors returned, not thrown** — resume validation failures (multi-target
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
- Step 6 (Open PR): failed 1 time(s) before succeeding
- Step 9 (Merge PR): failed 1 time(s) before in-progress

## Deferred Items
- blocker-marker-false-positive-in-agent-output: `hasBlockerMarker` (`runner.ts:259`) does a naive regex match for the bracketed blocker marker anywhere in agent output, so an agent that merely *quotes or discusses* the marker (docs, demo presentations, decision-pipeline diagrams) triggers a real escalation. Observed live: Sprint 12 step 8 (Demo) escalated (commit b4c5ffb) because the presentation quoted the decision-pipeline diagram containing the literal marker — confirmed false positive at demo review; demo content stood, no redo required. Fix: require the marker at line start (and/or only honor it in committed messages), and strip fenced code blocks/quoted text before matching. Check `[ESCALATE]` detection in `git-parser.ts` for the same quoting weakness while in there. — source: Sprint 12 demo false-positive escalation 2026-07-06 (PO triage: top of queue — hit the sprint itself, precedent Sprint 8 question #4)
- adversarial-verifier-review-gate: Harden the QA/PR review gates as out-of-loop adversarial verifiers. Three parts: (1) **assert against real production seams** — forbid test-local reimplementations of the system-under-test (the false-green failure the PO gate caught in Sprint 10; this is also unapplied retro proposal #3). (2) **generator ≠ verifier** — `spawnAgent` (`agents.ts:194`) takes no model param today, so every role-agent runs the same default `claude`; add `--model` plumbing + per-role model config so the QA/review agent can run on a different model and/or context-isolated prompt than the Engineer. Research shows a single model that both generates and judges reward-hacks in-context (evaluator scores rise while real quality stagnates). (3) **bias controls** on any LLM-judge gate — A/B order-swap + prompt-perturbation checks. Evidence: arXiv 2407.04549 (spontaneous in-context reward hacking); ImpossibleBench 2510.20270 (agents delete/rewrite tests to go false-green; stronger models cheat MORE — GPT-5 76%); arXiv 2604.16790 (judges prompt-fragile, ~15pt swing from a distraction). NOTE: a multi-judge *ensemble* was NOT supported (refuted 0-3 in our research) — do not build a judge panel. — source: loop-engineering research 2026-06-19
- persist-feedback-across-retries: Directional user/critic feedback is injected only on attempt 1 of a step and silently dropped on attempts 2–3 — verified at `runner.ts:832` (single-feature) and `runner.ts:1448` (multi-feature), both gated on `attempt === 1`. Per Reflexion (arXiv 2303.11366), feedback should persist as an episodic reflection buffer conditioning EVERY retry, not just the first. Add a per-step reflection buffer to `sprint-N.json` that accumulates directional feedback across all attempts (with a retention policy to avoid context overflow on long sprints), and bias the QA acceptance gate toward false-negative over false-positive ("an agent can self-reflect on a failing test but cannot recover from a falsely-passing one"). Closely related to escalate→resume. — source: loop-engineering research 2026-06-19
- backlog-format-error-with-example: When `run_sprint` rejects a backlog with "No backlog items found for sprint N" (tools.ts:687), include the expected format inline (`## Sprint N` / `- [ ] slug: description`) and a doc link. dora-metrics user spent ~3min in an edit→run→error loop reverse-engineering the parser — source: session ea5bc6fd 2026-04-26
- adopt-project-git-init: `adopt_project` should detect non-git directories and either auto-init (with prompt) or fail with a clear "run `git init` first" message. Today the failure surfaces as an opaque simple-git error — source: session ea5bc6fd 2026-04-26
- reset-sprint-tool: First-class `reset_sprint` MCP tool to clear escalated/failed state. Today users must `rm ~/.raptor/{project}/sprint-N.json` by hand to escape circuit-breaker escalation — source: session ea5bc6fd 2026-04-26
- config-keys-parsed-vs-declared: `RaptorConfig` (config.ts) declares `testConfig`, `codebaseContext`, `artifactInjection`, and `scopeNarrowing`, but `loadConfig` never parses them — users setting those keys in `~/.raptor/config.json` are silently ignored. Same defect class as the dead `timeouts` plumbing fixed by CB-5 in Sprint 12, which sat unnoticed for six sprints. Fix: parse every declared key (or delete unparsed keys from the interface) and add a conformance test asserting parsed-vs-declared parity so the two can't drift again. — source: Sprint 12 demo tech-debt flag 2026-07-06
- sprint-11-write-tests-escalation: **Post-mortem / live specimen for `progress-aware-circuit-breaker`.** Both Sprint 11 features (`expected-outputs-glob-resolution`, `artifact-injection-directory-handling`) escalated at step 3 (Write tests), 3 attempts / 3 failures each — but NOT on the feature logic and NOT on `expectedOutputs` validation (the step never reached the glob code path). Six failures total: 2× `agent timed out after 900000ms` (the 15-min `STEP_TIMEOUT_DEFAULTS["Write tests"]`) + 4× `socket connection closed unexpectedly` (transient API drops), and **every one recorded `hadPartialArtifacts: true`**. Both QA agents in fact produced complete, high-quality BDD files (203 + 122 lines, conventionally named) that the orchestrator discarded because the process didn't return cleanly. Three compounding defects, all folded into `progress-aware-circuit-breaker`: hard wall-clock kill of a still-working agent (#3), transient errors counted as hard failures (#2), completed artifacts thrown away (#4). Empirical step durations from sprint-8/9/10 state (`completedAt` deltas, incl. some checkpoint wait): Write tests 13–19 min (the long pole, hit the 15-min ceiling), Run test suite up to 29 min, Implement 10–13 min, Architecture 3–9 min, everything else <11 min. — source: Sprint 11 diagnostic 2026-07-06
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
Tool: Role
TypeScript / `tsc`: Production build
`@modelcontextprotocol/sdk`: MCP transport
`simple-git`: Git operations
`jest` + `ts-jest`: Test runner
`npm`: Package manager
Node.js: Runtime
Storage: Config JSON
Resolution: Defaults + merge
Aspect: Decision
Language / runtime: TypeScript on Node.js (existing)
Matching engine: `picomatch` (recommended) **or** hand-rolled glob→regex (fallback)
FS traversal: In-house synchronous recursive walker (`fs.readdirSync` + `statSync`), with prune list
Async model: Synchronous (validation is a fast, blocking gate; matches existing `validateRequiredOutputs`)
New persisted state: None
Module location: `src/orchestrator/glob-match.ts`
Subprocess spawn: `child_process.spawn` (Node built-in)
Pre-flight `claude` PATH check: `child_process.spawnSync("claude", ["--version"])` + `ENOENT` detection
Test runner: Jest (`it.skip`, `(condition ? it.skip : it)(...)`)
Constant import: `import { AGENT_ALLOWED_TOOLS } from "../../src/orchestrator/agents"`
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
Language / runtime: TypeScript / Node.js
State storage: JSON files under `~/.raptor/{slug}/sprint-N.json` via `loadSprintState`/`saveSprintState`
Git operations: `simple-git` (escalate/handoff commits)
Tool input validation: Zod (`z.string().optional()` for `feature`)
Status reduction: `deriveSprintStatus` in `multi-runner.ts` (kept pure)
Feedback injection: Existing attempt-1 feedback mechanism in `runAgentStepCycle`
Idle timer + hard ceiling: Node built-in `setTimeout`/`clearTimeout`
Error classification & signatures: plain TypeScript regex/string ops
Glob gate for salvage: existing `glob-match.ts` (`picomatch`)
State persistence: existing JSON sprint-state files
Config: existing `~/.raptor/config.json` via `loadConfig`
Git operations: `simple-git`
Tests: jest / ts-jest, colocated unit + `tests/integration/`
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
`template/` contains only `TEAM.md`.
`SCAFFOLD_DIRS` creates empty docs/tests/src directories.
`generateReadme()` emits a minimal README; `generateBacklog()` emits an empty backlog.
**Neither `bootstrap_project` nor `adopt_project` writes a `package.json` or `.mcp.json` for new projects today.**
Replacing `tsc` for production. **Don't touch `npm run build` semantics.**
Watch-mode tests. **Don't touch jest config.**
Hot-reload without `/mcp` reconnect. **Not a goal.**
Scaffolding `package.json` / `.mcp.json` into bootstrapped projects. **No-op per template-handling pattern above.**
Removing or restructuring `bin`. **Untouched.**
Live-claude smoke test. **Separate backlog item.**
Role keys (`po`, `architect`, etc.) remain canonical everywhere in code and state
Dino names are display-only — never used as identifiers in state or logic
Emoji selection avoids actual dinosaur emoji (🦕🦖) for most roles to maintain visual distinction in the progress table
DoD flags are set individually at the exact moment each condition is met — not batch-computed
PR description update is best-effort — failure doesn't block the merge
The DoD regex replacement in `updatePrDodChecklist` matches the standard PR template markers (e.g., `- [ ] All tests pass` → `- [x] All tests pass`)
**`workflow.ts` patterns are frozen.** Only resolution/matching changes (Out of Scope).
**Single matching implementation.** Both output validation (`runner.ts`) and input
**Instruction/validator parity (AC #5).** The string the agent is told to create and the
**Files-only, slug-scoped-where-stated.** The two invariants that fix the live bug:
**At-least-one-match semantics.** A pattern is satisfied by ≥1 real matching file; no
**Best-effort, no-crash traversal.** Unreadable dirs / missing base dirs degrade to "no
**Out of scope (handled elsewhere):** `artifact-injection-directory-handling` (EISDIR
**Pre-existing pattern compliance.** All git operations remain `simple-git`; no shelling
**No mocking of `child_process` in this file.** AC #3 is the entire point of the feature. A future `jest.mock("child_process", ...)` in this file silently neuters the regression coverage — the top-of-file comment must call this out (AC #10).
**Import the constant; do not duplicate.** AC #2 explicitly requires sourcing `AGENT_ALLOWED_TOOLS` from `agents.ts`. Copying the array as a string literal is a violation, even if "easier."
**Skip, don't fail, on missing prerequisites.** A test environment without `claude` installed is not a regression — it's a CI environment we deliberately don't gate on. AC #7 requires `it.skip` (with reason), never `expect(false).toBe(true)`.
**Stdin must be `"ignore"`.** This is the PR #13 fix. Any deviation (e.g. `"pipe"` or `"inherit"`) re-opens the regression the test is trying to detect.
**Exit-on-success is `code === 0`.** Don't be clever with `code !== null` or signal handling — claude exits cleanly on a successful `--print` and that's what the test asserts.
**Assertion order matters for diagnosability.** Check exit code first (the broadest signal), then stdout shape, then regex markers. The first failed assertion's message determines what a CI log reader sees first.
**Permission-denied regex is intentionally broad.** Open Question 3 resolved in favor of false-positive resistance over false-negative resistance — a too-tight regex that misses a regression is the worse outcome. The `say ok` prompt's response should contain none of the alternation's tokens, so false positives in practice are rare.
**No content assertions on model output.** AC out-of-scope. Asserting `stdout.includes("ok")` would be flaky and adds no regression coverage beyond what the non-empty check already provides.
**Test file lives in `tests/integration/`**, not `src/`, matching the convention from `tests/integration/*.integration.test.ts`. Runs in both `npm test` and `npm run test:integration` per AC #9.
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
**Additive-only, backward-compatible** — every change degrades gracefully for
**No `multi-runner.ts` signature changes** — honoring the Sprint 8 Out-of-Scope
**`deriveSprintStatus` stays a pure reducer** — finalization side effects live
**Single dispatcher entry point** — all execution still flows through
**Persist before yield** — `saveSprintState` is called before every park,
**Per-feature isolation** — re-engaging one feature never mutates a sibling's
**No silent advancement** — the dispatcher must not proceed to shared steps
**Circuit breaker unchanged** — `MAX_RETRY_ATTEMPTS` (3) is not touched; re-
**No migration** — Sprint 9 incident state files are not auto-fixed; this
**Errors returned, not thrown** — resume validation failures (multi-target
Test scoping is advisory — the agent sees it in the task description but isn't forced
The shared config warning is only injected during multi-feature sprints (when `state.features` is present)
Framework detection runs once per sprint, cached in the runner
Custom `testCommand` with `{slug}` placeholder takes full precedence over auto-detection
The merge step does NOT spawn a subagent — it's orchestrator-managed logic
The merge step participates in the retry/escalation circuit breaker (from agent-failure-recovery)
Squash-merge is always used — no configurable merge strategy
After merge, the PO feedback step runs on `main` (the orchestrator's working directory is the project root, and after merge the active branch is `main`)
Branch cleanup (remote delete) is explicitly out of scope
Issue: Step 6 (Open PR): failed 1 time(s) before succeeding
Issue: Step 9 (Merge PR): failed 1 time(s) before in-progress
