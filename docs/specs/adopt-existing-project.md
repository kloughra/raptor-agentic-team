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
3. The tool scaffolds only **missing** pieces — never overwrites or replace existing files/directories:
   - `TEAM.md` — only if not present
   - `docs/backlog.md` — only if not present (seeds with Sprint 1 section)
   - `docs/` — if the directory already exists, only add missing subdirectories (`specs/`, `architecture/`, `sprints/`). Never delete, move, or replace existing files in `docs/`.
   - `tests/bdd/`, `tests/integration/` — creates directories with `.gitkeep` only if they don't exist. Never touch existing test files.
   - `README.md` — never touched (existing repos already have one)
4. **Project context discovery**: On adoption, scan existing files to build an initial context summary:
   - Read `README.md` (if present) for project description and goals
   - Read existing `docs/` folder for any specs, architecture docs, or design notes
   - Read `package.json`, `pyproject.toml`, `Cargo.toml`, or similar for tech stack detection
   - Read directory structure for codebase layout understanding
   - Store the context summary as `docs/project-context.md` (only if it doesn't exist)
   - This context is fed to agents in Sprint 1 so they understand what already exists
5. The tool registers the project in `~/.raptor/projects.json` with the existing path
6. After adoption, `run_sprint`, `resume_sprint`, and `get_project_status` all work normally
7. A git commit is created for any scaffolded files: `[BOOTSTRAP] Architect: adopted existing project {name}`
8. If no files need scaffolding (everything already exists), the commit is skipped but registration still happens

## Edge Cases
- Repo has a TEAM.md but no docs directory → scaffold docs only
- Repo has existing `docs/` with custom structure (e.g., `docs/guides/`, `docs/api/`) → preserve all existing files, only add missing Raptor directories alongside them
- Repo has no git history → error: "Path must be an initialized git repository"
- Path doesn't exist → error with clear message
- Path exists but isn't a directory → error
- Project already registered by name → error (same as bootstrap)
- Project already registered by path → error: "This repo is already tracked as '{existing-name}'"
- Large README or docs folder → truncate context discovery to first 10KB per file, 50KB total
- Binary files in docs → skip them during context discovery

## Out of Scope
- Migrating existing test files into Raptor's directory conventions
- Automatically generating specs from existing code (context discovery is read-only summarization, not spec generation)
- Detecting the project's tech stack and adjusting TEAM.md accordingly (tech stack is noted in project-context.md but TEAM.md stays generic)

## Open Questions
- None
