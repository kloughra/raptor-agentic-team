# Backlog

## Sprint 8 — Planned
- [x] multi-feature-sprint-dispatch: complete — see Done section. PR #15 merged 2026-04-27.

## Ready (prioritized, next sprint)
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

## Inbox (unprioritized)
- shared-steps-bypass-slug-detection: `runSprintFromStep` runs `detectSprintFeatures` at the top of the function regardless of which step is being resumed. When Sprint 8 was resumed at step 13 (Apply retro improvements — a sprint-shared step that the runner handles deterministically without an agent or slug), the sprint section had been edited to a comment-only state and the dispatcher errored out with "Could not extract feature slug from backlog" before reaching step 13. Required a manual sentinel `- [x]` item in the backlog to unblock. Fix: skip slug detection when resuming at a step > 9 (sprint-shared steps don't need feature dispatch) — source: Sprint 8 step-13 resume failure 2026-04-28
- live-claude-smoke-test: Add a single non-mocked integration test that shells out to the real `claude` CLI with the orchestrator's actual spawn args and asserts the subprocess can produce some output (e.g. `claude --version`-equivalent) without permission failure. Today every `tests/integration/*.ts` mocks `spawnAgent` at the boundary, so a regression in spawn args (stdin, permissions, allowed tools, model flags) is invisible until a real `run_sprint` hits it. The permission-mode and stdin bugs (PR #13 + this hotfix) would both have been caught by such a test — source: post-mortem of hotfix/agent-permission-allowlist 2026-04-27
- partial-artifacts-gitkeep-filter: `validateStepOutputs` (runner.ts:75-96) lists every file in expected-output dirs without filtering `.gitkeep`, so `hadPartialArtifacts` is permanently `true` after bootstrap and masks the real signal of whether anything was written — source: dora-metrics adopt-and-run failure 2026-04-26
- agent-assisted-backlog-reformat: When deterministic backlog parsing fails to categorize items (tables, prose, non-standard formats), fall back to spawning a PO agent to reformat. Handles edge cases the regex parser misses — source: post-mortem from hotfix/backlog-reformat-on-adopt
- batch-checkpoints-config: Optional `batchCheckpoints` config knob to collapse per-feature checkpoints in multi-feature sprints into a single batched approval. Deferred at Sprint 8 demo — current per-feature streaming behavior preferred until we see a sprint with >3 features and approval friction is the bottleneck — source: Sprint 8 demo question #3 (PO triage 2026-04-27)
- mcp-remote-hosting: Host Raptor remotely for multi-device access (laptop, desktop, phone) — source: user request
- mcp-github-integration: Create GitHub repos and push during bootstrap — source: user request
- mcp-cicd-setup: Configure CI/CD pipelines in bootstrapped repos — source: user request
- discord-integration: Discord communication channel for team agents — source: user request
- openclaw-evaluation: Evaluate OpenClaw as potential addition — source: user request
- security-permissions-model: Security and permissions model for agent operations — source: user request
- multi-device-sync: Sync project state across devices — source: user request

## Done
- [x] multi-feature-sprint-dispatch: Wire `multi-runner.ts` helpers into `runSprintFromStep` so every backlog item in a sprint section gets dispatched. Per-feature branches, streaming checkpoints, failure isolation. Bundled `sprint-branch-auto-create` and `request-changes-feedback-injection` (Sprint 8)
- [x] sprint-branch-auto-create: Bundled into `multi-feature-sprint-dispatch` — `ensureFeatureBranch()` in `src/orchestrator/multi-runner.ts` is called from both single- and multi-feature paths, replacing the previous "record whatever HEAD points to" logic at `runner.ts:282-306` (Sprint 8)
- [x] request-changes-feedback-injection: Single-feature and multi-feature `request-changes` branches in `resumeSprint` both reset `attempts = 0` and `failures = []` so the retry loop re-enters at attempt 1 and the feedback-injection condition fires (Sprint 8)
- [x] codebase-aware-agent-context: Codebase snapshot (tree, exports, excerpts, deps) injected into agent prompts per step. 30KB cap, .gitignore-aware (Sprint 7)
- [x] read-before-write-enforcement: Required artifacts read from disk and injected into agent task descriptions with pre-generation checklist (Sprint 7)
- [x] progressive-retry-with-scope-narrowing: 3rd retry auto-decomposes by acceptance criteria (Engineer), scenario group (QA), or component (Architect) (Sprint 7)
- [x] adopt-existing-project: Register existing repos in Raptor, scaffold only missing pieces, discover project context (Sprint 6)
- [x] agent-timeout-scaling-by-step-type: Step-aware timeout scaling — QA 15min, Engineer 10min, Architect 7min, configurable cascade (Sprint 6)
- [x] scoped-test-execution: Feature-scoped test commands during implementation, full suite at review only, framework auto-detection (Sprint 6)
- [x] agent-parallel-execution: Parallel agent execution where TEAM.md allows it (Sprint 5)
- [x] multi-engineer-coordination: Multi-engineer support with feature branch isolation and conflict resolution (Sprint 5)
- [x] dino-agent-names: Dinosaur-themed names for each agent role (Sprint 5)
- [x] cross-sprint-context: Sprint summary artifacts generated after each sprint, fed as context to future sprint agents (Sprint 4)
- [x] agent-retrospective-improvements: Each role proposes TEAM.md improvements; user reviews at new retro checkpoint; adopted changes applied (Sprint 4)
- [x] dod-checklist-tracking: Track DoD checklist in sprint state and update PR description before merge (Sprint 4)
- [x] agent-failure-recovery: Circuit breaker (3 retries), structured retry with progressive context, resume from failed/escalated state (Sprint 3)
- [x] sprint-completion-on-merge: PR merge as sprint exit gate — auto-merge after demo approval, sprint ends on merge (Sprint 3)
- [x] mcp-agent-orchestration: Core orchestration loop with run_sprint and resume_sprint MCP tools, user checkpoints, sprint state persistence (Sprint 2)
- [x] mcp-project-bootstrap: Raptor MCP server with bootstrap_project, list_projects, and get_project_status tools (Sprint 1)

## Sprint 8 Demo Feedback (2026-04-27)

**Demo:** [docs/demos/sprint-8-multi-feature-sprint-dispatch.md](demos/sprint-8-multi-feature-sprint-dispatch.md)
**PR:** #15 (merged dc869a2)

| Demo question | PO triage | Outcome |
|---|---|---|
| 1. Acceptance vs spec intent | ACCEPTED — 14/14 ACs covered, 435/435 tests pass, no regressions | Sprint 8 closed |
| 2. Bundling `sprint-branch-auto-create` + `request-changes-feedback-injection` | ACCEPTED — shared code path, single review surface | Both items moved to Done |
| 3. Streaming checkpoints (one-per-feature, sequential) | CONFIRMED as designed — defer batching until friction data exists | Filed `batch-checkpoints-config` in Inbox |
| 4. Deferred plumbing bugs (`expected-outputs-glob-resolution`, `artifact-injection-directory-handling`) | PROMOTE both Inbox → Ready, top of queue for Sprint 9 — both hit Sprint 8 itself and masked correct QA output | Promoted |
| 5. Anything else | None | — |

**Net backlog mutations:**
- Promoted Inbox → Ready: `expected-outputs-glob-resolution`, `artifact-injection-directory-handling`
- Added to Inbox: `batch-checkpoints-config` (deferred follow-up from AC #13)
- Sprint 8 — Planned section emptied (all items in Done)
