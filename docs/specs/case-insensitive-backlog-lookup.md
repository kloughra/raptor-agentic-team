# Feature Spec: case-insensitive-backlog-lookup

## Problem
Raptor hardcodes `docs/backlog.md` (lowercase) across all tools: `run_sprint`, `get_project_status`, `resume_sprint`, and the backlog parser. When a project has `docs/BACKLOG.md` or `BACKLOG.MD`:
- On **macOS** (case-insensitive FS): `fs.existsSync("docs/backlog.md")` returns true for `BACKLOG.md`, so the file is found — but the adopt tool thinks it's already in Raptor format and skips reformatting
- On **Linux** (case-sensitive FS): the file is simply not found, and `run_sprint` fails with "No backlog.md found"

This was observed in a real session adopting OpenStory, which has `docs/BACKLOG.md`.

## Solution
Create a shared `resolveBacklogPath()` utility that performs case-insensitive lookup for the backlog file. All code that reads the backlog should use this function instead of hardcoding the path.

## Acceptance Criteria
- [ ] A shared `resolveBacklogPath(projectPath)` function exists that finds the backlog case-insensitively
- [ ] It searches `docs/` directory first, then project root, for any casing of `backlog.md`
- [ ] Returns the actual path on disk (preserving real casing) or null if not found
- [ ] `run_sprint` / `runSprintFromStep` uses `resolveBacklogPath` instead of hardcoded path
- [ ] `get_project_status` uses `resolveBacklogPath` instead of hardcoded path
- [ ] `adoptProject` uses `resolveBacklogPath` for the "already exists" check (fixes the macOS masking bug)
- [ ] `extractFeatureSlug` in runner.ts uses `resolveBacklogPath`
- [ ] `detectSprintFeatures` in multi-runner.ts uses `resolveBacklogPath`
- [ ] Backlog summary functions in summary.ts use `resolveBacklogPath`
- [ ] On macOS, if `BACKLOG.md` exists and adopt is run, it gets reformatted (not skipped)

## Out of Scope
- Renaming the user's original file on disk (we write to `docs/backlog.md` canonical, but don't delete `BACKLOG.md`)
- Case-insensitive lookup for other artifacts (specs, architecture docs) — future work if needed
