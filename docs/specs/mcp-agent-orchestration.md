---
slug: mcp-agent-orchestration
status: ready
sprint: 2
---

# Agent Orchestration — Core Sprint Loop

## User Story

As a user managing projects through Raptor, I want to tell Raptor to "run a sprint" on a bootstrapped project so that agents autonomously execute the full sprint workflow (PO → Architect → QA → Engineer) with me only stepping in at defined checkpoints.

## Overview

Raptor gains a new MCP tool `run_sprint` that orchestrates a complete sprint for a given project. The main Claude Code session acts as the **orchestrator** — it manages the workflow graph, spawns role-specific subagents for each step, commits artifacts via git, and pauses for user input at the four defined checkpoints (see TEAM.md § User Checkpoints). Between checkpoints, the sprint runs autonomously.

The orchestrator displays a clear, user-friendly view of sprint progress in the main session so the user always knows what's happening: which step is active, which role is working, what was produced, and what's coming next.

## Acceptance Criteria

- [ ] New MCP tool `run_sprint` accepts a project name and sprint number, and orchestrates the sprint workflow
- [ ] Orchestrator spawns a subagent for each role at the appropriate workflow step (PO, Architect, QA, Engineer)
- [ ] Each subagent receives a role-scoped system prompt derived from TEAM.md (only that role's responsibilities, boundaries, and decision authority)
- [ ] Each subagent receives the relevant input artifacts for its step (e.g., Engineer receives spec + architecture + tests)
- [ ] Subagent output is committed to the project repo with the correct `[ROLE]` commit message format
- [ ] Handoffs between roles are recorded as `[HANDOFF]` commits
- [ ] Sprint pauses for user input at exactly 4 checkpoints:
  1. After PO produces spec — user reviews features and acceptance criteria
  2. After Architect proposes tech choices — user approves or rejects
  3. After Engineer opens PR — user reviews the PR
  4. After demo — user gives feedback
- [ ] Between checkpoints, the sprint proceeds autonomously (no user prompts)
- [ ] The orchestrator displays a progress view in the main session showing: current step, active role, completed steps with summary, and next steps
- [ ] The progress view updates as each step completes (not just at the end)
- [ ] `run_sprint` validates that the project exists and has been bootstrapped before starting
- [ ] `run_sprint` validates that a backlog item exists for the given sprint before starting
- [ ] If a subagent fails or raises a `[BLOCKER]`, the orchestrator surfaces it to the user with context
- [ ] Sprint execution is sequential (no parallel steps in this sprint)
- [ ] `get_project_status` is extended to include sprint orchestrator state (current step, checkpoint status, progress table) so that a new Claude session can discover and display an in-progress or paused sprint

## Edge Cases

- **Project doesn't exist**: Return clear error with suggestion to run `bootstrap_project` first
- **No backlog items for sprint N**: Return error indicating the backlog needs sprint items before a sprint can run
- **Subagent produces invalid output** (missing required artifacts): Orchestrator retries once with clarified instructions, then escalates to user
- **User rejects at checkpoint 1 (spec review)**: PO subagent is re-spawned with the user's feedback to revise the spec
- **User rejects at checkpoint 2 (tech choices)**: Architect subagent is re-spawned with the user's feedback
- **User rejects at checkpoint 3 (PR review)**: Engineer subagent is re-spawned with review comments to address
- **User provides feedback at checkpoint 4 (demo)**: PO subagent processes feedback into backlog updates; sprint completes
- **Subagent hits circuit breaker (3 failures)**: Orchestrator stops and escalates to user per TEAM.md

## Out of Scope

- Parallel agent execution (Architect + QA steps running simultaneously) — deferred to `agent-parallel-execution`
- Automated circuit breaker retry logic beyond one retry — deferred to `agent-failure-recovery`
- Multi-engineer coordination (multiple engineers on the same sprint) — deferred to `multi-engineer-coordination`
- Persisting context across sprints — deferred to `cross-sprint-context`
- Running multiple sprints concurrently across projects
- Playwright E2E tests (not applicable until Raptor has a UI)

## Resolved Questions

- **Orchestrator progress view format**: Structured status table showing the full workflow with checkmarks that updates as each step completes. — *Resolved: user preference*
- **Checkpoint interaction model**: Structured options (Approve / Request changes) with a free-text field for feedback. — *Resolved: user preference*

## Open Questions

1. **Subagent invocation mechanism**: Should Raptor shell out to `claude` CLI to spawn subagents, or use the Claude API directly? The CLI approach is simpler but less controllable; the API approach gives more control over system prompts and streaming but adds a dependency. — *Needs Architect input*
