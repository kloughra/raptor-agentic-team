# Feature Spec: adopt-upsert

## Problem
`adopt_project` rejects calls when the project name is already registered, even if the user wants to re-run adoption to pick up tool improvements (e.g., backlog reformatting fixes). The user has to manually deregister and re-adopt, which is tedious and error-prone.

## Solution
Make `adopt_project` behave as an upsert. If the project name is already registered AND the path matches, re-run scaffolding and context discovery. Only reject if the name is registered with a different path (true duplicate).

## Acceptance Criteria
- [ ] If name exists and path matches: re-run scaffolding (additive), re-run context discovery, re-run backlog reformatting, update registry entry (description, timestamp)
- [ ] If name exists but path differs: return error "Project 'x' is already registered at a different path"
- [ ] If path is already registered under a different name: return error (existing behavior preserved)
- [ ] Re-adoption scaffolds only missing files (same additive behavior as first adoption)
- [ ] Re-adoption reformats the backlog even if docs/backlog.md already exists (the whole point of re-adopting)
- [ ] Re-adoption regenerates project-context.md (picks up codebase changes since first adoption)
- [ ] Response message distinguishes between first adoption and re-adoption: "re-adopted" vs "adopted"

## Out of Scope
- Renaming a project during re-adoption
- Merging two project registrations
