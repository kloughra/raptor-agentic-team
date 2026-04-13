# Backlog

## Sprint 5 — Planned
- [ ] agent-parallel-execution: Parallel agent execution where TEAM.md allows it (Architect + QA partial parallel, Architect review + QA test run)
- [ ] multi-engineer-coordination: Multi-engineer support with feature branch isolation and conflict resolution
- [ ] dino-agent-names: Assign dinosaur-themed names to each agent role

## Ready (prioritized, next sprint)
(empty — replenish from Inbox during Sprint 5 retro)

## Inbox (unprioritized)
- scoped-test-execution: Engineers should only run their own tests during implementation, not the full suite. Full suite runs once after all agents merge. Prevents parallel pytest deadlocks (observed: 26 competing pytest processes ground dora-metrics sprint to a halt, FEAT-H and FEAT-J ran 3hrs instead of ~1hr) — source: OpenStory session post-mortem
- resource-aware-agent-scheduling: Add concurrency limits to parallel agent execution. When agents share one machine, cap parallelism (e.g., max 2 agents) or detect CPU contention and queue excess agents. Current behavior: all engineers spawn simultaneously regardless of machine capacity — source: OpenStory session post-mortem
- agent-timeout-scaling-by-step-type: Scale AGENT_TIMEOUT_MS based on step type. QA generation steps (writing BDD + integration + performance tests) need significantly more time/tokens than engineer edit steps. Current flat 5-minute timeout caused 5 consecutive QA agent deaths on financial-planning-app Step 3 before any could finish writing tests — source: OpenStory session post-mortem
- progressive-retry-with-scope-narrowing: When a step fails twice, the third attempt should get a narrower scope (e.g., split "write all BDD + integration + performance tests" into separate sub-tasks) rather than retrying the identical prompt. Current retry sends the same prompt with error context appended, which doesn't help when the root cause is scope/timeout — source: OpenStory session post-mortem
- checkpoint-resume-for-subagents: Carry forward partial artifacts across retries more aggressively. Current buildRetryContext reads partial files but the sub-agent still re-reads all specs from scratch. Pre-summarize completed discovery work so retries skip the "read spec → read architecture → identify gaps" phase and jump straight to generation — source: OpenStory session post-mortem
- mcp-remote-hosting: Host Raptor remotely for multi-device access (laptop, desktop, phone) — source: user request
- mcp-github-integration: Create GitHub repos and push during bootstrap — source: user request
- mcp-cicd-setup: Configure CI/CD pipelines in bootstrapped repos — source: user request
- discord-integration: Discord communication channel for team agents — source: user request
- openclaw-evaluation: Evaluate OpenClaw as potential addition — source: user request
- security-permissions-model: Security and permissions model for agent operations — source: user request
- multi-device-sync: Sync project state across devices — source: user request

## Done
- [x] cross-sprint-context: Sprint summary artifacts generated after each sprint, fed as context to future sprint agents (Sprint 4)
- [x] agent-retrospective-improvements: Each role proposes TEAM.md improvements; user reviews at new retro checkpoint; adopted changes applied (Sprint 4)
- [x] dod-checklist-tracking: Track DoD checklist in sprint state and update PR description before merge (Sprint 4)
- [x] agent-failure-recovery: Circuit breaker (3 retries), structured retry with progressive context, resume from failed/escalated state (Sprint 3)
- [x] sprint-completion-on-merge: PR merge as sprint exit gate — auto-merge after demo approval, sprint ends on merge (Sprint 3)
- [x] mcp-agent-orchestration: Core orchestration loop with run_sprint and resume_sprint MCP tools, user checkpoints, sprint state persistence (Sprint 2)
- [x] mcp-project-bootstrap: Raptor MCP server with bootstrap_project, list_projects, and get_project_status tools (Sprint 1)
