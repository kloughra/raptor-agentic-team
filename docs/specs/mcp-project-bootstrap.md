---
slug: mcp-project-bootstrap
status: in-progress
sprint: 1
---

# Raptor — Project Bootstrap

## User Story

As a human engineer managing multiple projects, I want to tell Claude "start a new project" and have Raptor automatically scaffold a fully-structured repository following the agentic team process, so that I can go from idea to a working dev team in a single command.

## Acceptance Criteria

- [ ] Raptor (MCP server) is running and connectable from Claude Code on the user's local machine
- [ ] The server exposes a `bootstrap_project` tool that accepts a project name, brief description, and an optional list of initial feature ideas
- [ ] When called, `bootstrap_project`:
  - Creates a new local git repo at a configurable base directory (e.g., `~/projects/{project-name}`)
  - Stamps the canonical `TEAM.md` into the repo root (the MCP server owns this template)
  - Creates the full directory scaffold as defined in TEAM.md's Project Bootstrap section
  - Initializes `docs/backlog.md` with the project description and any provided feature ideas populated in the Inbox section
  - Creates an initial git commit: `[BOOTSTRAP] Architect: project scaffold for {project-name}`
  - Returns confirmation with the repo path and next steps
- [ ] The server exposes a `list_projects` tool that returns all projects it has bootstrapped, with their repo paths
- [ ] The server exposes a `get_project_status` tool that accepts a project name and returns:
  - Current sprint number (parsed from `docs/backlog.md`)
  - Items in each backlog section (Inbox, Ready, Sprint, Done) with counts
  - Any open `[BLOCKER]` or `[ESCALATE]` commits (parsed from git log)
- [ ] Raptor's configuration specifies the base directory for projects
- [ ] The canonical TEAM.md template is bundled with Raptor, not fetched from an external source

## Edge Cases

- **Project name already exists**: Return an error — do not overwrite. Suggest the user check `list_projects`.
- **Invalid project name**: Reject names with spaces or special characters. Suggest a slug format (lowercase, hyphen-separated).
- **Base directory doesn't exist**: Create it. If creation fails (permissions), return a clear error.
- **TEAM.md template is missing or corrupt**: Fail loudly at server startup, not at bootstrap time. Raptor should validate its own template on initialization.
- **get_project_status called for unknown project**: Return a clear "project not found" error with a hint to check `list_projects`.
- **Repo exists but was not bootstrapped by Raptor**: `get_project_status` should handle repos that exist on disk but aren't in its registry gracefully — return "project not tracked by Raptor."
- **Feature ideas provided but empty strings**: Ignore empty entries, only add non-empty ideas to the backlog Inbox.

## Out of Scope

- Spinning up agents or assigning roles (Sprint 2+)
- Remote/hosted MCP server (future — local only for now)
- Multi-device sync (future — depends on hosted server)
- Writing the first feature spec for the bootstrapped project (the PO agent will do this in Sprint 2+)
- CI/CD setup in the bootstrapped repo
- GitHub/remote repo creation (local git only for now)

## Open Questions

- ~~Where does Raptor store its registry of projects?~~ **Resolved: local registry file at `~/.raptor/projects.json`.**
- ~~Should `bootstrap_project` accept initial feature ideas to pre-populate the backlog?~~ **Resolved: yes, accept an optional list of feature ideas and add them to the Inbox section.**
- ~~What should the MCP server be called?~~ **Resolved: Raptor.**
