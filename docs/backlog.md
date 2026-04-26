# Backlog

## Ready (prioritized, next sprint)
- hotfix-workflow-tool: Add a `run_hotfix` MCP tool that enforces a lightweight SDLC: create hotfix branch → implement + test → PR → user approval → merge. Tracked in sprint state like a mini-sprint. Prevents untracked code changes.
- pre-flight-branch-check: Before any agent writes code, verify it's on a tracked branch (sprint or hotfix). If on main, refuse to proceed and prompt for branch creation. Enforced in `spawnAgent` and runner loop.
- change-proposal-tool: Add a `propose_change` MCP tool that creates a backlog entry and routes to the correct workflow (sprint vs hotfix) based on scope. Forces all changes through tracking before any code is written.
- resource-aware-agent-scheduling: Add concurrency limits to parallel agent execution. Cap parallelism (e.g., max 2 agents) or detect CPU contention and queue excess agents
- checkpoint-resume-for-subagents: Pre-summarize completed discovery work so retries skip re-reading all specs and jump straight to generation

## Inbox (unprioritized)
- multi-feature-sprint-dispatch: Wire `multi-runner.ts` (`detectSprintFeatures`, `createFeatureStates`, `featureBranchName`) into `runSprintFromStep`. Today the runner picks only the first slug from the sprint section via `extractFeatureSlug` (runner.ts:312) and never iterates the remaining items, so multi-item sprints silently drop everything after the first — source: dora-metrics adopt-and-run failure 2026-04-26
- sprint-branch-auto-create: Orchestrator should `git checkout -B sprint-{N}/{slug}` at sprint start instead of recording whatever branch HEAD points to (runner.ts:282-306). Today sprint state captures `master` and the agents commit to main, contradicting CLAUDE.md "All sprint commits go on the sprint branch" — source: dora-metrics adopt-and-run failure 2026-04-26
- partial-artifacts-gitkeep-filter: `validateStepOutputs` (runner.ts:75-96) lists every file in expected-output dirs without filtering `.gitkeep`, so `hadPartialArtifacts` is permanently `true` after bootstrap and masks the real signal of whether anything was written — source: dora-metrics adopt-and-run failure 2026-04-26
- agent-assisted-backlog-reformat: When deterministic backlog parsing fails to categorize items (tables, prose, non-standard formats), fall back to spawning a PO agent to reformat. Handles edge cases the regex parser misses — source: post-mortem from hotfix/backlog-reformat-on-adopt
- mcp-remote-hosting: Host Raptor remotely for multi-device access (laptop, desktop, phone) — source: user request
- mcp-github-integration: Create GitHub repos and push during bootstrap — source: user request
- mcp-cicd-setup: Configure CI/CD pipelines in bootstrapped repos — source: user request
- discord-integration: Discord communication channel for team agents — source: user request
- openclaw-evaluation: Evaluate OpenClaw as potential addition — source: user request
- security-permissions-model: Security and permissions model for agent operations — source: user request
- multi-device-sync: Sync project state across devices — source: user request

## Done
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
