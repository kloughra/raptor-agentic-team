---
slug: scoped-test-execution
status: draft
sprint: 6
---
# Scoped Test Execution

## User Story
As the Raptor orchestrator, I want engineers to only run tests relevant to their own feature during implementation, with the full suite running once after all features merge, so that parallel agent execution doesn't cause test deadlocks.

## Acceptance Criteria
1. During step 5 (Engineer implementation), the agent's task description instructs it to run only tests matching the feature slug:
   - `npx jest --testPathPattern="{feature-slug}"` for JS/TS projects
   - `pytest -k "{feature-slug}"` for Python projects
   - Pattern is configurable per project via `~/.raptor/config.json` under `testCommand`
2. A new step or sub-step "Run full test suite" executes after all engineer work is merged, running the complete test suite once
3. The `buildTaskDescription` function includes a `testScope` field that tells the agent which tests to run:
   - During implementation: `"scoped"` with the feature slug pattern
   - During QA test run (step 7): `"full"` — runs everything
4. If the project has no test command configured, fall back to auto-detection:
   - Check for `package.json` → use `npx jest`
   - Check for `pyproject.toml` or `setup.py` → use `pytest`
   - Check for `Cargo.toml` → use `cargo test`
   - Otherwise → no scoping, run whatever the engineer decides
5. The scoped test pattern is passed in the agent's context, not hardcoded in the system prompt
6. Step 7 (QA test run) always runs the full suite regardless of scoping

## Edge Cases
- Feature slug contains characters that are invalid in test path patterns → escape them
- Project has both `package.json` and `pyproject.toml` (monorepo) → use `testCommand` from config, or default to the first match
- No tests match the scoped pattern → agent should note this and continue (not fail)
- Custom `testCommand` in config uses a placeholder `{slug}` → replace with actual feature slug

## Out of Scope
- Parallel test execution within a single agent (e.g., jest --shard)
- Test result parsing and structured reporting
- Flaky test detection and retry

## Open Questions
- None
