---
slug: adopt-existing-project
status: draft
sprint: 6
---
# Adopt Existing Project

## User Story
As a Raptor user, I want to run the agentic team process on an existing repo that wasn't built with `bootstrap_project`, so that I can use Raptor on projects I've already started.

## Acceptance Criteria
1. A new MCP tool `adopt_project` is available that takes:
   - `path` (required): absolute path to an existing repo
   - `name` (required): project name for Raptor registration
   - `description` (required): project description
   - `featureIdeas` (optional): seed the backlog inbox
2. The tool validates:
   - The path exists and is a git repository
   - The project name isn't already registered
   - The project name matches the naming convention (`^[a-z][a-z0-9-]*$`)
3. The tool scaffolds only **missing** pieces — never overwrites existing files:
   - `TEAM.md` — only if not present
   - `docs/backlog.md` — only if not present (seeds with Sprint 1 section)
   - `docs/specs/`, `docs/architecture/`, `docs/sprints/`, `tests/bdd/`, `tests/integration/` — creates directories with `.gitkeep` only if they don't exist
   - `README.md` — never touched (existing repos already have one)
4. The tool registers the project in `~/.raptor/projects.json` with the existing path
5. After adoption, `run_sprint`, `resume_sprint`, and `get_project_status` all work normally
6. A git commit is created for any scaffolded files: `[BOOTSTRAP] Architect: adopted existing project {name}`
7. If no files need scaffolding (everything already exists), the commit is skipped

## Edge Cases
- Repo has a TEAM.md but no docs directory → scaffold docs only
- Repo has no git history → error: "Path must be an initialized git repository"
- Path doesn't exist → error with clear message
- Path exists but isn't a directory → error
- Project already registered by name → error (same as bootstrap)
- Project already registered by path → error: "This repo is already tracked as '{existing-name}'"

## Out of Scope
- Migrating existing test files into Raptor's directory conventions
- Automatically generating specs from existing code
- Detecting the project's tech stack and adjusting TEAM.md accordingly

## Open Questions
- None
