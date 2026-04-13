# Backlog

## Sprint 6 — Planned
- [ ] adopt-existing-project: Register an existing repo in Raptor, scaffold only missing pieces (TEAM.md, docs dirs, backlog), enable run_sprint on repos not built with bootstrap_project
- [ ] agent-timeout-scaling-by-step-type: Scale AGENT_TIMEOUT_MS based on step type. QA generation steps need 15-20min, engineer edit steps need 5min. Flat 5min timeout caused 5 consecutive QA agent deaths
- [ ] scoped-test-execution: Engineers only run their own tests during implementation. Full suite runs once after merge. Prevents parallel pytest deadlocks (26 competing processes observed)

## Ready (prioritized, next sprint)
- resource-aware-agent-scheduling: Add concurrency limits to parallel agent execution. Cap parallelism (e.g., max 2 agents) or detect CPU contention and queue excess agents
- progressive-retry-with-scope-narrowing: When a step fails twice, third attempt gets narrower scope (split oversized tasks into sub-tasks) rather than retrying identical prompt
- checkpoint-resume-for-subagents: Pre-summarize completed discovery work so retries skip re-reading all specs and jump straight to generation

## Inbox (unprioritized)
- mcp-remote-hosting: Host Raptor remotely for multi-device access (laptop, desktop, phone) — source: user request
- mcp-github-integration: Create GitHub repos and push during bootstrap — source: user request
- mcp-cicd-setup: Configure CI/CD pipelines in bootstrapped repos — source: user request
- discord-integration: Discord communication channel for team agents — source: user request
- openclaw-evaluation: Evaluate OpenClaw as potential addition — source: user request
- security-permissions-model: Security and permissions model for agent operations — source: user request
- multi-device-sync: Sync project state across devices — source: user request

## Done
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
