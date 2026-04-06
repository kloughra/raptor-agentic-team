# Backlog

## Sprint 4 — Planned
- cross-sprint-context: Cross-sprint memory and context passing between agent sessions — sprint summary artifacts as input to future sprints
- agent-retrospective-improvements: Each agent proposes a TEAM.md improvement after their step; user checkpoint to review and select; retro doc in sprint workspace

## Ready (prioritized, next sprint)
- agent-parallel-execution: Parallel agent execution where TEAM.md allows it (Architect + QA partial parallel, Architect review + QA test run)
- multi-engineer-coordination: Multi-engineer support with feature branch isolation and conflict resolution
- dino-agent-names: Assign dinosaur-themed names to each agent role

## Inbox (unprioritized)
- mcp-remote-hosting: Host Raptor remotely for multi-device access (laptop, desktop, phone) — source: user request
- mcp-github-integration: Create GitHub repos and push during bootstrap — source: user request
- mcp-cicd-setup: Configure CI/CD pipelines in bootstrapped repos — source: user request
- discord-integration: Discord communication channel for team agents — source: user request
- openclaw-evaluation: Evaluate OpenClaw as potential addition — source: user request
- security-permissions-model: Security and permissions model for agent operations — source: user request
- multi-device-sync: Sync project state across devices — source: user request

## Done
- [x] agent-failure-recovery: Circuit breaker (3 retries), structured retry with progressive context, resume from failed/escalated state (Sprint 3)
- [x] sprint-completion-on-merge: PR merge as sprint exit gate — auto-merge after demo approval, sprint ends on merge (Sprint 3)
- [x] mcp-agent-orchestration: Core orchestration loop with run_sprint and resume_sprint MCP tools, user checkpoints, sprint state persistence (Sprint 2)
- [x] mcp-project-bootstrap: Raptor MCP server with bootstrap_project, list_projects, and get_project_status tools (Sprint 1)
