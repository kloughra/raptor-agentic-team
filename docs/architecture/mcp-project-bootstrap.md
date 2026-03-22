---
slug: mcp-project-bootstrap
spec: docs/specs/mcp-project-bootstrap.md
---

# Raptor — Project Bootstrap — Architecture Design

## Overview

Raptor is a local MCP server that exposes three tools (`bootstrap_project`, `list_projects`, `get_project_status`) over stdio transport. It manages a registry of projects at `~/.raptor/projects.json`, owns the canonical TEAM.md template, and performs git operations to scaffold and inspect project repositories.

## Components

```
┌─────────────────────────────────────────────────┐
│                  Claude Code                     │
│              (MCP Client, stdio)                 │
└──────────────────────┬──────────────────────────┘
                       │ stdin/stdout
┌──────────────────────▼──────────────────────────┐
│                 Raptor Server                    │
│                  (index.ts)                      │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │bootstrap │  │  list    │  │  status       │  │
│  │_project  │  │_projects │  │  (git log     │  │
│  │          │  │          │  │   + backlog   │  │
│  │          │  │          │  │   parser)     │  │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│       │              │               │           │
│  ┌────▼──────────────▼───────────────▼───────┐  │
│  │              registry.ts                   │  │
│  │     Read/write ~/.raptor/projects.json     │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │              template.ts                   │  │
│  │   Bundled TEAM.md + scaffold directory map │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │              config.ts                     │  │
│  │       Read ~/.raptor/config.json           │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
         │
         │  simple-git
         ▼
┌──────────────────┐     ┌──────────────────────┐
│  Local Git Repos │     │  ~/.raptor/           │
│  ~/projects/*    │     │  ├── config.json      │
│                  │     │  └── projects.json    │
└──────────────────┘     └──────────────────────┘
```

## Data Model

### Registry (`~/.raptor/projects.json`)

```json
{
  "projects": [
    {
      "name": "my-app",
      "slug": "my-app",
      "description": "A recipe sharing app",
      "path": "/Users/katie/projects/my-app",
      "createdAt": "2026-03-21T10:00:00Z"
    }
  ]
}
```

### Config (`~/.raptor/config.json`)

```json
{
  "projectsBaseDir": "~/projects",
  "teamTemplatePath": null
}
```

- `projectsBaseDir`: Where new project repos are created. Defaults to `~/projects` if not set.
- `teamTemplatePath`: Override for TEAM.md template location. `null` means use the bundled template. Exists for future flexibility but not exposed to users in Sprint 1.

## API Contracts

### Tool: `bootstrap_project`

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Project name (lowercase, hyphen-separated, no special characters)",
      "pattern": "^[a-z][a-z0-9-]*$"
    },
    "description": {
      "type": "string",
      "description": "Brief description of what this project is"
    },
    "featureIdeas": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Optional list of initial feature ideas to add to the backlog Inbox"
    }
  },
  "required": ["name", "description"]
}
```

**Success Response:**
```json
{
  "status": "success",
  "project": {
    "name": "my-app",
    "path": "/Users/katie/projects/my-app",
    "createdAt": "2026-03-21T10:00:00Z"
  },
  "message": "Project 'my-app' bootstrapped at /Users/katie/projects/my-app. Next step: PO authors the first feature spec.",
  "scaffoldedFiles": [
    "TEAM.md",
    "README.md",
    "docs/backlog.md",
    "docs/specs/.gitkeep",
    "docs/architecture/.gitkeep",
    "docs/adr/.gitkeep",
    "docs/demos/.gitkeep",
    "tests/bdd/.gitkeep",
    "tests/integration/.gitkeep",
    "tests/performance/.gitkeep",
    "tests/e2e/.gitkeep",
    "tests/e2e/screenshots/.gitkeep",
    "src/.gitkeep"
  ]
}
```

**Error Responses:**
- `"Project 'my-app' already exists. Use list_projects to see all projects."`
- `"Invalid project name 'My App'. Use lowercase, hyphen-separated format (e.g., 'my-app')."`
- `"Cannot create base directory '/some/path': Permission denied."`

### Tool: `list_projects`

**Input Schema:**
```json
{
  "type": "object",
  "properties": {},
  "required": []
}
```

**Response:**
```json
{
  "projects": [
    {
      "name": "my-app",
      "description": "A recipe sharing app",
      "path": "/Users/katie/projects/my-app",
      "createdAt": "2026-03-21T10:00:00Z"
    }
  ],
  "count": 1
}
```

### Tool: `get_project_status`

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Project name as registered in Raptor"
    }
  },
  "required": ["name"]
}
```

**Response:**
```json
{
  "project": "my-app",
  "sprint": {
    "current": 1,
    "items": [
      { "slug": "user-login", "description": "User login flow", "done": false }
    ]
  },
  "backlog": {
    "inbox": { "count": 3, "items": ["...", "...", "..."] },
    "ready": { "count": 1, "items": ["..."] },
    "sprint": { "count": 1, "items": ["..."] },
    "done": { "count": 0, "items": [] }
  },
  "blockers": [
    {
      "role": "Engineer",
      "description": "unclear validation rules for email field",
      "blockedOn": "PO",
      "commit": "abc1234",
      "date": "2026-03-21T14:30:00Z"
    }
  ],
  "escalations": []
}
```

**Error Responses:**
- `"Project 'unknown' not found. Use list_projects to see all tracked projects."`
- `"Project 'legacy-app' exists on disk but is not tracked by Raptor."`

## Sequence Diagrams

### Bootstrap Project Flow

```
User ──► Claude Code ──► Raptor (bootstrap_project)
                              │
                              ├─ Validate name (regex, uniqueness)
                              ├─ Resolve base directory from config
                              ├─ Create project directory
                              ├─ git init
                              ├─ Write TEAM.md (from bundled template)
                              ├─ Write README.md
                              ├─ Create directory scaffold + .gitkeep files
                              ├─ Write docs/backlog.md (with description + feature ideas)
                              ├─ git add -A
                              ├─ git commit "[BOOTSTRAP] Architect: project scaffold for {name}"
                              ├─ Add project to ~/.raptor/projects.json
                              └─ Return success response
```

### Get Status Flow

```
User ──► Claude Code ──► Raptor (get_project_status)
                              │
                              ├─ Look up project in registry
                              ├─ Verify repo exists on disk
                              ├─ Read + parse docs/backlog.md
                              │    ├─ Extract sprint number from section headers
                              │    └─ Count items per section
                              ├─ git log --grep="[BLOCKER]" + "[ESCALATE]"
                              │    └─ Parse role, description, blocked-on from commit messages
                              └─ Return assembled status response
```

## Non-Functional Requirements

- **Startup time**: Raptor should start and be ready to accept tool calls in < 2 seconds
- **Bootstrap time**: Scaffolding a new project should complete in < 5 seconds (local filesystem + git init)
- **Status query time**: `get_project_status` should respond in < 3 seconds (file read + git log parse)
- **Reliability**: Raptor must validate its own template and config at startup. Fail fast with a clear error if misconfigured.
- **Data safety**: Never overwrite an existing project. Never modify a project's TEAM.md after bootstrap (it belongs to the project from that point forward).

## Technology Choices

| Choice | Option | Status |
|---|---|---|
| Language | TypeScript | user-approved |
| Runtime | Node.js | user-approved |
| MCP SDK | `@modelcontextprotocol/sdk` | user-approved |
| Git operations | `simple-git` | user-approved |
| Package manager | npm | user-approved |
| Transport | stdio | user-approved |
| Storage | JSON files | user-approved |

See ADR-001 for full rationale.

## Constraints & Patterns

- **All git operations go through `simple-git`** — no shelling out to git directly
- **Registry is the source of truth** for what projects Raptor knows about. If a project is deleted from disk but still in the registry, `get_project_status` should report it as missing rather than crashing
- **TEAM.md is immutable after bootstrap** — Raptor stamps it and never touches it again. The project team owns it from that point forward
- **Backlog parsing is best-effort** — the backlog format is defined in TEAM.md but could be manually edited. Parse what you can, return partial results rather than failing if the format is unexpected
- **Config has sensible defaults** — if `~/.raptor/config.json` doesn't exist, use defaults (`projectsBaseDir: ~/projects`). Don't require manual setup
- **.gitkeep files** in empty directories to ensure git tracks the scaffold structure
