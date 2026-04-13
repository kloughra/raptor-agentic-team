---
slug: agent-timeout-scaling-by-step-type
status: draft
sprint: 6
---
# Agent Timeout Scaling by Step Type

## User Story
As the Raptor orchestrator, I want agent timeouts to scale based on the type of work being done, so that complex generation steps (like QA test writing) get enough time to complete while simpler steps don't hang forever.

## Acceptance Criteria
1. Each `WorkflowStep` has an optional `timeoutMs` field that overrides the global default
2. A `STEP_TIMEOUT_DEFAULTS` map provides sensible defaults by step name/role:
   - QA test generation (step 3 "Write tests"): **15 minutes** (900,000ms)
   - Engineer implementation (step 5 "Implement TDD"): **10 minutes** (600,000ms)
   - All other steps: **5 minutes** (300,000ms) — current default
3. The `spawnAgent` function accepts an optional `timeoutMs` parameter and uses it instead of the hardcoded `AGENT_TIMEOUT_MS`
4. `AGENT_TIMEOUT_MS` remains as the fallback default (5 minutes) for backward compatibility
5. Timeout values are configurable via `~/.raptor/config.json` under a `timeouts` key:
   ```json
   { "timeouts": { "qa-test-generation": 1200000, "engineer-implementation": 900000, "default": 300000 } }
   ```
6. The runner passes the resolved timeout to `spawnAgent` for each step
7. Progress table shows timeout info when a step is in-progress with a non-default timeout

## Edge Cases
- Config has a timeout of 0 → use the default (don't allow zero timeout)
- Config has negative timeout → use the default
- Config has absurdly large timeout (>30min) → cap at 30 minutes with a warning in logs
- Step has both a workflow-level `timeoutMs` and a config override → config wins (user preference)

## Out of Scope
- Dynamic timeout adjustment based on project size or past step durations
- Per-retry timeout changes (e.g., increasing timeout on retries)

## Open Questions
- None
